import {
  getControledMihomoConfig,
  getProfileConfig,
  getProfile,
  getProfileStr,
  getProfileItem,
  getOverride,
  getOverrideItem,
  getOverrideConfig,
  getAppConfig,
  patchAppConfig
} from '../config'
import {
  mihomoProfileWorkDir,
  mihomoWorkConfigPath,
  mihomoWorkDir,
  overridePath
} from '../utils/dirs'
import { parseYaml, stringifyYaml } from '../utils/yaml'
import { copyFile, mkdir, readFile, readdir, writeFile } from 'fs/promises'
import { deepMerge } from '../utils/merge'
import vm from 'vm'
import { existsSync, writeFileSync } from 'fs'
import path from 'path'
import { is } from '@electron-toolkit/utils'
import { createServer } from 'node:net'

let runtimeConfigStr: string,
  rawProfileStr: string,
  currentProfileStr: string,
  overrideProfileStr: string,
  runtimeConfig: MihomoConfig
let runtimeSpeedTestPort = 17891
let runtimeCodexTestPorts: number[] = []

interface GenerateProfileOptions {
  reuseTestPorts?: RuntimeTestPorts
  preserveRuntimeTestPorts?: boolean
}

interface RuntimeTestPorts {
  speedTestPort: number
  codexTestPorts: number[]
}

export async function generateProfile(options: GenerateProfileOptions = {}): Promise<void> {
  const { current } = await getProfileConfig()
  const {
    diffWorkDir = false,
    controlDns = true,
    controlSniff = true,
    speedTestPort = 17891,
    testChannelCapacity
  } = await getAppConfig()
  const currentProfileConfig = await getProfile(current)
  rawProfileStr = await getProfileStr(current)
  currentProfileStr = stringifyYaml(currentProfileConfig)
  const currentProfile = await overrideProfile(current, currentProfileConfig)
  overrideProfileStr = stringifyYaml(currentProfile)
  const controledMihomoConfig = await getControledMihomoConfig()

  const configToMerge = JSON.parse(JSON.stringify(controledMihomoConfig))
  if (!controlDns) {
    delete configToMerge.dns
    delete configToMerge.hosts
  }
  if (!controlSniff) {
    delete configToMerge.sniffer
  }

  const profile = deepMerge(JSON.parse(JSON.stringify(currentProfile)), configToMerge)

  configureDevelopmentIsolation(profile)
  const reusableRuntimeTestPorts =
    options.reuseTestPorts ||
    (options.preserveRuntimeTestPorts && runtimeCodexTestPorts.length > 0
      ? {
          speedTestPort: runtimeSpeedTestPort,
          codexTestPorts: [...runtimeCodexTestPorts]
        }
      : undefined)
  const runtimeTestChannelCapacity =
    reusableRuntimeTestPorts?.codexTestPorts.length ??
    normalizeTestChannelCapacity(testChannelCapacity)
  await configureTestChannels(
    profile,
    speedTestPort,
    runtimeTestChannelCapacity,
    reusableRuntimeTestPorts
  )
  await cleanProfile(profile, controlDns, controlSniff)

  runtimeConfig = profile
  runtimeConfigStr = stringifyYaml(profile)
  if (diffWorkDir) {
    await prepareProfileWorkDir(current)
  }
  await writeFile(
    diffWorkDir ? mihomoWorkConfigPath(current) : mihomoWorkConfigPath('work'),
    runtimeConfigStr
  )
}

export const SPEED_TEST_GROUP = '__SPARKLE_SPEEDTEST__'
const SPEED_TEST_LISTENER = 'sparkle-speedtest'
const DEFAULT_TEST_CHANNEL_CAPACITY = 6
export const MAX_CODEX_TEST_CONCURRENCY = 16
const CODEX_TEST_GROUP_PREFIX = '__SPARKLE_CODEX_TEST_'
const CODEX_TEST_LISTENER_PREFIX = 'sparkle-codex-test-'

