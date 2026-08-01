import WebSocket from 'ws'
import { createServiceWebSocket, reportServiceUnavailable } from './api'
import { appendAppLog } from '../utils/log'

const dnsGuardReconnectDelay = 1000
const dnsGuardConnectTimeout = 2000
const dnsGuardCloseTimeout = 1000

let dnsGuardWs: WebSocket | null = null
let dnsGuardServers: string[] = []
let dnsGuardPort = 53
let dnsGuardManualClose = true
let dnsGuardReconnectTimer: NodeJS.Timeout | null = null
let dnsGuardGeneration = 0

function dnsGuardPath(servers: string[], port: number): string {
  const query = new URLSearchParams()
  for (const server of servers) {
    query.append('server', server)
  }
  query.set('port', String(port))
  return `/sys/dns/guard?${query.toString()}`
}

async function connectDNSGuard(generation: number): Promise<void> {
  if (dnsGuardManualClose || generation !== dnsGuardGeneration) return
  if (
    dnsGuardWs &&
    (dnsGuardWs.readyState === WebSocket.OPEN || dnsGuardWs.readyState === WebSocket.CONNECTING)
  ) {
    return
  }

  const path = dnsGuardPath(dnsGuardServers, dnsGuardPort)
  const ws = createServiceWebSocket(path)
  dnsGuardWs = ws

  ws.on('message', (data) => {
    appendAppLog(`[DNS]: service guard ${data.toString()}\n`).catch(() => {})
  })
  ws.on('error', (error) => {
    appendAppLog(`[DNS]: service guard websocket error, ${error}\n`).catch(() => {})
    if (!dnsGuardManualClose && generation === dnsGuardGeneration) {
      reportServiceUnavailable(error)
    }
  })
  ws.on('close', () => {
    if (dnsGuardWs === ws) {
      dnsGuardWs = null
    }
    if (!dnsGuardManualClose && generation === dnsGuardGeneration) {
      reportServiceUnavailable(new Error('DNS guard websocket disconnected'))
      scheduleDNSGuardReconnect(generation)
    }
  })

  await waitForDNSGuardSocket(ws)
}

function scheduleDNSGuardReconnect(generation: number): void {
  if (dnsGuardManualClose || generation !== dnsGuardGeneration || dnsGuardReconnectTimer) {
    return
  }

  dnsGuardReconnectTimer = setTimeout(() => {
    dnsGuardReconnectTimer = null
    connectDNSGuard(generation).catch((error) => {
      appendAppLog(`[DNS]: reconnect service guard failed, ${error}\n`).catch(() => {})
      reportServiceUnavailable(error)
      scheduleDNSGuardReconnect(generation)
    })
  }, dnsGuardReconnectDelay)
}

function waitForDNSGuardSocket(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const complete = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ws.off('open', handleOpen)
      ws.off('error', handleError)
      ws.off('unexpected-response', handleUnexpectedResponse)
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }
    const handleOpen = (): void => complete()
    const handleError = (error: Error): void => complete(error)
    const handleUnexpectedResponse = (
      _request: unknown,
      response: { statusCode?: number; resume: () => void }
    ): void => {
      response.resume()
      complete(new Error(`DNS 增强服务返回 HTTP ${response.statusCode ?? 'unknown'}`))
    }
    const timer = setTimeout(() => {
      ws.terminate()
      complete(new Error('连接 DNS 增强服务超时'))
    }, dnsGuardConnectTimeout)

    ws.once('open', handleOpen)
    ws.once('error', handleError)
    ws.once('unexpected-response', handleUnexpectedResponse)
  })
}

async function closeDNSGuardSocket(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return
  if (ws.readyState === WebSocket.CONNECTING) {
    ws.terminate()
    return
  }

  await new Promise<void>((resolve) => {
    let settled = false
    const complete = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ws.off('close', complete)
      resolve()
    }
    const timer = setTimeout(() => {
      ws.terminate()
      complete()
    }, dnsGuardCloseTimeout)
    ws.once('close', complete)
    ws.close()
  })
}

export async function startSysDnsGuard(servers: string[], port = 53): Promise<void> {
  const normalizedServers = Array.from(new Set(servers))
  const sameServers =
    normalizedServers.length === dnsGuardServers.length &&
    normalizedServers.every((server, index) => server === dnsGuardServers[index]) &&
    port === dnsGuardPort

  dnsGuardManualClose = false
  if (
    sameServers &&
    dnsGuardWs &&
    (dnsGuardWs.readyState === WebSocket.OPEN || dnsGuardWs.readyState === WebSocket.CONNECTING)
  ) {
    if (dnsGuardWs.readyState === WebSocket.CONNECTING) {
      await waitForDNSGuardSocket(dnsGuardWs)
    }
    return
  }

  const generation = ++dnsGuardGeneration
  dnsGuardServers = normalizedServers
  dnsGuardPort = port
  if (dnsGuardReconnectTimer) {
    clearTimeout(dnsGuardReconnectTimer)
    dnsGuardReconnectTimer = null
  }

  const previous = dnsGuardWs
  dnsGuardWs = null
  if (previous) {
    previous.removeAllListeners()
    previous.on('error', () => {})
    previous.terminate()
  }

  try {
    await connectDNSGuard(generation)
  } catch (error) {
    reportServiceUnavailable(error)
    scheduleDNSGuardReconnect(generation)
    throw error
  }
}

export async function stopSysDnsGuard(): Promise<void> {
  dnsGuardManualClose = true
  dnsGuardGeneration++
  dnsGuardServers = []
  dnsGuardPort = 53
  if (dnsGuardReconnectTimer) {
    clearTimeout(dnsGuardReconnectTimer)
    dnsGuardReconnectTimer = null
  }

  const ws = dnsGuardWs
  dnsGuardWs = null
  if (ws) {
    await closeDNSGuardSocket(ws)
  }
}
