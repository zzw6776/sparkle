import { addProfileItem, getCurrentProfileItem, getProfileConfig, getProfileItem } from '../config'
import { appendAppLog } from '../utils/log'

const intervalPool: Record<string, NodeJS.Timeout> = {}
const MAX_TIMEOUT_MS = 2147483647 // 32-bit signed integer max (~24.85 days)
const MAX_INTERVAL_MINUTES = 35791 // 24.85 days in minutes (~2147483647 ms)

export function normalizeInterval(rawInterval?: number): number {
  if (!rawInterval || rawInterval <= 0 || isNaN(rawInterval)) {
    return 0
  }
  // 容错：若历史数据或异常值为毫秒/秒，自动换算为分钟
  if (rawInterval >= 3600000) {
    return Math.min(MAX_INTERVAL_MINUTES, Math.round(rawInterval / 60000))
  }
  if (rawInterval >= 86400) {
    return Math.min(MAX_INTERVAL_MINUTES, Math.round(rawInterval / 60))
  }
  return Math.min(MAX_INTERVAL_MINUTES, Math.round(rawInterval))
}

export function calculateUpdateDelay(item: ProfileItem): number {
  const intervalMinutes = normalizeInterval(item.interval)
  if (intervalMinutes <= 0 || item.autoUpdate === false || item.type !== 'remote') {
    return -1
  }

  const now = Date.now()
  const lastUpdated = item.updated || 0
  const intervalMs = Math.min(intervalMinutes * 60 * 1000, MAX_TIMEOUT_MS)
  const timeSinceLastUpdate = now - lastUpdated

  if (timeSinceLastUpdate >= intervalMs) {
    return 0
  }

  return Math.min(intervalMs - timeSinceLastUpdate, MAX_TIMEOUT_MS)
}

async function triggerProfileUpdate(id: string): Promise<void> {
  const item = await getProfileItem(id)
  if (!item || item.type !== 'remote' || !item.url || item.autoUpdate === false || !item.interval) {
    await delProfileUpdater(id)
    return
  }

  try {
    await addProfileItem(item)
    // 成功后 addProfileItem 会调用 addProfileUpdater(newItem) 调度下一次周期
  } catch (error) {
    await appendAppLog(`[ProfileUpdater]: update profile ${item.name} (${id}) failed: ${error}\n`)
    // 失败退避：5 分钟后重试，避免丢失定时器
    const safeIntervalMinutes = normalizeInterval(item.interval)
    const retryDelay = Math.min(5 * 60 * 1000, safeIntervalMinutes * 60 * 1000)
    scheduleUpdate(id, retryDelay)
  }
}

function scheduleUpdate(id: string, delay: number): void {
  if (intervalPool[id]) {
    clearTimeout(intervalPool[id])
    delete intervalPool[id]
  }

  const safeDelay = Math.min(Math.max(0, delay), MAX_TIMEOUT_MS)

  intervalPool[id] = setTimeout(() => {
    delete intervalPool[id]
    void triggerProfileUpdate(id)
  }, safeDelay)
}

export async function addProfileUpdater(item: ProfileItem): Promise<void> {
  await delProfileUpdater(item.id)

  const delay = calculateUpdateDelay(item)
  if (delay === -1) {
    return
  }

  // 若已到期，延迟 1 秒后异步触发，避免同步堆叠
  scheduleUpdate(item.id, delay === 0 ? 1000 : delay)
}

export async function delProfileUpdater(id: string): Promise<void> {
  if (intervalPool[id]) {
    clearTimeout(intervalPool[id])
    delete intervalPool[id]
  }
}

export async function initProfileUpdater(): Promise<void> {
  const { items, current } = await getProfileConfig()
  const currentItem = await getCurrentProfileItem()

  // 错峰启动：启动时已过期的项错峰延迟 15~20 秒拉取，保证内核与网络已完全就绪
  for (const item of items.filter((i) => i.id !== current)) {
    if (item.type === 'remote' && item.interval && item.autoUpdate !== false) {
      const delay = calculateUpdateDelay(item)
      if (delay === -1) continue

      const initialDelay = delay === 0 ? 15000 : delay
      scheduleUpdate(item.id, initialDelay)
    }
  }

  if (currentItem?.type === 'remote' && currentItem.interval && currentItem.autoUpdate !== false) {
    const delay = calculateUpdateDelay(currentItem)
    if (delay !== -1) {
      const initialDelay = delay === 0 ? 20000 : delay + 10000
      scheduleUpdate(currentItem.id, initialDelay)
    }
  }
}


