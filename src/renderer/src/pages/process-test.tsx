import {
  Autocomplete,
  AutocompleteItem,
  Button,
  Checkbox,
  Chip,
  Input,
  Progress,
  Select,
  SelectItem,
  Tooltip
} from '@heroui/react'
import BasePage from '@renderer/components/base/base-page'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { useGroups } from '@renderer/hooks/use-groups'
import {
  getProcessTestSnapshot,
  runProcessTest,
  stopProcessTest,
  subscribeProcessTestStore
} from '@renderer/utils/process-test-store'
import {
  getProcessTestCatalog,
  ProcessTestDomainTarget,
  ProcessTestTargetCatalog,
  takeSelectedProcessTestProcess,
  updateActiveProcessTestConnections
} from '@renderer/utils/process-test-targets'
import { isTestableProxy } from '@renderer/utils/testable-proxy'
import { formatLatency } from '@renderer/utils/format-latency'
import { mihomoChangeProxy, mihomoCloseConnections } from '@renderer/utils/ipc'
import { notify } from '@renderer/utils/notification'
import {
  formatTestHistoryTime,
  readTestHistory,
  writeTestHistory
} from '@renderer/utils/test-history'
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import { IoIosArrowBack } from 'react-icons/io'
import {
  MdArrowDownward,
  MdArrowUpward,
  MdCheckCircle,
  MdClearAll,
  MdErrorOutline,
  MdStop,
  MdUnfoldMore
} from 'react-icons/md'
import { useNavigate } from 'react-router-dom'

type SortKey = 'name' | 'score' | 'successRate' | 'medianMs' | 'p95Ms' | 'failedTargets' | 'grade'
type SortDirection = 'asc' | 'desc'

const MIN_CONCURRENCY = 1
const MAX_CONCURRENCY = 16
const PROCESS_TEST_SELECTION_KEY = 'sparkle:process-test-selection'
const FOLLOW_TEST_GROUP = '__FOLLOW_TEST_GROUP__'

const stageText: Record<ProcessTestStage, string> = {
  selecting: '正在切换测试节点',
  probing: '正在测试目标',
  completed: '目标测试完成'
}

function normalizeConcurrency(value?: number): number {
  if (!Number.isFinite(value)) return 6
  return Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY, Math.trunc(value!)))
}

function metric(value?: number): string {
  return formatLatency(value)
}

function processLabel(catalog: ProcessTestTargetCatalog): string {
  return catalog.process || catalog.sourceIP || catalog.processPath || '未知进程'
}

function processSelectionKey(keys: Iterable<string>): string {
  return [...keys].sort().join('\u0000')
}

function processSelectionLabel(catalogs: ProcessTestTargetCatalog[]): string {
  if (catalogs.length === 0) return '未选择进程'
  if (catalogs.length === 1) return processLabel(catalogs[0])
  const preview = catalogs.slice(0, 2).map(processLabel).join('、')
  return `${catalogs.length} 个进程（${preview}${catalogs.length > 2 ? '…' : ''}）`
}

function resultGrade(result: ProcessTestResult): {
  label: string
  color: 'success' | 'primary' | 'warning' | 'danger'
} {
  if (result.successRate < 0.8 || result.score === undefined) {
    return { label: '较差', color: 'danger' }
  }
  if (result.score < 400) return { label: '优秀', color: 'success' }
  if (result.score < 750) return { label: '良好', color: 'primary' }
  if (result.score < 1300) return { label: '一般', color: 'warning' }
  return { label: '较差', color: 'danger' }
}

function gradeRank(result?: ProcessTestResult): number | undefined {
  if (!result) return undefined
  const label = resultGrade(result).label
  return label === '优秀' ? 0 : label === '良好' ? 1 : label === '一般' ? 2 : 3
}

interface ProcessMetricResultProps {
  result?: ProcessTestResult
  value?: number
  title: string
}

