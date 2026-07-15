import axios from 'axios'
import { performance } from 'node:perf_hooks'
import type { Readable } from 'node:stream'
import { getAppConfig } from '../config'
import { getRuntimeSpeedTestPort, SPEED_TEST_GROUP } from './factory'
import { mihomoChangeProxy } from './mihomoApi'

const CLOUDFLARE_URL = 'https://speed.cloudflare.com/__down?bytes={bytes}'
const TELEGRAM_URL = 'https://telegram.org/dl/desktop/win64'
const CLOUDFLARE_REQUEST_MAX_BYTES = 50_000_000

interface ActiveSpeedTest {
  controller: AbortController
  cancelled: boolean
}

let speedTestRunning = false
let activeSpeedTest: ActiveSpeedTest | undefined

export function cancelMihomoProxySpeedTest(): boolean {
  if (!activeSpeedTest) return false

  activeSpeedTest.cancelled = true
  activeSpeedTest.controller.abort()
  return true
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value!)))
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
    url.searchParams.set('_sparkle_speedtest', Date.now().toString())
  }
  return url.toString()
}

export async function mihomoProxySpeedTest(
  proxy: string,
  onProgress?: (progress: SpeedTestProgress) => void
): Promise<SpeedTestResult> {
  if (speedTestRunning) throw new Error('已有下载测速正在进行')
  speedTestRunning = true

  let stream: Readable | undefined
  let timer: NodeJS.Timeout | undefined
  const controller = new AbortController()
  const currentSpeedTest: ActiveSpeedTest = { controller, cancelled: false }
  activeSpeedTest = currentSpeedTest

  try {
    const {
      speedTestSource = 'cloudflare',
      speedTestUrl,
      speedTestDuration,
      speedTestMaxBytes,
      speedTestWarmupBytes
    } = await getAppConfig()

    const durationLimit = clamp(speedTestDuration, 8000, 1000, 30_000)
    const maxBytes = clamp(speedTestMaxBytes, 100_000_000, 2_000_000, 1_000_000_000)
    const warmupBytes = clamp(speedTestWarmupBytes, 1_000_000, 0, maxBytes - 1)
    const port = getRuntimeSpeedTestPort()

    try {
      await mihomoChangeProxy(SPEED_TEST_GROUP, proxy)
    } catch (error) {
      throw new Error(`测速通道不可用，请重启内核后重试：${String(error)}`)
    }

    let downloadedBytes = 0
    let measuredBytes = 0
    let measuredAt: number | undefined
    let lastProgressAt = 0
    let testedUrl = ''

    timer = setTimeout(() => controller.abort(), durationLimit)

    while (downloadedBytes < maxBytes && !controller.signal.aborted) {
      const remainingBytes = maxBytes - downloadedBytes
      const requestBytes =
        speedTestSource === 'cloudflare'
          ? Math.min(remainingBytes, CLOUDFLARE_REQUEST_MAX_BYTES)
          : remainingBytes
      const url = resolveSpeedTestUrl(speedTestSource, speedTestUrl, requestBytes)
      if (!testedUrl) testedUrl = url
      let requestDownloadedBytes = 0

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
            port
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
        for await (const chunk of stream) {
          const length = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk)
          requestDownloadedBytes += length
          downloadedBytes += length
          const now = performance.now()

          if (measuredAt === undefined) {
            if (downloadedBytes >= warmupBytes) measuredAt = now
          } else {
            measuredBytes += length
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

          if (downloadedBytes >= maxBytes) break
        }
      } catch (error) {
        if (!controller.signal.aborted) throw error
      } finally {
        stream?.destroy()
        stream = undefined
      }

      if (requestDownloadedBytes === 0) break
    }

    if (currentSpeedTest.cancelled) {
      throw new Error('测速已停止')
    }

    const finishedAt = performance.now()
    const measuredDuration = measuredAt === undefined ? 0 : finishedAt - measuredAt
    if (measuredBytes <= 0 || measuredDuration < 50) {
      throw new Error('测速数据不足，请更换下载地址或增大测速流量')
    }

    const bytesPerSecond = measuredBytes / (measuredDuration / 1000)
    return {
      proxy,
      source: speedTestSource,
      url: testedUrl,
      bytesPerSecond,
      bitsPerSecond: bytesPerSecond * 8,
      downloadedBytes,
      measuredBytes,
      duration: measuredDuration,
      testedAt: Date.now()
    }
  } finally {
    if (timer) clearTimeout(timer)
    controller.abort()
    stream?.destroy()
    if (activeSpeedTest === currentSpeedTest) activeSpeedTest = undefined
    speedTestRunning = false
  }
}
