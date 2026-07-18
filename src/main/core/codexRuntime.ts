import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform, type TransformCallback } from 'node:stream'
import axios from 'axios'
import { extract } from 'tar'
import { getControledMihomoConfig } from '../config'
import { codexRuntimeDir } from '../utils/dirs'
import { appendAppLog } from '../utils/log'

const CODEX_RUNTIME_VERSION = '0.144.5'
const PROGRESS_INTERVAL = 100
const PROBE_TIMEOUT = 10_000

type CodexRuntimeTarget = 'win32-x64' | 'win32-arm64' | 'darwin-x64' | 'darwin-arm64'
type CodexRuntimeKey = `${NodeJS.Platform}-${NodeJS.Architecture}`

interface CodexRuntimeSpec {
  target: CodexRuntimeTarget
  targetTriple:
    | 'x86_64-pc-windows-msvc'
    | 'aarch64-pc-windows-msvc'
    | 'x86_64-apple-darwin'
    | 'aarch64-apple-darwin'
  binaryName: 'codex.exe' | 'codex'
  url: string
  integrity: string
  archiveBytes?: number
}

const CODEX_RUNTIME_SPECS: Partial<Record<CodexRuntimeKey, CodexRuntimeSpec>> = {
  'win32-x64': {
    target: 'win32-x64',
    targetTriple: 'x86_64-pc-windows-msvc',
    binaryName: 'codex.exe',
    url: `https://registry.npmjs.org/@openai/codex/-/codex-${CODEX_RUNTIME_VERSION}-win32-x64.tgz`,
    integrity:
      'sha512-DnsSTlnnzleTxvLwIGnBitKInscxn2I7qASqosS8Fv+qysBygd+ZiBn/SQsRCgQ28PAlsNzmd3Gf3ZTecolAmg==',
    archiveBytes: 145_121_219
  },
  'win32-arm64': {
    target: 'win32-arm64',
    targetTriple: 'aarch64-pc-windows-msvc',
    binaryName: 'codex.exe',
    url: `https://registry.npmjs.org/@openai/codex/-/codex-${CODEX_RUNTIME_VERSION}-win32-arm64.tgz`,
    integrity:
      'sha512-0Pj7iqjEOEvPQPO3kFfCy9vGX4BTu76ChFFZHr2eNNIfVc3FOENAv/X98u4L+iIUtDOK9DbqmfUudW3DPapshg=='
  },
  'darwin-x64': {
    target: 'darwin-x64',
    targetTriple: 'x86_64-apple-darwin',
    binaryName: 'codex',
    url: `https://registry.npmjs.org/@openai/codex/-/codex-${CODEX_RUNTIME_VERSION}-darwin-x64.tgz`,
    integrity:
      'sha512-//Mo0m1MwaoT6psu5xsmofXpKx4/0irIkeq10xJvk59+886EG355ibjA+ZmlRcKhE3bLjsKD7p81nTbAdRL/bw==',
    archiveBytes: 128_766_507
  },
  'darwin-arm64': {
    target: 'darwin-arm64',
    targetTriple: 'aarch64-apple-darwin',
    binaryName: 'codex',
    url: `https://registry.npmjs.org/@openai/codex/-/codex-${CODEX_RUNTIME_VERSION}-darwin-arm64.tgz`,
    integrity:
      'sha512-zcT6NfBCqLFt+BReNSETTZW6v6PdbH0dzNtm9j7l7mDGqwPbKZDGJdnpkBao2389I0ZacyIKgSZoI0vez1d4Dw==',
    archiveBytes: 120_296_947
  }
}

interface ActiveRuntimeInstall {
  controller: AbortController
  promise: Promise<CodexRuntimeStatus>
}

let activeInstall: ActiveRuntimeInstall | undefined
let activeStatus: CodexRuntimeStatus | undefined

function runtimeErrorText(error: unknown): string {
  return error instanceof Error ? error.stack || error.message : String(error)
}

async function logRuntime(message: string): Promise<void> {
  await appendAppLog(`[CodexRuntime] ${message}\n`).catch(() => {})
}

function configuredBinary(): string | undefined {
  const value = process.env.SPARKLE_CODEX_BINARY?.trim()
  if (!value) return undefined
  return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value
}

function runtimeSpec(): CodexRuntimeSpec | undefined {
  const key = `${process.platform}-${process.arch}` as CodexRuntimeKey
  return CODEX_RUNTIME_SPECS[key]
}

function runtimeTargetDir(spec: CodexRuntimeSpec): string {
  return path.join(codexRuntimeDir(), CODEX_RUNTIME_VERSION, spec.target)
}

export function managedCodexBinaryPath(): string | undefined {
  const spec = runtimeSpec()
  return spec ? path.join(runtimeTargetDir(spec), spec.binaryName) : undefined
}

