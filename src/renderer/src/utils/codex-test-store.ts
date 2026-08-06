import {
  getCodexTestSnapshot as getCodexTestSnapshotFromMain,
  startCodexTest,
  stopCodexTest as stopCodexTestFromMain
} from '@renderer/utils/ipc'
import { notify } from '@renderer/utils/notification'

interface CodexTestStoreSnapshot {
  results: Record<string, CodexTestResult>
  testing: boolean
  cancelling: boolean
  status?: CodexTestRunStatus
  progress?: CodexTestProgress
  error?: string
  groupName?: string
  savedAt?: number
}

const EMPTY_SNAPSHOT: CodexTestStoreSnapshot = {
  results: {},
  testing: false,
  cancelling: false
}

let snapshot: CodexTestStoreSnapshot = EMPTY_SNAPSHOT
let lastRunId: string | undefined
let lastUpdatedAt = 0
let hydrated = false
let hydrationPromise: Promise<void> | undefined
const listeners = new Set<() => void>()
const notifiedRunStatuses = new Set<string>()

function updateSnapshot(next: CodexTestStoreSnapshot, runId?: string, updatedAt = 0): void {
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
      notify('Codex 测试已停止', { variant: 'warning' })
    } else if (next.status === 'failed') {
      notify('Codex 测试失败', { variant: 'danger' })
    } else {
      const succeeded = Object.values(next.results).filter((result) => result.succeeded > 0).length
      const total = Object.keys(next.results).length
      notify(`Codex 测试完成 ${succeeded}/${total}`, {
        variant: succeeded > 0 ? 'success' : 'danger'
      })
    }
  }

  listeners.forEach((listener) => listener())
}

function applyMainSnapshot(value: CodexTestSnapshot | undefined): void {
  if (!value || value.mode !== 'link') return
  updateSnapshot(
    {
      results: value.results as Record<string, CodexTestResult>,
      testing: value.testing,
      cancelling: value.cancelling,
      status: value.status,
      progress: value.progress as CodexTestProgress | undefined,
      error: value.error,
      groupName: value.groupName,
      savedAt: value.savedAt
    },
    value.runId,
    value.updatedAt
  )
}

async function hydrateFromMain(): Promise<void> {
  if (hydrated || hydrationPromise) return hydrationPromise
  hydrationPromise = getCodexTestSnapshotFromMain('link')
    .then((value) => {
      applyMainSnapshot(value)
      hydrated = true
    })
    .catch((error) => {
      notify(`读取 Codex 测试状态失败：${String(error)}`, { variant: 'danger' })
    })
    .finally(() => {
      hydrationPromise = undefined
    })
  return hydrationPromise
}

export function subscribeCodexTestStore(listener: () => void): () => void {
  listeners.add(listener)
  void hydrateFromMain()
  return () => {
    listeners.delete(listener)
  }
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

  try {
    const value = await startCodexTest(proxies, rounds, concurrency, groupName)
    applyMainSnapshot(value)
  } catch (error) {
    notify(String(error), { variant: 'danger' })
  }
}

export async function stopCodexTest(): Promise<void> {
  if (!snapshot.testing || snapshot.cancelling) return
  await stopCodexTestFromMain('link')
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
