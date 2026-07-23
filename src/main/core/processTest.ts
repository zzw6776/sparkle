import net from 'node:net'
import { performance } from 'node:perf_hooks'
import tls from 'node:tls'
import {
  ensureRuntimeTestChannelCapacity,
  getRuntimeCodexTestChannels,
  MAX_CODEX_TEST_CONCURRENCY
} from './factory'
import { mihomoChangeProxy } from './mihomoApi'
import { acquireNetworkTestChannel } from './networkTestChannel'

const REQUEST_TIMEOUT = 8_000
const MAX_HEADER_BYTES = 32 * 1024

interface ActiveProcessTest {
  controller: AbortController
  cancelled: boolean
}

interface TunnelResult {
  socket: net.Socket
  duration: number
}

interface SuccessfulSample extends ProcessTestTargetRequest {
  round: number
  connectMs: number
  tlsMs?: number
  totalMs: number
}

interface FailedSample extends ProcessTestTargetRequest {
  round: number
  error: string
}

let activeProcessTest: ActiveProcessTest | undefined

function abortError(): Error {
  return new Error('进程测速已停止')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function roundMetric(value: number): number {
  return Math.round(value * 10) / 10
}

function percentile(values: number[], percentage: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.max(0, Math.ceil(sorted.length * percentage) - 1)
  return sorted[index]
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

function targetKey(target: ProcessTestTargetRequest): string {
  return `${target.host}:${target.port}`
}

function appendSample<T>(samples: Map<string, T[]>, proxy: string, sample: T): void {
  const current = samples.get(proxy)
  if (current) current.push(sample)
  else samples.set(proxy, [sample])
}

function connectProxyTunnel(
  localPort: number,
  target: ProcessTestTargetRequest,
  signal: AbortSignal
): Promise<TunnelResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError())
      return
    }

    const startedAt = performance.now()
    const socket = net.createConnection({ host: '127.0.0.1', port: localPort })
    let buffer = Buffer.alloc(0)
    let settled = false

    const cleanup = (): void => {
      socket.removeListener('connect', onConnect)
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      socket.removeListener('timeout', onTimeout)
      signal.removeEventListener('abort', onAbort)
      socket.setTimeout(0)
    }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      socket.destroy()
      reject(error)
    }
    const onConnect = (): void => {
      socket.write(
        `CONNECT ${target.host}:${target.port} HTTP/1.1\r\n` +
          `Host: ${target.host}:${target.port}\r\n` +
          'Proxy-Connection: Keep-Alive\r\n\r\n'
      )
    }
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > MAX_HEADER_BYTES) {
        fail(new Error('代理 CONNECT 响应头过大'))
        return
      }

      const headerEnd = buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) return
      const header = buffer.subarray(0, headerEnd).toString('latin1')
      const status = Number.parseInt(header.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/i)?.[1] || '', 10)
      if (status !== 200) {
        fail(new Error(`代理 CONNECT 失败（HTTP ${Number.isFinite(status) ? status : '未知'}）`))
        return
      }

      const remaining = buffer.subarray(headerEnd + 4)
      settled = true
      cleanup()
      if (remaining.length > 0) socket.unshift(remaining)
      resolve({ socket, duration: performance.now() - startedAt })
    }
    const onError = (error: Error): void => fail(error)
    const onTimeout = (): void => fail(new Error(`连接 ${targetKey(target)} 超时`))
    const onAbort = (): void => fail(abortError())

    socket.once('connect', onConnect)
    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('timeout', onTimeout)
    socket.setTimeout(REQUEST_TIMEOUT)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function connectTls(socket: net.Socket, host: string, signal: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      socket.destroy()
      reject(abortError())
      return
    }

    const startedAt = performance.now()
    const secureSocket = tls.connect({
      socket,
      servername: host,
      ALPNProtocols: ['http/1.1'],
      rejectUnauthorized: true
    })
    let settled = false

    const cleanup = (): void => {
      secureSocket.removeListener('secureConnect', onSecureConnect)
      secureSocket.removeListener('error', onError)
      secureSocket.removeListener('timeout', onTimeout)
      signal.removeEventListener('abort', onAbort)
      secureSocket.setTimeout(0)
    }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      secureSocket.destroy()
      reject(error)
    }
    const onSecureConnect = (): void => {
      settled = true
      cleanup()
      const duration = performance.now() - startedAt
      secureSocket.destroy()
      resolve(duration)
    }
    const onError = (error: Error): void => fail(error)
    const onTimeout = (): void => fail(new Error('TLS 握手超时'))
    const onAbort = (): void => fail(abortError())

    secureSocket.once('secureConnect', onSecureConnect)
    secureSocket.once('error', onError)
    secureSocket.once('timeout', onTimeout)
    secureSocket.setTimeout(REQUEST_TIMEOUT)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function runProbe(
  localPort: number,
  target: ProcessTestTargetRequest,
  signal: AbortSignal
): Promise<{ connectMs: number; tlsMs?: number; totalMs: number }> {
  const tunnel = await connectProxyTunnel(localPort, target, signal)
  if (target.port !== 443) {
    tunnel.socket.destroy()
    return { connectMs: tunnel.duration, totalMs: tunnel.duration }
  }

  const tlsMs = await connectTls(tunnel.socket, target.host, signal)
  return {
    connectMs: tunnel.duration,
    tlsMs,
    totalMs: tunnel.duration + tlsMs
  }
}

