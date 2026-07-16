import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import readline from 'node:readline'
import { codexBinaryNeedsShell, getCodexBinaryCandidates } from './codexBinary'
import { getRuntimeCodexTestChannels } from './factory'
import { mihomoChangeProxy, mihomoCloseConnections, mihomoGetConnections } from './mihomoApi'
import { acquireNetworkTestChannel } from './networkTestChannel'

const REQUEST_TIMEOUT = 60_000
const RPC_TIMEOUT = 30_000
const MAX_ACTUAL_CONCURRENCY = 4
const ROUTE_CHECK_INTERVAL = 100

type JsonObject = Record<string, unknown>
type TestChannel = ReturnType<typeof getRuntimeCodexTestChannels>[number]

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface ThreadStartResponse {
  thread: { id: string }
  model: string
}

interface TurnStartResponse {
  turn: { id: string }
}

interface ActiveCodexActualTest {
  controller: AbortController
  clients: Set<CodexAppServerClient>
  cancelled: boolean
}

interface RouteMonitor {
  stop: () => Promise<CodexActualTestRouteEvidence[]>
}

let activeCodexActualTest: ActiveCodexActualTest | undefined
let resolvedCodexBinary: string | undefined

interface CodexProbeResult {
  available: boolean
  reason?: string
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function abortError(): Error {
  return new Error('Codex 真实响应测试已停止')
}

function terminateChildProcess(child: ChildProcess, force = false): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform !== 'win32' || !child.pid) {
    child.kill(force ? 'SIGKILL' : 'SIGTERM')
    return
  }

  const taskkill = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
    stdio: 'ignore',
    windowsHide: true
  })
  const fallback = (): void => {
    if (child.exitCode === null && child.signalCode === null) child.kill()
  }
  taskkill.once('error', fallback)
  taskkill.once('exit', (code) => {
    if (code !== 0) fallback()
  })
}