function baseStatus(spec?: CodexRuntimeSpec): CodexRuntimeStatus {
  return {
    state: spec ? 'missing' : 'unsupported',
    source: 'system',
    supported: Boolean(spec),
    version: CODEX_RUNTIME_VERSION,
    target: spec?.target,
    archiveBytes: spec?.archiveBytes
  }
}

async function installedRuntimeStatus(spec: CodexRuntimeSpec): Promise<CodexRuntimeStatus> {
  const binary = managedCodexBinaryPath()!
  if (!existsSync(binary)) return baseStatus(spec)
  try {
    await probeRuntime(binary)
  } catch (error) {
    return {
      ...baseStatus(spec),
      state: 'error',
      source: 'managed',
      binary,
      error: `托管运行时损坏：${error instanceof Error ? error.message : String(error)}`
    }
  }
  let installedAt: number | undefined
  try {
    const metadata = JSON.parse(
      await readFile(path.join(runtimeTargetDir(spec), 'runtime.json'), 'utf8')
    ) as { installedAt?: number }
    installedAt = metadata.installedAt
  } catch {
    // Older or manually repaired managed runtimes may not have metadata.
  }
  return {
    ...baseStatus(spec),
    state: 'ready',
    source: 'managed',
    binary,
    installedAt
  }
}

export async function getCodexRuntimeStatus(): Promise<CodexRuntimeStatus> {
  if (activeStatus && activeInstall) return activeStatus
  const spec = runtimeSpec()
  const override = configuredBinary()
  if (override) {
    return {
      ...baseStatus(spec),
      state: existsSync(override) ? 'ready' : 'error',
      source: 'custom',
      binary: override,
      error: existsSync(override) ? undefined : 'SPARKLE_CODEX_BINARY 指定的文件不存在'
    }
  }
  return spec ? installedRuntimeStatus(spec) : baseStatus()
}

function emitStatus(
  status: CodexRuntimeStatus,
  onProgress?: (status: CodexRuntimeStatus) => void
): void {
  activeStatus = status
  onProgress?.(status)
}

async function probeRuntime(binary: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = ''
    let settled = false
    const child = spawn(binary, ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(new Error('Codex Runtime 启动检查超时'))
    }, PROBE_TIMEOUT)
    child.stdout.on('data', (chunk: Buffer | string) => {
      output += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer | string) => {
      output += chunk.toString()
    })
    child.once('error', (error) => finish(error))
    child.once('exit', (code) => {
      const versionMatches = output.includes(`codex-cli ${CODEX_RUNTIME_VERSION}`)
      finish(
        code === 0 && versionMatches
          ? undefined
          : new Error(`Codex Runtime 版本检查失败：${output.trim() || `退出码 ${code}`}`)
      )
    })
  })
}

async function runtimeDownloadProxy(): Promise<
  { proxy: { protocol: 'http'; host: string; port: number } } | Record<string, never>
> {
  const config = await getControledMihomoConfig().catch(() => undefined)
  const port = config?.['mixed-port']
  return typeof port === 'number' && port > 0
    ? { proxy: { protocol: 'http', host: '127.0.0.1', port } }
    : {}
}

async function downloadRuntimeArchive(
  spec: CodexRuntimeSpec,
  archivePath: string,
  signal: AbortSignal,
  onProgress?: (status: CodexRuntimeStatus) => void
): Promise<void> {
  const response = await axios.get<NodeJS.ReadableStream>(spec.url, {
    responseType: 'stream',
    signal,
    timeout: 60_000,
    maxRedirects: 5,
    ...(await runtimeDownloadProxy())
  })
  const headerLength = Number(response.headers['content-length'])
  const totalBytes =
    Number.isFinite(headerLength) && headerLength > 0 ? headerLength : spec.archiveBytes
  const hash = createHash('sha512')
  const startedAt = Date.now()
  let downloadedBytes = 0
  let lastProgressAt = 0
  const meter = new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
      downloadedBytes += chunk.length
      hash.update(chunk)
      const now = Date.now()
      if (now - lastProgressAt >= PROGRESS_INTERVAL) {
        lastProgressAt = now
        emitStatus(
          {
            ...baseStatus(spec),
            state: 'downloading',
            source: 'managed',
            downloadedBytes,
            totalBytes,
            bytesPerSecond: downloadedBytes / Math.max(0.001, (now - startedAt) / 1000)
          },
          onProgress
        )
      }
      callback(null, chunk)
    }
  })
  await pipeline(response.data, meter, createWriteStream(archivePath, { flags: 'wx' }))
  const expected = spec.integrity.replace(/^sha512-/, '')
  const actual = hash.digest('base64')
  if (actual !== expected) throw new Error('Codex Runtime SHA-512 校验失败')
  await logRuntime(`download verified target=${spec.target} bytes=${downloadedBytes}`)
}

