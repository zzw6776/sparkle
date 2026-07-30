import { execFile } from 'child_process'
import { net } from 'electron'
import { createConnection } from 'node:net'
import os from 'os'
import { promisify } from 'util'
import { getAppConfig, getControledMihomoConfig, patchAppConfig } from '../config'
import { setSysDns } from '../service/api'
import { startSysDnsGuard, stopSysDnsGuard } from '../service/dns-guard'
import { triggerSysProxy } from '../sys/sysproxy'
import { appendAppLog } from '../utils/log'
import { systemDNSListenHost, systemDNSListenPort } from './system-dns-config'

export interface NetworkCoreController {
  shouldStartCore: (networkDownHandled: boolean) => boolean
  startCore: () => Promise<void>
  stopCore: () => Promise<void>
}

let networkDetectionTimer: NodeJS.Timeout | null = null
let networkDetectionGeneration = 0
let networkDownHandled = false
let dnsLifecycleGeneration = 0
let dnsLifecycleQueue: Promise<void> = Promise.resolve()

const compatibilityDNSServers = ['223.5.5.5']
const systemDNSListenerTimeout = 5000

export async function getDefaultDevice(): Promise<string> {
  const execFilePromise = promisify(execFile)
  const { stdout: deviceOut } = await execFilePromise('route', ['-n', 'get', 'default'])
  let device = deviceOut.split('\n').find((s) => s.includes('interface:'))
  device = device?.trim().split(' ').slice(1).join(' ')
  if (!device) throw new Error('Get device failed')
  return device
}

async function getDefaultService(): Promise<string> {
  const execFilePromise = promisify(execFile)
  const device = await getDefaultDevice()
  const { stdout: order } = await execFilePromise('networksetup', ['-listnetworkserviceorder'])
  const block = order.split('\n\n').find((s) => s.includes(`Device: ${device}`))
  if (!block) throw new Error('Get networkservice failed')
  for (const line of block.split('\n')) {
    if (line.match(/^\(\d+\).*/)) {
      return line.trim().split(' ').slice(1).join(' ')
    }
  }
  throw new Error('Get service failed')
}

async function getDNSForService(service: string): Promise<string[]> {
  const execFilePromise = promisify(execFile)
  const { stdout: dns } = await execFilePromise('networksetup', ['-getdnsservers', service])
  if (dns.startsWith("There aren't any DNS Servers set on")) {
    return []
  }
  return dns
    .trim()
    .split(/\r?\n/)
    .map((server) => server.trim())
    .filter(Boolean)
}

async function setDNSForService(
  service: string,
  servers: string[],
  mode: 'exec' | 'service'
): Promise<void> {
  const dnsServers = servers.length > 0 ? servers : ['Empty']
  if (mode === 'exec') {
    const execFilePromise = promisify(execFile)
    await execFilePromise('networksetup', ['-setdnsservers', service, ...dnsServers])
    return
  }
  await setSysDns(service, dnsServers)
}

function legacyOriginDNSServers(value: string): string[] {
  return value === 'Empty' ? [] : value.split(' ').filter(Boolean)
}

async function migrateLegacyOriginDNS(
  originDNS: string,
  mode: 'none' | 'exec' | 'service'
): Promise<OriginDNSState> {
  const state: OriginDNSState = {
    service: await getDefaultService(),
    servers: legacyOriginDNSServers(originDNS),
    mode: mode === 'service' ? 'service' : 'exec'
  }
  await patchAppConfig({ originDNSState: state, originDNS: undefined })
  return state
}

async function restoreSavedDNSState(
  state: OriginDNSState | undefined,
  legacyOriginDNS: string | undefined,
  mode: 'none' | 'exec' | 'service',
  generation: number
): Promise<void> {
  let savedState = state
  if (!savedState && legacyOriginDNS) {
    savedState = await migrateLegacyOriginDNS(legacyOriginDNS, mode)
  }
  if (!savedState || generation !== dnsLifecycleGeneration) return

  await setDNSForService(savedState.service, savedState.servers, savedState.mode)
  if (generation === dnsLifecycleGeneration) {
    await patchAppConfig({ originDNSState: undefined, originDNS: undefined })
  }
}

function probeSystemDNSListener(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({
      host: systemDNSListenHost,
      port: systemDNSListenPort
    })
    let settled = false
    const complete = (ready: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ready)
    }

    socket.setTimeout(250)
    socket.once('connect', () => complete(true))
    socket.once('timeout', () => complete(false))
    socket.once('error', () => complete(false))
  })
}

async function waitForSystemDNSListener(): Promise<void> {
  const deadline = Date.now() + systemDNSListenerTimeout
  while (Date.now() < deadline) {
    if (await probeSystemDNSListener()) return
    await new Promise((resolve) => {
      setTimeout(resolve, 100)
    })
  }
  throw new Error(`Mihomo 本地 DNS 未在 ${systemDNSListenHost}:${systemDNSListenPort} 就绪`)
}

function enqueueDNSLifecycle(
  task: (generation: number) => Promise<void>,
  generation: number
): Promise<void> {
  const next = dnsLifecycleQueue.then(
    () => task(generation),
    () => task(generation)
  )
  dnsLifecycleQueue = next.catch(() => {})
  return next
}