function aggregateResult(
  proxy: string,
  targets: ProcessTestTargetRequest[],
  rounds: number,
  successful: SuccessfulSample[],
  failed: FailedSample[]
): ProcessTestResult {
  const domains = targets.map((target): ProcessTestDomainResult => {
    const key = targetKey(target)
    const targetSuccessful = successful.filter((sample) => targetKey(sample) === key)
    const targetFailed = failed.filter((sample) => targetKey(sample) === key)
    const completed = targetSuccessful.length + targetFailed.length
    const roundResults: ProcessTestRoundResult[] = [
      ...targetSuccessful.map((sample) => ({
        round: sample.round,
        success: true,
        connectMs: roundMetric(sample.connectMs),
        tlsMs: sample.tlsMs === undefined ? undefined : roundMetric(sample.tlsMs),
        totalMs: roundMetric(sample.totalMs)
      })),
      ...targetFailed.map((sample) => ({
        round: sample.round,
        success: false,
        error: sample.error
      }))
    ].sort((left, right) => left.round - right.round)

    return {
      ...target,
      succeeded: targetSuccessful.length,
      failed: targetFailed.length,
      successRate: completed > 0 ? targetSuccessful.length / completed : 0,
      connectMs: targetSuccessful.length
        ? roundMetric(median(targetSuccessful.map((sample) => sample.connectMs)))
        : undefined,
      tlsMs: targetSuccessful.some((sample) => sample.tlsMs !== undefined)
        ? roundMetric(
            median(
              targetSuccessful
                .map((sample) => sample.tlsMs)
                .filter((value): value is number => value !== undefined)
            )
          )
        : undefined,
      totalMs: targetSuccessful.length
        ? roundMetric(median(targetSuccessful.map((sample) => sample.totalMs)))
        : undefined,
      roundResults
    }
  })
  const completedSamples = successful.length + failed.length
  const successRate = completedSamples > 0 ? successful.length / completedSamples : 0
  const totals = successful.map((sample) => sample.totalMs)
  const medianMs = totals.length ? roundMetric(median(totals)) : undefined
  const p95Ms = totals.length ? roundMetric(percentile(totals, 0.95)) : undefined
  const failedTargets = domains.filter((domain) => domain.failed > 0).length
  const score =
    medianMs === undefined || p95Ms === undefined
      ? undefined
      : roundMetric(medianMs + p95Ms * 0.25 + (1 - successRate) * 2000)

  return {
    proxy,
    targetCount: targets.length,
    completedSamples,
    totalSamples: targets.length * rounds,
    successRate,
    medianMs,
    p95Ms,
    failedTargets,
    score,
    domains,
    testedAt: Date.now()
  }
}

export function cancelMihomoProcessTest(): boolean {
  if (!activeProcessTest) return false
  activeProcessTest.cancelled = true
  activeProcessTest.controller.abort()
  return true
}