function codexTestGroup(index: number): string {
  return `${CODEX_TEST_GROUP_PREFIX}${index + 1}__`
}

function codexTestListener(index: number): string {
  return `${CODEX_TEST_LISTENER_PREFIX}${index + 1}`
}

export async function getPersistedTestPorts(
  current: string | undefined,
  diffWorkDir: boolean,
  configuredCapacity?: number
): Promise<RuntimeTestPorts | undefined> {
  try {
    const capacity = normalizeTestChannelCapacity(configuredCapacity)
    const configPath = diffWorkDir ? mihomoWorkConfigPath(current) : mihomoWorkConfigPath('work')
    const profile = parseYaml<MihomoConfig>(await readFile(configPath, 'utf-8'))
    const speedTestPort = profile.listeners?.find((item) => item.name === SPEED_TEST_LISTENER)?.port
    const codexTestPorts = Array.from(
      { length: capacity },
      (_, index) => profile.listeners?.find((item) => item.name === codexTestListener(index))?.port
    )
    const ports = [speedTestPort, ...codexTestPorts]
    if (
      ports.some((port) => !Number.isInteger(port) || Number(port) <= 0 || Number(port) > 65535)
    ) {
      return undefined
    }
    return {
      speedTestPort: Number(speedTestPort),
      codexTestPorts: codexTestPorts.map(Number)
    }
  } catch {
    return undefined
  }
}

function configureDevelopmentIsolation(profile: MihomoConfig): void {
  if (!is.dev || !profile.dns) return

  // A subscription may expose a fixed local DNS port. The installed app can
  // already own that port, while the development core only needs internal DNS.
  delete profile.dns.listen
}

function isLoopbackPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.unref()
    server.once('error', () => resolve(false))
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.close((error) => resolve(!error))
    })
  })
}

async function configureTestChannels(
  profile: MihomoConfig,
  configuredPort: number,
  capacity: number,
  reuseTestPorts?: RuntimeTestPorts
): Promise<void> {
  const preferredPort =
    Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65535
      ? configuredPort
      : 17891

  const occupiedPorts = new Set<number>()
  ;['mixed-port', 'socks-port', 'port', 'redir-port', 'tproxy-port'].forEach((key) => {
    const value = profile[key]
    if (typeof value === 'number' && value > 0) occupiedPorts.add(value)
  })
  profile.listeners?.forEach((listener) => {
    if (
      listener.name === SPEED_TEST_LISTENER ||
      Array.from({ length: MAX_CODEX_TEST_CONCURRENCY }, (_, index) =>
        codexTestListener(index)
      ).includes(String(listener.name))
    ) {
      return
    }
    const value = listener.port
    if (typeof value === 'number' && value > 0) occupiedPorts.add(value)
  })

  const allocatePort = async (start: number, checkAvailability: boolean): Promise<number> => {
    let port = start
    while (port <= 65535) {
      const available =
        !occupiedPorts.has(port) && (!checkAvailability || (await isLoopbackPortAvailable(port)))
      if (available) break
      port++
    }
    if (port > 65535) throw new Error('没有可用的测速端口')
    occupiedPorts.add(port)
    return port
  }

  if (reuseTestPorts) {
    if (reuseTestPorts.codexTestPorts.length !== capacity) {
      throw new Error('复用的 Codex 测试端口数量无效')
    }
    runtimeSpeedTestPort = await allocatePort(reuseTestPorts.speedTestPort, false)
    runtimeCodexTestPorts = []
    for (const port of reuseTestPorts.codexTestPorts) {
      runtimeCodexTestPorts.push(await allocatePort(port, false))
    }
  } else {
    runtimeSpeedTestPort = await allocatePort(preferredPort, true)
    runtimeCodexTestPorts = []
    let nextPort = runtimeSpeedTestPort + 1
    for (let index = 0; index < capacity; index++) {
      const port = await allocatePort(nextPort, true)
      runtimeCodexTestPorts.push(port)
      nextPort = port + 1
    }
  }

  const groups = Array.isArray(profile['proxy-groups']) ? profile['proxy-groups'] : []
  const testGroupNames = new Set([
    SPEED_TEST_GROUP,
    ...Array.from({ length: MAX_CODEX_TEST_CONCURRENCY }, (_, index) => codexTestGroup(index))
  ])
  profile['proxy-groups'] = groups.filter((group) => !testGroupNames.has(group.name))
  const selectableGroups = profile['proxy-groups'].map((group) => group.name)
  const createTestGroup = (name: string): MihomoProxyGroupConfig => ({
    name,
    type: 'select',
    proxies: [...new Set(['DIRECT', ...selectableGroups])],
    'include-all': true,
    hidden: true
  })
  profile['proxy-groups'].push(createTestGroup(SPEED_TEST_GROUP))
  for (let index = 0; index < capacity; index++) {
    profile['proxy-groups'].push(createTestGroup(codexTestGroup(index)))
  }

  const listeners = Array.isArray(profile.listeners) ? profile.listeners : []
  const testListenerNames = new Set([
    SPEED_TEST_LISTENER,
    ...Array.from({ length: MAX_CODEX_TEST_CONCURRENCY }, (_, index) => codexTestListener(index))
  ])
  profile.listeners = listeners.filter((listener) => !testListenerNames.has(String(listener.name)))
  profile.listeners.push({
    name: SPEED_TEST_LISTENER,
    type: 'mixed',
    listen: '127.0.0.1',
    port: runtimeSpeedTestPort,
    proxy: SPEED_TEST_GROUP
  })
  for (let index = 0; index < capacity; index++) {
    profile.listeners.push({
      name: codexTestListener(index),
      type: 'mixed',
      listen: '127.0.0.1',
      port: runtimeCodexTestPorts[index],
      proxy: codexTestGroup(index)
    })
  }
}

