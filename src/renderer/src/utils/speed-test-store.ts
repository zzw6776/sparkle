import {
  cancelMihomoProxySpeedTest,
  mihomoProxySpeedTest
} from '@renderer/utils/ipc'
import { notify } from '@renderer/utils/notification'

interface SpeedTestStoreSnapshot {
  tests: Record<string, SpeedTestResult>
  progresses: Record<string, SpeedTestProgress>
  errors: Record<string, string>
  testing: ReadonlySet<string>
  activeGroup?: string
  busy: boolean
}

let snapshot: SpeedTestStoreSnapshot = {
  tests: {},
  progresses: {},
  errors: {},
  testing: new Set(),
  busy: false
}
let cancelRequested = false
const listeners = new Set<() => void>()

function updateSnapshot(patch: Partial<SpeedTestStoreSnapshot>): void {
  snapshot = { ...snapshot, ...patch }
  listeners.forEach((listener) => listener())
}

export function subscribeSpeedTestStore(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getSpeedTestSnapshot(): SpeedTestStoreSnapshot {
  return snapshot
}

const unsubscribeProgress = window.electron.ipcRenderer.on(
  'mihomoProxySpeedTestProgress',
  (_event, progress: SpeedTestProgress) => {
    updateSnapshot({
      progresses: { ...snapshot.progresses, [progress.proxy]: progress }
    })
  }
)

if (import.meta.hot) {
  import.meta.hot.dispose(unsubscribeProgress)
}

async function executeProxySpeedTest(proxy: string, showError: boolean): Promise<boolean> {
  if (snapshot.busy) {
    if (showError) notify('已有下载测速正在进行')
    return false
  }

  const progresses = { ...snapshot.progresses }
  const errors = { ...snapshot.errors }
  const tests = { ...snapshot.tests }
  delete progresses[proxy]
  delete errors[proxy]
  delete tests[proxy]
  updateSnapshot({
    busy: true,
    testing: new Set(snapshot.testing).add(proxy),
    tests,
    progresses,
    errors
  })

  try {
    const result = await mihomoProxySpeedTest(proxy)
    updateSnapshot({ tests: { ...snapshot.tests, [proxy]: result } })
    return true
  } catch (error) {
    const message = String(error)
    if (message === '测速已停止') return false

    updateSnapshot({ errors: { ...snapshot.errors, [proxy]: message } })
    if (showError) notify(message, { variant: 'danger' })
    return false
  } finally {
    const testing = new Set(snapshot.testing)
    const nextProgresses = { ...snapshot.progresses }
    testing.delete(proxy)
    delete nextProgresses[proxy]
    updateSnapshot({ busy: false, testing, progresses: nextProgresses })
  }
}

export async function toggleProxySpeedTest(proxy: string): Promise<void> {
  if (snapshot.busy) {
    if (snapshot.testing.has(proxy)) {
      cancelRequested = true
      await cancelMihomoProxySpeedTest()
    } else {
      notify('已有下载测速正在进行')
    }
    return
  }

  if (snapshot.activeGroup) {
    notify('已有下载测速正在进行')
    return
  }

  cancelRequested = false
  await executeProxySpeedTest(proxy, true)
  cancelRequested = false
}

export async function toggleGroupSpeedTest(group: string, proxies: string[]): Promise<void> {
  if (snapshot.activeGroup === group) {
    cancelRequested = true
    await cancelMihomoProxySpeedTest()
    return
  }

  if (snapshot.busy || snapshot.activeGroup) {
    notify('已有下载测速正在进行')
    return
  }
  if (proxies.length === 0) return

  cancelRequested = false
  updateSnapshot({ activeGroup: group })
  let succeeded = 0

  try {
    for (const proxy of proxies) {
      if (cancelRequested) break
      if (await executeProxySpeedTest(proxy, false)) succeeded++
    }

    if (cancelRequested) {
      notify(`下载测速已停止，已完成 ${succeeded}/${proxies.length}`)
    } else {
      notify(`下载测速完成 ${succeeded}/${proxies.length}`, {
        variant: succeeded > 0 ? 'success' : 'danger'
      })
    }
  } finally {
    cancelRequested = false
    updateSnapshot({ activeGroup: undefined })
  }
}
