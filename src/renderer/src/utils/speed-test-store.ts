import {
  cancelMihomoProxySpeedTest,
  mihomoGeneralSpeedTest,
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

interface GroupSpeedTestOptions {
  notifyResult?: boolean
  onProxyCompleted?: (proxy: string, result?: SpeedTestResult, error?: string) => void
}

interface ConcurrentGroupSpeedTestOptions {
  onProxyCompleted?: (
    proxy: string,
    round: number,
    result?: SpeedTestResult,
    error?: string
  ) => void
}

type ConcurrentGroupSpeedTestOutcome = 'completed' | 'cancelled' | 'failed'

function createInitialSnapshot(): SpeedTestStoreSnapshot {
  return {
    tests: {},
    progresses: {},
    errors: {},
    testing: new Set(),
    busy: false
  }
}

let snapshot = createInitialSnapshot()
let cancelRequested = false
let storeGeneration = 0
let concurrentCompletionHandler: ConcurrentGroupSpeedTestOptions['onProxyCompleted']
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

export function clearSpeedTestResults(proxies: string[]): void {
  if (snapshot.busy || snapshot.activeGroup) return

  const tests = { ...snapshot.tests }
  const progresses = { ...snapshot.progresses }
  const errors = { ...snapshot.errors }
  proxies.forEach((proxy) => {
    delete tests[proxy]
    delete progresses[proxy]
    delete errors[proxy]
  })
  updateSnapshot({ tests, progresses, errors })
}

function resetSpeedTestStore(): void {
  storeGeneration++
  cancelRequested = false
  concurrentCompletionHandler = undefined
  snapshot = createInitialSnapshot()
  listeners.forEach((listener) => listener())
}

const unsubscribeProgress = window.electron.ipcRenderer.on(
  'mihomoProxySpeedTestProgress',
  (_event, progress: SpeedTestProgress) => {
    if (!snapshot.testing.has(progress.proxy)) return
    updateSnapshot({
      progresses: { ...snapshot.progresses, [progress.proxy]: progress }
    })
  }
)
const unsubscribeGeneralProgress = window.electron.ipcRenderer.on(
  'mihomoGeneralSpeedTestProgress',
  (_event, progress: GeneralSpeedTestProgress) => {
    if (!concurrentCompletionHandler) return

    const testing = new Set(snapshot.testing)
    const progresses = { ...snapshot.progresses }
    const tests = { ...snapshot.tests }
    const errors = { ...snapshot.errors }

    if (progress.stage === 'selecting') {
      testing.add(progress.proxy)
      delete progresses[progress.proxy]
      delete tests[progress.proxy]
      delete errors[progress.proxy]
    } else if (progress.stage === 'downloading') {
      testing.add(progress.proxy)
      if (
        progress.bytesPerSecond !== undefined &&
        progress.downloadedBytes !== undefined &&
        progress.duration !== undefined
      ) {
        progresses[progress.proxy] = {
          proxy: progress.proxy,
          bytesPerSecond: progress.bytesPerSecond,
          downloadedBytes: progress.downloadedBytes,
          duration: progress.duration
        }
      }
    } else {
      testing.delete(progress.proxy)
      delete progresses[progress.proxy]
      if (progress.result) tests[progress.proxy] = progress.result
      if (progress.error) errors[progress.proxy] = progress.error
      concurrentCompletionHandler(progress.proxy, progress.round, progress.result, progress.error)
    }

    updateSnapshot({ testing, progresses, tests, errors })
  }
)
const unsubscribeCoreStarted = window.electron.ipcRenderer.on('core-started', resetSpeedTestStore)

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unsubscribeProgress()
    unsubscribeGeneralProgress()
    unsubscribeCoreStarted()
  })
}