export function getRuntimeSpeedTestPort(): number {
  return runtimeSpeedTestPort
}

export function getRuntimeCodexTestChannels(): Array<{
  group: string
  listener: string
  port: number
}> {
  return runtimeCodexTestPorts.map((port, index) => ({
    group: codexTestGroup(index),
    listener: codexTestListener(index),
    port
  }))
}

export function normalizeTestChannelCapacity(value?: number): number {
  const numericValue = Number(value)
  if (!Number.isFinite(numericValue)) return DEFAULT_TEST_CHANNEL_CAPACITY
  return Math.min(MAX_CODEX_TEST_CONCURRENCY, Math.max(1, Math.trunc(numericValue)))
}

export async function getTestChannelCapacityStatus(): Promise<{
  current: number
  configured: number
  default: number
  max: number
  restartRequired: boolean
}> {
  const { testChannelCapacity } = await getAppConfig()
  const current = runtimeCodexTestPorts.length
  const configured = normalizeTestChannelCapacity(testChannelCapacity)
  return {
    current,
    configured,
    default: DEFAULT_TEST_CHANNEL_CAPACITY,
    max: MAX_CODEX_TEST_CONCURRENCY,
    restartRequired: current !== configured
  }
}

export async function ensureRuntimeTestChannelCapacity(requestedCapacity: number): Promise<void> {
  const requested = normalizeTestChannelCapacity(requestedCapacity)
  const { testChannelCapacity } = await getAppConfig()
  const configured = normalizeTestChannelCapacity(testChannelCapacity)
  const current = runtimeCodexTestPorts.length

  if (requested > configured) {
    await patchAppConfig({ testChannelCapacity: requested })
  }
  if (requested <= current) return

  const target = Math.max(configured, requested)
  throw new Error(
    `当前内核只有 ${current} 个测速通道，${requested > configured ? `已将通道容量扩展为 ${target}` : `通道容量已设置为 ${target}`}。请手动重启内核后再次测试。`
  )
}

