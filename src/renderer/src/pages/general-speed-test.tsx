import {
  Button,
  Checkbox,
  Chip,
  Input,
  Progress,
  Select,
  SelectItem,
  Switch,
  Tooltip
} from '@heroui/react'
import BasePage from '@renderer/components/base/base-page'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { useGroups } from '@renderer/hooks/use-groups'
import {
  getDelayTestSnapshot,
  releaseDelayTestResults,
  runGroupDelayTest,
  subscribeDelayTestStore
} from '@renderer/utils/delay-test-store'
import {
  MAX_DELAY_TEST_CONCURRENCY,
  MIN_DELAY_TEST_CONCURRENCY,
  normalizeDelayTestConcurrency
} from '@renderer/utils/delay-test'
import {
  getSpeedTestSnapshot,
  runConcurrentGroupSpeedTest,
  stopConcurrentGroupSpeedTest,
  subscribeSpeedTestStore
} from '@renderer/utils/speed-test-store'
import { mihomoChangeProxy, mihomoCloseConnections } from '@renderer/utils/ipc'
import { notify } from '@renderer/utils/notification'
import {
  DelayRoundMeasurement,
  DownloadRoundMeasurement,
  finishGeneralDelayTest,
  finishGeneralDownloadTest,
  getGeneralTestRuntimeSnapshot,
  recordGeneralDelay,
  recordGeneralDownload,
  selectGeneralTestGroup,
  setGeneralDelayRound,
  setGeneralDownloadRound,
  startGeneralDelayTest,
  startGeneralDownloadTest,
  subscribeGeneralTestRuntime
} from '@renderer/utils/general-test-runtime-store'
import { formatTestHistoryTime } from '@renderer/utils/test-history'
import { formatLatency } from '@renderer/utils/format-latency'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { IoIosArrowBack } from 'react-icons/io'
import {
  MdArrowDownward,
  MdArrowUpward,
  MdDownload,
  MdExpandLess,
  MdExpandMore,
  MdOutlineSpeed,
  MdStop,
  MdUnfoldMore
} from 'react-icons/md'
import { useNavigate } from 'react-router-dom'

type ProxyLike = ControllerProxiesDetail | ControllerGroupDetail
type SortKey = 'name' | 'delay' | 'speed' | 'downloaded'
type SortDirection = 'asc' | 'desc'

const FOLLOW_TEST_GROUP = '__FOLLOW_TEST_GROUP__'
const MIN_TEST_ROUNDS = 1
const MAX_TEST_ROUNDS = 20