export async function mihomoProcessTest(
  proxies: string[],
  targets: ProcessTestTargetRequest[],
  rounds: number,
  concurrency: number,
  onProgress?: (progress: ProcessTestProgress) => void
): Promise<ProcessTestResult[]> {
  const uniqueProxies = [...new Set(proxies.map((proxy) => proxy.trim()).filter(Boolean))]
  if (uniqueProxies.length === 0) throw new Error('请至少选择一个节点')
  const uniqueTargets = [
    ...new Map(
      targets
        .filter(
          (target) =>
            target.host.trim() &&
            Number.isInteger(target.port) &&
            target.port > 0 &&
            target.port <= 65535
        )
        .map((target) => [targetKey(target), { host: target.host.trim(), port: target.port }])
    ).values()
  ]
  if (uniqueTargets.length === 0) throw new Error('请至少选择一个目标域名')

  const normalizedRounds = Math.min(5, Math.max(1, Math.trunc(rounds) || 3))
  const requestedConcurrency = Math.min(
    MAX_CODEX_TEST_CONCURRENCY,
    uniqueProxies.length,
    Math.max(1, Math.trunc(concurrency) || 6)
  )
  await ensureRuntimeTestChannelCapacity(requestedConcurrency)
  const channels = getRuntimeCodexTestChannels()
  if (channels.length === 0) throw new Error('进程测速通道不可用，请重启内核后重试')
  const normalizedConcurrency = Math.min(
    MAX_CODEX_TEST_CONCURRENCY,
    channels.length,
    uniqueProxies.length,
    requestedConcurrency
  )
  const releaseTestChannel = acquireNetworkTestChannel('process')
  const current: ActiveProcessTest = { controller: new AbortController(), cancelled: false }
  activeProcessTest = current
  const successful = new Map<string, SuccessfulSample[]>()
  const failed = new Map<string, FailedSample[]>()
  const total = uniqueProxies.length * uniqueTargets.length * normalizedRounds
  let completed = 0

  try {
    let nextProxyIndex = 0
    await Promise.all(
      channels.slice(0, normalizedConcurrency).map(async (channel) => {
        while (nextProxyIndex < uniqueProxies.length) {
          const proxy = uniqueProxies[nextProxyIndex++]
          if (current.cancelled || current.controller.signal.aborted) throw abortError()
          onProgress?.({
            proxy,
            rounds: normalizedRounds,
            stage: 'selecting',
            completed,
            total
          })
          try {
            await mihomoChangeProxy(channel.group, proxy)
          } catch (error) {
            if (current.cancelled || current.controller.signal.aborted) throw abortError()
            const selectionError = `测速通道无法选择该节点：${errorMessage(error)}`
            for (let round = 1; round <= normalizedRounds; round++) {
              for (const target of uniqueTargets) {
                const sample: FailedSample = { ...target, round, error: selectionError }
                appendSample(failed, proxy, sample)
                completed++
                onProgress?.({
                  proxy,
                  target: targetKey(target),
                  round,
                  rounds: normalizedRounds,
                  stage: 'completed',
                  completed,
                  total,
                  result: aggregateResult(
                    proxy,
                    uniqueTargets,
                    normalizedRounds,
                    successful.get(proxy) || [],
                    failed.get(proxy) || []
                  )
                })
              }
            }
            continue
          }

          for (let round = 1; round <= normalizedRounds; round++) {
            for (const target of uniqueTargets) {
              if (current.cancelled || current.controller.signal.aborted) throw abortError()
              onProgress?.({
                proxy,
                target: targetKey(target),
                round,
                rounds: normalizedRounds,
                stage: 'probing',
                completed,
                total
              })

              try {
                const probe = await runProbe(channel.port, target, current.controller.signal)
                const sample: SuccessfulSample = { ...target, round, ...probe }
                appendSample(successful, proxy, sample)
              } catch (error) {
                if (current.cancelled || current.controller.signal.aborted) throw abortError()
                const sample: FailedSample = { ...target, round, error: errorMessage(error) }
                appendSample(failed, proxy, sample)
              }

              completed++
              onProgress?.({
                proxy,
                target: targetKey(target),
                round,
                rounds: normalizedRounds,
                stage: 'completed',
                completed,
                total,
                result: aggregateResult(
                  proxy,
                  uniqueTargets,
                  normalizedRounds,
                  successful.get(proxy) || [],
                  failed.get(proxy) || []
                )
              })
            }
          }
        }
      })
    )

    return uniqueProxies.map((proxy) =>
      aggregateResult(
        proxy,
        uniqueTargets,
        normalizedRounds,
        successful.get(proxy) || [],
        failed.get(proxy) || []
      )
    )
  } finally {
    current.controller.abort()
    if (activeProcessTest === current) activeProcessTest = undefined
    releaseTestChannel()
  }
}
