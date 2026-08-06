import { BrowserWindow, app } from 'electron'
import { randomUUID } from 'crypto'
import { readFile, rename, writeFile } from 'fs/promises'
import { join } from 'path'
import { cancelMihomoCodexTest, mihomoCodexTest } from './codexTest'
import { cancelMihomoCodexActualTest, mihomoCodexActualTest } from './codexActualTest'

interface CodexTestStateFile {
  version: 1
  snapshots: Partial<Record<CodexTestMode, CodexTestSnapshot>>
}

interface ActiveCodexTestRun {
  snapshot: CodexTestSnapshot
  persistTimer?: ReturnType<typeof setTimeout>
  persistPromise: Promise<void>
  done: Promise<void>
  resolveDone: () => void
  cancelRequested: boolean
  persistenceError?: string
}

let stateFile: CodexTestStateFile | undefined
let stateLoadPromise: Promise<CodexTestStateFile> | undefined
let stateWriteQueue = Promise.resolve()
let activeRun: ActiveCodexTestRun | undefined
const PERSIST_RETRY_DELAYS_MS = [0, 100, 500]

function statePath(): string {
  return join(app.getPath('userData'), 'codex-test-state.json')
}

function emptyState(): CodexTestStateFile {
  return { version: 1, snapshots: {} }
}

