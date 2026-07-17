import { cancelMihomoCodexTest, mihomoCodexTest } from '@renderer/utils/ipc'
import { notify } from '@renderer/utils/notification'
import { readTestHistory, writeTestHistory } from '@renderer/utils/test-history'

const CODEX_TEST_HISTORY_KEY = 'sparkle:codex-test-history'

interface PersistedCodexTestHistory {
  groupName?: string
  savedAt: number
  results: Record<string, CodexTestResult>
}

interface CodexTestStoreSnapshot {
  results: Record<string, CodexTestResult>
  testing: boolean
  cancelling: boolean
  progress?: CodexTestProgress
  error?: string
  groupName?: string
  savedAt?: number
}

let persistedHistory = readTestHistory<PersistedCodexTestHistory>(CODEX_TEST_HISTORY_KEY)

function createIdleSnapshot(): CodexTestStoreSnapshot {
  return {
    results: persistedHistory?.results || {},
    groupName: persistedHistory?.groupName,
    savedAt: persistedHistory?.savedAt,
    testing: false,
    cancelling: false
  }
}

const initialSnapshot: CodexTestStoreSnapshot = {
  ...createIdleSnapshot(),
  testing: false,
  cancelling: false
}

let snapshot = initialSnapshot
let memoryReleased = false
let generation = 0
const listeners = new Set<() => void>()
let pendingProgress: CodexTestProgress | undefined
let pendingResults: Record<string, CodexTestResult> = {}
let progressTimer: number | undefined
let progressFlushInterval = 100

function hydrateMemory(): void {
  if (!memoryReleased) return
  persistedHistory = readTestHistory<PersistedCodexTestHistory>(CODEX_TEST_HISTORY_KEY)
  snapshot = createIdleSnapshot()
  memoryReleased = false
}

function releaseMemoryIfIdle(): void {
  if (memoryReleased || listeners.size > 0 || snapshot.testing) return
  clearPendingProgress()
  persistedHistory = undefined
  snapshot = { results: {}, testing: false, cancelling: false }
  memoryReleased = true
}

function updateSnapshot(patch: Partial<CodexTestStoreSnapshot>): void {
  snapshot = { ...snapshot, ...patch }
  listeners.forEach((listener) => listener())
}

function persistResults(results: Record<string, CodexTestResult>, groupName?: string): void {
  const savedAt = Date.now()
  persistedHistory = { groupName, savedAt, results }
  writeTestHistory(CODEX_TEST_HISTORY_KEY, persistedHistory)
  updateSnapshot({ results, groupName, savedAt })
}

function flushProgress(): void {
  if (progressTimer !== undefined) window.clearTimeout(progressTimer)
  progressTimer = undefined
  if (!pendingProgress || !snapshot.testing) return
  const progress = pendingProgress
  const results = pendingResults
  pendingProgress = undefined
  pendingResults = {}
  updateSnapshot({ progress, results: { ...snapshot.results, ...results } })
}

function clearPendingProgress(): void {
  if (progressTimer !== undefined) window.clearTimeout(progressTimer)
  progressTimer = undefined
  pendingProgress = undefined
  pendingResults = {}
}

export function subscribeCodexTestStore(listener: () => void): () => void {
  hydrateMemory()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    releaseMemoryIfIdle()
  }
}

export function getCodexTestSnapshot(): CodexTestStoreSnapshot {
  hydrateMemory()
  return snapshot
}

export async function runCodexTest(
  proxies: string[],
  rounds = 3,
  concurrency = 6,
  groupName?: string
): Promise<void> {
  if (snapshot.testing) {
    notify('已有 Codex 测试正在进行')
    return
  }
  if (proxies.length === 0) {
    notify('请至少选择一个节点', { variant: 'warning' })
    return
  }

  const currentGeneration = generation
  progressFlushInterval = proxies.length > 30 ? 500 : 100
  clearPendingProgress()
  const previous = {
    results: snapshot.results,
    groupName: snapshot.groupName,
    savedAt: snapshot.savedAt
  }
  updateSnapshot({
    results: {},
    groupName,
    testing: true,
    cancelling: false,
    progress: undefined,
    error: undefined
  })
  try {
    const results = await mihomoCodexTest(proxies, rounds, concurrency)
    if (currentGeneration !== generation) return
    clearPendingProgress()
    const resultMap = Object.fromEntries(results.map((result) => [result.proxy, result]))
    persistResults(resultMap, groupName)
    const succeeded = results.filter((result) => result.succeeded > 0).length
    notify(`Codex 测试完成 ${succeeded}/${results.length}`, {
      variant: succeeded > 0 ? 'success' : 'danger'
    })
  } catch (error) {
    if (currentGeneration !== generation) return
    const message = String(error)
    if (message === 'Codex 测试已停止') flushProgress()
    else clearPendingProgress()
    if (message === 'Codex 测试已停止' && Object.keys(snapshot.results).length > 0) {
      persistResults(snapshot.results, groupName)
    } else {
      updateSnapshot(previous)
    }
    if (message !== 'Codex 测试已停止') {
      updateSnapshot({ error: message })
      notify(message, { variant: 'danger' })
    }
  } finally {
    if (currentGeneration === generation) {
      updateSnapshot({ testing: false, cancelling: false, progress: undefined })
      releaseMemoryIfIdle()
    }
  }
}

export async function stopCodexTest(): Promise<void> {
  if (!snapshot.testing || snapshot.cancelling) return
  updateSnapshot({ cancelling: true })
  try {
    await cancelMihomoCodexTest()
  } finally {
    if (snapshot.testing) updateSnapshot({ cancelling: false })
  }
}

function resetCodexTestStore(): void {
  generation++
  clearPendingProgress()
  if (snapshot.testing) void cancelMihomoCodexTest()
  persistedHistory = readTestHistory<PersistedCodexTestHistory>(CODEX_TEST_HISTORY_KEY)
  snapshot = createIdleSnapshot()
  memoryReleased = false
  listeners.forEach((listener) => listener())
  releaseMemoryIfIdle()
}

const unsubscribeProgress = window.electron.ipcRenderer.on(
  'mihomoCodexTestProgress',
  (_event, progress: CodexTestProgress) => {
    if (!snapshot.testing) return
    pendingProgress = progress
    if (progress.result) pendingResults[progress.result.proxy] = progress.result
    if (progressTimer === undefined) {
      progressTimer = window.setTimeout(flushProgress, progressFlushInterval)
    }
  }
)
const unsubscribeCoreStarted = window.electron.ipcRenderer.on('core-started', resetCodexTestStore)

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    clearPendingProgress()
    unsubscribeProgress()
    unsubscribeCoreStarted()
  })
}
