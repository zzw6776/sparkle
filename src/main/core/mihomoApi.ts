import axios, { AxiosInstance } from 'axios'
import net from 'net'
import tls from 'tls'
import { getAppConfig, getControledMihomoConfig } from '../config'
import { mainWindow } from '..'
import WebSocket from 'ws'
import { customTrayWindow, tray, updateTrayTraffic } from '../resolve/tray'
import { calcTraffic } from '../utils/calc'
import { getRuntimeConfig } from './factory'
import { floatingWindow } from '../resolve/floatingWindow'
import { mihomoIpcPath, serviceIpcPath } from '../utils/dirs'
import { publishMihomoLog } from '../utils/log'
import { createSignedServiceAxios, getServiceAuthHeaders } from '../service/api'
import { safeSendToWindow } from '../utils/webContents'

let axiosIns: AxiosInstance = null!
let mihomoTrafficWs: WebSocket | null = null
let trafficRetry = 10
let trafficReconnectTimer: NodeJS.Timeout | null = null
let mihomoMemoryWs: WebSocket | null = null
let memoryRetry = 10
let memoryReconnectTimer: NodeJS.Timeout | null = null
let mihomoLogsWs: WebSocket | null = null
let logsRetry = 10
let logsReconnectTimer: NodeJS.Timeout | null = null
let mihomoConnectionsWs: WebSocket | null = null
let connectionsRetry = 10
let connectionsReconnectTimer: NodeJS.Timeout | null = null
let axiosMode: 'direct' | 'service' | null = null
const wsReconnectDelay = 1000

function isWebSocketActive(ws: WebSocket | null): boolean {
  return ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING
}

function closeWebSocket(ws: WebSocket): void {
  ws.removeAllListeners()
  ws.on('error', () => {})
  if (isWebSocketActive(ws)) {
    ws.close()
  }
}

export const getAxios = async (force: boolean = false): Promise<AxiosInstance> => {
  const { corePermissionMode = 'elevated' } = await getAppConfig()
  const nextMode = corePermissionMode === 'service' ? 'service' : 'direct'
  const currentBaseURL =
    nextMode === 'service' ? 'http://localhost/core/controller' : 'http://localhost'

  if (axiosIns && (axiosIns.defaults.baseURL !== currentBaseURL || axiosMode !== nextMode)) {
    force = true
  }

  if (axiosIns && !force) return axiosIns

  axiosMode = nextMode
  if (nextMode === 'service') {
    axiosIns = createSignedServiceAxios(currentBaseURL)
  } else {
    axiosIns = axios.create({
      baseURL: currentBaseURL,
      socketPath: mihomoIpcPath(),
      timeout: 15000
    })

    axiosIns.interceptors.response.use(
      (response) => {
        return response.data
      },
      (error) => {
        if (error.response && error.response.data) {
          return Promise.reject(error.response.data)
        }
        return Promise.reject(error)
      }
    )
  }
  return axiosIns
}

const mihomoWs = async (path: string): Promise<WebSocket> => {
  const { corePermissionMode = 'elevated' } = await getAppConfig()
  if (corePermissionMode !== 'service') {
    return new WebSocket(`ws+unix:${mihomoIpcPath()}:${path}`)
  }

  const servicePath = `/core/controller${path}`
  return new WebSocket(`ws+unix:${serviceIpcPath()}:${servicePath}`, {
    headers: getServiceAuthHeaders('GET', servicePath)
  })
}

export async function mihomoVersion(): Promise<ControllerVersion> {
  const instance = await getAxios()
  return await instance.get('/version')
}

export const mihomoConfig = async (): Promise<ControllerConfigs> => {
  const instance = await getAxios()
  return await instance.get('/configs')
}

export const patchMihomoConfig = async (patch: Partial<ControllerConfigs>): Promise<void> => {
  const instance = await getAxios()
  return await instance.patch('/configs', patch)
}

export const mihomoCloseConnection = async (id: string): Promise<void> => {
  const instance = await getAxios()
  return await instance.delete(`/connections/${encodeURIComponent(id)}`)
}

export const mihomoGetConnections = async (): Promise<ControllerConnections> => {
  const instance = await getAxios()
  return await instance.get('/connections')
}

