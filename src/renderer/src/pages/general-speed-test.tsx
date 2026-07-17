import { Button, Chip, Input, Select, SelectItem, Switch } from '@heroui/react'
import {
  FOLLOW_TEST_GROUP,
  TestGroupSelectors,
  TestHistoryNotice,
  TestNodeConcurrencySelect,
  TestPageControlRow,
  TestPageControls,
  TestPageShell,
  TestProgressBar,
  TestRoundSelector,
  TestRunButton,
  parseTestInteger
} from '@renderer/components/speed-test/test-page-controls'
import {
  TestResultActionHeader,
  TestResultEmptyState,
  TestResultNodeCell,
  TestResultSelectionHeader,
  TestResultSortHeader,
  TestResultSwitchAction,
  TestResultTableHeader,
  TestResultTableRow,
  TestResultTableViewport,
  TestResultTooltip,
  TestResultVirtualRows
} from '@renderer/components/speed-test/test-result-table'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { useGroups } from '@renderer/hooks/use-groups'
import {
  getDelayTestSnapshot,
  releaseDelayTestResults,
  runGroupDelayTest,
  stopGroupDelayTest,
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
import { formatLatency } from '@renderer/utils/format-latency'
import { resolveEffectiveSpeedTestConnections } from '@renderer/utils/speed-test-config'
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import { MdDownload, MdExpandLess, MdExpandMore, MdOutlineSpeed } from 'react-icons/md'
import { useNavigate } from 'react-router-dom'

type ProxyLike = ControllerProxiesDetail | ControllerGroupDetail
type SortKey = 'name' | 'delay' | 'speed' | 'downloaded'
type SortDirection = 'asc' | 'desc'

const GENERAL_TABLE_COLUMNS = 'grid-cols-[minmax(180px,1.7fr)_100px_100px_130px_100px_72px]'

function getProviderName(proxy: ProxyLike): string | undefined {
  return 'provider-name' in proxy ? proxy['provider-name'] : undefined
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function normalizeRounds(value?: number): number {
  if (!Number.isFinite(value)) return 3
  if (value! <= 1) return 1
  if (value! <= 3) return 3
  return 5
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

interface GeneralSpeedTestRowProps {
  proxy: ProxyLike
  delayMeasurements?: DelayRoundMeasurement[]
  downloadMeasurements?: DownloadRoundMeasurement[]
  delayTesting: boolean
  speedTesting: boolean
  speedProgress?: SpeedTestProgress
  selected: boolean
  disabled: boolean
  canSwitch: boolean
  isCurrent: boolean
  isSwitching: boolean
  switchBusy: boolean
  switchGroupName?: string
  onSelectedChange: (proxy: string, selected: boolean) => void
  onSwitch: (proxy: string) => void
}

/* eslint-disable react/prop-types */
const GeneralSpeedTestRow = memo<GeneralSpeedTestRowProps>((props) => {
  const {
    proxy,
    delayMeasurements,
    downloadMeasurements,
    delayTesting,
    speedTesting,
    speedProgress,
    selected,
    disabled,
    canSwitch,
    isCurrent,
    isSwitching,
    switchBusy,
    switchGroupName,
    onSelectedChange,
    onSwitch
  } = props
  const delay = aggregateDelay(delayMeasurements)
  const speed = aggregateDownload(downloadMeasurements, 'bytesPerSecond')
  const downloaded = aggregateDownload(downloadMeasurements, 'downloadedBytes')

  return (
    <TestResultTableRow columnsClassName={GENERAL_TABLE_COLUMNS}>
      <TestResultNodeCell
        name={proxy.name}
        selected={selected}
        disabled={disabled}
        onSelectedChange={(checked) => onSelectedChange(proxy.name, checked)}
      />
      <span className="truncate text-xs text-foreground-500" title={proxy.type}>
        {proxy.type}
      </span>
      <TestResultTooltip
        placement="top"
        closeDelay={0}
        isDisabled={!delayMeasurements?.length}
        content={
          <div className="min-w-40 space-y-1 px-1 py-0.5 text-xs">
            <div className="font-medium">中位数：{delay ? formatLatency(delay) : '超时'}</div>
            {delayMeasurements?.map((item) => (
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
      </TestResultTooltip>
      <TestResultTooltip
        placement="top"
        closeDelay={0}
        isDisabled={!downloadMeasurements?.length}
        content={
          <div className="min-w-52 space-y-1 px-1 py-0.5 text-xs">
            <div className="font-medium">中位数：{formatSpeed(speed)}</div>
            {downloadMeasurements?.map((item) => (
              <div key={item.round} className="flex justify-between gap-4">
                <span>第 {item.round} 轮</span>
                <span className={item.result ? '' : 'text-danger'}>
                  {item.result ? formatSpeed(item.result.bytesPerSecond) : item.error || '失败'}
                </span>
              </div>
            ))}
          </div>
        }
      >
        <span>
          {speedTesting ? formatSpeed(speedProgress?.bytesPerSecond) : formatSpeed(speed)}
        </span>
      </TestResultTooltip>
      <span>
        {speedTesting ? formatBytes(speedProgress?.downloadedBytes) : formatBytes(downloaded)}
      </span>
      <TestResultSwitchAction
        groupName={switchGroupName}
        canSwitch={canSwitch}
        isCurrent={isCurrent}
        isLoading={isSwitching}
        switchBusy={switchBusy}
        onPress={() => onSwitch(proxy.name)}
      />
    </TestResultTableRow>
  )
})
GeneralSpeedTestRow.displayName = 'GeneralSpeedTestRow'
/* eslint-enable react/prop-types */

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
  const [nodeConcurrencyInput, setNodeConcurrencyInput] = useState(() =>
    clamp(appConfig?.generalTestNodeConcurrency ?? 1, 1, 16).toString()
  )
  const [configExpanded, setConfigExpanded] = useState(
    () => appConfig?.generalTestConfigExpanded ?? false
  )
  const [configContentReady, setConfigContentReady] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>('delay')
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')
  const [switchingProxy, setSwitchingProxy] = useState<string>()
  const delayStopRequestedRef = useRef(false)
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
    speedTestConnections = 4
  } = appConfig || {}
  const effectiveSpeedTestConnections = resolveEffectiveSpeedTestConnections(
    speedTestSource,
    speedTestMaxBytes,
    speedTestConnections
  )
  const nodeConcurrency = parseTestInteger(nodeConcurrencyInput, 1, 16)

  const group = groups.find((item) => item.name === groupName) || groups[0]
  const switchGroup =
    switchGroupName === FOLLOW_TEST_GROUP
      ? group
      : groups.find((item) => item.name === switchGroupName) || group
  const switchableProxyNames = useMemo(
    () => new Set(switchGroup?.all.map((item) => item.name) || []),
    [switchGroup]
  )
  const proxies = useMemo(() => {
    const unique = new Map<string, ProxyLike>()
    group?.all.forEach((proxy) => unique.set(proxy.name, proxy))
    return [...unique.values()]
  }, [group])
  const proxyKey = useMemo(() => proxies.map((proxy) => proxy.name).join('\u0000'), [proxies])

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
    const nextNames = proxies.map((proxy) => proxy.name)
    setSelected((current) => {
      if (current.size === nextNames.length && nextNames.every((name) => current.has(name))) {
        return current
      }
      return new Set(nextNames)
    })
    if (group?.name) selectGeneralTestGroup(group.name)
  }, [group?.name, proxyKey])

  useEffect(() => {
    if (!delaySession.running && !downloadSession.running) {
      setRounds(normalizeRounds(appConfig?.generalTestRounds))
      setNodeConcurrencyInput(clamp(appConfig?.generalTestNodeConcurrency ?? 1, 1, 16).toString())
    }
  }, [
    appConfig?.generalTestNodeConcurrency,
    appConfig?.generalTestRounds,
    delaySession.running,
    downloadSession.running
  ])

  useEffect(() => {
    if (appConfig?.generalTestConfigExpanded !== undefined) {
      setConfigExpanded(appConfig.generalTestConfigExpanded)
    }
  }, [appConfig?.generalTestConfigExpanded])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setConfigContentReady(true))
    return () => window.cancelAnimationFrame(frame)
  }, [])

  const selectedNames = useMemo(
    () => proxies.filter((proxy) => selected.has(proxy.name)).map((proxy) => proxy.name),
    [proxies, selected]
  )
  const allSelected = proxies.length > 0 && selectedNames.length === proxies.length
  const downloadRunningInStore = Boolean(group && speedState.activeGroup === group.name)
  const anotherDelayRunning = delayState.groups.size > 0 && !delaySession.running
  const anotherDownloadRunning =
    (speedState.busy || Boolean(speedState.activeGroup)) && !downloadSession.running
  const interactionDisabled =
    delaySession.running || downloadSession.running || anotherDelayRunning || anotherDownloadRunning
  const { activeDownloadSpeed, activeDownloadFractions } = useMemo(() => {
    let speed = 0
    let fractions = 0
    selectedNames.forEach((name) => {
      const progress = speedState.progresses[name]
      if (!progress) return
      speed += progress.bytesPerSecond
      fractions += Math.min(1, progress.downloadedBytes / speedTestMaxBytes)
    })
    return { activeDownloadSpeed: speed, activeDownloadFractions: fractions }
  }, [selectedNames, speedState.progresses, speedTestMaxBytes])
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
    <TestResultSortHeader
      label={label}
      active={key === sortKey}
      direction={sortDirection}
      onPress={() => toggleSort(key)}
    />
  )

  const runDelay = async (): Promise<void> => {
    if (!group || selectedNames.length === 0 || interactionDisabled) return
    delayStopRequestedRef.current = false
    const names = [...selectedNames]
    const testProxies = proxies.filter((proxy) => selected.has(proxy.name))
    let completed = 0
    startGeneralDelayTest(group.name, rounds, names.length)

    try {
      for (let round = 1; round <= rounds; round++) {
        if (delayStopRequestedRef.current) break
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
        if (delayStopRequestedRef.current) {
          releaseDelayTestResults(run)
          break
        }
        if (Object.keys(run).length === 0) break
        try {
          await mutate()
        } catch {
          // A later SWR refresh will update the controller history.
        } finally {
          releaseDelayTestResults(run)
        }
      }
      if (delayStopRequestedRef.current) {
        notify(`延迟测试已停止，已完成 ${completed}/${names.length * rounds} 次`)
      } else {
        notify(`延迟测试完成：${completed}/${names.length * rounds} 次`, {
          variant: completed > 0 ? 'success' : 'danger'
        })
      }
    } finally {
      finishGeneralDelayTest(completed > 0)
      delayStopRequestedRef.current = false
    }
  }

  const stopDelay = (): void => {
    if (!group || !delaySession.running) return
    delayStopRequestedRef.current = true
    stopGroupDelayTest(group.name)
  }

  const stopDownload = async (): Promise<void> => {
    if (downloadRunningInStore) await stopConcurrentGroupSpeedTest()
  }

  const runDownload = async (): Promise<void> => {
    if (
      !group ||
      selectedNames.length === 0 ||
      interactionDisabled ||
      nodeConcurrency === undefined
    ) {
      return
    }
    const names = [...selectedNames]
    let completed = 0
    let succeeded = 0
    startGeneralDownloadTest(group.name, rounds, names.length)

    try {
      const outcome = await runConcurrentGroupSpeedTest(
        group.name,
        names,
        rounds,
        nodeConcurrency,
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
        notify(`下载测速完成：成功 ${succeeded}/${names.length * rounds} 次`, {
          variant: succeeded > 0 ? 'success' : 'danger'
        })
      }
    } finally {
      finishGeneralDownloadTest(completed > 0)
    }
  }

  const changeNodeSelection = useCallback((proxy: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current)
      if (checked) next.add(proxy)
      else next.delete(proxy)
      return next
    })
  }, [])

  const switchProxy = useCallback(
    async (proxy: string): Promise<void> => {
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
    },
    [autoCloseConnection, closeMode, interactionDisabled, mutate, switchGroup, switchingProxy]
  )

  const renderRow = useCallback(
    (_index: number, proxy: ProxyLike) => (
      <GeneralSpeedTestRow
        proxy={proxy}
        delayMeasurements={delayMeasurements[proxy.name]}
        downloadMeasurements={downloadMeasurements[proxy.name]}
        delayTesting={delayState.testing.has(proxy.name)}
        speedTesting={speedState.testing.has(proxy.name)}
        speedProgress={speedState.progresses[proxy.name]}
        selected={selected.has(proxy.name)}
        disabled={interactionDisabled}
        canSwitch={switchableProxyNames.has(proxy.name)}
        isCurrent={switchGroup?.now === proxy.name}
        isSwitching={switchingProxy === proxy.name}
        switchBusy={Boolean(switchingProxy)}
        switchGroupName={switchGroup?.name}
        onSelectedChange={changeNodeSelection}
        onSwitch={switchProxy}
      />
    ),
    [
      changeNodeSelection,
      delayMeasurements,
      delayState.testing,
      downloadMeasurements,
      interactionDisabled,
      selected,
      speedState.progresses,
      speedState.testing,
      switchableProxyNames,
      switchingProxy,
      switchGroup?.name,
      switchGroup?.now,
      switchProxy
    ]
  )

  return (
    <TestPageShell title="普通测速" onBack={() => navigate('/speed-test')}>
      <TestPageControls>
        <TestPageControlRow>
          <TestGroupSelectors
            groups={groups}
            testGroupName={group?.name}
            switchGroupName={switchGroupName}
            testGroupDisabled={interactionDisabled}
            onTestGroupChange={setGroupName}
            onSwitchGroupChange={setSwitchGroupName}
          />

          <TestRoundSelector
            value={rounds}
            disabled={interactionDisabled}
            onChange={(value) => {
              setRounds(value)
              void patchAppConfig({ generalTestRounds: value })
            }}
          />
          <TestNodeConcurrencySelect
            value={nodeConcurrencyInput}
            disabled={interactionDisabled}
            onValueChange={setNodeConcurrencyInput}
            onValidBlur={(value) => void patchAppConfig({ generalTestNodeConcurrency: value })}
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
        </TestPageControlRow>

        {configExpanded && configContentReady && (
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-xl border border-divider/60 bg-content1 p-3">
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <div className="font-medium">延迟测试配置</div>
                  <div className="text-xs text-foreground-500">每轮并发测试，结果按中位数汇总</div>
                </div>
                <Switch
                  size="sm"
                  isSelected={delayTestUseGroupApi}
                  isDisabled={interactionDisabled}
                  onValueChange={(value) => void patchAppConfig({ delayTestUseGroupApi: value })}
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
                  label={`单节点连接数（配置 ${speedTestConnections} / 实际 ${effectiveSpeedTestConnections}）`}
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
              </div>
              {(nodeConcurrency ?? 0) > 1 && (
                <div className="mt-2 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning-700 dark:text-warning-400">
                  当前同时测试 {nodeConcurrency}{' '}
                  个节点，各节点会争抢本机总带宽；适合快速筛选，不适合精确比较峰值速度。
                </div>
              )}
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <TestRunButton
            running={delaySession.running}
            disabled={
              !delaySession.running &&
              (selectedNames.length === 0 ||
                downloadSession.running ||
                anotherDelayRunning ||
                anotherDownloadRunning)
            }
            startLabel={`测试延迟（${selectedNames.length} × ${rounds}）`}
            stopLabel="停止延迟测速"
            startContent={<MdOutlineSpeed />}
            onStart={runDelay}
            onStop={stopDelay}
          />
          <TestRunButton
            running={downloadSession.running}
            disabled={
              delaySession.running ||
              anotherDelayRunning ||
              (!downloadSession.running &&
                (selectedNames.length === 0 ||
                  anotherDownloadRunning ||
                  nodeConcurrency === undefined))
            }
            startLabel={`下载测速（${selectedNames.length} × ${rounds}）`}
            stopLabel="停止下载测速"
            startContent={<MdDownload />}
            onStart={runDownload}
            onStop={stopDownload}
          />
          <span className="text-xs text-foreground-500">
            延迟地址：
            {delayTestUrlScope === 'group'
              ? group?.testUrl || '节点组默认地址'
              : delayTestUrl || '默认地址'}
            {' · '}下载源：{sourceName(speedTestSource)}
          </span>
        </div>

        <TestHistoryNotice
          savedAt={history?.savedAt}
          visible={history?.groupName === group?.name && !interactionDisabled}
        />

        {delaySession.running && (
          <TestProgressBar
            label={`延迟测试第 ${delaySession.round}/${delaySession.rounds} 轮`}
            detail={`${delayCompleted}/${delaySession.nodeCount * delaySession.rounds}`}
            value={(delayCompleted / (delaySession.nodeCount * delaySession.rounds)) * 100}
            ariaLabel="延迟测试进度"
          />
        )}

        {downloadSession.running && (
          <TestProgressBar
            label={`下载测速第 ${downloadSession.round}/${downloadSession.rounds} 轮${
              speedState.testing.size > 0 ? `：正在并发 ${speedState.testing.size} 个节点` : ''
            }`}
            detail={`${downloadCompleted}/${downloadSession.nodeCount * downloadSession.rounds}${
              activeDownloadSpeed > 0 ? ` · 合计 ${formatSpeed(activeDownloadSpeed)}` : ''
            }`}
            value={
              ((downloadCompleted + activeDownloadFractions) /
                (downloadSession.nodeCount * downloadSession.rounds)) *
              100
            }
            ariaLabel="下载测速进度"
            color="secondary"
          />
        )}
      </TestPageControls>

      <section className="min-h-0 flex-1">
        <div>
          <TestResultSelectionHeader
            selected={allSelected}
            indeterminate={selectedNames.length > 0 && !allSelected}
            disabled={interactionDisabled || proxies.length === 0}
            hint={`已选择 ${selectedNames.length}/${proxies.length} 个节点；表格主值为成功轮次中位数`}
            onChange={(checked) => {
              setSelected(checked ? new Set(proxies.map((proxy) => proxy.name)) : new Set())
            }}
          />

          <TestResultTableViewport minWidthClassName="min-w-190">
            <TestResultTableHeader columnsClassName={GENERAL_TABLE_COLUMNS}>
              {sortHeader('name', '节点')}
              <span className="flex h-6 items-center">类型</span>
              {sortHeader('delay', '延迟')}
              {sortHeader('speed', '下载速度')}
              {sortHeader('downloaded', '下载量')}
              <TestResultActionHeader />
            </TestResultTableHeader>

            {rows.length === 0 ? (
              <TestResultEmptyState />
            ) : (
              <TestResultVirtualRows
                items={rows}
                itemKey={(proxy) => proxy.name}
                itemContent={renderRow}
              />
            )}
          </TestResultTableViewport>
        </div>
      </section>
    </TestPageShell>
  )
}

export default GeneralSpeedTest
