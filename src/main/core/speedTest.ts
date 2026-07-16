import axios from 'axios'
import { performance } from 'node:perf_hooks'
import type { Readable } from 'node:stream'
import { getAppConfig } from '../config'
import {
  getRuntimeCodexTestChannels,
  getRuntimeSpeedTestPort,
  MAX_CODEX_TEST_CONCURRENCY,
  SPEED_TEST_GROUP
} from './factory'
import { mihomoChangeProxy } from './mihomoApi'
import { acquireNetworkTestChannel } from './networkTestChannel'
import { appendAppLog } from '../utils/log'

const CLOUDFLARE_URL = 'https://speed.cloudflare.com/__down?bytes={bytes}'
const TELEGRAM_URL = 'https://telegram.org/dl/desktop/win64'
const CLOUDFLARE_REQUEST_MAX_BYTES = 50_000_000
const CLOUDFLARE_REQUEST_SIZES = [CLOUDFLARE_REQUEST_MAX_BYTES, 25_000_000, 10_000_000] as const
const CLOUDFLARE_CONNECTION_TARGET_BYTES = 10_000_000
export const MAX_SPEED_TEST_CONNECTIONS = 16
export const MAX_GENERAL_TEST_NODE_CONCURRENCY = 16

interface ActiveSpeedTest {
  controllers: Set<AbortController>
  cancelled: boolean
}

interface ResolvedSpeedTestConfig {
  source: SpeedTestSource
  customUrl?: string
  durationLimit: number
  maxBytes: number
  warmupBytes: number
  connections: number
}

interface SpeedTestChannel {
  group: string
  port: number
}

let activeSpeedTest: ActiveSpeedTest | undefined

