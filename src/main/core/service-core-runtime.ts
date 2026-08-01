import { ipcMain } from 'electron'
import { getAppConfig, getControledMihomoConfig, patchAppConfig } from '../config'
import { mainWindow } from '..'
import { floatingWindow } from '../resolve/floatingWindow'
import {
  getAxios,
  startMihomoConnections,
  startMihomoLogs,
  startMihomoMemory,
  startMihomoTraffic,
  stopMihomoConnections,
  stopMihomoLogs,
  stopMihomoMemory,
  stopMihomoTraffic
} from './mihomoApi'
import {
  getCoreStatus,
  isServiceConnectionError,
  setServiceUnavailableFallbackHandler,
  startServiceCoreEventStream,
  stopServiceCoreEventStream,
  stopServiceSysproxyEventStream,
  subscribeServiceCoreEvents,
  subscribeServiceCoreEventStream,
  type ServiceCoreEvent
} from '../service/api'
import { shouldSkipServiceUnavailableFallback } from '../service/fallback'
import { appendAppLog, setMihomoLogSource } from '../utils/log'
import { showNotification } from '../utils/notification'
import { recoverDNS, setPublicDNS } from './network'

interface ServiceCoreRuntimeOptions {
  notifyCoreLog: (source: ServiceCoreEvent) => void
  resetDirectCoreRetry: () => void
  startCore: (
    detached?: boolean,
    shouldContinue?: () => boolean
  ) => Promise<Promise<void>[]>
}