async function performInstall(
  spec: CodexRuntimeSpec,
  controller: AbortController,
  onProgress?: (status: CodexRuntimeStatus) => void
): Promise<CodexRuntimeStatus> {
  const runtimeRoot = codexRuntimeDir()
  const stagingRoot = path.join(
    runtimeRoot,
    `.install-${process.pid}-${randomBytes(6).toString('hex')}`
  )
  const archivePath = path.join(stagingRoot, 'codex.tgz')
  const extractedDir = path.join(stagingRoot, 'extracted')
  const stagedTargetDir = path.join(stagingRoot, spec.target)
  try {
    await logRuntime(
      `install started version=${CODEX_RUNTIME_VERSION} target=${spec.target} source=${spec.url}`
    )
    await mkdir(extractedDir, { recursive: true })
    emitStatus({ ...baseStatus(spec), state: 'downloading', source: 'managed' }, onProgress)
    await downloadRuntimeArchive(spec, archivePath, controller.signal, onProgress)
    if (controller.signal.aborted) throw new Error('Codex Runtime 安装已取消')

    emitStatus({ ...baseStatus(spec), state: 'verifying', source: 'managed' }, onProgress)
    await logRuntime(`extracting archive target=${spec.target}`)
    await extract({ file: archivePath, cwd: extractedDir, strict: true })
    const extractedBinary = path.join(
      extractedDir,
      'package',
      'vendor',
      spec.targetTriple,
      'bin',
      spec.binaryName
    )
    if (!existsSync(extractedBinary)) {
      throw new Error(`Codex Runtime 压缩包中缺少 ${spec.binaryName}`)
    }
    await probeRuntime(extractedBinary)
    await logRuntime(`binary probe passed version=${CODEX_RUNTIME_VERSION} target=${spec.target}`)
    if (controller.signal.aborted) throw new Error('Codex Runtime 安装已取消')

    emitStatus({ ...baseStatus(spec), state: 'installing', source: 'managed' }, onProgress)
    await mkdir(stagedTargetDir, { recursive: true })
    const stagedBinary = path.join(stagedTargetDir, spec.binaryName)
    await rename(extractedBinary, stagedBinary)
    if (process.platform !== 'win32') await chmod(stagedBinary, 0o755)
    const installedAt = Date.now()
    await writeFile(
      path.join(stagedTargetDir, 'runtime.json'),
      JSON.stringify(
        {
          version: CODEX_RUNTIME_VERSION,
          target: spec.target,
          integrity: spec.integrity,
          source: spec.url,
          installedAt
        },
        null,
        2
      )
    )
    const targetDir = runtimeTargetDir(spec)
    await mkdir(path.dirname(targetDir), { recursive: true })
    if (existsSync(targetDir)) await rm(targetDir, { recursive: true, force: true })
    await rename(stagedTargetDir, targetDir)
    const ready = await installedRuntimeStatus(spec)
    await logRuntime(`install completed binary=${ready.binary || ''}`)
    emitStatus(ready, onProgress)
    return ready
  } catch (error) {
    const cancelled = controller.signal.aborted
    const status: CodexRuntimeStatus = {
      ...baseStatus(spec),
      state: cancelled ? 'missing' : 'error',
      source: 'managed',
      error: cancelled ? '安装已取消' : error instanceof Error ? error.message : String(error)
    }
    await logRuntime(
      `${cancelled ? 'install cancelled' : 'install failed'} version=${CODEX_RUNTIME_VERSION} target=${spec.target} error=${runtimeErrorText(error)}`
    )
    emitStatus(status, onProgress)
    if (cancelled) return status
    throw error
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => {})
  }
}

export function installCodexRuntime(
  onProgress?: (status: CodexRuntimeStatus) => void
): Promise<CodexRuntimeStatus> {
  if (activeInstall) return activeInstall.promise
  if (configuredBinary()) {
    return Promise.reject(new Error('已通过 SPARKLE_CODEX_BINARY 指定自定义 Codex'))
  }
  const spec = runtimeSpec()
  if (!spec) return Promise.reject(new Error('当前平台暂不支持 Sparkle 托管 Codex Runtime'))
  const controller = new AbortController()
  const promise = performInstall(spec, controller, onProgress).finally(() => {
    if (activeInstall?.promise === promise) activeInstall = undefined
  })
  activeInstall = { controller, promise }
  return promise
}

export function cancelCodexRuntimeInstall(): boolean {
  if (!activeInstall) return false
  activeInstall.controller.abort()
  return true
}
