import { readTestHistory, writeTestHistory } from '@renderer/utils/test-history'

const PROCESS_CONNECTION_HISTORY_KEY = 'sparkle:process-connection-history'

export interface ProcessTestDomainTarget {
  key: string
  host: string
  port: number
  count: number
  active: boolean
  lastSeen: number
}

export interface ProcessTestTargetCatalog {
  key: string
  process: string
  processPath: string
  sourceIP: string
  connectionCount: number
  domains: ProcessTestDomainTarget[]
}

let connections =
  readTestHistory<ControllerConnectionDetail[]>(PROCESS_CONNECTION_HISTORY_KEY) || []
let connectionsReleased = false
let selectedProcessKey: string | undefined
let persistTimer: number | undefined
let catalogBuildTimer: number | undefined
let catalogCache: ProcessTestTargetCatalog[] | undefined

function hydrateConnections(): void {
  if (!connectionsReleased) return
  connections = readTestHistory<ControllerConnectionDetail[]>(PROCESS_CONNECTION_HISTORY_KEY) || []
  connectionsReleased = false
}

function scheduleCatalogBuild(): void {
  catalogCache = undefined
  if (catalogBuildTimer !== undefined) window.clearTimeout(catalogBuildTimer)
  catalogBuildTimer = window.setTimeout(() => {
    catalogBuildTimer = undefined
    catalogCache = buildProcessTestCatalog()
  }, 0)
}

function schedulePersistConnections(): void {
  if (persistTimer !== undefined) window.clearTimeout(persistTimer)
  persistTimer = window.setTimeout(() => {
    persistTimer = undefined
    writeTestHistory(PROCESS_CONNECTION_HISTORY_KEY, connections)
  }, 1000)
}

export function processTestKey(
  processPath: string | undefined,
  process: string | undefined,
  sourceIP: string | undefined
): string {
  if (processPath) return `path:${processPath}`
  if (process) return `process:${process}`
  return `source:${sourceIP || 'unknown'}`
}

export function updateProcessTestConnections(nextConnections: ControllerConnectionDetail[]): void {
  connections = nextConnections
  connectionsReleased = false
  scheduleCatalogBuild()
  schedulePersistConnections()
}

export function updateActiveProcessTestConnections(
  activeConnections: ControllerConnectionDetail[]
): void {
  hydrateConnections()
  const activeIds = new Set(activeConnections.map((connection) => connection.id))
  const retained = connections
    .filter((connection) => !activeIds.has(connection.id))
    .map((connection) =>
      connection.isActive
        ? { ...connection, isActive: false, uploadSpeed: 0, downloadSpeed: 0 }
        : connection
    )
  const normalizedActive = activeConnections.map((connection) => ({
    ...connection,
    metadata:
      connection.metadata.type === 'Inner'
        ? { ...connection.metadata, process: 'mihomo', processPath: 'mihomo' }
        : connection.metadata,
    isActive: true
  }))
  connections = [...retained, ...normalizedActive].slice(-(normalizedActive.length + 200))
  scheduleCatalogBuild()
  schedulePersistConnections()
}

export function selectProcessTestProcess(key: string): void {
  selectedProcessKey = key
}

export function takeSelectedProcessTestProcess(): string | undefined {
  const key = selectedProcessKey
  selectedProcessKey = undefined
  return key
}

function parseTarget(
  connection: ControllerConnectionDetail
): { host: string; port: number } | null {
  const candidates = [
    connection.metadata.host,
    connection.metadata.sniffHost,
    connection.metadata.remoteDestination
  ]
  let raw = candidates.find((value) => value?.trim())?.trim()
  if (!raw) return null

  let parsedPort: number | undefined
  try {
    if (raw.includes('://')) {
      const url = new URL(raw)
      raw = url.hostname
      parsedPort = url.port ? Number(url.port) : undefined
    } else {
      const match = raw.match(/^([^:[\]]+):(\d+)$/)
      if (match) {
        raw = match[1]
        parsedPort = Number(match[2])
      }
    }
  } catch {
    return null
  }

  const host = raw
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
  if (
    !host ||
    host === 'localhost' ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) ||
    host.includes(':') ||
    !host.includes('.')
  ) {
    return null
  }

  const observedPort = Number(connection.metadata.destinationPort)
  const port =
    parsedPort || (Number.isInteger(observedPort) && observedPort > 0 ? observedPort : 443)
  if (port <= 0 || port > 65535 || connection.metadata.network !== 'tcp') return null
  return { host, port }
}

function buildProcessTestCatalog(): ProcessTestTargetCatalog[] {
  hydrateConnections()
  const catalogs = new Map<
    string,
    ProcessTestTargetCatalog & { domainMap: Map<string, ProcessTestDomainTarget> }
  >()

  for (const connection of connections) {
    const { process = '', processPath = '', sourceIP = '' } = connection.metadata
    const key = processTestKey(processPath, process, sourceIP)
    let catalog = catalogs.get(key)
    if (!catalog) {
      catalog = {
        key,
        process,
        processPath,
        sourceIP,
        connectionCount: 0,
        domains: [],
        domainMap: new Map()
      }
      catalogs.set(key, catalog)
    }
    catalog.connectionCount++

    const target = parseTarget(connection)
    if (!target) continue
    const domainKey = `${target.host}:${target.port}`
    const existing = catalog.domainMap.get(domainKey)
    const lastSeen = Number.isFinite(Date.parse(connection.start))
      ? Date.parse(connection.start)
      : Date.now()
    if (existing) {
      existing.count++
      existing.active ||= connection.isActive
      existing.lastSeen = Math.max(existing.lastSeen, lastSeen)
    } else {
      catalog.domainMap.set(domainKey, {
        key: domainKey,
        ...target,
        count: 1,
        active: connection.isActive,
        lastSeen
      })
    }
  }

  return [...catalogs.values()]
    .map(({ domainMap, ...catalog }) => ({
      ...catalog,
      domains: [...domainMap.values()].sort(
        (left, right) => right.lastSeen - left.lastSeen || left.key.localeCompare(right.key)
      )
    }))
    .filter((catalog) => catalog.domains.length > 0)
    .sort((left, right) => {
      const leftName = left.process || left.sourceIP
      const rightName = right.process || right.sourceIP
      return leftName.localeCompare(rightName)
    })
}

export function getProcessTestCatalog(): ProcessTestTargetCatalog[] {
  if (!catalogCache) {
    if (catalogBuildTimer !== undefined) window.clearTimeout(catalogBuildTimer)
    catalogBuildTimer = undefined
    catalogCache = buildProcessTestCatalog()
  }
  return catalogCache
}

export function getRetainedConnectionHistory(): ControllerConnectionDetail[] {
  hydrateConnections()
  return connections.map((connection) => ({
    ...connection,
    isActive: false,
    uploadSpeed: 0,
    downloadSpeed: 0
  }))
}

export function releaseProcessTestTargetMemory(): void {
  if (persistTimer !== undefined) {
    window.clearTimeout(persistTimer)
    persistTimer = undefined
    writeTestHistory(PROCESS_CONNECTION_HISTORY_KEY, connections)
  }
  if (catalogBuildTimer !== undefined) {
    window.clearTimeout(catalogBuildTimer)
    catalogBuildTimer = undefined
  }
  connections = []
  catalogCache = undefined
  connectionsReleased = true
}

scheduleCatalogBuild()

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (persistTimer !== undefined) window.clearTimeout(persistTimer)
    if (catalogBuildTimer !== undefined) window.clearTimeout(catalogBuildTimer)
    writeTestHistory(PROCESS_CONNECTION_HISTORY_KEY, connections)
  })
}
