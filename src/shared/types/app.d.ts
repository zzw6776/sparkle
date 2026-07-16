interface AppVersion {
  version: string
  changelog: string
}

type AppNotificationMode = 'system' | 'toast'
type AppNotificationVariant = 'default' | 'accent' | 'success' | 'warning' | 'danger'
type SpeedTestSource = 'cloudflare' | 'telegram' | 'custom'

interface SpeedTestResult {
  proxy: string
  source: SpeedTestSource
  url: string
  bytesPerSecond: number
  bitsPerSecond: number
  downloadedBytes: number
  measuredBytes: number
  duration: number
  testedAt: number
}

interface SpeedTestProgress {
  proxy: string
  bytesPerSecond: number
  downloadedBytes: number
  duration: number
}

type GeneralSpeedTestStage = 'selecting' | 'downloading' | 'completed'

interface GeneralSpeedTestProgress {
  proxy: string
  round: number
  rounds: number
  stage: GeneralSpeedTestStage
  completed: number
  total: number
  bytesPerSecond?: number
  downloadedBytes?: number
  duration?: number
  result?: SpeedTestResult
  error?: string
}

interface GeneralSpeedTestRoundResult {
  proxy: string
  round: number
  result?: SpeedTestResult
  error?: string
}

type CodexTestStage = 'selecting' | 'probing' | 'completed'

interface CodexTestProgress {
  proxy: string
  round: number
  rounds: number
  stage: CodexTestStage
  completed: number
  total: number
  result?: CodexTestResult
}

interface CodexTestRoundResult {
  round: number
  success: boolean
  combinedMs?: number
  tunnelMs?: number
  tlsMs?: number
  httpsTtfbMs?: number
  websocketMs?: number
  httpsStatus?: number
  websocketStatus?: number
  error?: string
}

interface CodexTestResult {
  proxy: string
  rounds: number
  completedRounds: number
  succeeded: number
  failed: number
  successRate: number
  tunnelMs?: number
  tlsMs?: number
  httpsTtfbMs?: number
  websocketMs?: number
  totalMs?: number
  jitterMs?: number
  score?: number
  httpsStatus?: number
  websocketStatus?: number
  error?: string
  roundResults: CodexTestRoundResult[]
  testedAt: number
}

type CodexActualTestStage = 'selecting' | 'starting' | 'requesting' | 'streaming' | 'completed'

interface CodexActualTestTokenUsage {
  totalTokens: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
}

interface CodexActualTestRouteEvidence {
  inboundName: string
  host: string
  destinationIP: string
  remoteDestination: string
  dnsMode: string
  chains: string[]
}

interface CodexActualTestRoundResult {
  round: number
  success: boolean
  routeVerified: boolean
  queueMs?: number
  firstTokenMs?: number
  totalMs?: number
  model?: string
  response?: string
  routes?: CodexActualTestRouteEvidence[]
  tokenUsage?: CodexActualTestTokenUsage
  error?: string
}

interface CodexActualTestResult {
  proxy: string
  rounds: number
  completedRounds: number
  succeeded: number
  failed: number
  successRate: number
  routeVerifiedRate: number
  queueMs?: number
  firstTokenMs?: number
  totalMs?: number
  jitterMs?: number
  score?: number
  model?: string
  tokenUsage: CodexActualTestTokenUsage
  error?: string
  roundResults: CodexActualTestRoundResult[]
  testedAt: number
}

interface CodexActualTestProgress {
  proxy: string
  round: number
  rounds: number
  stage: CodexActualTestStage
  completed: number
  total: number
  model?: string
  request?: string
  result?: CodexActualTestResult
}

type CodexActualTestLogLevel = 'info' | 'success' | 'error'

interface CodexActualTestLogEntry {
  id: string
  timestamp: number
  level: CodexActualTestLogLevel
  message: string
  proxy?: string
  round?: number
}

interface ProcessTestTargetRequest {
  host: string
  port: number
}