export function cancelMihomoProxySpeedTest(): boolean {
  if (!activeSpeedTest) return false

  activeSpeedTest.cancelled = true
  activeSpeedTest.controllers.forEach((controller) => controller.abort())
  return true
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value!)))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function safeTestUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname}`
  } catch {
    return '[invalid URL]'
  }
}

function errorDiagnostic(error: unknown): Record<string, unknown> {
  const diagnostic: Record<string, unknown> = {
    name: error instanceof Error ? error.name : typeof error,
    message: errorMessage(error)
  }

  if (axios.isAxiosError(error)) {
    diagnostic.code = error.code
    diagnostic.status = error.response?.status
    diagnostic.statusText = error.response?.statusText
    diagnostic.requestUrl = safeTestUrl(error.config?.url)
    diagnostic.cause = error.cause instanceof Error ? error.cause.message : undefined
  }

  return diagnostic
}

async function logSpeedTest(event: string, fields: Record<string, unknown> = {}): Promise<void> {
  const content = JSON.stringify({ time: new Date().toISOString(), event, ...fields })
  await appendAppLog(`[SpeedTest] ${content}\n`).catch(() => {})
}

function stopError(): Error {
  return new Error('测速已停止')
}

async function resolveConfig(): Promise<ResolvedSpeedTestConfig> {
  const {
    speedTestSource = 'cloudflare',
    speedTestUrl,
    speedTestDuration,
    speedTestMaxBytes,
    speedTestWarmupBytes,
    speedTestConnections
  } = await getAppConfig()
  const maxBytes = clamp(speedTestMaxBytes, 100_000_000, 2_000_000, 1_000_000_000)
  const configuredConnections = clamp(speedTestConnections, 4, 1, MAX_SPEED_TEST_CONNECTIONS)
  const connections =
    speedTestSource === 'cloudflare'
      ? Math.min(
          configuredConnections,
          Math.max(1, Math.ceil(maxBytes / CLOUDFLARE_CONNECTION_TARGET_BYTES))
        )
      : configuredConnections
  return {
    source: speedTestSource,
    customUrl: speedTestUrl,
    durationLimit: clamp(speedTestDuration, 8000, 1000, 30_000),
    maxBytes,
    warmupBytes: clamp(speedTestWarmupBytes, 1_000_000, 0, maxBytes - 1),
    connections
  }
}

function resolveSpeedTestUrl(
  source: SpeedTestSource,
  customUrl: string | undefined,
  maxBytes: number
): string {
  const template =
    source === 'telegram' ? TELEGRAM_URL : source === 'custom' ? customUrl?.trim() : CLOUDFLARE_URL

  if (!template) throw new Error('请先设置自定义测速地址')
  const url = new URL(template.replaceAll('{bytes}', maxBytes.toString()))
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('测速地址仅支持 HTTP 或 HTTPS')
  }
  if (source !== 'custom') {
    url.searchParams.set(
      '_sparkle_speedtest',
      `${Date.now()}-${Math.random().toString(36).slice(2)}`
    )
  }
  return url.toString()
}

function resolveCloudflareRequestBytes(remainingBytes: number, perConnectionBytes: number): number {
  const desiredBytes = Math.min(remainingBytes, perConnectionBytes, CLOUDFLARE_REQUEST_MAX_BYTES)
  return CLOUDFLARE_REQUEST_SIZES.find((bytes) => bytes <= desiredBytes) ?? desiredBytes
}

async function runSpeedTestOnChannel(
  proxy: string,
  channel: SpeedTestChannel,
  config: ResolvedSpeedTestConfig,
  current: ActiveSpeedTest,
  onProgress?: (progress: SpeedTestProgress) => void,
  round?: number
): Promise<SpeedTestResult> {
  if (current.cancelled) throw stopError()

  try {
    await mihomoChangeProxy(channel.group, proxy)
  } catch (error) {
    throw new Error(`测速通道不可用，请重启内核后重试：${errorMessage(error)}`)
  }
  if (current.cancelled) throw stopError()

  const controller = new AbortController()
  const streams = new Set<Readable>()
  current.controllers.add(controller)
  if (current.cancelled) controller.abort()

  let timer: NodeJS.Timeout | undefined
  let downloadedBytes = 0
  let measuredBytes = 0
  let measuredAt: number | undefined
  let lastProgressAt = 0
  let testedUrl = ''
  let firstError: unknown
  let inFlightReservedBytes = 0
  const perConnectionRequestBytes = Math.max(1, Math.ceil(config.maxBytes / config.connections))

  const runWorker = async (): Promise<void> => {
    while (downloadedBytes < config.maxBytes && !controller.signal.aborted) {
      const remainingBytes = config.maxBytes - downloadedBytes - inFlightReservedBytes
      if (remainingBytes <= 0) break
      const requestBytes =
        config.source === 'cloudflare'
          ? resolveCloudflareRequestBytes(remainingBytes, perConnectionRequestBytes)
          : Math.min(remainingBytes, perConnectionRequestBytes)
      inFlightReservedBytes += requestBytes
      const url = resolveSpeedTestUrl(config.source, config.customUrl, requestBytes)
      if (!testedUrl) testedUrl = url
      let requestDownloadedBytes = 0
      let stream: Readable | undefined

      try {
        const response = await axios.get<Readable>(url, {
          responseType: 'stream',
          signal: controller.signal,
          timeout: 15_000,
          maxRedirects: 8,
          decompress: false,
          proxy: {
            protocol: 'http',
            host: '127.0.0.1',
            port: channel.port
          },
          headers: {
            Accept: '*/*',
            'Accept-Encoding': 'identity',
            'Cache-Control': 'no-cache',
            Connection: 'close'
          },
          validateStatus: (status) => status >= 200 && status < 300
        })

        stream = response.data
        streams.add(stream)
        for await (const chunk of stream) {
          const chunkLength = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk)
          const acceptedLength = Math.min(
            chunkLength,
            requestBytes - requestDownloadedBytes,
            config.maxBytes - downloadedBytes
          )
          if (acceptedLength <= 0) break

          requestDownloadedBytes += acceptedLength
          inFlightReservedBytes -= acceptedLength
          downloadedBytes += acceptedLength
          const now = performance.now()

          if (measuredAt === undefined) {
            if (downloadedBytes >= config.warmupBytes) measuredAt = now
          } else {
            measuredBytes += acceptedLength
            const elapsed = now - measuredAt
            if (elapsed > 0 && now - lastProgressAt >= 250) {
              lastProgressAt = now
              onProgress?.({
                proxy,
                bytesPerSecond: measuredBytes / (elapsed / 1000),
                downloadedBytes,
                duration: elapsed
              })
            }
          }

          if (downloadedBytes >= config.maxBytes || requestDownloadedBytes >= requestBytes) {
            break
          }
        }
      } catch (error) {
        if (!controller.signal.aborted && firstError === undefined) firstError = error
        break
      } finally {
        inFlightReservedBytes -= requestBytes - requestDownloadedBytes
        if (stream) streams.delete(stream)
        stream?.destroy()
      }

      if (requestDownloadedBytes === 0) break
    }
  }

  try {
    timer = setTimeout(() => controller.abort(), config.durationLimit)
    await Promise.all(Array.from({ length: config.connections }, () => runWorker()))

    if (current.cancelled) throw stopError()

    const finishedAt = performance.now()
    const measuredDuration = measuredAt === undefined ? 0 : finishedAt - measuredAt
    if (measuredBytes <= 0 || measuredDuration < 50) {
      if (firstError) throw firstError
      throw new Error('测速数据不足，请更换下载地址或增大测速流量')
    }

    const bytesPerSecond = measuredBytes / (measuredDuration / 1000)
    return {
      proxy,
      source: config.source,
      url: testedUrl,
      bytesPerSecond,
      bitsPerSecond: bytesPerSecond * 8,
      downloadedBytes,
      measuredBytes,
      duration: measuredDuration,
      testedAt: Date.now()
    }
  } catch (error) {
    await logSpeedTest('node-failed', {
      proxy,
      round,
      channel: channel.group,
      port: channel.port,
      source: config.source,
      url: safeTestUrl(testedUrl || config.customUrl),
      durationLimit: config.durationLimit,
      maxBytes: config.maxBytes,
      warmupBytes: config.warmupBytes,
      connections: config.connections,
      downloadedBytes,
      measuredBytes,
      ...errorDiagnostic(error)
    })
    throw error
  } finally {
    if (timer) clearTimeout(timer)
    controller.abort()
    streams.forEach((stream) => stream.destroy())
    current.controllers.delete(controller)
  }
}

export async function mihomoProxySpeedTest(
  proxy: string,
  onProgress?: (progress: SpeedTestProgress) => void
): Promise<SpeedTestResult> {
  const releaseTestChannel = acquireNetworkTestChannel('download')
  const current: ActiveSpeedTest = { controllers: new Set(), cancelled: false }
  activeSpeedTest = current

  try {
    const config = await resolveConfig()
    await logSpeedTest('single-started', {
      proxy,
      source: config.source,
      url: safeTestUrl(config.customUrl),
      durationLimit: config.durationLimit,
      maxBytes: config.maxBytes,
      warmupBytes: config.warmupBytes,
      connections: config.connections
    })
    return await runSpeedTestOnChannel(
      proxy,
      { group: SPEED_TEST_GROUP, port: getRuntimeSpeedTestPort() },
      config,
      current,
      onProgress
    )
  } finally {
    current.controllers.forEach((controller) => controller.abort())
    if (activeSpeedTest === current) activeSpeedTest = undefined
    releaseTestChannel()
  }
}

export async function mihomoGeneralSpeedTest(
  proxies: string[],
  rounds: number,
  nodeConcurrency: number,
  onProgress?: (progress: GeneralSpeedTestProgress) => void
): Promise<GeneralSpeedTestRoundResult[]> {
  const uniqueProxies = [...new Set(proxies.map((proxy) => proxy.trim()).filter(Boolean))]
  if (uniqueProxies.length === 0) throw new Error('请至少选择一个节点')
  const normalizedRounds = clamp(rounds, 3, 1, 20)
  const channels = getRuntimeCodexTestChannels()
  if (channels.length === 0) throw new Error('普通测速通道不可用，请重启内核后重试')
  const normalizedConcurrency = Math.min(
    MAX_GENERAL_TEST_NODE_CONCURRENCY,
    MAX_CODEX_TEST_CONCURRENCY,
    channels.length,
    uniqueProxies.length,
    clamp(nodeConcurrency, 1, 1, MAX_GENERAL_TEST_NODE_CONCURRENCY)
  )
  const releaseTestChannel = acquireNetworkTestChannel('download')
  const current: ActiveSpeedTest = { controllers: new Set(), cancelled: false }
  activeSpeedTest = current
  const results: GeneralSpeedTestRoundResult[] = []
  const total = uniqueProxies.length * normalizedRounds
  let completed = 0

  try {
    const config = await resolveConfig()
    await logSpeedTest('general-started', {
      nodes: uniqueProxies.length,
      rounds: normalizedRounds,
      concurrency: normalizedConcurrency,
      source: config.source,
      url: safeTestUrl(config.customUrl),
      durationLimit: config.durationLimit,
      maxBytes: config.maxBytes,
      warmupBytes: config.warmupBytes,
      connections: config.connections
    })
    const runSample = async (
      proxy: string,
      round: number,
      channel: SpeedTestChannel
    ): Promise<void> => {
      if (current.cancelled) throw stopError()
      onProgress?.({
        proxy,
        round,
        rounds: normalizedRounds,
        stage: 'selecting',
        completed,
        total
      })

      let sample: GeneralSpeedTestRoundResult
      try {
        const result = await runSpeedTestOnChannel(
          proxy,
          channel,
          config,
          current,
          (progress) => {
            onProgress?.({
              ...progress,
              round,
              rounds: normalizedRounds,
              stage: 'downloading',
              completed,
              total
            })
          },
          round
        )
        sample = { proxy, round, result }
      } catch (error) {
        if (current.cancelled) throw stopError()
        sample = { proxy, round, error: errorMessage(error) }
      }

      results.push(sample)
      completed++
      onProgress?.({
        proxy,
        round,
        rounds: normalizedRounds,
        stage: 'completed',
        completed,
        total,
        result: sample.result,
        error: sample.error
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

    await logSpeedTest('general-completed', {
      total,
      succeeded: results.filter((item) => item.result).length,
      failed: results.filter((item) => item.error).length
    })
    return results.sort((left, right) => left.round - right.round)
  } catch (error) {
    await logSpeedTest('general-failed', {
      completed,
      total,
      ...errorDiagnostic(error)
    })
    throw error
  } finally {
    current.controllers.forEach((controller) => controller.abort())
    if (activeSpeedTest === current) activeSpeedTest = undefined
    releaseTestChannel()
  }
}