async function setPublicDNSInternal(generation: number): Promise<void> {
  if (process.platform !== 'darwin' || generation !== dnsLifecycleGeneration) return

  const { originDNSState, originDNS, autoSetDNSMode = 'none' } = await getAppConfig()
  if (autoSetDNSMode === 'none' || generation !== dnsLifecycleGeneration) return

  if (autoSetDNSMode === 'service') {
    await waitForSystemDNSListener()
    if (generation !== dnsLifecycleGeneration) return

    await startSysDnsGuard([systemDNSListenHost], systemDNSListenPort)
    if (generation !== dnsLifecycleGeneration) return

    try {
      await restoreSavedDNSState(originDNSState, originDNS, autoSetDNSMode, generation)
    } catch (error) {
      await appendAppLog(`[DNS]: restore legacy network-service DNS failed, ${error}\n`)
    }
    return
  }

  if (generation !== dnsLifecycleGeneration || originDNSState) return

  if (originDNS) {
    try {
      await migrateLegacyOriginDNS(originDNS, autoSetDNSMode)
    } catch (error) {
      await appendAppLog(`[DNS]: migrate legacy DNS recovery state failed, ${error}\n`)
    }
    return
  }

  try {
    const service = await getDefaultService()
    const state: OriginDNSState = {
      service,
      servers: await getDNSForService(service),
      mode: autoSetDNSMode
    }
    await patchAppConfig({ originDNSState: state, originDNS: undefined })
    if (generation !== dnsLifecycleGeneration) return
    await setDNSForService(service, compatibilityDNSServers, autoSetDNSMode)
  } catch (error) {
    await appendAppLog(`[DNS]: no active network service for compatibility DNS, ${error}\n`)
  }
}

async function recoverDNSInternal(generation: number): Promise<void> {
  if (process.platform !== 'darwin') return

  await stopSysDnsGuard()
  if (generation !== dnsLifecycleGeneration) return

  const { originDNSState, originDNS, autoSetDNSMode = 'none' } = await getAppConfig()
  try {
    await restoreSavedDNSState(originDNSState, originDNS, autoSetDNSMode, generation)
  } catch (error) {
    await appendAppLog(`[DNS]: recover network-service DNS failed, ${error}\n`)
  }
}

export function setPublicDNS(): Promise<void> {
  const generation = ++dnsLifecycleGeneration
  return enqueueDNSLifecycle(setPublicDNSInternal, generation)
}

export function recoverDNS(): Promise<void> {
  const generation = ++dnsLifecycleGeneration
  return enqueueDNSLifecycle(recoverDNSInternal, generation)
}

export async function startNetworkDetectionController(
  controller: NetworkCoreController
): Promise<void> {
  const generation = ++networkDetectionGeneration
  let detecting = false
  const { networkDetectionBypass = [], networkDetectionInterval = 10 } = await getAppConfig()
  const { tun: { device = process.platform === 'darwin' ? undefined : 'mihomo' } = {} } =
    await getControledMihomoConfig()
  if (generation !== networkDetectionGeneration) return
  if (networkDetectionTimer) {
    clearInterval(networkDetectionTimer)
  }
  const extendedBypass = networkDetectionBypass.concat(
    [device, 'lo', 'docker0', 'utun'].filter((item): item is string => item !== undefined)
  )

  networkDetectionTimer = setInterval(async () => {
    if (detecting || generation !== networkDetectionGeneration) return
    detecting = true
    try {
      const {
        onlyActiveDevice = false,
        sysProxy = { enable: false },
        autoSetDNSMode = 'none'
      } = await getAppConfig()
      if (generation !== networkDetectionGeneration) return
      const canRunWithoutSystemOnline =
        process.platform === 'darwin' && autoSetDNSMode === 'service'
      if (
        isAnyNetworkInterfaceUp(extendedBypass) &&
        (net.isOnline() || canRunWithoutSystemOnline)
      ) {
        if (controller.shouldStartCore(networkDownHandled)) {
          await controller.startCore()
          if (generation !== networkDetectionGeneration) return
          if (sysProxy.enable) await triggerSysProxy(true, onlyActiveDevice)
          networkDownHandled = false
        }
      } else if (!networkDownHandled) {
        if (sysProxy.enable) await triggerSysProxy(false, onlyActiveDevice, true)
        if (generation !== networkDetectionGeneration) return
        await controller.stopCore()
        if (generation === networkDetectionGeneration) {
          networkDownHandled = true
        }
      }
    } catch (error) {
      appendAppLog(`[Network]: network detection failed, ${error}\n`).catch(() => {})
    } finally {
      detecting = false
    }
  }, networkDetectionInterval * 1000)
}

export function stopNetworkDetection(): void {
  networkDetectionGeneration++
  if (networkDetectionTimer) {
    clearInterval(networkDetectionTimer)
    networkDetectionTimer = null
  }
}

function isAnyNetworkInterfaceUp(excludedKeywords: string[] = []): boolean {
  const interfaces = os.networkInterfaces()
  return Object.entries(interfaces).some(([name, ifaces]) => {
    if (excludedKeywords.some((keyword) => name.includes(keyword))) return false

    return ifaces?.some((iface) => {
      return !iface.internal && (iface.family === 'IPv4' || iface.family === 'IPv6')
    })
  })
}