interface ProcessTestRoundResult {
  round: number
  success: boolean
  connectMs?: number
  tlsMs?: number
  totalMs?: number
  error?: string
}

interface ProcessTestDomainResult extends ProcessTestTargetRequest {
  succeeded: number
  failed: number
  successRate: number
  connectMs?: number
  tlsMs?: number
  totalMs?: number
  roundResults: ProcessTestRoundResult[]
}

interface ProcessTestResult {
  proxy: string
  targetCount: number
  completedSamples: number
  totalSamples: number
  successRate: number
  medianMs?: number
  p95Ms?: number
  failedTargets: number
  score?: number
  domains: ProcessTestDomainResult[]
  testedAt: number
}

type ProcessTestStage = 'selecting' | 'probing' | 'completed'

interface ProcessTestProgress {
  proxy: string
  target?: string
  round?: number
  rounds: number
  stage: ProcessTestStage
  completed: number
  total: number
  result?: ProcessTestResult
}

interface AppNotificationPayload {
  title: string
  body?: string
  persistent?: boolean
  url?: string
  variant?: AppNotificationVariant
}

interface ISysProxyConfig {
  enable: boolean
  host?: string
  mode?: SysProxyMode
  bypass?: string[]
  pacScript?: string
  settingMode?: 'exec' | 'service'
  guard?: boolean
  guardNotify?: boolean
}

interface IHost {
  domain: string
  value: string | string[]
}

