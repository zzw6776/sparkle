import { randomBytes } from 'node:crypto'
import net from 'node:net'
import { performance } from 'node:perf_hooks'
import tls from 'node:tls'
import { getRuntimeCodexTestChannels, MAX_CODEX_TEST_CONCURRENCY } from './factory'
import { mihomoChangeProxy } from './mihomoApi'
import { acquireNetworkTestChannel } from './networkTestChannel'

const TARGET_HOST = 'chatgpt.com'
const TARGET_PORT = 443
const REQUEST_TIMEOUT = 10_000
const MAX_HEADER_BYTES = 32 * 1024

interface ActiveCodexTest {
  controller: AbortController
  cancelled: boolean
}

interface TunnelResult {
  socket: net.Socket
  duration: number
}

interface TlsResult {
  socket: tls.TLSSocket
  duration: number
}

interface HeaderResult {
  duration: number
  status: number
}

interface ProbeResult {
  tunnelMs: number
  tlsMs: number
  responseMs: number
  status: number
  totalMs: number
}

interface SuccessfulSample {
  proxy: string
  round: number
  https: ProbeResult
  websocket: ProbeResult
}

interface FailedSample {
  proxy: string
  round: number
  error: string
}

let activeCodexTest: ActiveCodexTest | undefined

function abortError(): Error {
  return new Error('Codex 测试已停止')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

function standardDeviation(values: number[]): number {
  if (values.length <= 1) return 0
  const average = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance =
    values.reduce((sum, value) => sum + Math.pow(value - average, 2), 0) / values.length
  return Math.sqrt(variance)
}

function roundMetric(value: number): number {
  return Math.round(value * 10) / 10
}

function connectProxyTunnel(port: number, signal: AbortSignal): Promise<TunnelResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError())
      return
    }

    const startedAt = performance.now()
    const socket = net.createConnection({ host: '127.0.0.1', port })
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
        `CONNECT ${TARGET_HOST}:${TARGET_PORT} HTTP/1.1\r\n` +
          `Host: ${TARGET_HOST}:${TARGET_PORT}\r\n` +
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
    const onTimeout = (): void => fail(new Error('连接 chatgpt.com 超时'))
    const onAbort = (): void => fail(abortError())

    socket.once('connect', onConnect)
    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('timeout', onTimeout)
    socket.setTimeout(REQUEST_TIMEOUT)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function connectTls(socket: net.Socket, signal: AbortSignal): Promise<TlsResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      socket.destroy()
      reject(abortError())
      return
    }

    const startedAt = performance.now()
    const secureSocket = tls.connect({
      socket,
      servername: TARGET_HOST,
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
      resolve({ socket: secureSocket, duration: performance.now() - startedAt })
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

function requestHeaders(
  socket: tls.TLSSocket,
  request: string,
  signal: AbortSignal
): Promise<HeaderResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      socket.destroy()
      reject(abortError())
      return
    }

    const startedAt = performance.now()
    let firstByteAt: number | undefined
    let buffer = Buffer.alloc(0)
    let settled = false

    const cleanup = (): void => {
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      socket.removeListener('timeout', onTimeout)
      socket.removeListener('end', onEnd)
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
    const onData = (chunk: Buffer): void => {
      if (firstByteAt === undefined) firstByteAt = performance.now()
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > MAX_HEADER_BYTES) {
        fail(new Error('chatgpt.com 响应头过大'))
        return
      }
      const headerEnd = buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) return

      const header = buffer.subarray(0, headerEnd).toString('latin1')
      const status = Number.parseInt(header.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/i)?.[1] || '', 10)
      if (!Number.isFinite(status)) {
        fail(new Error('chatgpt.com 返回了无法识别的响应'))
        return
      }

      settled = true
      cleanup()
      socket.destroy()
      resolve({ duration: (firstByteAt ?? performance.now()) - startedAt, status })
    }
    const onError = (error: Error): void => fail(error)
    const onTimeout = (): void => fail(new Error('等待 chatgpt.com 响应超时'))
    const onEnd = (): void => fail(new Error('chatgpt.com 未返回完整响应头'))
    const onAbort = (): void => fail(abortError())

    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('timeout', onTimeout)
    socket.once('end', onEnd)
    socket.setTimeout(REQUEST_TIMEOUT)
    signal.addEventListener('abort', onAbort, { once: true })
    socket.write(request)
  })
}