async function cleanProfile(
  profile: MihomoConfig,
  controlDns: boolean,
  controlSniff: boolean
): Promise<void> {
  if (!['info', 'debug'].includes(profile['log-level'])) {
    profile['log-level'] = 'info'
  }

  configureLanSettings(profile)
  cleanBooleanConfigs(profile)
  cleanNumberConfigs(profile)
  cleanStringConfigs(profile)
  cleanAuthenticationConfig(profile)
  cleanTunConfig(profile)
  cleanDnsConfig(profile, controlDns)
  cleanSnifferConfig(profile, controlSniff)
  cleanProxyConfigs(profile)
}

function cleanBooleanConfigs(profile: MihomoConfig): void {
  if (profile.ipv6 !== false) {
    delete (profile as Partial<MihomoConfig>).ipv6
  }

  const booleanConfigs = [
    'unified-delay',
    'tcp-concurrent',
    'geodata-mode',
    'geo-auto-update',
    'disable-keep-alive'
  ]

  booleanConfigs.forEach((key) => {
    if (!profile[key]) delete (profile as Partial<MihomoConfig>)[key]
  })

  if (!profile.profile) return

  const { 'store-selected': hasStoreSelected, 'store-fake-ip': hasStoreFakeIp } = profile.profile

  if (!hasStoreSelected && !hasStoreFakeIp) {
    delete (profile as Partial<MihomoConfig>).profile
  } else {
    const profileConfig = profile.profile as MihomoProfileConfig
    if (!hasStoreSelected) delete profileConfig['store-selected']
    if (!hasStoreFakeIp) delete profileConfig['store-fake-ip']
  }
}

function cleanNumberConfigs(profile: MihomoConfig): void {
  ;[
    'port',
    'socks-port',
    'redir-port',
    'tproxy-port',
    'mixed-port',
    'keep-alive-idle',
    'keep-alive-interval'
  ].forEach((key) => {
    if (profile[key] === 0) delete (profile as Partial<MihomoConfig>)[key]
  })
}

function cleanStringConfigs(profile: MihomoConfig): void {
  const partialProfile = profile as Partial<MihomoConfig>

  if (profile.mode === 'rule') delete partialProfile.mode

  // Mihomo no longer accepts this global option. It can still be supplied by an
  // older subscription or override after the controlled-config migration runs,
  // so remove it from the final runtime profile as well.
  delete partialProfile['global-client-fingerprint']

  const emptyStringConfigs = ['interface-name', 'secret']
  emptyStringConfigs.forEach((key) => {
    if (profile[key] === '') delete partialProfile[key]
  })

  if (profile['external-controller'] === '') {
    delete partialProfile['external-controller']
    delete partialProfile['external-ui']
    delete partialProfile['external-ui-url']
    delete partialProfile['external-controller-cors']
  } else if (profile['external-ui'] === '') {
    delete partialProfile['external-ui']
    delete partialProfile['external-ui-url']
  }
}

function configureLanSettings(profile: MihomoConfig): void {
  const partialProfile = profile as Partial<MihomoConfig>

  if (profile['allow-lan'] === false) {
    delete partialProfile['lan-allowed-ips']
    delete partialProfile['lan-disallowed-ips']
    return
  }

  if (!profile['allow-lan']) {
    delete partialProfile['allow-lan']
    delete partialProfile['lan-allowed-ips']
    delete partialProfile['lan-disallowed-ips']
    return
  }

  const allowedIps = profile['lan-allowed-ips']
  if (allowedIps?.length === 0) {
    delete partialProfile['lan-allowed-ips']
  } else if (allowedIps && !allowedIps.some((ip: string) => ip.startsWith('127.0.0.1/'))) {
    allowedIps.push('127.0.0.1/8')
  }

  if (profile['lan-disallowed-ips']?.length === 0) {
    delete partialProfile['lan-disallowed-ips']
  }
}

