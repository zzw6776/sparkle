export function readTestHistory<T>(key: string): T | undefined {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as { version?: number; value?: T }
    return parsed.version === 1 ? parsed.value : undefined
  } catch {
    return undefined
  }
}

export function writeTestHistory<T>(key: string, value: T): void {
  try {
    window.localStorage.setItem(key, JSON.stringify({ version: 1, value }))
  } catch {
    // 测速结果仍保留在当前会话内，存储空间不足不影响本次测试。
  }
}

export function formatTestHistoryTime(timestamp?: number): string {
  if (!timestamp) return ''
  return new Date(timestamp).toLocaleString()
}
