import { cancelMihomoProcessTest, mihomoProcessTest } from '@renderer/utils/ipc'
import { notify } from '@renderer/utils/notification'
import { readTestHistory, writeTestHistory } from '@renderer/utils/test-history'

const PROCESS_TEST_HISTORY_KEY = 'sparkle:process-test-history'

interface PersistedProcessTestHistory {
  processKeys?: string[]
  processKey?: string
  savedAt: number
  results: Record<string, ProcessTestResult>
}

interface ProcessTestStoreSnapshot {
  results: Record<string, ProcessTestResult>
  testing: boolean
  cancelling: boolean
  progress?: ProcessTestProgress
  error?: string
  processKeys?: string[]
  savedAt?: number
}

let persistedHistory = readTestHistory<PersistedProcessTestHistory>(PROCESS_TEST_HISTORY_KEY)

function createIdleSnapshot(): ProcessTestStoreSnapshot {
  return {
    results: persistedHistory?.results || {},
    processKeys:
      persistedHistory?.processKeys ||
      (persistedHistory?.processKey ? [persistedHistory.processKey] : undefined),
    savedAt: persistedHistory?.savedAt,
    testing: false,
    cancelling: false
  }
}

let snapshot = createIdleSnapshot()
let generation = 0
const listeners = new Set<() => void>()
let pendingProgress: ProcessTestProgress | undefined
let pendingResults: Record<string, ProcessTestResult> = {}
let progressTimer: number | undefined
let progressFlushInterval = 100

function updateSnapshot(patch: Partial<ProcessTestStoreSnapshot>): void {
  snapshot = { ...snapshot, ...patch }
  listeners.forEach((listener) => listener())
}

function flushProcessTestProgress(): void {
  if (progressTimer !== undefined) window.clearTimeout(progressTimer)
  progressTimer = undefined
  if (!pendingProgress) return
  const progress = pendingProgress
  const results = pendingResults
  pendingProgress = undefined
  pendingResults = {}
  if (!snapshot.testing) return
  updateSnapshot({ progress, results: { ...snapshot.results, ...results } })
}

function clearPendingProcessTestProgress(): void {
  if (progressTimer !== undefined) window.clearTimeout(progressTimer)
  progressTimer = undefined
  pendingProgress = undefined
  pendingResults = {}
}

export function subscribeProcessTestStore(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getProcessTestSnapshot(): ProcessTestStoreSnapshot {
  return snapshot
}

export async function runProcessTest(
  proxies: string[],
  targets: ProcessTestTargetRequest[],
  rounds = 3,
  concurrency = 6,
  processKeys: string[] = []
): Promise<void> {
  if (snapshot.testing) {
    notify('已有进程测速正在进行')
    return
  }
  if (proxies.length === 0) {
    notify('请至少选择一个节点', { variant: 'warning' })
    return
  }
  if (targets.length === 0) {
    notify('请至少选择一个目标域名', { variant: 'warning' })
    return
  }

  const currentGeneration = generation
  progressFlushInterval = proxies.length > 30 ? 500 : 100
  const previous = {
    results: snapshot.results,
    processKeys: snapshot.processKeys,
    savedAt: snapshot.savedAt
  }
  updateSnapshot({
    results: {},
    processKeys,
    testing: true,
    cancelling: false,
    progress: undefined,
    error: undefined
  })
  try {
    const results = await mihomoProcessTest(proxies, targets, rounds, concurrency)
    if (currentGeneration !== generation) return
    clearPendingProcessTestProgress()
    const resultMap = Object.fromEntries(results.map((result) => [result.proxy, result]))
    const savedAt = Date.now()
    persistedHistory = { processKeys, savedAt, results: resultMap }
    writeTestHistory(PROCESS_TEST_HISTORY_KEY, persistedHistory)
    updateSnapshot({ results: resultMap, processKeys, savedAt })
    const succeeded = results.filter((result) => result.successRate > 0).length
    notify(`进程测速完成 ${succeeded}/${results.length}`, {
      variant: succeeded > 0 ? 'success' : 'danger'
    })
  } catch (error) {
    if (currentGeneration !== generation) return
    clearPendingProcessTestProgress()
    const message = String(error)
    updateSnapshot(previous)
    if (message !== '进程测速已停止') {
      updateSnapshot({ error: message })
      notify(message, { variant: 'danger' })
    }
  } finally {
    if (currentGeneration === generation) {
      updateSnapshot({ testing: false, cancelling: false, progress: undefined })
    }
  }
}

export async function stopProcessTest(): Promise<void> {
  if (!snapshot.testing || snapshot.cancelling) return
  updateSnapshot({ cancelling: true })
  try {
    await cancelMihomoProcessTest()
  } finally {
    if (snapshot.testing) updateSnapshot({ cancelling: false })
  }
}

function resetProcessTestStore(): void {
  generation++
  clearPendingProcessTestProgress()
  if (snapshot.testing) void cancelMihomoProcessTest()
  snapshot = createIdleSnapshot()
  listeners.forEach((listener) => listener())
}

const unsubscribeProgress = window.electron.ipcRenderer.on(
  'mihomoProcessTestProgress',
  (_event, progress: ProcessTestProgress) => {
    if (!snapshot.testing) return
    if (progress.total > 100) progressFlushInterval = 500
    pendingProgress = progress
    if (progress.result) pendingResults[progress.result.proxy] = progress.result
    if (progressTimer === undefined) {
      progressTimer = window.setTimeout(flushProcessTestProgress, progressFlushInterval)
    }
  }
)
const unsubscribeCoreStarted = window.electron.ipcRenderer.on('core-started', resetProcessTestStore)

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    clearPendingProcessTestProgress()
    unsubscribeProgress()
    unsubscribeCoreStarted()
  })
}
