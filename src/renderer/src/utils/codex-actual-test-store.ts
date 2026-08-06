import {
  getCodexTestSnapshot as getCodexTestSnapshotFromMain,
  startCodexActualTest,
  stopCodexTest as stopCodexTestFromMain
} from '@renderer/utils/ipc'
import { notify } from '@renderer/utils/notification'

interface CodexActualTestStoreSnapshot {
  results: Record<string, CodexActualTestResult>
  testing: boolean
  cancelling: boolean
  progress?: CodexActualTestProgress
  error?: string
  groupName?: string
  savedAt?: number
  logs: CodexActualTestLogEntry[]
  status?: CodexTestRunStatus
}

const EMPTY_SNAPSHOT: CodexActualTestStoreSnapshot = {
  results: {},
  testing: false,
  cancelling: false,
  logs: []
}

let snapshot: CodexActualTestStoreSnapshot = EMPTY_SNAPSHOT
let lastRunId: string | undefined
let lastUpdatedAt = 0
let hydrated = false
let hydrationPromise: Promise<void> | undefined
const listeners = new Set<() => void>()
const notifiedRunStatuses = new Set<string>()

function updateSnapshot(next: CodexActualTestStoreSnapshot, runId?: string, updatedAt = 0): void {
  if (updatedAt < lastUpdatedAt) return
  if (runId && runId === lastRunId && updatedAt === lastUpdatedAt) return

  const previous = snapshot
  snapshot = next
  lastRunId = runId
  lastUpdatedAt = updatedAt

  if (
    runId &&
    !next.testing &&
    previous.testing &&
    !notifiedRunStatuses.has(`${runId}:${next.savedAt || updatedAt}`)
  ) {
    notifiedRunStatuses.add(`${runId}:${next.savedAt || updatedAt}`)
    if (next.error) {
      notify(next.error, { variant: 'danger' })
    } else if (next.status === 'stopped') {
      notify('Codex 真实响应测试已停止', { variant: 'warning' })
    } else if (next.status === 'failed') {
      notify('Codex 真实响应测试失败', { variant: 'danger' })
    } else {
      const succeeded = Object.values(next.results).filter((result) => result.succeeded > 0).length
      const total = Object.keys(next.results).length
      notify(`Codex 真实响应测试完成 ${succeeded}/${total}`, {
        variant: succeeded > 0 ? 'success' : 'danger'
      })
    }
  }

  listeners.forEach((listener) => listener())
}

function applyMainSnapshot(value: CodexTestSnapshot | undefined): void {
  if (!value || value.mode !== 'actual') return
  updateSnapshot(
    {
      results: value.results as Record<string, CodexActualTestResult>,
      testing: value.testing,
      cancelling: value.cancelling,
      progress: value.progress as CodexActualTestProgress | undefined,
      error: value.error,
      groupName: value.groupName,
      savedAt: value.savedAt,
      logs: value.logs || [],
      status: value.status
    },
    value.runId,
    value.updatedAt
  )
}

async function hydrateFromMain(): Promise<void> {
  if (hydrated || hydrationPromise) return hydrationPromise
  hydrationPromise = getCodexTestSnapshotFromMain('actual')
    .then((value) => {
      applyMainSnapshot(value)
      hydrated = true
    })
    .catch((error) => {
      notify(`读取 Codex 真实响应测试状态失败：${String(error)}`, { variant: 'danger' })
    })
    .finally(() => {
      hydrationPromise = undefined
    })
  return hydrationPromise
}

export function subscribeCodexActualTestStore(listener: () => void): () => void {
  listeners.add(listener)
  void hydrateFromMain()
  return () => {
    listeners.delete(listener)
  }
}

export function getCodexActualTestSnapshot(): CodexActualTestStoreSnapshot {
  return snapshot
}

export async function runCodexActualTest(
  proxies: string[],
  rounds = 1,
  concurrency = 2,
  groupName?: string,
  options: CodexActualTestOptions = {}
): Promise<void> {
  if (snapshot.testing) {
    notify('已有 Codex 真实响应测试正在进行')
    return
  }
  if (proxies.length === 0) {
    notify('请至少选择一个节点', { variant: 'warning' })
    return
  }

  try {
    const value = await startCodexActualTest(proxies, rounds, concurrency, groupName, options)
    applyMainSnapshot(value)
  } catch (error) {
    notify(String(error), { variant: 'danger' })
  }
}

export async function stopCodexActualTest(): Promise<void> {
  if (!snapshot.testing || snapshot.cancelling) return
  await stopCodexTestFromMain('actual')
}

const unsubscribeSnapshot = window.electron.ipcRenderer.on(
  'codexTestSnapshot',
  (_event, value: CodexTestSnapshot) => applyMainSnapshot(value)
)

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unsubscribeSnapshot()
  })
}