function getProviderName(proxy: ProxyLike): string | undefined {
  return 'provider-name' in proxy ? proxy['provider-name'] : undefined
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function normalizeRounds(value?: number): number {
  if (!Number.isFinite(value)) return 3
  return clamp(value!, MIN_TEST_ROUNDS, MAX_TEST_ROUNDS)
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

function aggregateDelay(measurements?: DelayRoundMeasurement[]): number | undefined {
  if (!measurements?.length) return undefined
  return median(measurements.map((item) => item.delay).filter((delay) => delay > 0)) ?? 0
}

function aggregateDownload(
  measurements: DownloadRoundMeasurement[] | undefined,
  key: 'bytesPerSecond' | 'downloadedBytes'
): number | undefined {
  return median(
    (measurements ?? [])
      .map((item) => item.result?.[key])
      .filter((value): value is number => value !== undefined)
  )
}

function formatSpeed(bytesPerSecond?: number): string {
  if (bytesPerSecond === undefined) return '—'
  if (bytesPerSecond >= 1024 * 1024) {
    return `${(bytesPerSecond / 1024 / 1024).toFixed(bytesPerSecond >= 100 * 1024 * 1024 ? 0 : 1)} MiB/s`
  }
  return `${Math.max(0, bytesPerSecond / 1024).toFixed(0)} KiB/s`
}

function formatBytes(bytes?: number): string {
  if (bytes === undefined) return '—'
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
  return `${Math.max(0, bytes / 1024).toFixed(0)} KiB`
}

function sourceName(source?: SpeedTestSource): string {
  if (source === 'telegram') return 'Telegram'
  if (source === 'custom') return '自定义地址'
  return 'Cloudflare'
}

const GeneralSpeedTest: React.FC = () => {
  const navigate = useNavigate()
  const { groups = [], mutate } = useGroups()
  const { appConfig, patchAppConfig } = useAppConfig()
  const delayState = useSyncExternalStore(
    subscribeDelayTestStore,
    getDelayTestSnapshot,
    getDelayTestSnapshot
  )
  const speedState = useSyncExternalStore(
    subscribeSpeedTestStore,
    getSpeedTestSnapshot,
    getSpeedTestSnapshot
  )
  const runtimeState = useSyncExternalStore(
    subscribeGeneralTestRuntime,
    getGeneralTestRuntimeSnapshot,
    getGeneralTestRuntimeSnapshot
  )
  const { history, delayMeasurements, downloadMeasurements, delaySession, downloadSession } =
    runtimeState
  const [groupName, setGroupName] = useState(() => runtimeState.groupName || '')
  const [switchGroupName, setSwitchGroupName] = useState(FOLLOW_TEST_GROUP)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [rounds, setRounds] = useState(() => normalizeRounds(appConfig?.generalTestRounds))
  const [configExpanded, setConfigExpanded] = useState(
    () => appConfig?.generalTestConfigExpanded ?? false
  )
  const [sortKey, setSortKey] = useState<SortKey>('delay')
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')
  const [switchingProxy, setSwitchingProxy] = useState<string>()
  const {
    autoCloseConnection = true,
    closeMode = 'all',
    delayTestUrl = '',
    delayTestUrlScope = 'group',
    delayTestUseGroupApi = false,
    delayTestConcurrency = 50,
    delayTestTimeout = 5000,
    speedTestSource = 'cloudflare',
    speedTestUrl = '',
    speedTestDuration = 8000,
    speedTestMaxBytes = 100_000_000,
    speedTestWarmupBytes = 1_000_000,
    speedTestConnections = 4,
    generalTestNodeConcurrency = 1
  } = appConfig || {}

  const group = groups.find((item) => item.name === groupName) || groups[0]
  const switchGroup =
    switchGroupName === FOLLOW_TEST_GROUP
      ? group
      : groups.find((item) => item.name === switchGroupName) || group
  const proxies = useMemo(() => {
    const unique = new Map<string, ProxyLike>()
    group?.all.forEach((proxy) => unique.set(proxy.name, proxy))
    return [...unique.values()]
  }, [group])
  const proxyKey = proxies.map((proxy) => proxy.name).join('\u0000')

  useEffect(() => {
    if (!groupName && groups[0]) {
      const historyGroup = groups.find((item) => item.name === history?.groupName)
      setGroupName(historyGroup?.name || groups[0].name)
    }
  }, [groupName, groups, history?.groupName])

  useEffect(() => {
    if (
      switchGroupName !== FOLLOW_TEST_GROUP &&
      !groups.some((item) => item.name === switchGroupName)
    ) {
      setSwitchGroupName(FOLLOW_TEST_GROUP)
    }
  }, [groups, switchGroupName])

  useEffect(() => {
    setSelected(new Set(proxies.map((proxy) => proxy.name)))
    if (group?.name) selectGeneralTestGroup(group.name)
  }, [group?.name, proxyKey])

  useEffect(() => {
    if (!delaySession.running && !downloadSession.running) {
      setRounds(normalizeRounds(appConfig?.generalTestRounds))
    }
  }, [appConfig?.generalTestRounds, delaySession.running, downloadSession.running])

  useEffect(() => {
    if (appConfig?.generalTestConfigExpanded !== undefined) {
      setConfigExpanded(appConfig.generalTestConfigExpanded)
    }
  }, [appConfig?.generalTestConfigExpanded])

  const selectedNames = proxies
    .filter((proxy) => selected.has(proxy.name))
    .map((proxy) => proxy.name)
  const allSelected = proxies.length > 0 && selectedNames.length === proxies.length
  const downloadRunningInStore = Boolean(group && speedState.activeGroup === group.name)
  const anotherDelayRunning = delayState.groups.size > 0 && !delaySession.running
  const anotherDownloadRunning =
    (speedState.busy || Boolean(speedState.activeGroup)) && !downloadSession.running
  const interactionDisabled =
    delaySession.running || downloadSession.running || anotherDelayRunning || anotherDownloadRunning
  const activeDownloadProgresses = selectedNames
    .map((name) => speedState.progresses[name])
    .filter((progress): progress is SpeedTestProgress => progress !== undefined)
  const activeDownloadSpeed = activeDownloadProgresses.reduce(
    (total, progress) => total + progress.bytesPerSecond,
    0
  )
  const activeDownloadFractions = activeDownloadProgresses.reduce(
    (total, progress) => total + Math.min(1, progress.downloadedBytes / speedTestMaxBytes),
    0
  )
  const delayCompleted = Object.values(delayMeasurements).reduce(
    (total, values) => total + values.length,
    0
  )
  const downloadCompleted = Object.values(downloadMeasurements).reduce(
    (total, values) => total + values.length,
    0
  )

  const rows = useMemo(() => {
    const value = (proxy: ProxyLike): string | number | undefined => {
      if (sortKey === 'name') return proxy.name
      if (sortKey === 'delay') {
        const delay = aggregateDelay(delayMeasurements[proxy.name])
        return delay === 0 ? Number.MAX_SAFE_INTEGER : delay
      }
      if (sortKey === 'speed') {
        return aggregateDownload(downloadMeasurements[proxy.name], 'bytesPerSecond')
      }
      return aggregateDownload(downloadMeasurements[proxy.name], 'downloadedBytes')
    }

    return [...proxies].sort((left, right) => {
      const leftValue = value(left)
      const rightValue = value(right)
      if (leftValue === undefined && rightValue === undefined) {
        return left.name.localeCompare(right.name)
      }
      if (leftValue === undefined) return 1
      if (rightValue === undefined) return -1
      const compared =
        typeof leftValue === 'string' && typeof rightValue === 'string'
          ? leftValue.localeCompare(rightValue)
          : Number(leftValue) - Number(rightValue)
      return sortDirection === 'asc' ? compared : -compared
    })
  }, [delayMeasurements, downloadMeasurements, proxies, sortDirection, sortKey])

  const toggleSort = (key: SortKey): void => {
    if (key === sortKey) {
      setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'))
      return
    }
    setSortKey(key)
    setSortDirection(key === 'speed' || key === 'downloaded' ? 'desc' : 'asc')
  }

  const sortHeader = (key: SortKey, label: string): React.ReactNode => (
    <Button
      size="sm"
      variant="light"
      className="h-6 min-w-0 justify-start gap-0.5 px-0 text-xs text-foreground-500"
      endContent={
        key !== sortKey ? (
          <MdUnfoldMore className="shrink-0 text-sm opacity-50" />
        ) : sortDirection === 'asc' ? (
          <MdArrowUpward className="shrink-0 text-sm" />
        ) : (
          <MdArrowDownward className="shrink-0 text-sm" />
        )
      }
      onPress={() => toggleSort(key)}
    >
      <span className="truncate">{label}</span>
    </Button>
  )

  const runDelay = async (): Promise<void> => {
    if (!group || selectedNames.length === 0 || interactionDisabled) return
    const names = [...selectedNames]
    const testProxies = proxies.filter((proxy) => selected.has(proxy.name))
    let completed = 0
    startGeneralDelayTest(group.name, rounds, names.length)

    try {
      for (let round = 1; round <= rounds; round++) {
        setGeneralDelayRound(round)
        const run = await runGroupDelayTest({
          group: group.name,
          proxies: testProxies.map((proxy) => ({
            name: proxy.name,
            provider: getProviderName(proxy)
          })),
          url: delayTestUrlScope === 'group' ? group.testUrl : undefined,
          useGroupApi: delayTestUseGroupApi,
          concurrency: delayTestConcurrency,
          onResult: (proxy, delay) => {
            completed++
            recordGeneralDelay(proxy, round, delay)
          }
        })
        if (Object.keys(run).length === 0) break
        try {
          await mutate()
        } catch {
          // A later SWR refresh will update the controller history.
        } finally {
          releaseDelayTestResults(run)
        }
      }
      notify(`延迟测试完成：${completed}/${names.length * rounds} 次`, {
        variant: completed > 0 ? 'success' : 'danger'
      })
    } finally {
      finishGeneralDelayTest(completed > 0)
    }
  }

  const stopDownload = async (): Promise<void> => {
    if (downloadRunningInStore) await stopConcurrentGroupSpeedTest()
  }

  const runDownload = async (): Promise<void> => {
    if (!group || selectedNames.length === 0 || interactionDisabled) return
    const names = [...selectedNames]
    let completed = 0
    let succeeded = 0
    let completedRun = false
    startGeneralDownloadTest(group.name, rounds, names.length)

    try {
      const outcome = await runConcurrentGroupSpeedTest(
        group.name,
        names,
        rounds,
        generalTestNodeConcurrency,
        {
          onProxyCompleted: (proxy, round, result, error) => {
            completed++
            if (result) succeeded++
            setGeneralDownloadRound(round)
            recordGeneralDownload(proxy, round, result, error)
          }
        }
      )

      if (outcome === 'cancelled') {
        notify(`下载测速已停止，已完成 ${completed}/${names.length * rounds} 次`)
      } else if (outcome === 'completed') {
        completedRun = true
        notify(`下载测速完成：成功 ${succeeded}/${names.length * rounds} 次`, {
          variant: succeeded > 0 ? 'success' : 'danger'
        })
      }
    } finally {
      finishGeneralDownloadTest(completedRun)
    }
  }

  const switchProxy = async (proxy: string): Promise<void> => {
    if (!switchGroup || switchingProxy || switchGroup.now === proxy) return
    if (!switchGroup.all.some((item) => item.name === proxy)) {
      notify(`代理组 ${switchGroup.name} 不包含节点 ${proxy}`, { variant: 'warning' })
      return
    }
    setSwitchingProxy(proxy)
    try {
      await mihomoChangeProxy(switchGroup.name, proxy)
      if (interactionDisabled) {
        await mihomoCloseConnections(switchGroup.name)
      } else if (autoCloseConnection) {
        await mihomoCloseConnections(closeMode === 'group' ? switchGroup.name : undefined)
      }
      await mutate()
      notify(`已将 ${switchGroup.name} 切换到 ${proxy}`, { variant: 'success' })
    } catch (error) {
      notify(error, { variant: 'danger' })
    } finally {
      setSwitchingProxy(undefined)
    }
  }

  const updateRounds = (value: string): void => {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) setRounds(normalizeRounds(parsed))
  }

  return (
    <BasePage
      title="普通测速"
      header={
        <Button
          size="sm"
          isIconOnly
          variant="light"
          className="app-nodrag"
          title="返回测速中心"
          onPress={() => navigate('/speed-test')}
        >
          <IoIosArrowBack className="text-lg" />
        </Button>
      }
    >
      <div className="flex min-h-full w-full flex-col">
        <section className="border-b border-divider p-3">
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-end gap-3">
              <Select
                label="测试节点组"
                size="sm"
                className="min-w-52 flex-1"
                classNames={{ base: 'data-[disabled=true]:opacity-100' }}
                selectedKeys={group ? new Set([group.name]) : new Set()}
                disallowEmptySelection
                isDisabled={interactionDisabled || groups.length === 0}
                onSelectionChange={(keys) => {
                  const next = keys.currentKey
                  if (next) setGroupName(String(next))
                }}
              >
                {groups.map((item) => (
                  <SelectItem key={item.name}>{item.name}</SelectItem>
                ))}
              </Select>

              <Select
                label="切换目标组"
                size="sm"
                className="min-w-52 flex-1"
                classNames={{ base: 'data-[disabled=true]:opacity-100' }}
                selectedKeys={new Set([switchGroupName])}
                disallowEmptySelection
                isDisabled={groups.length === 0}
                onSelectionChange={(keys) => {
                  const next = keys.currentKey
                  if (next) setSwitchGroupName(String(next))
                }}
              >
                {[
                  { key: FOLLOW_TEST_GROUP, label: '跟随测试节点组' },
                  ...groups.map((item) => ({ key: item.name, label: item.name }))
                ].map((item) => (
                  <SelectItem key={item.key}>{item.label}</SelectItem>
                ))}
              </Select>

              <Input
                label="测试次数"
                type="number"
                size="sm"
                className="w-28"
                classNames={{ base: 'data-[disabled=true]:opacity-100' }}
                min={MIN_TEST_ROUNDS}
                max={MAX_TEST_ROUNDS}
                value={rounds.toString()}
                isDisabled={interactionDisabled}
                onValueChange={updateRounds}
                onBlur={() => void patchAppConfig({ generalTestRounds: rounds })}
              />
              <Button
                size="sm"
                variant="flat"
                className="data-[disabled=true]:opacity-100"
                isDisabled={interactionDisabled}
                endContent={configExpanded ? <MdExpandLess /> : <MdExpandMore />}
                onPress={() => {
                  const next = !configExpanded
                  setConfigExpanded(next)
                  void patchAppConfig({ generalTestConfigExpanded: next })
                }}
              >
                {configExpanded ? '收起配置' : '展开配置'}
              </Button>
            </div>

            {configExpanded && (
              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded-xl border border-divider/60 bg-content1 p-3">
                  <div className="mb-3 flex items-center justify-between">
                    <div>
                      <div className="font-medium">延迟测试配置</div>
                      <div className="text-xs text-foreground-500">
                        每轮并发测试，结果按中位数汇总
                      </div>
                    </div>
                    <Switch
                      size="sm"
                      isSelected={delayTestUseGroupApi}
                      isDisabled={interactionDisabled}
                      onValueChange={(value) =>
                        void patchAppConfig({ delayTestUseGroupApi: value })
                      }
                    >
                      组 API
                    </Switch>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Select
                      label="测试地址来源"
                      size="sm"
                      selectedKeys={new Set([delayTestUrlScope])}
                      disallowEmptySelection
                      isDisabled={interactionDisabled}
                      onSelectionChange={(keys) => {
                        const next = keys.currentKey
                        if (next) {
                          void patchAppConfig({
                            delayTestUrlScope: String(next) as 'group' | 'global'
                          })
                        }
                      }}
                    >
                      <SelectItem key="group">使用组配置</SelectItem>
                      <SelectItem key="global">使用统一地址</SelectItem>
                    </Select>
                    <Input
                      key={`delay-url-${delayTestUrl}`}
                      label="统一延迟地址"
                      size="sm"
                      className="sm:col-span-2"
                      defaultValue={delayTestUrl}
                      placeholder="https://www.gstatic.com/generate_204"
                      isDisabled={interactionDisabled}
                      onBlur={(event) =>
                        void patchAppConfig({ delayTestUrl: event.currentTarget.value.trim() })
                      }
                    />
                    <Input
                      key={`delay-concurrency-${delayTestConcurrency}`}
                      label="并发数"
                      type="number"
                      size="sm"
                      defaultValue={delayTestConcurrency.toString()}
                      min={MIN_DELAY_TEST_CONCURRENCY}
                      max={MAX_DELAY_TEST_CONCURRENCY}
                      isDisabled={interactionDisabled || delayTestUseGroupApi}
                      onBlur={(event) =>
                        void patchAppConfig({
                          delayTestConcurrency: normalizeDelayTestConcurrency(
                            Number(event.currentTarget.value)
                          )
                        })
                      }
                    />
                    <Input
                      key={`delay-timeout-${delayTestTimeout}`}
                      label="超时时间（ms）"
                      type="number"
                      size="sm"
                      defaultValue={delayTestTimeout.toString()}
                      min={100}
                      max={60000}
                      isDisabled={interactionDisabled}
                      onBlur={(event) => {
                        const value = Number(event.currentTarget.value)
                        if (Number.isFinite(value)) {
                          void patchAppConfig({ delayTestTimeout: clamp(value, 100, 60000) })
                        }
                      }}
                    />
                  </div>
                </div>

                <div className="rounded-xl border border-divider/60 bg-content1 p-3">
                  <div className="mb-3">
                    <div className="font-medium">下载测速配置</div>
                    <div className="text-xs text-foreground-500">
                      单节点多连接可跑满带宽；节点并发大于 1 会共享总带宽
                    </div>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Select
                      label="下载源"
                      size="sm"
                      selectedKeys={new Set([speedTestSource])}
                      disallowEmptySelection
                      isDisabled={interactionDisabled}
                      onSelectionChange={(keys) => {
                        const next = keys.currentKey
                        if (next) {
                          void patchAppConfig({ speedTestSource: String(next) as SpeedTestSource })
                        }
                      }}
                    >
                      <SelectItem key="cloudflare">Cloudflare</SelectItem>
                      <SelectItem key="telegram">Telegram</SelectItem>
                      <SelectItem key="custom">自定义地址</SelectItem>
                    </Select>
                    {speedTestSource === 'custom' && (
                      <Input
                        key={`speed-url-${speedTestUrl}`}
                        label="自定义下载地址"
                        size="sm"
                        className="sm:col-span-2"
                        defaultValue={speedTestUrl}
                        placeholder="支持 {bytes} 文件大小占位符"
                        isDisabled={interactionDisabled}
                        onBlur={(event) =>
                          void patchAppConfig({ speedTestUrl: event.currentTarget.value.trim() })
                        }
                      />
                    )}
                    <Input
                      key={`speed-duration-${speedTestDuration}`}
                      label="最长时间（ms）"
                      type="number"
                      size="sm"
                      defaultValue={speedTestDuration.toString()}
                      min={1000}
                      max={30000}
                      isDisabled={interactionDisabled}
                      onBlur={(event) => {
                        const value = Number(event.currentTarget.value)
                        if (Number.isFinite(value)) {
                          void patchAppConfig({ speedTestDuration: clamp(value, 1000, 30000) })
                        }
                      }}
                    />
                    <Input
                      key={`speed-max-${speedTestMaxBytes}`}
                      label="最大流量（MB）"
                      type="number"
                      size="sm"
                      defaultValue={Math.round(speedTestMaxBytes / 1_000_000).toString()}
                      min={2}
                      max={1000}
                      isDisabled={interactionDisabled}
                      onBlur={(event) => {
                        const value = Number(event.currentTarget.value)
                        if (Number.isFinite(value)) {
                          void patchAppConfig({
                            speedTestMaxBytes: clamp(value, 2, 1000) * 1_000_000
                          })
                        }
                      }}
                    />
                    <Input
                      key={`speed-warmup-${speedTestWarmupBytes}`}
                      label="预热流量（MB）"
                      type="number"
                      size="sm"
                      defaultValue={(speedTestWarmupBytes / 1_000_000).toString()}
                      min={0}
                      max={Math.max(0, Math.floor(speedTestMaxBytes / 1_000_000) - 1)}
                      isDisabled={interactionDisabled}
                      onBlur={(event) => {
                        const value = Number(event.currentTarget.value)
                        if (Number.isFinite(value)) {
                          void patchAppConfig({
                            speedTestWarmupBytes:
                              clamp(
                                value,
                                0,
                                Math.max(0, Math.floor(speedTestMaxBytes / 1_000_000) - 1)
                              ) * 1_000_000
                          })
                        }
                      }}
                    />
                    <Input
                      key={`speed-connections-${speedTestConnections}`}
                      label="单节点连接数"
                      type="number"
                      size="sm"
                      defaultValue={speedTestConnections.toString()}
                      min={1}
                      max={16}
                      isDisabled={interactionDisabled}
                      onBlur={(event) => {
                        const value = Number(event.currentTarget.value)
                        if (Number.isFinite(value)) {
                          void patchAppConfig({ speedTestConnections: clamp(value, 1, 16) })
                        }
                      }}
                    />
                    <Input
                      key={`node-concurrency-${generalTestNodeConcurrency}`}
                      label="节点并发数"
                      type="number"
                      size="sm"
                      defaultValue={generalTestNodeConcurrency.toString()}
                      min={1}
                      max={16}
                      isDisabled={interactionDisabled}
                      onBlur={(event) => {
                        const value = Number(event.currentTarget.value)
                        if (Number.isFinite(value)) {
                          void patchAppConfig({
                            generalTestNodeConcurrency: clamp(value, 1, 16)
                          })
                        }
                      }}
                    />
                  </div>
                  {generalTestNodeConcurrency > 1 && (
                    <div className="mt-2 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning-700 dark:text-warning-400">
                      当前同时测试 {generalTestNodeConcurrency}{' '}
                      个节点，各节点会争抢本机总带宽；适合快速筛选，不适合精确比较峰值速度。
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <Button
                color="primary"
                variant="solid"
                isLoading={delaySession.running}
                isDisabled={
                  selectedNames.length === 0 ||
                  downloadSession.running ||
                  anotherDelayRunning ||
                  anotherDownloadRunning
                }
                startContent={delaySession.running ? undefined : <MdOutlineSpeed />}
                onPress={() => void runDelay()}
              >
                测试延迟（{selectedNames.length} × {rounds}）
              </Button>
              <Button
                color={downloadSession.running ? 'danger' : 'primary'}
                variant="solid"
                isDisabled={
                  delaySession.running ||
                  anotherDelayRunning ||
                  (!downloadSession.running &&
                    (selectedNames.length === 0 || anotherDownloadRunning))
                }
                startContent={downloadSession.running ? <MdStop /> : <MdDownload />}
                onPress={() => void (downloadSession.running ? stopDownload() : runDownload())}
              >
                {downloadSession.running
                  ? '停止下载测速'
                  : `下载测速（${selectedNames.length} × ${rounds}）`}
              </Button>
              <span className="text-xs text-foreground-500">
                延迟地址：
                {delayTestUrlScope === 'group'
                  ? group?.testUrl || '节点组默认地址'
                  : delayTestUrl || '默认地址'}
                {' · '}下载源：{sourceName(speedTestSource)}
              </span>
            </div>

            {history?.savedAt && history.groupName === group?.name && !interactionDisabled && (
              <div className="text-xs text-foreground-500">
                已恢复上次测试结果 · {formatTestHistoryTime(history.savedAt)}
              </div>
            )}

            {delaySession.running && (
              <div>
                <div className="mb-1 flex justify-between text-xs">
                  <span>
                    延迟测试第 {delaySession.round}/{delaySession.rounds} 轮
                  </span>
                  <span>
                    {delayCompleted}/{delaySession.nodeCount * delaySession.rounds}
                  </span>
                </div>
                <Progress
                  aria-label="延迟测试进度"
                  value={(delayCompleted / (delaySession.nodeCount * delaySession.rounds)) * 100}
                  color="primary"
                />
              </div>
            )}

            {downloadSession.running && (
              <div>
                <div className="mb-1 flex justify-between gap-3 text-xs">
                  <span className="flag-emoji truncate">
                    下载测速第 {downloadSession.round}/{downloadSession.rounds} 轮
                    {speedState.testing.size > 0
                      ? `：正在并发 ${speedState.testing.size} 个节点`
                      : ''}
                  </span>
                  <span className="shrink-0">
                    {downloadCompleted}/{downloadSession.nodeCount * downloadSession.rounds}
                    {activeDownloadSpeed > 0 ? ` · 合计 ${formatSpeed(activeDownloadSpeed)}` : ''}
                  </span>
                </div>
                <Progress
                  aria-label="下载测速进度"
                  value={
                    ((downloadCompleted + activeDownloadFractions) /
                      (downloadSession.nodeCount * downloadSession.rounds)) *
                    100
                  }
                  color="secondary"
                />
              </div>
            )}
          </div>
        </section>

        <section className="min-h-0 flex-1">
          <div>
            <div className="flex items-center justify-between border-b border-divider px-4 py-3">
              <Checkbox
                classNames={{ base: 'data-[disabled=true]:opacity-100' }}
                isSelected={allSelected}
                isIndeterminate={selectedNames.length > 0 && !allSelected}
                isDisabled={interactionDisabled || proxies.length === 0}
                onValueChange={(checked) => {
                  setSelected(checked ? new Set(proxies.map((proxy) => proxy.name)) : new Set())
                }}
              >
                全选
              </Checkbox>
              <span className="text-xs text-foreground-500">
                已选择 {selectedNames.length}/{proxies.length} 个节点；表格主值为成功轮次中位数
              </span>
            </div>

            <div className="overflow-x-auto">
              <div className="min-w-190">
                <div className="grid grid-cols-[minmax(190px,1.8fr)_100px_100px_130px_100px_82px] gap-3 border-b border-divider px-4 py-2 text-xs text-foreground-500">
                  {sortHeader('name', '节点')}
                  <span className="flex h-6 items-center">类型</span>
                  {sortHeader('delay', '延迟')}
                  {sortHeader('speed', '下载速度')}
                  {sortHeader('downloaded', '下载量')}
                  <span className="flex h-6 items-center">操作</span>
                </div>

                {rows.length === 0 ? (
                  <div className="flex min-h-40 items-center justify-center text-sm text-foreground-400">
                    当前代理组没有可测试节点
                  </div>
                ) : (
                  rows.map((proxy) => {
                    const proxyDelayMeasurements = delayMeasurements[proxy.name]
                    const proxyDownloadMeasurements = downloadMeasurements[proxy.name]
                    const delay = aggregateDelay(proxyDelayMeasurements)
                    const speed = aggregateDownload(proxyDownloadMeasurements, 'bytesPerSecond')
                    const downloaded = aggregateDownload(
                      proxyDownloadMeasurements,
                      'downloadedBytes'
                    )
                    const delayTesting = delayState.testing.has(proxy.name)
                    const speedTesting = speedState.testing.has(proxy.name)
                    const speedProgress = speedState.progresses[proxy.name]
                    const canSwitch = Boolean(
                      switchGroup?.all.some((item) => item.name === proxy.name)
                    )
                    const isCurrent = switchGroup?.now === proxy.name

                    return (
                      <div
                        key={proxy.name}
                        className="grid grid-cols-[minmax(190px,1.8fr)_100px_100px_130px_100px_82px] items-center gap-3 border-b border-divider/60 px-4 py-3 text-sm last:border-b-0"
                      >
                        <div className="flex min-w-0 items-center gap-2 overflow-hidden">
                          <Checkbox
                            aria-label={`选择节点 ${proxy.name}`}
                            className="shrink-0"
                            classNames={{ base: 'data-[disabled=true]:opacity-100' }}
                            isSelected={selected.has(proxy.name)}
                            isDisabled={interactionDisabled}
                            onValueChange={(checked) => {
                              setSelected((current) => {
                                const next = new Set(current)
                                if (checked) next.add(proxy.name)
                                else next.delete(proxy.name)
                                return next
                              })
                            }}
                          />
                          <span
                            className="flag-emoji block min-w-0 flex-1 truncate"
                            title={proxy.name}
                          >
                            {proxy.name}
                          </span>
                        </div>
                        <span className="truncate text-xs text-foreground-500" title={proxy.type}>
                          {proxy.type}
                        </span>
                        <Tooltip
                          placement="top"
                          isDisabled={!proxyDelayMeasurements?.length}
                          content={
                            <div className="min-w-40 space-y-1 px-1 py-0.5 text-xs">
                              <div className="font-medium">
                                中位数：{delay ? formatLatency(delay) : '超时'}
                              </div>
                              {proxyDelayMeasurements?.map((item) => (
                                <div key={item.round} className="flex justify-between gap-4">
                                  <span>第 {item.round} 轮</span>
                                  <span className={item.delay === 0 ? 'text-danger' : ''}>
                                    {item.delay === 0 ? '超时' : formatLatency(item.delay)}
                                  </span>
                                </div>
                              ))}
                            </div>
                          }
                        >
                          <span>
                            {delayTesting ? (
                              <Chip size="sm" color="primary" variant="flat">
                                测试中
                              </Chip>
                            ) : delay === undefined ? (
                              '—'
                            ) : delay === 0 ? (
                              <span className="text-danger">超时</span>
                            ) : (
                              formatLatency(delay)
                            )}
                          </span>
                        </Tooltip>
                        <Tooltip
                          placement="top"
                          isDisabled={!proxyDownloadMeasurements?.length}
                          content={
                            <div className="min-w-52 space-y-1 px-1 py-0.5 text-xs">
                              <div className="font-medium">中位数：{formatSpeed(speed)}</div>
                              {proxyDownloadMeasurements?.map((item) => (
                                <div key={item.round} className="flex justify-between gap-4">
                                  <span>第 {item.round} 轮</span>
                                  <span className={item.result ? '' : 'text-danger'}>
                                    {item.result
                                      ? formatSpeed(item.result.bytesPerSecond)
                                      : item.error || '失败'}
                                  </span>
                                </div>
                              ))}
                            </div>
                          }
                        >
                          <span>
                            {speedTesting
                              ? formatSpeed(speedProgress?.bytesPerSecond)
                              : formatSpeed(speed)}
                          </span>
                        </Tooltip>
                        <span>
                          {speedTesting
                            ? formatBytes(speedProgress?.downloadedBytes)
                            : formatBytes(downloaded)}
                        </span>
                        <Tooltip
                          placement="top"
                          isDisabled={canSwitch}
                          content={`切换目标组“${switchGroup?.name || '未知'}”不包含该节点`}
                        >
                          <span>
                            <Button
                              size="sm"
                              color={isCurrent ? 'success' : 'primary'}
                              variant="flat"
                              className="min-w-0 px-2"
                              isLoading={switchingProxy === proxy.name}
                              isDisabled={Boolean(switchingProxy) || isCurrent || !canSwitch}
                              onPress={() => void switchProxy(proxy.name)}
                            >
                              {isCurrent ? '当前' : canSwitch ? '切换' : '不可用'}
                            </Button>
                          </span>
                        </Tooltip>
                      </div>
                    )
                  })
                )}
              </div>
            </div>
          </div>
        </section>
      </div>
    </BasePage>
  )
}

export default GeneralSpeedTest
