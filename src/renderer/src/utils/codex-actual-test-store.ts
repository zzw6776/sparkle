import { cancelMihomoCodexActualTest, mihomoCodexActualTest } from '@renderer/utils/ipc'
import { notify } from '@renderer/utils/notification'
import { readTestHistory, writeTestHistory } from '@renderer/utils/test-history'
import { formatLatency } from '@renderer/utils/format-latency'

const CODEX_ACTUAL_TEST_HISTORY_KEY = 'sparkle:codex-actual-test-history'

interface PersistedCodexActualTestHistory {
  groupName?: string
  savedAt: number
  results: Record<string, CodexActualTestResult>
  logs?: CodexActualTestLogEntry[]
}

interface CodexActualTestStoreSnapshot {
  results: Record<string, CodexActualTestResult>
  testing: boolean
  cancelling: boolean
  progress?: CodexActualTestProgress
  error?: string
  groupName?: string
  savedAt?: number
  logs: CodexActualTestLogEntry[]
}

let persistedHistory = readTestHistory<PersistedCodexActualTestHistory>(
  CODEX_ACTUAL_TEST_HISTORY_KEY
)

function createIdleSnapshot(): CodexActualTestStoreSnapshot {
  return {
    results: persistedHistory?.results || {},
    groupName: persistedHistory?.groupName,
    savedAt: persistedHistory?.savedAt,
    logs: persistedHistory?.logs || [],
    testing: false,
    cancelling: false
  }
}

let snapshot = createIdleSnapshot()
let generation = 0
let nextLogId = 0
const listeners = new Set<() => void>()

function logEntry(
  message: string,
  level: CodexActualTestLogLevel = 'info',
  context?: { proxy?: string; round?: number }
): CodexActualTestLogEntry {
  return {
    id: `${Date.now()}-${nextLogId++}`,
    timestamp: Date.now(),
    level,
    message,
    ...context
  }
}

function appendLog(entry: CodexActualTestLogEntry): CodexActualTestLogEntry[] {
  const logs = [...snapshot.logs, entry].slice(-300)
  updateSnapshot({ logs })
  return logs
}

function metric(value?: number): string {
  return formatLatency(value)
}

function progressLogs(progress: CodexActualTestProgress): CodexActualTestLogEntry[] {
  const context = { proxy: progress.proxy, round: progress.round }
  if (progress.stage === 'selecting') {
    return [logEntry('正在切换隐藏测速通道并关闭旧连接', 'info', context)]
  }
  if (progress.stage === 'starting') {
    return [logEntry('正在启动或复用独立 Codex 后台', 'info', context)]
  }
  if (progress.stage === 'requesting') {
    const unavailableHint = '未获取到（若刚更新测试功能，请重启 Sparkle 后重试）'
    return [
      logEntry(`模型：${progress.model || unavailableHint}`, 'info', context),
      logEntry(`发送：${progress.request || unavailableHint}`, 'info', context),
      logEntry('真实请求已发送，正在等待 Codex 返回', 'info', context)
    ]
  }
  if (progress.stage === 'streaming') {
    return [logEntry('已收到首个响应片段', 'info', context)]
  }

  const roundResult = progress.result?.roundResults.find((item) => item.round === progress.round)
  if (!roundResult) {
    return [logEntry('本轮已结束，但没有收到详细结果', 'error', context)]
  }
  const route = roundResult.routeVerified ? '路由已验证' : '路由未验证'
  const tokens = roundResult.tokenUsage?.totalTokens ?? 0
  const reply = logEntry(`回复：${roundResult.response || '未收到文本回复'}`, 'info', context)
  if (!roundResult.success) {
    return [
      reply,
      logEntry(
        `失败：${roundResult.error || '未知错误'}；${route}；完整 ${metric(roundResult.totalMs)}；Token ${tokens}`,
        'error',
        context
      )
    ]
  }
  return [
    reply,
    logEntry(
      `成功：首字 ${metric(roundResult.firstTokenMs)}；完整 ${metric(roundResult.totalMs)}；${route}；Token ${tokens}`,
      'success',
      context
    )
  ]
}