async function loadState(): Promise<CodexTestStateFile> {
  try {
    const raw = await readFile(statePath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<CodexTestStateFile>
    if (parsed.version === 1 && parsed.snapshots && typeof parsed.snapshots === 'object') {
      return { version: 1, snapshots: parsed.snapshots }
    }
    console.error('[CodexTest] ignoring invalid persisted state version')
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
    if (code !== 'ENOENT') {
      console.error('[CodexTest] failed to load persisted state', error)
    }
  }
  return emptyState()
}

async function ensureState(): Promise<CodexTestStateFile> {
  if (stateFile) return stateFile
  if (!stateLoadPromise) {
    stateLoadPromise = loadState()
  }
  stateFile = await stateLoadPromise
  return stateFile
}

function queueStateWrite(): Promise<void> {
  const serialized = JSON.stringify(stateFile)
  const path = statePath()
  const temporaryPath = `${path}.${process.pid}.tmp`
  const nextWrite = stateWriteQueue.then(async () => {
    await writeFile(temporaryPath, serialized, 'utf8')
    await rename(temporaryPath, path)
  })
  // Keep the queue usable after a failed write, while returning the original
  // rejection to the caller so critical flushes cannot be mistaken for success.
  stateWriteQueue = nextWrite.catch(() => {})
  return nextWrite
}

function storedSnapshot(mode: CodexTestMode, snapshot: CodexTestSnapshot): void {
  if (!stateFile) return
  stateFile.snapshots[mode] = snapshot
}

function broadcast(snapshot: CodexTestSnapshot): void {
  BrowserWindow.getAllWindows().forEach((window) => {
    if (window.isDestroyed()) return
    try {
      window.webContents.send('codexTestSnapshot', snapshot)
    } catch {
      // A renderer can disappear between the lifecycle check and send().
    }
  })
}

function updateRun(run: ActiveCodexTestRun, patch: Partial<CodexTestSnapshot>): void {
  if (activeRun !== run) return
  run.snapshot = {
    ...run.snapshot,
    ...patch,
    updatedAt: Date.now()
  }
  storedSnapshot(run.snapshot.mode, run.snapshot)
  broadcast(run.snapshot)
  schedulePersist(run)
}

function reportPersistenceFailure(run: ActiveCodexTestRun, error: unknown): void {
  const message = `Codex 测试结果保存失败：${errorMessage(error)}`
  if (run.persistenceError === message) return

  run.persistenceError = message
  console.error('[CodexTest] failed to persist state', error)
  if (activeRun !== run) return

  const snapshot: CodexTestSnapshot = {
    ...run.snapshot,
    error: run.snapshot.error ? `${run.snapshot.error}；${message}` : message,
    updatedAt: Date.now()
  }
  broadcast(snapshot)
}

function enqueuePersist(run: ActiveCodexTestRun): Promise<void> {
  const nextPersist = run.persistPromise.then(() => queueStateWrite())
  run.persistPromise = nextPersist
    .then(() => {
      run.persistenceError = undefined
    })
    .catch((error) => {
      reportPersistenceFailure(run, error)
    })
  return nextPersist
}

function schedulePersist(run: ActiveCodexTestRun, immediate = false): void {
  if (run.persistTimer !== undefined) {
    if (!immediate) return
    clearTimeout(run.persistTimer)
    run.persistTimer = undefined
  }

  if (!immediate) {
    run.persistTimer = setTimeout(() => {
      run.persistTimer = undefined
      void enqueuePersist(run).catch(() => {})
    }, 200)
    return
  }

  void enqueuePersist(run).catch(() => {})
}

async function flushPersist(run: ActiveCodexTestRun): Promise<void> {
  if (run.persistTimer !== undefined) {
    clearTimeout(run.persistTimer)
    run.persistTimer = undefined
  }

  let lastError: unknown
  for (const delay of PERSIST_RETRY_DELAYS_MS) {
    if (delay > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delay)
      })
    }
    try {
      await enqueuePersist(run)
      return
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

function metric(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  if (value >= 1000) return `${Number((value / 1000).toFixed(2))} s`
  return `${Math.round(value)} ms`
}

let nextLogId = 0

function actualLog(
  message: string,
  level: CodexActualTestLogLevel = 'info',
  context?: { proxy?: string; worker?: number; round?: number }
): CodexActualTestLogEntry {
  return {
    id: `${Date.now()}-${nextLogId++}`,
    timestamp: Date.now(),
    level,
    message,
    ...context
  }
}

function actualProgressLogs(progress: CodexActualTestProgress): CodexActualTestLogEntry[] {
  const context = { proxy: progress.proxy, worker: progress.worker, round: progress.round }
  if (progress.stage === 'selecting') {
    return [actualLog('正在切换隐藏测速通道并关闭旧连接', 'info', context)]
  }
  if (progress.stage === 'starting') {
    return [actualLog('正在启动或复用独立 Codex 后台', 'info', context)]
  }
  if (progress.stage === 'requesting') {
    return [
      actualLog(`模型：${progress.model || '未获取到'}`, 'info', context),
      actualLog(`推理深度：${progress.reasoningEffort || '跟随模型默认'}`, 'info', context),
      actualLog(`发送：${progress.request || '未获取到'}`, 'info', context),
      actualLog('真实请求已发送，正在等待 Codex 返回', 'info', context)
    ]
  }
  if (progress.stage === 'streaming') {
    return [actualLog('已收到首个响应片段', 'info', context)]
  }

  const roundResult = progress.result?.roundResults.find((item) => item.round === progress.round)
  if (!roundResult) {
    return [actualLog('本轮已结束，但没有收到详细结果', 'error', context)]
  }
  const route = roundResult.routeVerified ? '路由已验证' : '路由未验证'
  const tokens = roundResult.tokenUsage?.totalTokens ?? 0
  const reply = actualLog(`回复：${roundResult.response || '未收到文本回复'}`, 'info', context)
  if (!roundResult.success) {
    return [
      reply,
      actualLog(
        `失败：${roundResult.error || '未知错误'}；${route}；完整 ${metric(roundResult.totalMs)}；Token ${tokens}`,
        'error',
        context
      )
    ]
  }
  return [
    reply,
    actualLog(
      `成功：首字 ${metric(roundResult.firstTokenMs)}；完整 ${metric(roundResult.totalMs)}；${route}；Token ${tokens}`,
      'success',
      context
    )
  ]
}

function createRunSnapshot(
  mode: CodexTestMode,
  proxies: string[],
  rounds: number,
  concurrency: number,
  groupName: string | undefined,
  options?: CodexActualTestOptions
): CodexTestSnapshot {
  const now = Date.now()
  return {
    mode,
    runId: randomUUID(),
    status: 'running',
    testing: true,
    cancelling: false,
    groupName,
    startedAt: now,
    updatedAt: now,
    completed: 0,
    total: proxies.length * rounds,
    rounds,
    concurrency,
    results: {},
    logs:
      mode === 'actual'
        ? [
            actualLog(
              `开始测试 ${proxies.length} 个节点，共 ${rounds} 轮，并发 ${concurrency}；模型 ${options?.model || 'Codex 默认'}；推理深度 ${options?.reasoningEffort || '模型默认'}`
            )
          ]
        : undefined,
    options
  }
}

function createActiveRun(snapshot: CodexTestSnapshot): ActiveCodexTestRun {
  let resolveDone = (): void => {}
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  return {
    snapshot,
    persistPromise: Promise.resolve(),
    done,
    resolveDone,
    cancelRequested: false
  }
}

async function finishRun(
  run: ActiveCodexTestRun,
  patch: Partial<CodexTestSnapshot>
): Promise<void> {
  if (activeRun !== run) return
  const now = Date.now()
  run.snapshot = {
    ...run.snapshot,
    ...patch,
    testing: false,
    cancelling: false,
    updatedAt: now,
    savedAt: now
  }
  storedSnapshot(run.snapshot.mode, run.snapshot)
  broadcast(run.snapshot)
  try {
    await flushPersist(run)
  } catch (error) {
    // The final in-memory snapshot is still useful to the current renderer,
    // but make the durability failure visible instead of treating it as saved.
    reportPersistenceFailure(run, error)
  }
  if (activeRun === run) activeRun = undefined
  run.resolveDone()
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function handleLinkProgress(run: ActiveCodexTestRun, progress: CodexTestProgress): void {
  if (activeRun !== run) return
  const results = run.snapshot.results as Record<string, CodexTestResult>
  updateRun(run, {
    progress,
    completed: progress.completed,
    total: progress.total,
    results: progress.result ? { ...results, [progress.result.proxy]: progress.result } : results
  })
}

function handleActualProgress(run: ActiveCodexTestRun, progress: CodexActualTestProgress): void {
  if (activeRun !== run) return
  const results = run.snapshot.results as Record<string, CodexActualTestResult>
  const logs = [...(run.snapshot.logs || []), ...actualProgressLogs(progress)].slice(-300)
  updateRun(run, {
    progress,
    completed: progress.completed,
    total: progress.total,
    logs,
    results: progress.result ? { ...results, [progress.result.proxy]: progress.result } : results
  })
}

async function executeLinkRun(
  run: ActiveCodexTestRun,
  proxies: string[],
  rounds: number,
  concurrency: number
): Promise<void> {
  try {
    const results = await mihomoCodexTest(proxies, rounds, concurrency, (progress) => {
      handleLinkProgress(run, progress)
    })
    await finishRun(run, {
      status: 'completed',
      completed: run.snapshot.total,
      results: Object.fromEntries(results.map((result) => [result.proxy, result]))
    })
  } catch (error) {
    const message = errorMessage(error)
    await finishRun(run, {
      status: message === 'Codex 测试已停止' ? 'stopped' : 'failed',
      error: message === 'Codex 测试已停止' ? undefined : message
    })
  } finally {
    if (activeRun === run) {
      await finishRun(run, { status: 'failed', error: '测试未正常结束' })
    }
  }
}

async function executeActualRun(
  run: ActiveCodexTestRun,
  proxies: string[],
  rounds: number,
  concurrency: number,
  options: CodexActualTestOptions
): Promise<void> {
  try {
    const results = await mihomoCodexActualTest(
      proxies,
      rounds,
      concurrency,
      options,
      (progress) => {
        handleActualProgress(run, progress)
      }
    )
    const logs = [
      ...(run.snapshot.logs || []),
      actualLog(
        `测试完成：${results.filter((result) => result.succeeded > 0).length}/${results.length} 个节点至少成功 1 轮`,
        results.some((result) => result.succeeded > 0) ? 'success' : 'error'
      )
    ].slice(-300)
    await finishRun(run, {
      status: 'completed',
      completed: run.snapshot.total,
      results: Object.fromEntries(results.map((result) => [result.proxy, result])),
      logs
    })
  } catch (error) {
    const message = errorMessage(error)
    await finishRun(run, {
      status: message === 'Codex 真实响应测试已停止' ? 'stopped' : 'failed',
      error: message === 'Codex 真实响应测试已停止' ? undefined : message
    })
  } finally {
    if (activeRun === run) {
      await finishRun(run, { status: 'failed', error: '测试未正常结束' })
    }
  }
}

async function startRun(
  mode: CodexTestMode,
  proxies: string[],
  rounds: number,
  concurrency: number,
  groupName?: string,
  options?: CodexActualTestOptions
): Promise<CodexTestSnapshot> {
  await ensureState()
  if (activeRun) {
    throw new Error(
      activeRun.snapshot.mode === 'actual'
        ? '已有 Codex 真实响应测试正在进行'
        : '已有 Codex 测试正在进行'
    )
  }
  if (proxies.length === 0) throw new Error('请至少选择一个节点')

  const snapshot = createRunSnapshot(mode, proxies, rounds, concurrency, groupName, options)
  const run = createActiveRun(snapshot)
  activeRun = run
  storedSnapshot(mode, snapshot)

  // Persist the initial running state before starting the underlying test. This
  // guarantees that a renderer reload or app exit cannot lose the run entirely.
  const initialPersist = flushPersist(run)
  run.done = (async () => {
    try {
      await initialPersist
    } catch (error) {
      await finishRun(run, {
        status: 'failed',
        error: `Codex 测试状态保存失败：${errorMessage(error)}`
      })
      return
    }

    if (run.cancelRequested || activeRun !== run) {
      await finishRun(run, { status: 'stopped' })
      return
    }

    try {
      await (mode === 'actual'
        ? executeActualRun(run, proxies, rounds, concurrency, options || {})
        : executeLinkRun(run, proxies, rounds, concurrency))
    } catch (error) {
      await finishRun(run, { status: 'failed', error: errorMessage(error) })
    }
  })()

  try {
    await initialPersist
  } catch (error) {
    throw new Error(`Codex 测试状态保存失败：${errorMessage(error)}`)
  }
  broadcast(run.snapshot)
  return run.snapshot
}

export function startCodexTest(
  proxies: string[],
  rounds = 3,
  concurrency = 6,
  groupName?: string
): Promise<CodexTestSnapshot> {
  const normalizedRounds = Math.min(5, Math.max(1, Math.trunc(rounds) || 3))
  const normalizedConcurrency = Math.max(1, Math.trunc(concurrency) || 6)
  return startRun('link', proxies, normalizedRounds, normalizedConcurrency, groupName)
}

export function startCodexActualTest(
  proxies: string[],
  rounds = 1,
  concurrency = 2,
  groupName?: string,
  options: CodexActualTestOptions = {}
): Promise<CodexTestSnapshot> {
  const normalizedRounds = Math.min(5, Math.max(1, Math.trunc(rounds) || 1))
  const normalizedConcurrency = Math.min(4, Math.max(1, Math.trunc(concurrency) || 2))
  return startRun('actual', proxies, normalizedRounds, normalizedConcurrency, groupName, options)
}

export async function getCodexTestSnapshot(
  mode: CodexTestMode
): Promise<CodexTestSnapshot | undefined> {
  const state = await ensureState()
  if (activeRun?.snapshot.mode === mode) return activeRun.snapshot

  const snapshot = state.snapshots[mode]
  if (!snapshot) return undefined
  if (snapshot.status !== 'running') return snapshot

  const interrupted: CodexTestSnapshot = {
    ...snapshot,
    status: 'interrupted',
    testing: false,
    cancelling: false,
    updatedAt: Date.now(),
    savedAt: Date.now()
  }
  state.snapshots[mode] = interrupted
  try {
    await queueStateWrite()
  } catch (error) {
    return {
      ...interrupted,
      error: `Codex 测试状态保存失败：${errorMessage(error)}`
    }
  }
  return interrupted
}

export async function stopCodexTest(mode?: CodexTestMode): Promise<boolean> {
  const run = activeRun
  if (!run || (mode && run.snapshot.mode !== mode)) return false

  run.cancelRequested = true
  updateRun(run, { cancelling: true })
  schedulePersist(run, true)
  if (run.snapshot.mode === 'actual') cancelMihomoCodexActualTest()
  else cancelMihomoCodexTest()
  await run.done
  return true
}

export function hasActiveCodexTest(): boolean {
  return activeRun !== undefined
}

export async function stopAllCodexTests(): Promise<void> {
  if (activeRun) await stopCodexTest()
  if (stateFile) {
    try {
      await queueStateWrite()
    } catch (error) {
      console.error('[CodexTest] final state flush failed', error)
    }
  }
  await stateWriteQueue
}
