import { readTestHistory, writeTestHistory } from '@renderer/utils/test-history'

export interface DelayRoundMeasurement {
  round: number
  delay: number
}

export interface DownloadRoundMeasurement {
  round: number
  result?: SpeedTestResult
  error?: string
}

interface GeneralTestSession {
  running: boolean
  round: number
  rounds: number
  nodeCount: number
}

interface GeneralTestHistory {
  groupName: string
  savedAt: number
  delayMeasurements: Record<string, DelayRoundMeasurement[]>
  downloadMeasurements: Record<string, DownloadRoundMeasurement[]>
}

interface GeneralTestRuntimeSnapshot {
  groupName?: string
  history?: GeneralTestHistory
  delayMeasurements: Record<string, DelayRoundMeasurement[]>
  downloadMeasurements: Record<string, DownloadRoundMeasurement[]>
  delaySession: GeneralTestSession
  downloadSession: GeneralTestSession
}

const GENERAL_TEST_HISTORY_KEY = 'sparkle:general-test-history'
const IDLE_SESSION: GeneralTestSession = { running: false, round: 0, rounds: 0, nodeCount: 0 }
let persistedHistory = readTestHistory<GeneralTestHistory>(GENERAL_TEST_HISTORY_KEY)

function createIdleSnapshot(): GeneralTestRuntimeSnapshot {
  return {
    groupName: persistedHistory?.groupName,
    history: persistedHistory,
    delayMeasurements: persistedHistory?.delayMeasurements || {},
    downloadMeasurements: persistedHistory?.downloadMeasurements || {},
    delaySession: IDLE_SESSION,
    downloadSession: IDLE_SESSION
  }
}

let snapshot = createIdleSnapshot()
let memoryReleased = false
const listeners = new Set<() => void>()

function hydrateMemory(): void {
  if (!memoryReleased) return
  persistedHistory = readTestHistory<GeneralTestHistory>(GENERAL_TEST_HISTORY_KEY)
  snapshot = createIdleSnapshot()
  memoryReleased = false
}

function releaseMemoryIfIdle(): void {
  if (
    memoryReleased ||
    listeners.size > 0 ||
    snapshot.delaySession.running ||
    snapshot.downloadSession.running
  ) {
    return
  }
  persistedHistory = undefined
  snapshot = {
    delayMeasurements: {},
    downloadMeasurements: {},
    delaySession: IDLE_SESSION,
    downloadSession: IDLE_SESSION
  }
  memoryReleased = true
}

function updateSnapshot(patch: Partial<GeneralTestRuntimeSnapshot>): void {
  snapshot = { ...snapshot, ...patch }
  listeners.forEach((listener) => listener())
}

function measurementsForGroup(
  groupName: string
): Pick<GeneralTestRuntimeSnapshot, 'delayMeasurements' | 'downloadMeasurements'> {
  if (persistedHistory?.groupName === groupName) {
    return {
      delayMeasurements: persistedHistory.delayMeasurements,
      downloadMeasurements: persistedHistory.downloadMeasurements
    }
  }
  return { delayMeasurements: {}, downloadMeasurements: {} }
}

function saveHistory(): void {
  if (!snapshot.groupName) return
  persistedHistory = {
    groupName: snapshot.groupName,
    savedAt: Date.now(),
    delayMeasurements: snapshot.delayMeasurements,
    downloadMeasurements: snapshot.downloadMeasurements
  }
  writeTestHistory(GENERAL_TEST_HISTORY_KEY, persistedHistory)
  updateSnapshot({ history: persistedHistory })
}

export function subscribeGeneralTestRuntime(listener: () => void): () => void {
  hydrateMemory()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    releaseMemoryIfIdle()
  }
}

export function getGeneralTestRuntimeSnapshot(): GeneralTestRuntimeSnapshot {
  hydrateMemory()
  return snapshot
}

export function selectGeneralTestGroup(groupName: string): void {
  if (
    !groupName ||
    snapshot.groupName === groupName ||
    snapshot.delaySession.running ||
    snapshot.downloadSession.running
  ) {
    return
  }
  updateSnapshot({ groupName, ...measurementsForGroup(groupName) })
}

export function startGeneralDelayTest(groupName: string, rounds: number, nodeCount: number): void {
  updateSnapshot({
    groupName,
    delayMeasurements: {},
    delaySession: { running: true, round: 1, rounds, nodeCount }
  })
}

export function setGeneralDelayRound(round: number): void {
  updateSnapshot({ delaySession: { ...snapshot.delaySession, round } })
}

export function recordGeneralDelay(proxy: string, round: number, delay: number): void {
  updateSnapshot({
    delayMeasurements: {
      ...snapshot.delayMeasurements,
      [proxy]: [...(snapshot.delayMeasurements[proxy] || []), { round, delay }]
    }
  })
}

export function finishGeneralDelayTest(saveCompletedResult: boolean): void {
  if (saveCompletedResult) {
    saveHistory()
  } else if (snapshot.groupName) {
    updateSnapshot(measurementsForGroup(snapshot.groupName))
  }
  updateSnapshot({ delaySession: IDLE_SESSION })
  releaseMemoryIfIdle()
}

export function startGeneralDownloadTest(
  groupName: string,
  rounds: number,
  nodeCount: number
): void {
  updateSnapshot({
    groupName,
    downloadMeasurements: {},
    downloadSession: { running: true, round: 1, rounds, nodeCount }
  })
}

export function setGeneralDownloadRound(round: number): void {
  updateSnapshot({ downloadSession: { ...snapshot.downloadSession, round } })
}

export function recordGeneralDownload(
  proxy: string,
  round: number,
  result?: SpeedTestResult,
  error?: string
): void {
  updateSnapshot({
    downloadMeasurements: {
      ...snapshot.downloadMeasurements,
      [proxy]: [...(snapshot.downloadMeasurements[proxy] || []), { round, result, error }]
    }
  })
}

export function finishGeneralDownloadTest(saveCompletedResult: boolean): void {
  if (saveCompletedResult) {
    saveHistory()
  } else if (snapshot.groupName) {
    updateSnapshot(measurementsForGroup(snapshot.groupName))
  }
  updateSnapshot({ downloadSession: IDLE_SESSION })
  releaseMemoryIfIdle()
}

function resetGeneralTestRuntime(): void {
  persistedHistory = readTestHistory<GeneralTestHistory>(GENERAL_TEST_HISTORY_KEY)
  snapshot = createIdleSnapshot()
  memoryReleased = false
  listeners.forEach((listener) => listener())
  releaseMemoryIfIdle()
}

const unsubscribeCoreStarted = window.electron.ipcRenderer.on(
  'core-started',
  resetGeneralTestRuntime
)

if (import.meta.hot) {
  import.meta.hot.dispose(unsubscribeCoreStarted)
}
