import { mihomoGroupDelay, mihomoProxyDelay } from '@renderer/utils/ipc'
import { runDelayTestsWithConcurrency } from '@renderer/utils/delay-test'

interface DelayTestProxy {
  name: string
  provider?: string
}

interface GroupDelayTestOptions {
  group: string
  proxies: DelayTestProxy[]
  url?: string
  useGroupApi: boolean
  concurrency?: number
  onResult?: (proxy: string, delay: number) => void
}

interface DelayTestStoreSnapshot {
  delays: Record<string, number>
  managed: ReadonlySet<string>
  testing: ReadonlySet<string>
  groups: ReadonlySet<string>
}

interface ActiveGroupDelayRun {
  version: number
  run: DelayTestRun
  cancelled: Promise<void>
  cancel: () => void
}

type DelayTestRun = Record<string, number>

let snapshot: DelayTestStoreSnapshot = {
  delays: {},
  managed: new Set(),
  testing: new Set(),
  groups: new Set()
}

const listeners = new Set<() => void>()
const proxyRunVersions = new Map<string, number>()
const groupRunVersions = new Map<string, number>()
const activeGroupRuns = new Map<string, ActiveGroupDelayRun>()
let nextRunVersion = 0

function updateSnapshot(patch: Partial<DelayTestStoreSnapshot>): void {
  snapshot = { ...snapshot, ...patch }
  listeners.forEach((listener) => listener())
}

function clearDelays(proxies: DelayTestProxy[]): DelayTestRun {
  const delays = { ...snapshot.delays }
  const managed = new Set(snapshot.managed)
  const testing = new Set(snapshot.testing)
  const run: DelayTestRun = {}

  proxies.forEach(({ name }) => {
    if (run[name] !== undefined) return
    const version = ++nextRunVersion
    proxyRunVersions.set(name, version)
    run[name] = version
    delete delays[name]
    managed.add(name)
    testing.add(name)
  })

  updateSnapshot({ delays, managed, testing })
  return run
}

function finishProxy(proxy: string, delay: number, version: number): void {
  if (proxyRunVersions.get(proxy) !== version) return

  const testing = new Set(snapshot.testing)
  testing.delete(proxy)
  updateSnapshot({
    delays: { ...snapshot.delays, [proxy]: delay },
    testing
  })
}

export function subscribeDelayTestStore(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getDelayTestSnapshot(): DelayTestStoreSnapshot {
  return snapshot
}

export function releaseDelayTestResults(run: DelayTestRun): void {
  const delays = { ...snapshot.delays }
  const managed = new Set(snapshot.managed)
  let changed = false

  Object.entries(run).forEach(([proxy, version]) => {
    if (proxyRunVersions.get(proxy) !== version || snapshot.testing.has(proxy)) return
    proxyRunVersions.delete(proxy)
    delete delays[proxy]
    managed.delete(proxy)
    changed = true
  })

  if (changed) updateSnapshot({ delays, managed })
}

function resetDelayTestStore(): void {
  activeGroupRuns.forEach((active) => active.cancel())
  activeGroupRuns.clear()
  proxyRunVersions.clear()
  groupRunVersions.clear()
  updateSnapshot({
    delays: {},
    managed: new Set(),
    testing: new Set(),
    groups: new Set()
  })
}

export function stopGroupDelayTest(group: string): boolean {
  const active = activeGroupRuns.get(group)
  if (!active) return false

  activeGroupRuns.delete(group)
  groupRunVersions.delete(group)
  active.cancel()

  const delays = { ...snapshot.delays }
  const managed = new Set(snapshot.managed)
  const testing = new Set(snapshot.testing)
  Object.entries(active.run).forEach(([proxy, version]) => {
    if (proxyRunVersions.get(proxy) !== version) return
    proxyRunVersions.delete(proxy)
    delete delays[proxy]
    managed.delete(proxy)
    testing.delete(proxy)
  })
  const groups = new Set(snapshot.groups)
  groups.delete(group)
  updateSnapshot({ delays, managed, testing, groups })
  return true
}

const unsubscribeCoreStarted = window.electron.ipcRenderer.on('core-started', resetDelayTestStore)

if (import.meta.hot) {
  import.meta.hot.dispose(unsubscribeCoreStarted)
}

export function getDisplayedDelay(
  proxy: ControllerProxiesDetail | ControllerGroupDetail,
  state: DelayTestStoreSnapshot = snapshot
): number {
  if (state.managed.has(proxy.name)) return state.delays[proxy.name] ?? -1
  return proxy.history.length > 0 ? proxy.history[proxy.history.length - 1].delay : -1
}

export async function runProxyDelayTest(
  proxy: string,
  url?: string,
  provider?: string
): Promise<DelayTestRun> {
  if (snapshot.testing.has(proxy)) return {}

  const run = clearDelays([{ name: proxy, provider }])
  const version = run[proxy]
  try {
    const result = await mihomoProxyDelay(proxy, url, provider)
    finishProxy(proxy, result.delay ?? 0, version)
  } catch {
    finishProxy(proxy, 0, version)
  }
  return run
}

export async function runGroupDelayTest(options: GroupDelayTestOptions): Promise<DelayTestRun> {
  const { group, proxies, url, useGroupApi, concurrency, onResult } = options
  if (snapshot.groups.has(group) || proxies.length === 0) return {}

  const groupVersion = ++nextRunVersion
  groupRunVersions.set(group, groupVersion)
  const groups = new Set(snapshot.groups)
  groups.add(group)
  const run = clearDelays(proxies)
  let cancelRun = (): void => {}
  const cancelled = new Promise<void>((resolve) => {
    cancelRun = resolve
  })
  const active: ActiveGroupDelayRun = {
    version: groupVersion,
    run,
    cancelled,
    cancel: cancelRun
  }
  activeGroupRuns.set(group, active)
  updateSnapshot({ groups })
  const isActive = (): boolean => groupRunVersions.get(group) === groupVersion

  try {
    const execute = async (): Promise<void> => {
      if (useGroupApi) {
        try {
          const results = await mihomoGroupDelay(group, url)
          if (!isActive()) return
          proxies.forEach(({ name }) => {
            const delay = results[name] ?? 0
            finishProxy(name, delay, run[name])
            onResult?.(name, delay)
          })
        } catch {
          if (!isActive()) return
          proxies.forEach(({ name }) => {
            finishProxy(name, 0, run[name])
            onResult?.(name, 0)
          })
        }
        return
      }

      await runDelayTestsWithConcurrency(
        proxies,
        concurrency,
        async ({ name, provider }) => {
          try {
            const result = await mihomoProxyDelay(name, url, provider)
            if (!isActive()) return
            const delay = result.delay ?? 0
            finishProxy(name, delay, run[name])
            onResult?.(name, delay)
          } catch {
            if (!isActive()) return
            finishProxy(name, 0, run[name])
            onResult?.(name, 0)
          }
        },
        () => !isActive()
      )
    }

    await Promise.race([execute(), cancelled])
  } finally {
    if (isActive()) {
      groupRunVersions.delete(group)
      const nextGroups = new Set(snapshot.groups)
      nextGroups.delete(group)
      updateSnapshot({ groups: nextGroups })
    }
    if (activeGroupRuns.get(group) === active) activeGroupRuns.delete(group)
  }
  return run
}