export const mihomoCloseConnections = async (name?: string): Promise<void> => {
  const instance = await getAxios()
  if (name) {
    const connectionsInfo = await mihomoGetConnections()
    const targetConnections =
      connectionsInfo?.connections?.filter((conn) => conn.chains && conn.chains.includes(name)) ||
      []
    for (const conn of targetConnections) {
      try {
        await mihomoCloseConnection(conn.id)
      } catch (error) {
        // ignore
      }
    }
  } else {
    return await instance.delete('/connections')
  }
}

export const mihomoRules = async (): Promise<ControllerRules> => {
  const instance = await getAxios()
  return await instance.get('/rules')
}

const RULE_MATCH_TIMEOUT = 8000
const RULE_MATCH_CONNECTION_INTERVAL = 50

function parseRuleMatchUrl(input: string): URL {
  const trimmed = input.trim()
  if (!trimmed) throw new Error('请输入要测试的网址')

  let url: URL
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
  } catch {
    throw new Error('网址格式不正确')
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('仅支持 HTTP 或 HTTPS 网址')
  }
  if (!url.hostname) throw new Error('网址缺少主机名')

  return url
}

function formatConnectAuthority(host: string, port: number): string {
  return `${net.isIP(host) === 6 ? `[${host}]` : host}:${port}`
}

async function waitForWebSocketOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('连接内核超时'))
    }, RULE_MATCH_TIMEOUT)
    const cleanup = (): void => {
      clearTimeout(timer)
      ws.off('open', handleOpen)
      ws.off('error', handleError)
    }
    const handleOpen = (): void => {
      cleanup()
      resolve()
    }
    const handleError = (): void => {
      cleanup()
      reject(new Error('无法连接内核'))
    }

    ws.once('open', handleOpen)
    ws.once('error', handleError)
  })
}