/* eslint-disable react/prop-types */
const ProcessMetricResult: React.FC<ProcessMetricResultProps> = (props) => {
  const { result, value, title } = props
  const [isOpen, setIsOpen] = useState(false)
  if (!result) return <span>—</span>

  return (
    <Tooltip
      placement="top"
      isOpen={isOpen}
      onOpenChange={setIsOpen}
      content={
        isOpen ? (
          <div className="max-h-80 min-w-64 space-y-2 overflow-y-auto px-1 py-0.5 text-xs">
            <div className="font-medium">
              {title}：{metric(value)}
            </div>
            {result.domains.map((domain) => (
              <div key={`${domain.host}:${domain.port}`} className="border-t border-divider pt-1">
                <div className="font-medium">
                  {domain.host}:{domain.port} · {metric(domain.totalMs)}
                </div>
                {(domain.roundResults ?? []).map((round) => (
                  <div key={round.round} className="flex max-w-96 justify-between gap-3">
                    <span className="shrink-0">第 {round.round} 轮</span>
                    {round.success ? (
                      <span className="text-right">
                        总计 {metric(round.totalMs)} · CONNECT {metric(round.connectMs)}
                        {round.tlsMs === undefined ? '' : ` · TLS ${metric(round.tlsMs)}`}
                      </span>
                    ) : (
                      <span className="break-all text-right text-danger">
                        失败{round.error ? ` · ${round.error}` : ''}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : (
          <span>{title}</span>
        )
      }
    >
      <span className="inline-flex">{metric(value)}</span>
    </Tooltip>
  )
}
/* eslint-enable react/prop-types */

interface ProcessTestRowProps {
  proxy: ControllerProxiesDetail
  result?: ProcessTestResult
  selected: boolean
  testing: boolean
  canSwitch: boolean
  isCurrent: boolean
  isSwitching: boolean
  switchBusy: boolean
  onSelectedChange: (proxy: string, selected: boolean) => void
  onSwitch: (proxy: string) => void
}

/* eslint-disable react/prop-types */
const ProcessTestRow = memo<ProcessTestRowProps>((props) => {
  const {
    proxy,
    result,
    selected,
    testing,
    canSwitch,
    isCurrent,
    isSwitching,
    switchBusy,
    onSelectedChange,
    onSwitch
  } = props
  const grade = result ? resultGrade(result) : undefined

  return (
    <div className="grid grid-cols-[minmax(180px,1.8fr)_repeat(5,minmax(86px,1fr))_82px_72px] items-center gap-2 border-b border-divider/60 px-4 py-3 text-sm last:border-b-0">
      <div className="flex min-w-0 items-center gap-2 overflow-hidden">
        <Checkbox
          aria-label={`选择节点 ${proxy.name}`}
          className="shrink-0"
          classNames={{ base: 'data-[disabled=true]:opacity-100' }}
          isSelected={selected}
          isDisabled={testing}
          onValueChange={(checked) => onSelectedChange(proxy.name, checked)}
        />
        <span className="flag-emoji block min-w-0 flex-1 truncate" title={proxy.name}>
          {proxy.name}
        </span>
      </div>
      <ProcessMetricResult result={result} value={result?.score} title="综合耗时" />
      {result ? (
        <Tooltip
          content={
            <div className="space-y-1 px-1 py-0.5 text-xs">
              <div>
                已完成：{result.completedSamples}/{result.totalSamples} 次
              </div>
              <div>成功率：{Math.round(result.successRate * 100)}%</div>
              <div>
                失败目标：{result.failedTargets}/{result.targetCount}
              </div>
            </div>
          }
        >
          <span className="inline-flex">{Math.round(result.successRate * 100)}%</span>
        </Tooltip>
      ) : (
        <span>—</span>
      )}
      <ProcessMetricResult result={result} value={result?.medianMs} title="中位耗时" />
      <ProcessMetricResult result={result} value={result?.p95Ms} title="P95" />
      <span>{result ? `${result.failedTargets}/${result.targetCount}` : '—'}</span>
      {grade ? (
        <Chip
          size="sm"
          color={grade.color}
          variant="flat"
          startContent={grade.color === 'danger' ? <MdErrorOutline /> : <MdCheckCircle />}
        >
          {grade.label}
        </Chip>
      ) : (
        <span className="text-xs text-foreground-400">未测试</span>
      )}
      <Tooltip
        placement="top"
        isDisabled={canSwitch}
        content={canSwitch ? '' : '切换目标组不包含该节点'}
      >
        <span>
          <Button
            size="sm"
            color={isCurrent ? 'success' : 'primary'}
            variant="flat"
            className="min-w-0 px-2"
            isLoading={isSwitching}
            isDisabled={switchBusy || isCurrent || !canSwitch}
            onPress={() => onSwitch(proxy.name)}
          >
            {isCurrent ? '当前' : canSwitch ? '切换' : '不可用'}
          </Button>
        </span>
      </Tooltip>
    </div>
  )
})
ProcessTestRow.displayName = 'ProcessTestRow'
/* eslint-enable react/prop-types */

function sortValue(
  proxy: ControllerProxiesDetail | ControllerGroupDetail,
  result: ProcessTestResult | undefined,
  key: SortKey
): string | number | undefined {
  if (key === 'name') return proxy.name
  if (key === 'grade') return gradeRank(result)
  return result?.[key]
}

const ProcessTest: React.FC = () => {
  const navigate = useNavigate()
  const { groups = [], mutate } = useGroups()
  const { appConfig, patchAppConfig } = useAppConfig()
  const { autoCloseConnection = true, closeMode = 'all' } = appConfig || {}
  const state = useSyncExternalStore(
    subscribeProcessTestStore,
    getProcessTestSnapshot,
    getProcessTestSnapshot
  )
  const [catalogs, setCatalogs] = useState(() => getProcessTestCatalog())
  const [requestedProcessKey] = useState(() => takeSelectedProcessTestProcess())
  const [savedProcessKeys] = useState(() => readTestHistory<string[]>(PROCESS_TEST_SELECTION_KEY))
  const initialProcessKeys = requestedProcessKey
    ? [requestedProcessKey]
    : savedProcessKeys !== undefined
      ? savedProcessKeys
      : state.processKeys || (catalogs[0] ? [catalogs[0].key] : [])
  const preferredProcessKeysRef = useRef(initialProcessKeys)
  const selectionTouchedRef = useRef(savedProcessKeys !== undefined)
  const testingRef = useRef(state.testing)
  testingRef.current = state.testing
  const [selectedProcessKeys, setSelectedProcessKeys] = useState<Set<string>>(() => {
    return new Set(initialProcessKeys)
  })
  const [processSearch, setProcessSearch] = useState('')
  const [groupName, setGroupName] = useState('')
  const [switchGroupName, setSwitchGroupName] = useState(FOLLOW_TEST_GROUP)
  const [switchingProxy, setSwitchingProxy] = useState<string>()
  const [selectedDomains, setSelectedDomains] = useState<Set<string>>(new Set())
  const [selectedNodes, setSelectedNodes] = useState<Set<string>>(new Set())
  const [rounds, setRounds] = useState(3)
  const [concurrency, setConcurrency] = useState(() =>
    normalizeConcurrency(appConfig?.codexTestConcurrency)
  )
  const [sortKey, setSortKey] = useState<SortKey>('score')
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')
  const selectedCatalogs = useMemo(
    () => catalogs.filter((catalog) => selectedProcessKeys.has(catalog.key)),
    [catalogs, selectedProcessKeys]
  )
  const combinedDomains = useMemo(() => {
    const domains = new Map<string, ProcessTestDomainTarget>()
    selectedCatalogs.forEach((catalog) => {
      catalog.domains.forEach((domain) => {
        const existing = domains.get(domain.key)
        if (existing) {
          existing.count += domain.count
          existing.active ||= domain.active
          existing.lastSeen = Math.max(existing.lastSeen, domain.lastSeen)
        } else {
          domains.set(domain.key, { ...domain })
        }
      })
    })
    return [...domains.values()].sort(
      (left, right) => right.lastSeen - left.lastSeen || left.key.localeCompare(right.key)
    )
  }, [selectedCatalogs])
  const selectedProcessSelectionKey = processSelectionKey(selectedProcessKeys)
  const combinedDomainSelectionKey = combinedDomains.map((domain) => domain.key).join('\u0000')
  const testingProcessSelectionKey = processSelectionKey(state.processKeys || [])
  const testingCatalogs = catalogs.filter((catalog) => state.processKeys?.includes(catalog.key))
  const group = groups.find((item) => item.name === groupName) || groups[0]
  const switchGroup =
    switchGroupName === FOLLOW_TEST_GROUP
      ? group
      : groups.find((item) => item.name === switchGroupName) || group
  const proxies = useMemo(() => {
    const unique = new Map<string, ControllerProxiesDetail>()
    group?.all.filter(isTestableProxy).forEach((proxy) => unique.set(proxy.name, proxy))
    return [...unique.values()]
  }, [group])
  const proxyKey = proxies.map((proxy) => proxy.name).join('\u0000')
  const visibleResults =
    testingProcessSelectionKey && selectedProcessSelectionKey !== testingProcessSelectionKey
      ? {}
      : state.results

  useEffect(() => {
    if (!groupName && groups[0]) setGroupName(groups[0].name)
  }, [groupName, groups])

  useEffect(() => {
    if (
      switchGroupName !== FOLLOW_TEST_GROUP &&
      !groups.some((item) => item.name === switchGroupName)
    ) {
      setSwitchGroupName(FOLLOW_TEST_GROUP)
    }
  }, [groups, switchGroupName])

  useEffect(() => {
    if (selectionTouchedRef.current || selectedProcessKeys.size > 0 || catalogs.length === 0) {
      return
    }
    const restoredKeys = preferredProcessKeysRef.current.filter((key) =>
      catalogs.some((catalog) => catalog.key === key)
    )
    setSelectedProcessKeys(
      new Set(restoredKeys.length > 0 ? restoredKeys : catalogs[0] ? [catalogs[0].key] : [])
    )
  }, [catalogs, selectedProcessKeys.size])

  useEffect(() => {
    setSelectedDomains(
      new Set(combinedDomainSelectionKey ? combinedDomainSelectionKey.split('\u0000') : [])
    )
  }, [combinedDomainSelectionKey, selectedProcessSelectionKey])

  useEffect(() => {
    writeTestHistory(PROCESS_TEST_SELECTION_KEY, [...selectedProcessKeys])
  }, [selectedProcessKeys])

  useEffect(() => {
    const unsubscribe = window.electron.ipcRenderer.on(
      'mihomoConnections',
      (_event, info: ControllerConnections) => {
        if (testingRef.current || !info.connections) return
        updateActiveProcessTestConnections(
          info.connections.map((connection) => ({ ...connection, isActive: true }))
        )
        setCatalogs(getProcessTestCatalog())
      }
    )
    return unsubscribe
  }, [])

  useEffect(() => {
    setSelectedNodes(new Set(proxies.map((proxy) => proxy.name)))
  }, [group?.name, proxyKey])

  useEffect(() => {
    if (!state.testing) {
      setConcurrency(normalizeConcurrency(appConfig?.codexTestConcurrency))
    }
  }, [appConfig?.codexTestConcurrency, state.testing])

  const selectedProxyNames = proxies
    .filter((proxy) => selectedNodes.has(proxy.name))
    .map((proxy) => proxy.name)
  const selectedTargets = combinedDomains
    .filter((domain) => selectedDomains.has(domain.key))
    .map(({ host, port }) => ({ host, port }))
  const allDomainsSelected = Boolean(
    combinedDomains.length && selectedTargets.length === combinedDomains.length
  )
  const allNodesSelected = proxies.length > 0 && selectedProxyNames.length === proxies.length
  const progressValue = state.progress
    ? Math.min(100, (state.progress.completed / state.progress.total) * 100)
    : 0
  const rows = useMemo(() => {
    if (state.testing) return proxies
    return [...proxies].sort((left, right) => {
      const leftValue = sortValue(left, visibleResults[left.name], sortKey)
      const rightValue = sortValue(right, visibleResults[right.name], sortKey)
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
  }, [proxies, sortDirection, sortKey, state.testing, visibleResults])

  const toggleSort = (key: SortKey): void => {
    if (key === sortKey) {
      setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'))
      return
    }
    setSortKey(key)
    setSortDirection(key === 'successRate' ? 'desc' : 'asc')
  }

  const changeNodeSelection = useCallback((proxy: string, checked: boolean) => {
    setSelectedNodes((current) => {
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
        if (state.testing) {
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
    [autoCloseConnection, closeMode, mutate, state.testing, switchGroup, switchingProxy]
  )

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

  return (
    <BasePage
      title="进程测速"
      header={
        <Button
          size="sm"
          isIconOnly
          variant="light"
          className="app-nodrag"
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
              <Autocomplete
                label="添加进程"
                size="sm"
                className="min-w-56 flex-1"
                placeholder="搜索进程名称、路径或来源 IP"
                inputValue={processSearch}
                selectedKey={null}
                isClearable
                onInputChange={setProcessSearch}
                onClear={() => setProcessSearch('')}
                onSelectionChange={(key) => {
                  if (!key) return
                  selectionTouchedRef.current = true
                  setSelectedProcessKeys((current) => {
                    const next = new Set(current)
                    const processKey = String(key)
                    if (next.has(processKey)) next.delete(processKey)
                    else next.add(processKey)
                    return next
                  })
                }}
              >
                {catalogs.map((item) => (
                  <AutocompleteItem
                    key={item.key}
                    textValue={`${processLabel(item)} ${item.processPath} ${item.sourceIP}`}
                    startContent={
                      selectedProcessKeys.has(item.key) ? (
                        <MdCheckCircle className="shrink-0 text-success" />
                      ) : undefined
                    }
                  >
                    {processLabel(item)}（{item.domains.length} 个目标）
                  </AutocompleteItem>
                ))}
              </Autocomplete>

              <Button
                size="sm"
                variant="flat"
                startContent={<MdClearAll className="text-lg" />}
                isDisabled={selectedProcessKeys.size === 0}
                onPress={() => {
                  selectionTouchedRef.current = true
                  setSelectedProcessKeys(new Set())
                }}
              >
                清空进程
              </Button>

              <Select
                label="测试节点组"
                size="sm"
                className="min-w-52 flex-1"
                classNames={{ base: 'data-[disabled=true]:opacity-100' }}
                selectedKeys={group ? new Set([group.name]) : new Set()}
                disallowEmptySelection
                isDisabled={state.testing || groups.length === 0}
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

              <div>
                <div className="mb-1 text-xs text-foreground-500">测试轮数</div>
                <div className="flex gap-1">
                  {[1, 3, 5].map((value) => (
                    <Button
                      key={value}
                      size="sm"
                      className="min-w-16 data-[disabled=true]:opacity-100"
                      color={rounds === value ? 'primary' : 'default'}
                      variant={rounds === value ? 'solid' : 'flat'}
                      isDisabled={state.testing}
                      onPress={() => setRounds(value)}
                    >
                      {value} 轮
                    </Button>
                  ))}
                </div>
              </div>

              <Input
                label="并发节点"
                type="number"
                size="sm"
                className="w-28"
                classNames={{ base: 'data-[disabled=true]:opacity-100' }}
                min={MIN_CONCURRENCY}
                max={MAX_CONCURRENCY}
                value={concurrency.toString()}
                isDisabled={state.testing}
                onValueChange={(value) => {
                  const parsed = Number(value)
                  if (Number.isFinite(parsed)) setConcurrency(normalizeConcurrency(parsed))
                }}
                onBlur={() => void patchAppConfig({ codexTestConcurrency: concurrency })}
              />

              {state.testing ? (
                <Button
                  color="danger"
                  variant="flat"
                  isLoading={state.cancelling}
                  startContent={state.cancelling ? undefined : <MdStop />}
                  onPress={() => void stopProcessTest()}
                >
                  停止测试
                </Button>
              ) : (
                <Button
                  color="primary"
                  variant="solid"
                  isDisabled={selectedProxyNames.length === 0 || selectedTargets.length === 0}
                  onPress={() =>
                    void runProcessTest(selectedProxyNames, selectedTargets, rounds, concurrency, [
                      ...selectedProcessKeys
                    ])
                  }
                >
                  测试 {selectedProxyNames.length} 个节点
                </Button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-foreground-500">
                已选进程 {selectedCatalogs.length} 个：
              </span>
              {selectedCatalogs.length === 0 ? (
                <span className="text-xs text-foreground-400">未选择</span>
              ) : (
                selectedCatalogs.map((item) => (
                  <Chip
                    key={item.key}
                    size="sm"
                    variant="flat"
                    onClose={() => {
                      selectionTouchedRef.current = true
                      setSelectedProcessKeys((current) => {
                        const next = new Set(current)
                        next.delete(item.key)
                        return next
                      })
                    }}
                  >
                    {processLabel(item)} · {item.domains.length} 个目标
                  </Chip>
                ))
              )}
            </div>

            <div className="rounded-xl border border-divider/60 bg-content1 px-3 py-2 text-xs leading-5 text-foreground-500">
              来源：连接监控保留的活动连接和最近约 200 条关闭记录。443 端口测试代理 CONNECT +
              TLS，其他 TCP 端口只测试 CONNECT；不会发送 HTTP 请求或业务数据。
            </div>

            {state.savedAt &&
              testingProcessSelectionKey === selectedProcessSelectionKey &&
              !state.testing && (
                <div className="text-xs text-foreground-500">
                  已恢复上次测试结果 · {formatTestHistoryTime(state.savedAt)}
                </div>
              )}

            {state.testing && state.progress && (
              <div>
                <div className="mb-1 flex justify-between gap-3 text-xs">
                  <span className="min-w-0 truncate flag-emoji">
                    {stageText[state.progress.stage]}：{state.progress.proxy}
                    {state.progress.target ? ` · ${state.progress.target}` : ''}
                    {state.progress.round
                      ? ` · 第 ${state.progress.round}/${state.progress.rounds} 轮`
                      : ''}
                  </span>
                  <span className="shrink-0">
                    {state.progress.completed}/{state.progress.total}
                  </span>
                </div>
                <Progress aria-label="进程测速进度" value={progressValue} color="primary" />
              </div>
            )}
            {state.testing && testingProcessSelectionKey !== selectedProcessSelectionKey && (
              <div className="rounded-xl bg-warning/10 px-3 py-2 text-sm text-warning-700 dark:text-warning-400">
                后台仍在测试：{processSelectionLabel(testingCatalogs)}。当前选择为
                {processSelectionLabel(selectedCatalogs)}，不会改变正在执行的目标。
              </div>
            )}
            {state.error && !state.testing && (
              <div className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
                {state.error}
              </div>
            )}
          </div>
        </section>

        <section className="border-b border-divider p-3">
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <Checkbox
                classNames={{ base: 'data-[disabled=true]:opacity-100' }}
                isSelected={allDomainsSelected}
                isIndeterminate={selectedTargets.length > 0 && !allDomainsSelected}
                isDisabled={state.testing || combinedDomains.length === 0}
                onValueChange={(checked) => {
                  setSelectedDomains(
                    checked ? new Set(combinedDomains.map((domain) => domain.key)) : new Set()
                  )
                }}
              >
                测试目标（已选 {selectedTargets.length}/{combinedDomains.length}）
              </Checkbox>
              <span className="text-xs text-foreground-500">仅保留会话内记录</span>
            </div>

            {selectedCatalogs.length === 0 ? (
              <div className="flex min-h-28 items-center justify-center text-sm text-foreground-400">
                请搜索并添加至少一个进程
              </div>
            ) : (
              <div className="grid min-w-0 max-h-48 gap-2 overflow-x-hidden overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">
                {combinedDomains.map((domain) => (
                  <Checkbox
                    key={domain.key}
                    classNames={{
                      base: 'm-0 w-full min-w-0 max-w-none overflow-hidden rounded-xl border border-divider/60 bg-content1 px-3 py-2 data-[disabled=true]:opacity-100',
                      label: 'min-w-0 flex-1 overflow-hidden'
                    }}
                    isSelected={selectedDomains.has(domain.key)}
                    isDisabled={state.testing}
                    onValueChange={(checked) => {
                      setSelectedDomains((current) => {
                        const next = new Set(current)
                        if (checked) next.add(domain.key)
                        else next.delete(domain.key)
                        return next
                      })
                    }}
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm" title={domain.key}>
                        {domain.key}
                      </div>
                      <div className="text-xs text-foreground-500">
                        {domain.active ? '活动' : '已关闭'} · 出现 {domain.count} 次
                      </div>
                    </div>
                  </Checkbox>
                ))}
              </div>
            )}
          </div>
        </section>

        <section className="min-h-0 flex-1">
          <div>
            <div className="flex items-center justify-between border-b border-divider px-4 py-3">
              <Checkbox
                classNames={{ base: 'data-[disabled=true]:opacity-100' }}
                isSelected={allNodesSelected}
                isIndeterminate={selectedProxyNames.length > 0 && !allNodesSelected}
                isDisabled={state.testing || proxies.length === 0}
                onValueChange={(checked) => {
                  setSelectedNodes(
                    checked ? new Set(proxies.map((proxy) => proxy.name)) : new Set()
                  )
                }}
              >
                全选节点
              </Checkbox>
              <span className="text-xs text-foreground-500">悬停指标可查看各域名和逐轮结果</span>
            </div>

            <div className="overflow-x-auto">
              <div className="min-w-190">
                <div className="grid grid-cols-[minmax(180px,1.8fr)_repeat(5,minmax(86px,1fr))_82px_72px] gap-2 border-b border-divider px-4 py-2 text-xs text-foreground-500">
                  {sortHeader('name', '节点')}
                  {sortHeader('score', '综合耗时')}
                  {sortHeader('successRate', '成功率')}
                  {sortHeader('medianMs', '中位耗时')}
                  {sortHeader('p95Ms', 'P95')}
                  {sortHeader('failedTargets', '失败目标')}
                  {sortHeader('grade', '评级')}
                  <span className="flex h-6 items-center">操作</span>
                </div>

                {rows.length === 0 ? (
                  <div className="flex min-h-40 items-center justify-center text-sm text-foreground-400">
                    当前代理组没有可测试节点
                  </div>
                ) : (
                  rows.map((proxy) => (
                    <ProcessTestRow
                      key={proxy.name}
                      proxy={proxy}
                      result={visibleResults[proxy.name]}
                      selected={selectedNodes.has(proxy.name)}
                      testing={state.testing}
                      canSwitch={Boolean(switchGroup?.all.some((item) => item.name === proxy.name))}
                      isCurrent={switchGroup?.now === proxy.name}
                      isSwitching={switchingProxy === proxy.name}
                      switchBusy={Boolean(switchingProxy)}
                      onSelectedChange={changeNodeSelection}
                      onSwitch={switchProxy}
                    />
                  ))
                )}
              </div>
            </div>
          </div>
        </section>
      </div>
    </BasePage>
  )
}

export default ProcessTest