interface AppConfig {
  updateChannel: 'stable' | 'beta'
  notificationMode?: AppNotificationMode
  showUpdateButtonAfterNotification?: boolean
  core: 'mihomo' | 'mihomo-alpha' | 'system'
  systemCorePath?: string
  corePermissionMode?: 'elevated' | 'service'
  serviceAuthKey?: string
  disableLoopbackDetector: boolean
  disableEmbedCA: boolean
  disableSystemCA: boolean
  disableNftables: boolean
  safePaths: string[]
  proxyDisplayOrder: 'default' | 'delay' | 'speed' | 'name'
  proxyDisplayLayout: 'hidden' | 'single' | 'double'
  groupDisplayLayout: 'hidden' | 'single' | 'double'
  showGroupSelectedProxy: boolean
  showProxyDetailTooltip: boolean
  profileDisplayDate?: 'expire' | 'update'
  envType?: ('bash' | 'fish' | 'cmd' | 'powershell' | 'nushell')[]
  proxyCols: 'auto' | '1' | '2' | '3' | '4'
  connectionDirection: 'asc' | 'desc'
  connectionOrderBy: 'time' | 'upload' | 'download' | 'uploadSpeed' | 'downloadSpeed' | 'process'
  connectionGroupByProcess?: boolean
  connectionGroupSort?: 'name' | 'count' | 'upload' | 'download' | 'uploadSpeed' | 'downloadSpeed'
  connectionGroupDirection?: 'asc' | 'desc'
  connectionInterval?: number
  spinFloatingIcon?: boolean
  disableTray?: boolean
  showFloatingWindow?: boolean
  connectionCardStatus?: CardStatus
  dnsCardStatus?: CardStatus
  logCardStatus?: CardStatus
  speedTestCardStatus?: CardStatus
  pauseSSID?: string[]
  mihomoCoreCardStatus?: CardStatus
  overrideCardStatus?: CardStatus
  profileCardStatus?: CardStatus
  proxyCardStatus?: CardStatus
  resourceCardStatus?: CardStatus
  ruleCardStatus?: CardStatus
  sniffCardStatus?: CardStatus
  substoreCardStatus?: CardStatus
  sysproxyCardStatus?: CardStatus
  tunCardStatus?: CardStatus
  githubToken?: string
  gistSyncEnabled?: boolean
  gistEncrypted?: boolean
  gistAgeRecipient?: string
  gistAgeIdentity?: string
  useSubStore: boolean
  subStoreHost?: string
  subStoreBackendSyncCron?: string
  subStoreBackendDownloadCron?: string
  subStoreBackendUploadCron?: string
  autoLightweight?: boolean
  autoLightweightDelay?: number
  autoLightweightMode?: 'core' | 'tray'
  coreStartupMode?: 'post-up' | 'log'
  useCustomSubStore?: boolean
  useProxyInSubStore?: boolean
  mihomoCpuPriority?: Priority
  customSubStoreUrl?: string
  diffWorkDir?: boolean
  autoSetDNSMode?: 'none' | 'exec' | 'service'
  originDNS?: string
  useWindowFrame: boolean
  proxyInTray: boolean
  trayProxyDelayLayout?: 'same-line' | 'new-line'
  siderOrder: string[]
  siderWidth: number
  appTheme: AppTheme
  customTheme?: string
  autoCheckUpdate: boolean
  silentStart: boolean
  autoCloseConnection: boolean
  closeMode: 'all' | 'group'
  sysProxy: ISysProxyConfig
  saveLogs?: boolean
  maxLogDays: number
  maxLogFileSizeMB?: number
  maxLogEntries?: number
  realtimeLogLevel?: LogLevel
  userAgent?: string
  delayTestConcurrency?: number
  delayTestUseGroupApi?: boolean
  delayTestUrl?: string
  delayTestUrlScope?: 'group' | 'global'
  delayTestTimeout?: number
  speedTestSource?: SpeedTestSource
  speedTestUrl?: string
  speedTestPort?: number
  speedTestDuration?: number
  speedTestMaxBytes?: number
  speedTestWarmupBytes?: number
  speedTestConnections?: number
  generalTestRounds?: number
  generalTestNodeConcurrency?: number
  generalTestConfigExpanded?: boolean
  codexTestConcurrency?: number
  encryptedPassword?: number[]
  rememberProxyGroupOpenState?: boolean
  controlDns?: boolean
  controlSniff?: boolean
  useDockIcon?: boolean
  showTraffic?: boolean
  customTrayIcon?: string
  useCustomTrayMenu?: boolean
  webdavUrl?: string
  webdavDir?: string
  webdavUsername?: string
  webdavPassword?: string
  hosts: IHost[]
  showWindowShortcut?: string
  showFloatingWindowShortcut?: string
  triggerSysProxyShortcut?: string
  triggerTunShortcut?: string
  ruleModeShortcut?: string
  globalModeShortcut?: string
  directModeShortcut?: string
  restartAppShortcut?: string
  quitWithoutCoreShortcut?: string
  onlyActiveDevice?: boolean
  networkDetection?: boolean
  networkDetectionBypass?: string[]
  networkDetectionInterval?: number
  displayIcon?: boolean
  displayAppName?: boolean
  disableGPU: boolean
  disableAnimation?: boolean
}

interface ProfileConfig {
  current?: string
  items: ProfileItem[]
}

interface ProfileItem {
  id: string
  type: 'remote' | 'local'
  name: string
  url?: string // remote
  fingerprint?: string // remote
  ua?: string // remote
  file?: string // local
  verify?: boolean // remote
  interval?: number
  home?: string
  updated?: number
  override?: string[]
  useProxy?: boolean
  ageRecipient?: string
  ageIdentity?: string
  extra?: SubscriptionUserInfo
  substore?: boolean
  locked?: boolean
  autoUpdate?: boolean
}

interface SubscriptionUserInfo {
  upload: number
  download: number
  total: number
  expire: number
}

interface OverrideConfig {
  items: OverrideItem[]
}

interface OverrideItem {
  id: string
  type: 'remote' | 'local'
  ext: 'js' | 'yaml'
  name: string
  updated: number
  global?: boolean
  url?: string
  file?: string
  fingerprint?: string
}

interface SubStoreSub {
  name: string
  displayName?: string
  icon?: string
  tag?: string[]
}
