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

export interface GeneralTestSession {
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
const listeners = new Set<() => void>()

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
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getGeneralTestRuntimeSnapshot(): GeneralTestRuntimeSnapshot {
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
}

function resetGeneralTestRuntime(): void {
  snapshot = createIdleSnapshot()
  listeners.forEach((listener) => listener())
}

const unsubscribeCoreStarted = window.electron.ipcRenderer.on(
  'core-started',
  resetGeneralTestRuntime
)

if (import.meta.hot) {
  import.meta.hot.dispose(unsubscribeCoreStarted)
}