async function runProbe(port: number, signal: AbortSignal, request: string): Promise<ProbeResult> {
  const tunnel = await connectProxyTunnel(port, signal)
  const secure = await connectTls(tunnel.socket, signal)
  const response = await requestHeaders(secure.socket, request, signal)
  return {
    tunnelMs: tunnel.duration,
    tlsMs: secure.duration,
    responseMs: response.duration,
    status: response.status,
    totalMs: tunnel.duration + secure.duration + response.duration
  }
}

function httpsRequest(): string {
  return (
    `GET / HTTP/1.1\r\nHost: ${TARGET_HOST}\r\n` +
    'User-Agent: Sparkle-Codex-Test/1.0\r\n' +
    'Accept: text/html,application/xhtml+xml\r\n' +
    'Accept-Encoding: identity\r\n' +
    'Cache-Control: no-cache\r\nConnection: close\r\n\r\n'
  )
}

function websocketRequest(): string {
  return (
    `GET / HTTP/1.1\r\nHost: ${TARGET_HOST}\r\n` +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n` +
    'Sec-WebSocket-Version: 13\r\n' +
    `Origin: https://${TARGET_HOST}\r\n` +
    'User-Agent: Sparkle-Codex-Test/1.0\r\n\r\n'
  )
}

function aggregateResult(
  proxy: string,
  rounds: number,
  successful: SuccessfulSample[],
  failed: FailedSample[]
): CodexTestResult {
  const completedRounds = successful.length + failed.length
  const successRate = completedRounds > 0 ? successful.length / completedRounds : 0
  const httpsTotals = successful.map((sample) => sample.https.totalMs)
  const websocketTotals = successful.map((sample) => sample.websocket.totalMs)
  const combinedTotals = successful.map(
    (sample) => sample.https.totalMs * 0.45 + sample.websocket.totalMs * 0.55
  )
  const score =
    successful.length > 0
      ? median(combinedTotals) + standardDeviation(combinedTotals) + (1 - successRate) * 2000
      : undefined
  const last = successful.at(-1)
  const roundResults: CodexTestRoundResult[] = [
    ...successful.map((sample) => ({
      round: sample.round,
      success: true,
      combinedMs: roundMetric(sample.https.totalMs * 0.45 + sample.websocket.totalMs * 0.55),
      tunnelMs: roundMetric(sample.https.tunnelMs),
      tlsMs: roundMetric(sample.https.tlsMs),
      httpsTtfbMs: roundMetric(sample.https.responseMs),
      websocketMs: roundMetric(sample.websocket.responseMs),
      httpsStatus: sample.https.status,
      websocketStatus: sample.websocket.status
    })),
    ...failed.map((sample) => ({
      round: sample.round,
      success: false,
      error: sample.error
    }))
  ].sort((left, right) => left.round - right.round)

  return {
    proxy,
    rounds,
    completedRounds,
    succeeded: successful.length,
    failed: failed.length,
    successRate,
    tunnelMs: successful.length
      ? roundMetric(median(successful.map((sample) => sample.https.tunnelMs)))
      : undefined,
    tlsMs: successful.length
      ? roundMetric(median(successful.map((sample) => sample.https.tlsMs)))
      : undefined,
    httpsTtfbMs: successful.length
      ? roundMetric(median(successful.map((sample) => sample.https.responseMs)))
      : undefined,
    websocketMs: successful.length
      ? roundMetric(median(successful.map((sample) => sample.websocket.responseMs)))
      : undefined,
    totalMs: successful.length
      ? roundMetric(median(httpsTotals) * 0.45 + median(websocketTotals) * 0.55)
      : undefined,
    jitterMs: successful.length ? roundMetric(standardDeviation(combinedTotals)) : undefined,
    score: score === undefined ? undefined : roundMetric(score),
    httpsStatus: last?.https.status,
    websocketStatus: last?.websocket.status,
    error: failed.at(-1)?.error,
    roundResults,
    testedAt: Date.now()
  }
}

