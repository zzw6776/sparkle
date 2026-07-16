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
let generation = 0
const listeners = new Set<() => void>()

function updateSnapshot(patch: Partial<CodexTestStoreSnapshot>): void {
  snapshot = { ...snapshot, ...patch }
  listeners.forEach((listener) => listener())
}

export function subscribeCodexTestStore(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getCodexTestSnapshot(): CodexTestStoreSnapshot {
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
    const resultMap = Object.fromEntries(results.map((result) => [result.proxy, result]))
    const savedAt = Date.now()
    persistedHistory = { groupName, savedAt, results: resultMap }
    writeTestHistory(CODEX_TEST_HISTORY_KEY, persistedHistory)
    updateSnapshot({ results: resultMap, groupName, savedAt })
    const succeeded = results.filter((result) => result.succeeded > 0).length
    notify(`Codex 测试完成 ${succeeded}/${results.length}`, {
      variant: succeeded > 0 ? 'success' : 'danger'
    })
  } catch (error) {
    if (currentGeneration !== generation) return
    const message = String(error)
    updateSnapshot(previous)
    if (message !== 'Codex 测试已停止') {
      updateSnapshot({ error: message })
      notify(message, { variant: 'danger' })
    }
  } finally {
    if (currentGeneration === generation) {
      updateSnapshot({ testing: false, cancelling: false, progress: undefined })
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
  if (snapshot.testing) void cancelMihomoCodexTest()
  snapshot = createIdleSnapshot()
  listeners.forEach((listener) => listener())
}

const unsubscribeProgress = window.electron.ipcRenderer.on(
  'mihomoCodexTestProgress',
  (_event, progress: CodexTestProgress) => {
    if (!snapshot.testing) return
    updateSnapshot({
      progress,
      results: progress.result
        ? { ...snapshot.results, [progress.result.proxy]: progress.result }
        : snapshot.results
    })
  }
)
const unsubscribeCoreStarted = window.electron.ipcRenderer.on('core-started', resetCodexTestStore)

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unsubscribeProgress()
    unsubscribeCoreStarted()
  })
}