function updateSnapshot(patch: Partial<CodexActualTestStoreSnapshot>): void {
  snapshot = { ...snapshot, ...patch }
  listeners.forEach((listener) => listener())
}

export function subscribeCodexActualTestStore(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getCodexActualTestSnapshot(): CodexActualTestStoreSnapshot {
  return snapshot
}

export async function runCodexActualTest(
  proxies: string[],
  rounds = 1,
  concurrency = 2,
  groupName?: string
): Promise<void> {
  if (snapshot.testing) {
    notify('已有 Codex 真实响应测试正在进行')
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
    logs: [logEntry(`开始测试 ${proxies.length} 个节点，共 ${rounds} 轮，并发 ${concurrency}`)],
    groupName,
    testing: true,
    cancelling: false,
    progress: undefined,
    error: undefined
  })

  try {
    const results = await mihomoCodexActualTest(proxies, rounds, concurrency)
    if (currentGeneration !== generation) return
    const resultMap = Object.fromEntries(results.map((result) => [result.proxy, result]))
    const savedAt = Date.now()
    const logs = appendLog(
      logEntry(
        `测试完成：${results.filter((result) => result.succeeded > 0).length}/${results.length} 个节点至少成功 1 轮`,
        results.some((result) => result.succeeded > 0) ? 'success' : 'error'
      )
    )
    persistedHistory = { groupName, savedAt, results: resultMap, logs }
    writeTestHistory(CODEX_ACTUAL_TEST_HISTORY_KEY, persistedHistory)
    updateSnapshot({ results: resultMap, groupName, savedAt })
    const succeeded = results.filter((result) => result.succeeded > 0).length
    notify(`Codex 真实响应测试完成 ${succeeded}/${results.length}`, {
      variant: succeeded > 0 ? 'success' : 'danger'
    })
  } catch (error) {
    if (currentGeneration !== generation) return
    const message = String(error)
    updateSnapshot(previous)
    if (message === 'Codex 真实响应测试已停止') {
      appendLog(logEntry('测试已由用户停止'))
    } else {
      appendLog(logEntry(`测试异常终止：${message}`, 'error'))
      updateSnapshot({ error: message })
      notify(message, { variant: 'danger' })
    }
  } finally {
    if (currentGeneration === generation) {
      if (
        snapshot.logs.length > 0 &&
        persistedHistory?.logs?.at(-1)?.id !== snapshot.logs.at(-1)?.id
      ) {
        const savedAt = snapshot.savedAt || Date.now()
        persistedHistory = {
          groupName: snapshot.groupName || groupName,
          savedAt,
          results: snapshot.results,
          logs: snapshot.logs
        }
        writeTestHistory(CODEX_ACTUAL_TEST_HISTORY_KEY, persistedHistory)
        updateSnapshot({ savedAt })
      }
      updateSnapshot({ testing: false, cancelling: false, progress: undefined })
    }
  }
}

export async function stopCodexActualTest(): Promise<void> {
  if (!snapshot.testing || snapshot.cancelling) return
  updateSnapshot({ cancelling: true })
  try {
    await cancelMihomoCodexActualTest()
  } finally {
    if (snapshot.testing) updateSnapshot({ cancelling: false })
  }
}

function resetCodexActualTestStore(): void {
  generation++
  if (snapshot.testing) void cancelMihomoCodexActualTest()
  snapshot = createIdleSnapshot()
  listeners.forEach((listener) => listener())
}

const unsubscribeProgress = window.electron.ipcRenderer.on(
  'mihomoCodexActualTestProgress',
  (_event, progress: CodexActualTestProgress) => {
    if (!snapshot.testing) return
    const logs = [...snapshot.logs, ...progressLogs(progress)].slice(-300)
    updateSnapshot({
      progress,
      logs,
      results: progress.result
        ? { ...snapshot.results, [progress.result.proxy]: progress.result }
        : snapshot.results
    })
  }
)
const unsubscribeCoreStarted = window.electron.ipcRenderer.on(
  'core-started',
  resetCodexActualTestStore
)

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unsubscribeProgress()
    unsubscribeCoreStarted()
  })
}