function roundMetric(value: number): number {
  return Math.round(value * 10) / 10
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

function emptyTokenUsage(): CodexActualTestTokenUsage {
  return {
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0
  }
}

function addTokenUsage(
  left: CodexActualTestTokenUsage,
  right?: CodexActualTestTokenUsage
): CodexActualTestTokenUsage {
  if (!right) return left
  return {
    totalTokens: left.totalTokens + right.totalTokens,
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningOutputTokens: left.reasoningOutputTokens + right.reasoningOutputTokens
  }
}

function parseTokenUsage(value: unknown): CodexActualTestTokenUsage | undefined {
  if (!isObject(value)) return undefined
  const numberValue = (key: string): number => {
    const current = value[key]
    return typeof current === 'number' && Number.isFinite(current) ? current : 0
  }
  return {
    totalTokens: numberValue('totalTokens'),
    inputTokens: numberValue('inputTokens'),
    cachedInputTokens: numberValue('cachedInputTokens'),
    outputTokens: numberValue('outputTokens'),
    reasoningOutputTokens: numberValue('reasoningOutputTokens')
  }
}

function aggregateResult(
  proxy: string,
  rounds: number,
  roundResults: CodexActualTestRoundResult[]
): CodexActualTestResult {
  const successful = roundResults.filter((round) => round.success)
  const failed = roundResults.filter((round) => !round.success)
  const completedRounds = roundResults.length
  const successRate = completedRounds > 0 ? successful.length / completedRounds : 0
  const routeVerifiedRate =
    completedRounds > 0
      ? roundResults.filter((round) => round.routeVerified).length / completedRounds
      : 0
  const queueValues = successful
    .map((round) => round.queueMs)
    .filter((value): value is number => value !== undefined)
  const firstTokenValues = successful
    .map((round) => round.firstTokenMs)
    .filter((value): value is number => value !== undefined)
  const totalValues = successful
    .map((round) => round.totalMs)
    .filter((value): value is number => value !== undefined)
  const queueMs = queueValues.length ? median(queueValues) : undefined
  const firstTokenMs = firstTokenValues.length ? median(firstTokenValues) : undefined
  const totalMs = totalValues.length ? median(totalValues) : undefined
  const jitterMs = firstTokenValues.length ? standardDeviation(firstTokenValues) : undefined
  const score =
    firstTokenMs === undefined || totalMs === undefined || jitterMs === undefined
      ? undefined
      : firstTokenMs * 0.7 +
        totalMs * 0.3 +
        jitterMs +
        (1 - successRate) * 10_000 +
        (1 - routeVerifiedRate) * 10_000

  return {
    proxy,
    rounds,
    completedRounds,
    succeeded: successful.length,
    failed: failed.length,
    successRate,
    routeVerifiedRate,
    queueMs: queueMs === undefined ? undefined : roundMetric(queueMs),
    firstTokenMs: firstTokenMs === undefined ? undefined : roundMetric(firstTokenMs),
    totalMs: totalMs === undefined ? undefined : roundMetric(totalMs),
    jitterMs: jitterMs === undefined ? undefined : roundMetric(jitterMs),
    score: score === undefined ? undefined : roundMetric(score),
    model: successful.find((round) => round.model)?.model,
    tokenUsage: roundResults.reduce(
      (usage, round) => addTokenUsage(usage, round.tokenUsage),
      emptyTokenUsage()
    ),
    error: failed.at(-1)?.error,
    roundResults: [...roundResults].sort((left, right) => left.round - right.round),
    testedAt: Date.now()
  }
}

function probeCodexBinary(candidate: string): Promise<CodexProbeResult> {
  return new Promise((resolve) => {
    let settled = false
    let output = ''
    let child: ChildProcess
    try {
      child = spawn(candidate, ['--version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: codexBinaryNeedsShell(candidate),
        windowsHide: true
      })
    } catch (error) {
      resolve({ available: false, reason: errorMessage(error) })
      return
    }
    const finish = (result: CodexProbeResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      terminateChildProcess(child, true)
      finish({ available: false, reason: '探测超时' })
    }, 5000)
    child.stdout?.on('data', (chunk: Buffer | string) => {
      output += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      output += chunk.toString()
    })
    child.once('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code
      finish({ available: false, reason: code ? `${code}: ${error.message}` : error.message })
    })
    child.once('exit', (code) => {
      const detail = output.trim().replace(/\s+/g, ' ').slice(0, 240)
      finish({
        available: code === 0 && /codex/i.test(output),
        reason:
          code === 0 && /codex/i.test(output)
            ? undefined
            : `退出码 ${code ?? '未知'}${detail ? `：${detail}` : ''}`
      })
    })
  })
}

async function resolveCodexBinary(): Promise<string> {
  if (resolvedCodexBinary) {
    const cached = await probeCodexBinary(resolvedCodexBinary)
    if (cached.available) return resolvedCodexBinary
    resolvedCodexBinary = undefined
  }
  const failures: Array<{ candidate: string; reason: string }> = []
  for (const candidate of getCodexBinaryCandidates()) {
    const result = await probeCodexBinary(candidate)
    if (result.available) {
      resolvedCodexBinary = candidate
      return candidate
    }
    failures.push({ candidate, reason: result.reason || '不可用' })
  }
  const displayed = failures
    .slice(0, 12)
    .map(({ candidate, reason }) => `- ${candidate}：${reason.replace(/\s+/g, ' ').slice(0, 200)}`)
    .join('\n')
  const omitted = failures.length > 12 ? `\n- 另有 ${failures.length - 12} 个候选不可用` : ''
  throw new Error(
    process.platform === 'win32'
      ? `未找到可用的 Codex。可安装 Codex Desktop/CLI，或通过 SPARKLE_CODEX_BINARY 指定路径。\n已尝试：\n${displayed}${omitted}`
      : `未找到可用的 Codex。请安装 Codex CLI，或通过 SPARKLE_CODEX_BINARY 指定路径。\n已尝试：\n${displayed}${omitted}`
  )
}

class CodexAppServerClient {
  private child?: ChildProcessWithoutNullStreams
  private lineReader?: readline.Interface
  private nextRequestId = 1
  private pending = new Map<number, PendingRequest>()
  private notificationListeners = new Set<(message: JsonObject) => void>()
  private failureListeners = new Set<(error: Error) => void>()
  private stderr = ''
  private stopped = false