async function executeProxySpeedTest(
  proxy: string,
  showError: boolean
): Promise<SpeedTestResult | undefined> {
  if (snapshot.busy) {
    if (showError) notify('已有下载测速正在进行')
    return undefined
  }

  const generation = storeGeneration
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
    if (generation !== storeGeneration) return undefined
    updateSnapshot({ tests: { ...snapshot.tests, [proxy]: result } })
    return result
  } catch (error) {
    if (generation !== storeGeneration) return undefined
    const message = String(error)
    if (message === '测速已停止') return undefined

    updateSnapshot({ errors: { ...snapshot.errors, [proxy]: message } })
    if (showError) notify(message, { variant: 'danger' })
    return undefined
  } finally {
    if (generation === storeGeneration) {
      const testing = new Set(snapshot.testing)
      const nextProgresses = { ...snapshot.progresses }
      testing.delete(proxy)
      delete nextProgresses[proxy]
      updateSnapshot({ busy: false, testing, progresses: nextProgresses })
    }
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

  const generation = storeGeneration
  cancelRequested = false
  await executeProxySpeedTest(proxy, true)
  if (generation === storeGeneration) cancelRequested = false
}

export async function runConcurrentGroupSpeedTest(
  group: string,
  proxies: string[],
  rounds: number,
  nodeConcurrency: number,
  options: ConcurrentGroupSpeedTestOptions = {}
): Promise<ConcurrentGroupSpeedTestOutcome> {
  if (snapshot.busy || snapshot.activeGroup) {
    notify('已有下载测速正在进行')
    return 'failed'
  }
  if (proxies.length === 0) return 'failed'

  const generation = storeGeneration
  const tests = { ...snapshot.tests }
  const progresses = { ...snapshot.progresses }
  const errors = { ...snapshot.errors }
  proxies.forEach((proxy) => {
    delete tests[proxy]
    delete progresses[proxy]
    delete errors[proxy]
  })
  concurrentCompletionHandler = options.onProxyCompleted ?? (() => {})
  updateSnapshot({
    activeGroup: group,
    busy: true,
    testing: new Set(),
    tests,
    progresses,
    errors
  })

  try {
    await mihomoGeneralSpeedTest(proxies, rounds, nodeConcurrency)
    return 'completed'
  } catch (error) {
    if (String(error) === '测速已停止') return 'cancelled'
    notify(error, { variant: 'danger' })
    return 'failed'
  } finally {
    if (generation === storeGeneration) {
      concurrentCompletionHandler = undefined
      const tests = { ...snapshot.tests }
      const errors = { ...snapshot.errors }
      proxies.forEach((proxy) => {
        delete tests[proxy]
        delete errors[proxy]
      })
      updateSnapshot({
        activeGroup: undefined,
        busy: false,
        testing: new Set(),
        progresses: {},
        tests,
        errors
      })
    }
  }
}

export async function stopConcurrentGroupSpeedTest(): Promise<void> {
  await cancelMihomoProxySpeedTest()
}

export async function toggleGroupSpeedTest(
  group: string,
  proxies: string[],
  options: GroupSpeedTestOptions = {}
): Promise<void> {
  const { notifyResult = true, onProxyCompleted } = options
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

  const generation = storeGeneration
  cancelRequested = false
  updateSnapshot({ activeGroup: group })
  let succeeded = 0

  try {
    for (const proxy of proxies) {
      if (cancelRequested || generation !== storeGeneration) break
      const result = await executeProxySpeedTest(proxy, false)
      if (result) succeeded++
      const error = snapshot.errors[proxy]
      if (result || error) onProxyCompleted?.(proxy, result, error)
    }

    if (generation !== storeGeneration) {
      return
    } else if (!notifyResult) {
      return
    } else if (cancelRequested) {
      notify(`下载测速已停止，已完成 ${succeeded}/${proxies.length}`)
    } else {
      notify(`下载测速完成 ${succeeded}/${proxies.length}`, {
        variant: succeeded > 0 ? 'success' : 'danger'
      })
    }
  } finally {
    if (generation === storeGeneration) {
      cancelRequested = false
      updateSnapshot({ activeGroup: undefined })
    }
  }
}