function cleanAuthenticationConfig(profile: MihomoConfig): void {
  if (profile.authentication?.length === 0) {
    const partialProfile = profile as Partial<MihomoConfig>
    delete partialProfile.authentication
    delete partialProfile['skip-auth-prefixes']
  }
}

function cleanTunConfig(profile: MihomoConfig): void {
  if (!profile.tun?.enable) {
    delete (profile as Partial<MihomoConfig>).tun
    return
  }

  const tunConfig = profile.tun as MihomoTunConfig

  if (tunConfig['auto-route'] !== false) {
    delete tunConfig['auto-route']
  }
  if (tunConfig['auto-detect-interface'] !== false) {
    delete tunConfig['auto-detect-interface']
  }

  const tunBooleanConfigs = ['auto-redirect', 'strict-route', 'disable-icmp-forwarding']
  tunBooleanConfigs.forEach((key) => {
    if (!tunConfig[key]) delete tunConfig[key]
  })

  if (tunConfig.device === '') {
    delete tunConfig.device
  } else if (
    process.platform === 'darwin' &&
    tunConfig.device &&
    !tunConfig.device.startsWith('utun')
  ) {
    delete tunConfig.device
  }

  if (tunConfig['dns-hijack']?.length === 0) delete tunConfig['dns-hijack']
  if (tunConfig['route-exclude-address']?.length === 0) delete tunConfig['route-exclude-address']
}

function cleanDnsConfig(profile: MihomoConfig, controlDns: boolean): void {
  if (!controlDns) return
  if (!profile.dns?.enable) {
    delete (profile as Partial<MihomoConfig>).dns
    return
  }

  const dnsConfig = profile.dns as MihomoDNSConfig
  const dnsArrayConfigs = [
    'fake-ip-range',
    'fake-ip-range6',
    'fake-ip-filter',
    'proxy-server-nameserver',
    'direct-nameserver',
    'nameserver'
  ]

  dnsArrayConfigs.forEach((key) => {
    if (dnsConfig[key]?.length === 0) delete dnsConfig[key]
  })

  if (dnsConfig['respect-rules'] === false || dnsConfig['proxy-server-nameserver']?.length === 0) {
    delete dnsConfig['respect-rules']
  }

  if (dnsConfig['nameserver-policy'] && Object.keys(dnsConfig['nameserver-policy']).length === 0) {
    delete dnsConfig['nameserver-policy']
  }
  if (
    dnsConfig['proxy-server-nameserver-policy'] &&
    Object.keys(dnsConfig['proxy-server-nameserver-policy']).length === 0
  ) {
    delete dnsConfig['proxy-server-nameserver-policy']
  }

  delete dnsConfig.fallback
  delete dnsConfig['fallback-filter']
}

function cleanSnifferConfig(profile: MihomoConfig, controlSniff: boolean): void {
  if (!controlSniff) return
  if (!profile.sniffer?.enable) {
    delete (profile as Partial<MihomoConfig>).sniffer
  }
}

function cleanProxyConfigs(profile: MihomoConfig): void {
  const partialProfile = profile as Partial<MihomoConfig>
  const arrayConfigs = ['proxies', 'proxy-groups', 'rules']
  const objectConfigs = ['proxy-providers', 'rule-providers']

  arrayConfigs.forEach((key) => {
    if (Array.isArray(profile[key]) && profile[key]?.length === 0) {
      delete partialProfile[key]
    }
  })

  objectConfigs.forEach((key) => {
    const value = profile[key]
    if (
      value === null ||
      value === undefined ||
      (value && typeof value === 'object' && Object.keys(value).length === 0)
    ) {
      delete partialProfile[key]
    }
  })
}