async function observeRuleMatch(
  ws: WebSocket,
  url: URL,
  proxyPort: number
): Promise<ControllerConnectionDetail> {
  const host = url.hostname
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
  const authority = formatConnectAuthority(host, port)

  return await new Promise<ControllerConnectionDetail>((resolve, reject) => {
    let sourcePort = ''
    let settled = false
    let proxyResponse = ''
    let tunnelSocket: net.Socket | tls.TLSSocket | null = null
    const socket = net.createConnection({ host: '127.0.0.1', port: proxyPort })

    const cleanup = (): void => {
      clearTimeout(timer)
      ws.removeAllListeners()
      closeWebSocket(ws)
      tunnelSocket?.destroy()
      if (tunnelSocket !== socket) socket.destroy()
    }
    const finish = (
      connection?: ControllerConnectionDetail,
      error?: Error
    ): void => {
      if (settled) return
      settled = true
      cleanup()
      if (connection) resolve(connection)
      else reject(error || new Error('未获取到规则匹配结果'))
    }
    const timer = setTimeout(
      () => finish(undefined, new Error('规则匹配超时，请确认目标网址可以连接')),
      RULE_MATCH_TIMEOUT
    )

    ws.on('message', (data) => {
      if (!sourcePort) return
      try {
        const info = JSON.parse(data.toString()) as ControllerConnections
        const connection = info.connections?.find(
          (item) =>
            item.metadata.sourcePort === sourcePort &&
            (item.metadata.host === host ||
              item.metadata.sniffHost === host ||
              item.metadata.destinationPort === String(port))
        )
        if (connection) finish(connection)
      } catch {
        // Ignore an incomplete controller frame and keep waiting for the next one.
      }
    })
    ws.on('error', () => finish(undefined, new Error('读取内核连接信息失败')))

    socket.setNoDelay(true)
    socket.once('connect', () => {
      sourcePort = String(socket.localPort || '')
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Connection: keep-alive\r\n\r\n`
      )
    })
    socket.on('data', (chunk) => {
      if (tunnelSocket) return
      proxyResponse += chunk.toString('latin1')
      const headerEnd = proxyResponse.indexOf('\r\n\r\n')
      if (headerEnd < 0) return

      const status = Number(proxyResponse.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/i)?.[1])
      if (status !== 200) {
        finish(
          undefined,
          new Error(status === 407 ? '本机代理需要认证，无法测试规则' : '本机代理拒绝了测试连接')
        )
        return
      }

      if (url.protocol === 'https:') {
        const secureSocket = tls.connect({
          socket,
          servername: net.isIP(host) ? undefined : host,
          rejectUnauthorized: false
        })
        tunnelSocket = secureSocket
        secureSocket.on('error', () => {
          // The rule is resolved before the remote TLS handshake completes.
        })
      } else {
        tunnelSocket = socket
        const path = `${url.pathname || '/'}${url.search}`
        socket.write(
          `HEAD ${path} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: keep-alive\r\n\r\n`
        )
      }
    })
    socket.once('error', () => finish(undefined, new Error('无法连接本机代理端口')))
  })
}

export const mihomoMatchRule = async (input: string): Promise<ControllerRuleMatchResult> => {
  const url = parseRuleMatchUrl(input)
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
  const [config, rulesBefore] = await Promise.all([mihomoConfig(), mihomoRules()])
  const proxyPort = config['mixed-port'] || config.port
  if (!proxyPort) throw new Error('请先启用混合端口或 HTTP 代理端口')

  const ws = await mihomoWs(`/connections?interval=${RULE_MATCH_CONNECTION_INTERVAL}`)
  try {
    await waitForWebSocketOpen(ws)
  } catch (error) {
    closeWebSocket(ws)
    throw error
  }

  const connection = await observeRuleMatch(ws, url, proxyPort)
  const rulesAfter = await mihomoRules().catch(() => rulesBefore)
  const beforeByIndex = new Map(rulesBefore.rules.map((rule) => [rule.index, rule]))
  const candidates = rulesAfter.rules.filter(
    (rule) =>
      !rule.extra.disabled &&
      rule.type === connection.rule &&
      rule.payload === connection.rulePayload
  )
  const matchedRule =
    candidates.find(
      (rule) => rule.extra.hitCount > (beforeByIndex.get(rule.index)?.extra.hitCount || 0)
    ) || candidates[0]

  return {
    url: url.toString(),
    host: url.hostname,
    port,
    ruleIndex: matchedRule?.index,
    rule: connection.rule,
    rulePayload: connection.rulePayload,
    ruleProxy: matchedRule?.proxy || '',
    chains: connection.chains || [],
    destinationIP: connection.metadata.destinationIP || ''
  }
}

export const mihomoProxies = async (): Promise<ControllerProxies> => {
  const instance = await getAxios()
  return await instance.get('/proxies')
}

function isControllerGroupDetail(
  proxy: ControllerProxiesDetail | ControllerGroupDetail | undefined
): proxy is ControllerGroupDetail {
  return Boolean(proxy && 'all' in proxy)
}

const PROVIDER_DETAIL_FETCH_THRESHOLD = 8

async function resolveProviderProxies(
  names: Set<string>,
  providerNames: Set<string>,
  fallbackToAllProviders: boolean
): Promise<Record<string, ControllerProxiesDetail>> {
  if (names.size === 0) return {}

  const providers =
    fallbackToAllProviders || providerNames.size > PROVIDER_DETAIL_FETCH_THRESHOLD
      ? Object.values((await mihomoProxyProviders()).providers)
      : await Promise.all([...providerNames].map((name) => mihomoProxyProvider(name)))

  const providerProxies: Record<string, ControllerProxiesDetail> = {}
  providers.forEach((provider) => {
    provider.proxies?.forEach((proxy) => {
      if (names.has(proxy.name)) {
        providerProxies[proxy.name] = proxy
      }
    })
  })
  return providerProxies
}

export const mihomoGroups = async (): Promise<ControllerMixedGroup[]> => {
  const { mode = 'rule' } = await getControledMihomoConfig()
  if (mode === 'direct') return []
  const [proxies, runtime] = await Promise.all([mihomoProxies(), getRuntimeConfig()])
  const rawGroups: { group: ControllerGroupDetail & { testUrl?: string }; providers: string[] }[] =
    []

  runtime?.['proxy-groups']?.forEach((group: { name: string; url?: string; use?: string[] }) => {
    const proxy = proxies.proxies[group.name]
    if (isControllerGroupDetail(proxy) && !proxy.hidden) {
      rawGroups.push({ group: { ...proxy, testUrl: group.url }, providers: group.use || [] })
    }
  })

  if (!rawGroups.find(({ group }) => group.name === 'GLOBAL')) {
    const global = proxies.proxies['GLOBAL']
    if (isControllerGroupDetail(global) && !global.hidden) {
      rawGroups.push({ group: global, providers: [] })
    }
  }

  const missingProxyNames = new Set<string>()
  const providerNames = new Set<string>()
  let fallbackToAllProviders = false
  rawGroups.forEach(({ group, providers }) => {
    group.all.forEach((name) => {
      if (!proxies.proxies[name]) {
        missingProxyNames.add(name)
        if (providers.length > 0) {
          providers.forEach((provider) => providerNames.add(provider))
        } else {
          fallbackToAllProviders = true
        }
      }
    })
  })

  const providerProxies = await resolveProviderProxies(
    missingProxyNames,
    providerNames,
    fallbackToAllProviders
  )
  const groups: ControllerMixedGroup[] = []
  rawGroups.forEach(({ group }) => {
    const newAll = group.all
      .map((name) => proxies.proxies[name] || providerProxies[name])
      .filter((proxy): proxy is ControllerProxiesDetail | ControllerGroupDetail => Boolean(proxy))
    groups.push({ ...group, all: newAll })
  })

  if (mode === 'global') {
    const global = groups.findIndex((group) => group.name === 'GLOBAL')
    if (global > 0) groups.unshift(groups.splice(global, 1)[0])
  }
  return groups
}

export const mihomoProxyProviders = async (): Promise<ControllerProxyProviders> => {
  const instance = await getAxios()
  return await instance.get('/providers/proxies')
}

const mihomoProxyProvider = async (name: string): Promise<ControllerProxyProviderDetail> => {
  const instance = await getAxios()
  return await instance.get(`/providers/proxies/${encodeURIComponent(name)}`)
}

export const mihomoUpdateProxyProviders = async (name: string): Promise<void> => {
  const instance = await getAxios()
  return await instance.put(`/providers/proxies/${encodeURIComponent(name)}`)
}

export const mihomoRuleProviders = async (): Promise<ControllerRuleProviders> => {
  const instance = await getAxios()
  return await instance.get('/providers/rules')
}

export const mihomoUpdateRuleProviders = async (name: string): Promise<void> => {
  const instance = await getAxios()
  return await instance.put(`/providers/rules/${encodeURIComponent(name)}`)
}

export const mihomoChangeProxy = async (
  group: string,
  proxy: string
): Promise<ControllerProxiesDetail> => {
  const instance = await getAxios()
  return await instance.put(`/proxies/${encodeURIComponent(group)}`, { name: proxy })
}

export const mihomoUnfixedProxy = async (group: string): Promise<ControllerProxiesDetail> => {
  const instance = await getAxios()
  return await instance.delete(`/proxies/${encodeURIComponent(group)}`)
}

export const mihomoProxyDelay = async (
  proxy: string,
  url?: string,
  provider?: string
): Promise<ControllerProxiesDelay> => {
  const appConfig = await getAppConfig()
  const { delayTestUrl, delayTestTimeout } = appConfig
  const instance = await getAxios()
  const path = provider
    ? `/providers/proxies/${encodeURIComponent(provider)}/${encodeURIComponent(proxy)}/healthcheck`
    : `/proxies/${encodeURIComponent(proxy)}/delay`
  return await instance.get(path, {
    params: {
      url: url || delayTestUrl || 'https://www.gstatic.com/generate_204',
      timeout: delayTestTimeout || 5000
    }
  })
}

export const mihomoGroupDelay = async (
  group: string,
  url?: string
): Promise<ControllerGroupDelay> => {
  const appConfig = await getAppConfig()
  const { delayTestUrl, delayTestTimeout } = appConfig
  const instance = await getAxios()
  return await instance.get(`/group/${encodeURIComponent(group)}/delay`, {
    params: {
      url: url || delayTestUrl || 'https://www.gstatic.com/generate_204',
      timeout: delayTestTimeout || 5000
    }
  })
}

export const mihomoRulesDisable = async (rules: Record<string, boolean>): Promise<void> => {
  const instance = await getAxios()
  return await instance.patch(`/rules/disable`, rules)
}

export const mihomoUpgrade = async (channel: string): Promise<void> => {
  if (process.platform === 'win32') await patchMihomoConfig({ 'log-level': 'info' })
  const instance = await getAxios()
  return await instance.post(`/upgrade?channel=${encodeURIComponent(channel)}`, undefined, {
    timeout: 90000
  })
}

export const mihomoUpgradeGeo = async (): Promise<void> => {
  const instance = await getAxios()
  return await instance.post('/upgrade/geo', undefined, { timeout: 90000 })
}

export const mihomoUpgradeUI = async (): Promise<void> => {
  const instance = await getAxios()
  return await instance.post('/upgrade/ui', undefined, { timeout: 90000 })
}

export const startMihomoTraffic = async (): Promise<void> => {
  if (isWebSocketActive(mihomoTrafficWs)) return
  if (trafficReconnectTimer) {
    clearTimeout(trafficReconnectTimer)
    trafficReconnectTimer = null
  }
  await mihomoTraffic()
}

export const stopMihomoTraffic = (): void => {
  trafficRetry = 10
  if (trafficReconnectTimer) {
    clearTimeout(trafficReconnectTimer)
    trafficReconnectTimer = null
  }
  if (mihomoTrafficWs) {
    closeWebSocket(mihomoTrafficWs)
    mihomoTrafficWs = null
  }
}

const mihomoTraffic = async (): Promise<void> => {
  const ws = await mihomoWs('/traffic')
  mihomoTrafficWs = ws

  ws.onmessage = async (e): Promise<void> => {
    const data = e.data as string
    const json = JSON.parse(data) as ControllerTraffic
    trafficRetry = 10
    try {
      safeSendToWindow(mainWindow, 'mihomoTraffic', json)
      if (process.platform !== 'linux') {
        tray?.setToolTip(
          '↑' +
            `${calcTraffic(json.up)}/s`.padStart(9) +
            '\n↓' +
            `${calcTraffic(json.down)}/s`.padStart(9)
        )
      }
      void updateTrayTraffic(json.up, json.down).catch(() => {})
      safeSendToWindow(floatingWindow, 'mihomoTraffic', json)
      if (customTrayWindow && !customTrayWindow.isDestroyed() && customTrayWindow.isVisible()) {
        safeSendToWindow(customTrayWindow, 'mihomoTraffic', json)
      }
    } catch {
      // ignore
    }
  }

  ws.onclose = (): void => {
    if (mihomoTrafficWs === ws) {
      mihomoTrafficWs = null
    }
    if (mihomoTrafficWs !== null || !trafficRetry || trafficReconnectTimer) return

    trafficRetry--
    trafficReconnectTimer = setTimeout(() => {
      trafficReconnectTimer = null
      mihomoTraffic().catch(() => {})
    }, wsReconnectDelay)
  }

  ws.onerror = (): void => {
    ws.close()
  }
}

export const startMihomoMemory = async (): Promise<void> => {
  if (isWebSocketActive(mihomoMemoryWs)) return
  if (memoryReconnectTimer) {
    clearTimeout(memoryReconnectTimer)
    memoryReconnectTimer = null
  }
  await mihomoMemory()
}

export const stopMihomoMemory = (): void => {
  memoryRetry = 10
  if (memoryReconnectTimer) {
    clearTimeout(memoryReconnectTimer)
    memoryReconnectTimer = null
  }
  if (mihomoMemoryWs) {
    closeWebSocket(mihomoMemoryWs)
    mihomoMemoryWs = null
  }
}

const mihomoMemory = async (): Promise<void> => {
  const ws = await mihomoWs('/memory')
  mihomoMemoryWs = ws

  ws.onmessage = (e): void => {
    const data = e.data as string
    memoryRetry = 10
    try {
      safeSendToWindow(mainWindow, 'mihomoMemory', JSON.parse(data) as ControllerMemory)
    } catch {
      // ignore
    }
  }

  ws.onclose = (): void => {
    if (mihomoMemoryWs === ws) {
      mihomoMemoryWs = null
    }
    if (mihomoMemoryWs !== null || !memoryRetry || memoryReconnectTimer) return

    memoryRetry--
    memoryReconnectTimer = setTimeout(() => {
      memoryReconnectTimer = null
      mihomoMemory().catch(() => {})
    }, wsReconnectDelay)
  }

  ws.onerror = (): void => {
    ws.close()
  }
}

export const startMihomoLogs = async (): Promise<void> => {
  if (isWebSocketActive(mihomoLogsWs)) return
  if (logsReconnectTimer) {
    clearTimeout(logsReconnectTimer)
    logsReconnectTimer = null
  }
  await mihomoLogs()
}

export const stopMihomoLogs = (): void => {
  logsRetry = 10
  if (logsReconnectTimer) {
    clearTimeout(logsReconnectTimer)
    logsReconnectTimer = null
  }
  if (mihomoLogsWs) {
    closeWebSocket(mihomoLogsWs)
    mihomoLogsWs = null
  }
}

export const restartMihomoLogs = async (): Promise<void> => {
  stopMihomoLogs()
  await startMihomoLogs()
}

const mihomoLogs = async (): Promise<void> => {
  const { realtimeLogLevel } = await getAppConfig()
  const { 'log-level': logLevel = 'info' } = await getControledMihomoConfig()
  const activeLogLevel = realtimeLogLevel ?? logLevel

  const ws = await mihomoWs(`/logs?level=${activeLogLevel}`)
  mihomoLogsWs = ws

  ws.onmessage = (e): void => {
    const data = e.data as string
    logsRetry = 10
    try {
      publishMihomoLog(JSON.parse(data) as ControllerLog)
    } catch {
      // ignore
    }
  }

  ws.onclose = (): void => {
    if (mihomoLogsWs === ws) {
      mihomoLogsWs = null
    }
    if (mihomoLogsWs !== null || !logsRetry || logsReconnectTimer) return

    logsRetry--
    logsReconnectTimer = setTimeout(() => {
      logsReconnectTimer = null
      mihomoLogs().catch(() => {})
    }, wsReconnectDelay)
  }

  ws.onerror = (): void => {
    ws.close()
  }
}

export const startMihomoConnections = async (): Promise<void> => {
  if (isWebSocketActive(mihomoConnectionsWs)) return
  if (connectionsReconnectTimer) {
    clearTimeout(connectionsReconnectTimer)
    connectionsReconnectTimer = null
  }
  await mihomoConnections()
}

export const stopMihomoConnections = (): void => {
  connectionsRetry = 10
  if (connectionsReconnectTimer) {
    clearTimeout(connectionsReconnectTimer)
    connectionsReconnectTimer = null
  }
  if (mihomoConnectionsWs) {
    closeWebSocket(mihomoConnectionsWs)
    mihomoConnectionsWs = null
  }
}

export const restartMihomoConnections = async (): Promise<void> => {
  stopMihomoConnections()
  await startMihomoConnections()
}

const mihomoConnections = async (): Promise<void> => {
  const { connectionInterval = 500 } = await getAppConfig()
  const ws = await mihomoWs(`/connections?interval=${connectionInterval}`)
  mihomoConnectionsWs = ws

  ws.onmessage = (e): void => {
    const data = e.data as string
    connectionsRetry = 10
    try {
      safeSendToWindow(
        mainWindow,
        'mihomoConnections',
        JSON.parse(data) as ControllerConnections
      )
    } catch {
      // ignore
    }
  }

  ws.onclose = (): void => {
    if (mihomoConnectionsWs === ws) {
      mihomoConnectionsWs = null
    }
    if (mihomoConnectionsWs !== null || !connectionsRetry || connectionsReconnectTimer) return

    connectionsRetry--
    connectionsReconnectTimer = setTimeout(() => {
      connectionsReconnectTimer = null
      mihomoConnections().catch(() => {})
    }, wsReconnectDelay)
  }

  ws.onerror = (): void => {
    ws.close()
  }
}