export function createServiceCoreRuntime(options: ServiceCoreRuntimeOptions) {
  const serviceCoreState = {
    streamsRestartTimer: null as NodeJS.Timeout | null,
    unsubscribeEvents: null as (() => void) | null,
    unsubscribeEventStream: null as (() => void) | null,
    streamsActive: false,
    streamsGeneration: 0,
    streamsStarting: null as { generation: number; promise: Promise<void> } | null,
    eventGeneration: 0,
    lastEventKey: '',
    startupActive: false,
    managed: false,
    autoResumePaused: false,
    reconnectResumePromise: null as Promise<void> | null
  }

  const serviceFallbackState = {
    unavailableModePromise: null as Promise<void> | null
  }

  setServiceUnavailableFallbackHandler(async (reason) => {
    if (shouldSkipServiceUnavailableFallback()) {
      await appendAppLog(
        `[Manager]: skip service unavailable fallback during app update, ${reason}\n`
      )
      return
    }

    if (!serviceFallbackState.unavailableModePromise) {
      serviceFallbackState.unavailableModePromise = fallbackUnavailableServiceModes(reason).finally(
        () => {
          serviceFallbackState.unavailableModePromise = null
        }
      )
    }

    return serviceFallbackState.unavailableModePromise
  })

  function pauseAutoResume(): void {
    serviceCoreState.autoResumePaused = true
  }

  function resumeAutoResume(): void {
    serviceCoreState.autoResumePaused = false
  }

  function beginStartup(): void {
    serviceCoreState.startupActive = true
  }

  function endStartup(): void {
    serviceCoreState.startupActive = false
  }

  function setManaged(managed: boolean): void {
    serviceCoreState.managed = managed
  }

  function isManaged(): boolean {
    return serviceCoreState.managed
  }

  async function startEventStream(): Promise<void> {
    await startServiceCoreEventStream()
  }

  function ensureEventHandler(): void {
    const generation = serviceCoreState.eventGeneration
    if (!serviceCoreState.unsubscribeEvents) {
      serviceCoreState.unsubscribeEvents = subscribeServiceCoreEvents((event) =>
        handleServiceCoreEvent(event, generation)
      )
    }
    if (!serviceCoreState.unsubscribeEventStream) {
      serviceCoreState.unsubscribeEventStream = subscribeServiceCoreEventStream((state) =>
        handleServiceCoreEventStreamState(state, generation)
      )
    }
  }

  function stopEventHandlers(): void {
    serviceCoreState.eventGeneration++
    serviceCoreState.reconnectResumePromise = null
    stopServiceCoreEventStream()
    releaseEventHandler()
  }

  function clearStreams(): void {
    serviceCoreState.streamsGeneration++
    stopStreams()
    serviceCoreState.streamsActive = false
    clearStreamsRestartTimer()
  }

  function stopStreams(): void {
    stopMihomoTraffic()
    stopMihomoConnections()
    stopMihomoLogs()
    stopMihomoMemory()
  }

  async function fallbackToElevatedCore(
    detached: boolean,
    reason: unknown
  ): Promise<Promise<void>[]> {
    await appendAppLog(`[Manager]: Service unavailable, fallback to elevated core, ${reason}\n`)
    const { autoSetDNSMode = 'none' } = await getAppConfig()
    if (autoSetDNSMode === 'service') {
      await recoverDNS().catch((error) =>
        appendAppLog(`[Manager]: recover DNS before elevated fallback failed, ${error}\n`)
      )
    }
    clearStreams()
    stopEventHandlers()
    await patchAppConfig({
      corePermissionMode: 'elevated',
      ...(autoSetDNSMode === 'service' ? { autoSetDNSMode: 'exec' as const } : {})
    })
    mainWindow?.webContents.send('appConfigUpdated')
    floatingWindow?.webContents.send('appConfigUpdated')
    void showNotification({ title: '服务不可用，已切换到非服务模式' })
    return options.startCore(detached)
  }

  async function fallbackUnavailableServiceModes(reason: unknown): Promise<void> {
    const appConfig = await getAppConfig()
    const { sysProxy, corePermissionMode = 'elevated', autoSetDNSMode = 'none' } = appConfig
    const useServiceCore = corePermissionMode === 'service'
    const useServiceSysProxy = sysProxy?.settingMode === 'service'
    const useServiceDNS = autoSetDNSMode === 'service'

    if (!useServiceCore && !useServiceSysProxy && !useServiceDNS) {
      return
    }

    await appendAppLog(`[Manager]: Service unavailable, fallback service modes, ${reason}\n`)

    if (useServiceCore) {
      clearStreams()
      stopEventHandlers()
      setMihomoLogSource('out')
    }

    if (useServiceDNS) {
      await recoverDNS().catch((error) =>
        appendAppLog(`[Manager]: recover DNS before service fallback failed, ${error}\n`)
      )
    }

    if (useServiceSysProxy) {
      stopServiceSysproxyEventStream()
    }

    await patchAppConfig({
      ...(useServiceCore ? { corePermissionMode: 'elevated' as const } : {}),
      ...(useServiceSysProxy && sysProxy
        ? {
            sysProxy: {
              ...sysProxy,
              settingMode: 'exec' as const,
              guard: false,
              guardNotify: false
            }
          }
        : {}),
      ...(useServiceDNS ? { autoSetDNSMode: 'exec' as const } : {})
    })

    mainWindow?.webContents.send('appConfigUpdated')
    floatingWindow?.webContents.send('appConfigUpdated')

    try {
      if (useServiceCore) {
        const promises = await options.startCore()
        await Promise.all(promises)
        mainWindow?.webContents.send('core-started')
      } else if (useServiceDNS) {
        await syncCoreDNS()
      }
      void showNotification({ title: '服务不可用，已切换到非服务模式' })
    } finally {
      mainWindow?.webContents.reload()
      floatingWindow?.webContents.reload()
    }
  }

  async function syncCoreDNS(): Promise<void> {
    const { autoSetDNSMode = 'none' } = await getAppConfig()
    if (autoSetDNSMode === 'none') return

    const { tun } = await getControledMihomoConfig()
    if (!tun?.enable) return

    await setPublicDNS()
  }

  return {
    pauseAutoResume,
    resumeAutoResume,
    beginStartup,
    endStartup,
    setManaged,
    isManaged,
    startEventStream,
    ensureEventHandler,
    stopEventHandlers,
    clearStreams,
    waitForStreamsIdle,
    ensureStreamsStarted,
    fallbackToElevatedCore
  }

  function releaseEventHandler(): void {
    if (serviceCoreState.unsubscribeEvents) {
      serviceCoreState.unsubscribeEvents()
      serviceCoreState.unsubscribeEvents = null
    }
    if (serviceCoreState.unsubscribeEventStream) {
      serviceCoreState.unsubscribeEventStream()
      serviceCoreState.unsubscribeEventStream = null
    }
  }

  async function handleServiceCoreEvent(
    event: ServiceCoreEvent,
    generation: number
  ): Promise<void> {
    if (generation !== serviceCoreState.eventGeneration) return

    if (event.type === 'log') {
      options.notifyCoreLog(event)
      return
    }

    if (isDuplicateServiceCoreEvent(event)) {
      return
    }

    await appendAppLog(
      `[Manager]: Service core event: ${event.type}${event.pid ? `, pid: ${event.pid}` : ''}${event.error ? `, error: ${event.error}` : ''}\n`
    )
    if (generation !== serviceCoreState.eventGeneration) return

    mainWindow?.webContents.send('core-status-changed', event)

    switch (event.type) {
      case 'started':
        serviceCoreState.autoResumePaused = false
        serviceCoreState.managed = true
        await getAxios(true).catch(() => {})
        if (generation !== serviceCoreState.eventGeneration) return
        await syncCoreDNS().catch((error) =>
          appendAppLog(`[Manager]: sync DNS after service core start failed, ${error}\n`)
        )
        if (generation !== serviceCoreState.eventGeneration) return
        mainWindow?.webContents.send('core-started', event)
        mainWindow?.webContents.send('groupsUpdated')
        mainWindow?.webContents.send('rulesUpdated')
        ipcMain.emit('updateTrayMenu')
        void ensureStreamsStarted().catch((error) =>
          appendAppLog(`[Manager]: start service core streams failed, ${error}\n`)
        )
        break
      case 'takeover':
      case 'ready':
        serviceCoreState.autoResumePaused = false
        serviceCoreState.managed = true
        await getAxios(true).catch(() => {})
        if (generation !== serviceCoreState.eventGeneration) return
        await syncCoreDNS().catch((error) =>
          appendAppLog(`[Manager]: sync DNS after service core takeover failed, ${error}\n`)
        )
        if (generation !== serviceCoreState.eventGeneration) return
        mainWindow?.webContents.send('core-started', event)
        mainWindow?.webContents.send('groupsUpdated')
        mainWindow?.webContents.send('rulesUpdated')
        ipcMain.emit('updateTrayMenu')
        scheduleStreamsRestart()
        break
      case 'exited':
      case 'failed':
      case 'restart_failed':
        clearStreams()
        await recoverDNS().catch((error) =>
          appendAppLog(`[Manager]: recover DNS after service core stopped failed, ${error}\n`)
        )
        if (generation !== serviceCoreState.eventGeneration) return
        setMihomoLogSource('out')
        mainWindow?.webContents.send('core-stopped', event)
        if (event.type === 'failed' || event.type === 'restart_failed') {
          serviceCoreState.managed = false
        }
        if (event.type === 'restart_failed') {
          mainWindow?.webContents.reload()
        }
        break
      case 'stopped':
        serviceCoreState.autoResumePaused = true
        serviceCoreState.managed = false
        clearStreams()
        await recoverDNS().catch((error) =>
          appendAppLog(`[Manager]: recover DNS after service core stopped failed, ${error}\n`)
        )
        if (generation !== serviceCoreState.eventGeneration) return
        mainWindow?.webContents.send('core-stopped', event)
        break
    }
  }

  async function handleServiceCoreEventStreamState(
    state: 'connected' | 'disconnected',
    generation: number
  ): Promise<void> {
    if (generation !== serviceCoreState.eventGeneration) return
    await appendAppLog(`[Manager]: Service core event stream ${state}\n`)
    if (generation !== serviceCoreState.eventGeneration) return
    if (state !== 'connected') {
      return
    }
    if (
      serviceCoreState.startupActive ||
      serviceCoreState.autoResumePaused ||
      serviceCoreState.reconnectResumePromise
    ) {
      return
    }

    const resumePromise = resumeServiceCoreAfterReconnect(generation)
    serviceCoreState.reconnectResumePromise = resumePromise
    try {
      await resumePromise
    } finally {
      if (serviceCoreState.reconnectResumePromise === resumePromise) {
        serviceCoreState.reconnectResumePromise = null
      }
    }
  }

  async function resumeServiceCoreAfterReconnect(generation: number): Promise<void> {
    await delay(500)
    if (
      generation !== serviceCoreState.eventGeneration ||
      serviceCoreState.startupActive ||
      serviceCoreState.autoResumePaused
    ) {
      return
    }

    const { corePermissionMode = 'elevated' } = await getAppConfig()
    if (corePermissionMode !== 'service') {
      return
    }

    if (generation !== serviceCoreState.eventGeneration) {
      return
    }

    try {
      await getCoreStatus()
      return
    } catch (error) {
      if (isServiceConnectionError(error)) {
        return
      }
    }

    if (serviceCoreState.autoResumePaused) {
      return
    }

    if (generation !== serviceCoreState.eventGeneration) {
      return
    }

    await appendAppLog(`[Manager]: Service reconnected without running core, starting core\n`)
    if (generation !== serviceCoreState.eventGeneration) {
      return
    }
    const promises = await options.startCore(
      false,
      () => generation === serviceCoreState.eventGeneration && !serviceCoreState.autoResumePaused
    )
    await Promise.all(promises)
    if (generation !== serviceCoreState.eventGeneration) {
      return
    }
    mainWindow?.webContents.send('core-started')
  }

  function isDuplicateServiceCoreEvent(event: ServiceCoreEvent): boolean {
    const key = [
      event.seq ?? '',
      event.type,
      event.time,
      event.pid ?? '',
      event.old_pid ?? '',
      event.error ?? ''
    ].join('|')
    if (key === serviceCoreState.lastEventKey) {
      return true
    }
    serviceCoreState.lastEventKey = key
    return false
  }

  function scheduleStreamsRestart(): void {
    if (serviceCoreState.streamsRestartTimer) {
      clearTimeout(serviceCoreState.streamsRestartTimer)
    }

    serviceCoreState.streamsRestartTimer = setTimeout(() => {
      serviceCoreState.streamsRestartTimer = null
      restartStreams().catch((error) => {
        appendAppLog(`[Manager]: restart service core streams failed, ${error}\n`).catch(() => {})
      })
    }, 300)
  }

  async function restartStreams(): Promise<void> {
    clearStreams()
    await ensureStreamsStarted()
  }

  async function waitForStreamsIdle(): Promise<void> {
    const starting = serviceCoreState.streamsStarting
    if (!starting) return
    await starting.promise.catch(() => {})
  }

  async function ensureStreamsStarted(): Promise<void> {
    clearStreamsRestartTimer()
    if (serviceCoreState.streamsActive) {
      return
    }
    const starting = serviceCoreState.streamsStarting
    if (starting) {
      try {
        await starting.promise
      } catch (error) {
        if (starting.generation === serviceCoreState.streamsGeneration) {
          throw error
        }
      }
      if (starting.generation !== serviceCoreState.streamsGeneration) {
        return ensureStreamsStarted()
      }
      return
    }

    const generation = serviceCoreState.streamsGeneration
    const promise = (async () => {
      await getAxios(true).catch(() => {})
      await startMihomoTraffic()
      if (generation !== serviceCoreState.streamsGeneration) {
        stopStreams()
        return
      }
      await startMihomoConnections()
      if (generation !== serviceCoreState.streamsGeneration) {
        stopStreams()
        return
      }
      await startMihomoLogs()
      if (generation !== serviceCoreState.streamsGeneration) {
        stopStreams()
        return
      }
      await startMihomoMemory()
      if (generation !== serviceCoreState.streamsGeneration) {
        stopStreams()
        return
      }
      setMihomoLogSource('ws')
      options.resetDirectCoreRetry()
      if (generation === serviceCoreState.streamsGeneration) {
        serviceCoreState.streamsActive = true
      }
    })()
    serviceCoreState.streamsStarting = { generation, promise }

    try {
      await promise
    } finally {
      if (serviceCoreState.streamsStarting?.promise === promise) {
        serviceCoreState.streamsStarting = null
      }
    }
  }

  function clearStreamsRestartTimer(): void {
    if (serviceCoreState.streamsRestartTimer) {
      clearTimeout(serviceCoreState.streamsRestartTimer)
      serviceCoreState.streamsRestartTimer = null
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