async function prepareProfileWorkDir(current: string | undefined): Promise<void> {
  const targetDir = mihomoProfileWorkDir(current)
  const sourceDir = mihomoWorkDir()
  if (!existsSync(targetDir)) {
    await mkdir(targetDir, { recursive: true })
  }
  const copy = async (file: string): Promise<void> => {
    const targetPath = path.join(targetDir, file)
    const sourcePath = path.join(sourceDir, file)
    if (!existsSync(targetPath) && existsSync(sourcePath)) {
      await copyFile(sourcePath, targetPath)
    }
  }
  const files = await readdir(sourceDir, { withFileTypes: true })
  await Promise.all(
    files
      .filter((file) => file.isFile() && /(?:db|dat)$/i.test(file.name))
      .map((file) => copy(file.name))
  )
}

async function overrideProfile(
  current: string | undefined,
  profile: MihomoConfig
): Promise<MihomoConfig> {
  const { items = [] } = (await getOverrideConfig()) || {}
  const globalOverride = items.filter((item) => item.global).map((item) => item.id)
  const { override = [] } = (await getProfileItem(current)) || {}
  for (const ov of new Set(globalOverride.concat(override))) {
    const item = await getOverrideItem(ov)
    const content = await getOverride(ov, item?.ext || 'js')
    switch (item?.ext) {
      case 'js':
        profile = await runOverrideScript(profile, content, item)
        break
      case 'yaml': {
        let patch = parseYaml<Partial<MihomoConfig>>(content)
        if (typeof patch !== 'object') patch = {}
        profile = deepMerge(profile, patch, true)
        break
      }
    }
  }
  return profile
}

async function runOverrideScript(
  profile: MihomoConfig,
  script: string,
  item: OverrideItem
): Promise<MihomoConfig> {
  const log = (type: string, data: string, flag = 'a'): void => {
    writeFileSync(overridePath(item.id, 'log'), `[${type}] ${data}\n`, {
      encoding: 'utf-8',
      flag
    })
  }
  try {
    const b64d = (str: string): string => Buffer.from(str, 'base64').toString('utf-8')
    const b64e = (data: Buffer | string): string =>
      (Buffer.isBuffer(data) ? data : Buffer.from(String(data))).toString('base64')
    const ctx = {
      console: Object.freeze({
        log: (...args: unknown[]) => log('log', args.map(format).join(' ')),
        info: (...args: unknown[]) => log('info', args.map(format).join(' ')),
        error: (...args: unknown[]) => log('error', args.map(format).join(' ')),
        debug: (...args: unknown[]) => log('debug', args.map(format).join(' '))
      }),
      fetch,
      yaml: { parse: parseYaml, stringify: stringifyYaml },
      b64d,
      b64e,
      Buffer
    }
    vm.createContext(ctx)
    log('info', '开始执行脚本', 'w')
    vm.runInContext(script, ctx)
    const promise = vm.runInContext(
      `(async () => {
        const result = main(${JSON.stringify(profile)})
        if (result instanceof Promise) return await result
        return result
      })()`,
      ctx
    )
    const newProfile = await promise
    if (typeof newProfile !== 'object') {
      throw new Error('脚本返回值必须是对象')
    }
    log('info', '脚本执行成功')
    return newProfile
  } catch (e) {
    log('exception', `脚本执行失败：${e}`)
    return profile
  }
}

function format(data: unknown): string {
  if (data instanceof Error) {
    return `${data.name}: ${data.message}\n${data.stack}`
  }
  try {
    return JSON.stringify(data)
  } catch {
    return String(data)
  }
}

export async function getRuntimeConfigStr(): Promise<string> {
  return runtimeConfigStr
}

export async function getRawProfileStr(): Promise<string> {
  return rawProfileStr
}

export async function getCurrentProfileStr(): Promise<string> {
  return currentProfileStr
}

export async function getOverrideProfileStr(): Promise<string> {
  return overrideProfileStr
}

export async function getRuntimeConfig(): Promise<MihomoConfig> {
  return runtimeConfig
}