  constructor(
    private readonly binary: string,
    private readonly proxyPort: number,
    private readonly signal: AbortSignal
  ) {}

  async start(): Promise<void> {
    if (this.child) return
    if (this.signal.aborted) throw abortError()
    const proxyUrl = `http://127.0.0.1:${this.proxyPort}`
    const child = spawn(this.binary, ['app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: codexBinaryNeedsShell(this.binary),
      env: {
        ...process.env,
        HTTP_PROXY: proxyUrl,
        HTTPS_PROXY: proxyUrl,
        ALL_PROXY: proxyUrl,
        http_proxy: proxyUrl,
        https_proxy: proxyUrl,
        all_proxy: proxyUrl,
        NO_PROXY: '127.0.0.1,localhost,::1',
        no_proxy: '127.0.0.1,localhost,::1'
      }
    })
    this.child = child
    this.lineReader = readline.createInterface({ input: child.stdout })
    this.lineReader.on('line', (line) => this.handleLine(line))
    child.stderr.on('data', (chunk: Buffer | string) => {
      this.stderr = `${this.stderr}${chunk.toString()}`.slice(-4000)
    })
    child.once('error', (error) => this.handleExit(error))
    child.once('exit', (code, signal) => {
      if (this.stopped) return
      const detail = this.stderr.trim()
      this.handleExit(
        new Error(
          `Codex 后台已退出（${signal || code || '未知状态'}）${detail ? `：${detail}` : ''}`
        )
      )
    })
    this.signal.addEventListener('abort', this.stop, { once: true })

    await this.request('initialize', {
      clientInfo: { name: 'sparkle', title: 'Sparkle', version: '1.0' },
      capabilities: null
    })
    this.send({ method: 'initialized' })
  }

  onNotification(listener: (message: JsonObject) => void): () => void {
    this.notificationListeners.add(listener)
    return () => this.notificationListeners.delete(listener)
  }

  onFailure(listener: (error: Error) => void): () => void {
    this.failureListeners.add(listener)
    return () => this.failureListeners.delete(listener)
  }