export function cancelMihomoCodexTest(): boolean {
  if (!activeCodexTest) return false
  activeCodexTest.cancelled = true
  activeCodexTest.controller.abort()
  return true
}

export async function mihomoCodexTest(
  proxies: string[],
  rounds: number,
  concurrency: number,
  onProgress?: (progress: CodexTestProgress) => void
): Promise<CodexTestResult[]> {
  const uniqueProxies = [...new Set(proxies.map((proxy) => proxy.trim()).filter(Boolean))]
  if (uniqueProxies.length === 0) throw new Error('请至少选择一个节点')
  const normalizedRounds = Math.min(5, Math.max(1, Math.trunc(rounds) || 3))
  const channels = getRuntimeCodexTestChannels()
  if (channels.length === 0) throw new Error('Codex 测试通道不可用，请重启内核后重试')
  const normalizedConcurrency = Math.min(
    MAX_CODEX_TEST_CONCURRENCY,
    channels.length,
    uniqueProxies.length,
    Math.max(1, Math.trunc(concurrency) || 6)
  )
  const releaseTestChannel = acquireNetworkTestChannel('codex')
  const current: ActiveCodexTest = { controller: new AbortController(), cancelled: false }
  activeCodexTest = current
  const successful = new Map<string, SuccessfulSample[]>()
  const failed = new Map<string, FailedSample[]>()
  const total = uniqueProxies.length * normalizedRounds
  let completed = 0

  try {
    const runSample = async (
      proxy: string,
      round: number,
      channel: { group: string; port: number }
    ): Promise<void> => {
      if (current.cancelled || current.controller.signal.aborted) throw abortError()
      onProgress?.({
        proxy,
        round,
        rounds: normalizedRounds,
        stage: 'selecting',
        completed,
        total
      })

      try {
        await mihomoChangeProxy(channel.group, proxy)
        onProgress?.({
          proxy,
          round,
          rounds: normalizedRounds,
          stage: 'probing',
          completed,
          total
        })
        const [httpsResult, websocketResult] = await Promise.allSettled([
          runProbe(channel.port, current.controller.signal, httpsRequest()),
          runProbe(channel.port, current.controller.signal, websocketRequest())
        ])
        if (httpsResult.status === 'rejected') throw httpsResult.reason
        if (websocketResult.status === 'rejected') throw websocketResult.reason

        const sample: SuccessfulSample = {
          proxy,
          round,
          https: httpsResult.value,
          websocket: websocketResult.value
        }
        successful.set(proxy, [...(successful.get(proxy) || []), sample])
      } catch (error) {
        if (current.cancelled || current.controller.signal.aborted) throw abortError()
        const sample: FailedSample = { proxy, round, error: errorMessage(error) }
        failed.set(proxy, [...(failed.get(proxy) || []), sample])
      }

      completed++
      const result = aggregateResult(
        proxy,
        normalizedRounds,
        successful.get(proxy) || [],
        failed.get(proxy) || []
      )
      onProgress?.({
        proxy,
        round,
        rounds: normalizedRounds,
        stage: 'completed',
        completed,
        total,
        result
      })
    }

    for (let round = 1; round <= normalizedRounds; round++) {
      let nextProxyIndex = 0
      await Promise.all(
        channels.slice(0, normalizedConcurrency).map(async (channel) => {
          while (nextProxyIndex < uniqueProxies.length) {
            const proxyIndex = nextProxyIndex++
            await runSample(uniqueProxies[proxyIndex], round, channel)
          }
        })
      )
    }

    return uniqueProxies.map((proxy) =>
      aggregateResult(proxy, normalizedRounds, successful.get(proxy) || [], failed.get(proxy) || [])
    )
  } finally {
    current.controller.abort()
    if (activeCodexTest === current) activeCodexTest = undefined
    releaseTestChannel()
  }
}