  request<T>(method: string, params: unknown, timeout = RPC_TIMEOUT): Promise<T> {
    if (!this.child || this.stopped) return Promise.reject(new Error('Codex 后台未启动'))
    const id = this.nextRequestId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex 后台请求超时：${method}`))
      }, timeout)
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer
      })
      try {
        this.send({ method, id, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  stop = (): void => {
    if (this.stopped) return
    this.stopped = true
    this.signal.removeEventListener('abort', this.stop)
    this.lineReader?.close()
    const error = this.signal.aborted ? abortError() : new Error('Codex 后台已停止')
    this.rejectPending(error)
    const child = this.child
    if (child && child.exitCode === null) {
      terminateChildProcess(child)
      const forceTimer = setTimeout(() => {
        terminateChildProcess(child, true)
      }, 1000)
      forceTimer.unref()
    }
  }

  private send(message: JsonObject): void {
    if (!this.child || this.child.stdin.destroyed) throw new Error('Codex 后台连接不可用')
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private handleLine(line: string): void {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (!isObject(message)) return
    const id = message.id
    if (typeof id === 'number') {
      const pending = this.pending.get(id)
      if (!pending) return
      this.pending.delete(id)
      clearTimeout(pending.timer)
      if (isObject(message.error)) {
        const detail =
          typeof message.error.message === 'string'
            ? message.error.message
            : JSON.stringify(message.error)
        pending.reject(new Error(detail))
      } else {
        pending.resolve(message.result)
      }
      return
    }
    if (typeof message.method === 'string') {
      this.notificationListeners.forEach((listener) => listener(message as JsonObject))
    }
  }

  private handleExit(error: Error): void {
    if (this.stopped) return
    this.stopped = true
    this.signal.removeEventListener('abort', this.stop)
    this.lineReader?.close()
    this.rejectPending(error)
    this.failureListeners.forEach((listener) => listener(error))
    this.failureListeners.clear()
  }

  private rejectPending(error: Error): void {
    this.pending.forEach((pending) => {
      clearTimeout(pending.timer)
      pending.reject(error)
    })
    this.pending.clear()
  }
}

function createRouteMonitor(channel: TestChannel): RouteMonitor {
  const evidence = new Map<string, CodexActualTestRouteEvidence>()
  let stopped = false
  let currentCheck: Promise<void> | undefined

  const check = (): Promise<void> => {
    if (currentCheck) return currentCheck
    currentCheck = (async () => {
      try {
        const connections = await mihomoGetConnections()
        connections.connections
          ?.filter(
            (connection) =>
              connection.chains.includes(channel.group) &&
              (!connection.metadata.inboundName ||
                connection.metadata.inboundName === channel.listener)
          )
          .forEach((connection) => {
            const route = {
              inboundName: connection.metadata.inboundName,
              host: connection.metadata.host,
              destinationIP: connection.metadata.destinationIP,
              remoteDestination: connection.metadata.remoteDestination,
              dnsMode: connection.metadata.dnsMode,
              chains: connection.chains
            }
            const key = [
              route.inboundName,
              route.host,
              route.destinationIP,
              route.remoteDestination,
              route.dnsMode,
              ...route.chains
            ].join('\u0000')
            evidence.set(key, route)
          })
      } catch {
        // 最终以未验证处理，测速请求本身仍可正常收尾。
      }
    })().finally(() => {
      currentCheck = undefined
    })
    return currentCheck
  }

  const timer = setInterval(() => void check(), ROUTE_CHECK_INTERVAL)
  timer.unref()
  void check()

  return {
    stop: async () => {
      if (!stopped) {
        stopped = true
        clearInterval(timer)
        await check()
        await check()
      }
      return [...evidence.values()]
    }
  }
}

async function runActualProbe(
  client: CodexAppServerClient,
  channel: TestChannel,
  round: number,
  signal: AbortSignal,
  onStage: (
    stage: CodexActualTestStage,
    detail?: Pick<CodexActualTestProgress, 'model' | 'request'>
  ) => void
): Promise<CodexActualTestRoundResult> {
  const workDir = await mkdtemp(path.join(tmpdir(), 'sparkle-codex-test-'))
  const nonce = `SPARKLE_OK_${randomBytes(8).toString('hex')}`
  const requestText = `只回复 ${nonce}`
  let routeMonitor: RouteMonitor | undefined
  let unsubscribe = (): void => {}
  let unsubscribeFailure = (): void => {}
  let requestStartedAt: number | undefined
  let turnStartedAt: number | undefined
  let firstTokenAt: number | undefined
  let completedAt: number | undefined
  let response = ''
  let tokenUsage: CodexActualTestTokenUsage | undefined
  let model: string | undefined
  let handleAbort: (() => void) | undefined

  try {
    if (signal.aborted) throw abortError()
    onStage('starting')
    await client.start()
    const thread = await client.request<ThreadStartResponse>('thread/start', {
      cwd: workDir,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: true,
      config: { web_search: 'disabled' },
      developerInstructions:
        'This is a network latency benchmark. Do not call tools, inspect files, or add explanations. Return only the exact token requested by the user.'
    })
    const threadId = thread.thread.id
    model = thread.model

    // 初始化或上一轮可能留下长连接。切换节点后只关闭当前隐藏测速组的连接，
    // 保证本轮模型请求重新通过当前节点建链，不影响正式代理组。
    await mihomoCloseConnections(channel.group)
    routeMonitor = createRouteMonitor(channel)

    let turnId: string | undefined
    let completionResolve: (() => void) | undefined
    let completionReject: ((error: Error) => void) | undefined
    const completion = new Promise<void>((resolve, reject) => {
      completionResolve = resolve
      completionReject = reject
    })
    handleAbort = (): void => completionReject?.(abortError())
    signal.addEventListener('abort', handleAbort, { once: true })
    unsubscribeFailure = client.onFailure((error) => completionReject?.(error))

    unsubscribe = client.onNotification((message) => {
      const method = message.method
      const params = isObject(message.params) ? message.params : undefined
      if (!params || params.threadId !== threadId) return

      if (method === 'turn/started' && isObject(params.turn)) {
        turnId = typeof params.turn.id === 'string' ? params.turn.id : turnId
        turnStartedAt ??= performance.now()
        return
      }
      const notificationTurnId =
        typeof params.turnId === 'string'
          ? params.turnId
          : isObject(params.turn) && typeof params.turn.id === 'string'
            ? params.turn.id
            : undefined
      if (turnId && notificationTurnId && notificationTurnId !== turnId) return

      if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
        if (firstTokenAt === undefined) {
          firstTokenAt = performance.now()
          onStage('streaming')
        }
        response += params.delta
        return
      }
      if (method === 'item/completed' && isObject(params.item)) {
        if (params.item.type === 'agentMessage' && typeof params.item.text === 'string') {
          firstTokenAt ??= performance.now()
          response = params.item.text
        }
        return
      }
      if (method === 'thread/tokenUsage/updated' && isObject(params.tokenUsage)) {
        tokenUsage = parseTokenUsage(params.tokenUsage.last)
        return
      }
      if (method === 'error' && params.willRetry === false && isObject(params.error)) {
        const messageText =
          typeof params.error.message === 'string' ? params.error.message : 'Codex 请求失败'
        completionReject?.(new Error(messageText))
        return
      }
      if (method === 'turn/completed' && isObject(params.turn)) {
        completedAt = performance.now()
        if (params.turn.status === 'failed') {
          const turnError = isObject(params.turn.error) ? params.turn.error : undefined
          completionReject?.(
            new Error(typeof turnError?.message === 'string' ? turnError.message : 'Codex 请求失败')
          )
        } else if (params.turn.status === 'interrupted') {
          completionReject?.(abortError())
        } else {
          completionResolve?.()
        }
      }
    })

    requestStartedAt = performance.now()
    onStage('requesting', { model, request: requestText })
    const turn = await client.request<TurnStartResponse>('turn/start', {
      threadId,
      input: [{ type: 'text', text: requestText, text_elements: [] }],
      approvalPolicy: 'never',
      model
    })
    turnId = turn.turn.id

    const requestTimer = setTimeout(() => {
      completionReject?.(new Error('等待 Codex 返回超时'))
    }, REQUEST_TIMEOUT)
    try {
      await completion
    } finally {
      clearTimeout(requestTimer)
      signal.removeEventListener('abort', handleAbort)
    }
    completedAt ??= performance.now()
    const routes = await routeMonitor.stop()
    const routeVerified = routes.length > 0
    const queueMs = turnStartedAt === undefined ? undefined : turnStartedAt - requestStartedAt
    const firstTokenMs = firstTokenAt === undefined ? undefined : firstTokenAt - requestStartedAt
    const totalMs = completedAt - requestStartedAt
    const cleanResponse = response.trim().slice(0, 500)
    const validationError = !routeVerified
      ? '未检测到请求经过对应隐藏测速通道'
      : !cleanResponse.includes(nonce)
        ? 'Codex 返回校验失败'
        : undefined

    return {
      round,
      success: validationError === undefined,
      routeVerified,
      queueMs: queueMs === undefined ? undefined : roundMetric(queueMs),
      firstTokenMs: firstTokenMs === undefined ? undefined : roundMetric(firstTokenMs),
      totalMs: roundMetric(totalMs),
      model,
      response: cleanResponse,
      routes,
      tokenUsage,
      error: validationError
    }
  } catch (error) {
    if (signal.aborted) throw abortError()
    const now = performance.now()
    const routes = routeMonitor ? await routeMonitor.stop() : []
    const routeVerified = routes.length > 0
    return {
      round,
      success: false,
      routeVerified,
      queueMs:
        requestStartedAt !== undefined && turnStartedAt !== undefined
          ? roundMetric(turnStartedAt - requestStartedAt)
          : undefined,
      firstTokenMs:
        requestStartedAt !== undefined && firstTokenAt !== undefined
          ? roundMetric(firstTokenAt - requestStartedAt)
          : undefined,
      totalMs: requestStartedAt === undefined ? undefined : roundMetric(now - requestStartedAt),
      model,
      response: response.trim().slice(0, 500) || undefined,
      routes,
      tokenUsage,
      error: errorMessage(error)
    }
  } finally {
    if (handleAbort) signal.removeEventListener('abort', handleAbort)
    unsubscribe()
    unsubscribeFailure()
    await routeMonitor?.stop()
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}

export function cancelMihomoCodexActualTest(): boolean {
  if (!activeCodexActualTest) return false
  activeCodexActualTest.cancelled = true
  activeCodexActualTest.controller.abort()
  activeCodexActualTest.clients.forEach((client) => client.stop())
  return true
}

export async function mihomoCodexActualTest(
  proxies: string[],
  rounds: number,
  concurrency: number,
  onProgress?: (progress: CodexActualTestProgress) => void
): Promise<CodexActualTestResult[]> {
  const uniqueProxies = [...new Set(proxies.map((proxy) => proxy.trim()).filter(Boolean))]
  if (uniqueProxies.length === 0) throw new Error('请至少选择一个节点')
  const normalizedRounds = Math.min(5, Math.max(1, Math.trunc(rounds) || 1))
  const channels = getRuntimeCodexTestChannels()
  if (channels.length === 0) throw new Error('Codex 测试通道不可用，请重启内核后重试')
  const normalizedConcurrency = Math.min(
    MAX_ACTUAL_CONCURRENCY,
    channels.length,
    uniqueProxies.length,
    Math.max(1, Math.trunc(concurrency) || 2)
  )
  const binary = await resolveCodexBinary()
  const releaseTestChannel = acquireNetworkTestChannel('codex-actual')
  const current: ActiveCodexActualTest = {
    controller: new AbortController(),
    clients: new Set(),
    cancelled: false
  }
  activeCodexActualTest = current
  const roundResults = new Map<string, CodexActualTestRoundResult[]>()
  const clients = new Map<number, CodexAppServerClient>()
  const total = uniqueProxies.length * normalizedRounds
  let completed = 0

  const getClient = (channel: TestChannel): CodexAppServerClient => {
    const existing = clients.get(channel.port)
    if (existing) return existing
    const client = new CodexAppServerClient(binary, channel.port, current.controller.signal)
    clients.set(channel.port, client)
    current.clients.add(client)
    return client
  }

  try {
    const runSample = async (proxy: string, round: number, channel: TestChannel): Promise<void> => {
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
        await mihomoCloseConnections(channel.group)
      } catch (error) {
        if (current.cancelled || current.controller.signal.aborted) throw abortError()
        const failedRound: CodexActualTestRoundResult = {
          round,
          success: false,
          routeVerified: false,
          error: `测速通道无法选择该节点：${errorMessage(error)}`
        }
        roundResults.set(proxy, [...(roundResults.get(proxy) || []), failedRound])
        completed++
        onProgress?.({
          proxy,
          round,
          rounds: normalizedRounds,
          stage: 'completed',
          completed,
          total,
          result: aggregateResult(proxy, normalizedRounds, roundResults.get(proxy) || [])
        })
        return
      }
      const client = getClient(channel)
      const result = await runActualProbe(
        client,
        channel,
        round,
        current.controller.signal,
        (stage, detail) =>
          onProgress?.({
            proxy,
            round,
            rounds: normalizedRounds,
            stage,
            completed,
            total,
            ...detail
          })
      )
      roundResults.set(proxy, [...(roundResults.get(proxy) || []), result])
      completed++
      onProgress?.({
        proxy,
        round,
        rounds: normalizedRounds,
        stage: 'completed',
        completed,
        total,
        result: aggregateResult(proxy, normalizedRounds, roundResults.get(proxy) || [])
      })

      if (!result.success) {
        client.stop()
        clients.delete(channel.port)
        current.clients.delete(client)
      }
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
      aggregateResult(proxy, normalizedRounds, roundResults.get(proxy) || [])
    )
  } finally {
    current.controller.abort()
    current.clients.forEach((client) => client.stop())
    if (activeCodexActualTest === current) activeCodexActualTest = undefined
    releaseTestChannel()
  }
}
