import { Autocomplete, AutocompleteItem, Button, Checkbox, Chip } from '@heroui/react'
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
import { useDefaultAllSelection } from '@renderer/hooks/use-default-all-selection'
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
  releaseProcessTestTargetMemory,
  takeSelectedProcessTestProcess,
  updateActiveProcessTestConnections
} from '@renderer/utils/process-test-targets'
import { isTestableProxy } from '@renderer/utils/testable-proxy'
import { formatLatency } from '@renderer/utils/format-latency'
import { mihomoChangeProxy, mihomoCloseConnections } from '@renderer/utils/ipc'
import { notify } from '@renderer/utils/notification'
import { readTestHistory, writeTestHistory } from '@renderer/utils/test-history'
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import { MdCheckCircle, MdClearAll, MdErrorOutline } from 'react-icons/md'
import { useNavigate } from 'react-router-dom'

type SortKey = 'name' | 'score' | 'successRate' | 'medianMs' | 'p95Ms' | 'failedTargets' | 'grade'
type SortDirection = 'asc' | 'desc'

const MIN_CONCURRENCY = 1
const MAX_CONCURRENCY = 16
const PROCESS_TEST_SELECTION_KEY = 'sparkle:process-test-selection'
const PROCESS_TABLE_COLUMNS = 'grid-cols-[minmax(180px,1.7fr)_repeat(5,minmax(86px,1fr))_82px_72px]'
const EMPTY_PROCESS_RESULTS: Record<string, ProcessTestResult> = {}

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
    <TestResultTooltip
      placement="top"
      closeDelay={0}
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
    </TestResultTooltip>
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
  switchGroupName?: string
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
    switchGroupName,
    onSelectedChange,
    onSwitch
  } = props
  const grade = result ? resultGrade(result) : undefined

  return (
    <TestResultTableRow columnsClassName={PROCESS_TABLE_COLUMNS}>
      <TestResultNodeCell
        name={proxy.name}
        selected={selected}
        disabled={testing}
        onSelectedChange={(checked) => onSelectedChange(proxy.name, checked)}
      />
      <ProcessMetricResult result={result} value={result?.score} title="综合耗时" />
      {result ? (
        <TestResultTooltip
          closeDelay={0}
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
        </TestResultTooltip>
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
  const preferredProcessKeys = requestedProcessKey
    ? [requestedProcessKey]
    : savedProcessKeys !== undefined
      ? savedProcessKeys
      : state.processKeys || (catalogs[0] ? [catalogs[0].key] : [])
  const preferredProcessKeysRef = useRef(preferredProcessKeys)
  const selectionTouchedRef = useRef(
    !requestedProcessKey && savedProcessKeys !== undefined && savedProcessKeys.length === 0
  )
  const testingRef = useRef(state.testing)
  testingRef.current = state.testing
  const [selectedProcessKeys, setSelectedProcessKeys] = useState<Set<string>>(() => {
    return new Set(preferredProcessKeys)
  })
  const [processSearch, setProcessSearch] = useState('')
  const [processPickerSelection, setProcessPickerSelection] = useState<string | null>(null)
  const processPickerRef = useRef<HTMLInputElement>(null)
  const [groupName, setGroupName] = useState(() => groups[0]?.name || '')
  const [switchGroupName, setSwitchGroupName] = useState(FOLLOW_TEST_GROUP)
  const [switchingProxy, setSwitchingProxy] = useState<string>()
  const [rounds, setRounds] = useState(3)
  const [concurrencyInput, setConcurrencyInput] = useState(() =>
    normalizeConcurrency(
      appConfig?.processTestConcurrency ?? appConfig?.codexTestConcurrency
    ).toString()
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
  const selectedProcessSelectionKey = useMemo(
    () => processSelectionKey(selectedProcessKeys),
    [selectedProcessKeys]
  )
  const combinedDomainKeys = useMemo(
    () => combinedDomains.map((domain) => domain.key),
    [combinedDomains]
  )
  const {
    selected: selectedDomains,
    setItemSelected: setDomainSelected,
    setAllSelected: setAllDomainsSelected
  } = useDefaultAllSelection(selectedProcessSelectionKey, combinedDomainKeys)
  const testingProcessSelectionKey = useMemo(
    () => processSelectionKey(state.processKeys || []),
    [state.processKeys]
  )
  const testingCatalogs = useMemo(
    () => catalogs.filter((catalog) => state.processKeys?.includes(catalog.key)),
    [catalogs, state.processKeys]
  )
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
    const unique = new Map<string, ControllerProxiesDetail>()
    group?.all.filter(isTestableProxy).forEach((proxy) => unique.set(proxy.name, proxy))
    return [...unique.values()]
  }, [group])
  const proxyNames = useMemo(() => proxies.map((proxy) => proxy.name), [proxies])
  const {
    selected: selectedNodes,
    setItemSelected: changeNodeSelection,
    setAllSelected: setAllNodesSelected
  } = useDefaultAllSelection(group?.name, proxyNames)
  const visibleResults =
    testingProcessSelectionKey && selectedProcessSelectionKey !== testingProcessSelectionKey
      ? EMPTY_PROCESS_RESULTS
      : state.results
  const concurrency = parseTestInteger(concurrencyInput, MIN_CONCURRENCY, MAX_CONCURRENCY)

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
    if (catalogs.length === 0) return
    const catalogKeys = new Set(catalogs.map((catalog) => catalog.key))
    setSelectedProcessKeys((current) => {
      const currentKeys = [...current].filter((key) => catalogKeys.has(key))
      const preferredKeys = preferredProcessKeysRef.current.filter((key) => catalogKeys.has(key))
      const nextKeys =
        currentKeys.length > 0 || selectionTouchedRef.current
          ? currentKeys
          : preferredKeys.length > 0
            ? preferredKeys
            : [catalogs[0].key]
      if (current.size === nextKeys.length && nextKeys.every((key) => current.has(key))) {
        return current
      }
      return new Set(nextKeys)
    })
  }, [catalogs])

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

  useEffect(() => releaseProcessTestTargetMemory, [])

  useEffect(() => {
    if (!state.testing) {
      setConcurrencyInput(
        normalizeConcurrency(
          appConfig?.processTestConcurrency ?? appConfig?.codexTestConcurrency
        ).toString()
      )
    }
  }, [appConfig?.codexTestConcurrency, appConfig?.processTestConcurrency, state.testing])

  const selectedProxyNames = useMemo(
    () => proxies.filter((proxy) => selectedNodes.has(proxy.name)).map((proxy) => proxy.name),
    [proxies, selectedNodes]
  )
  const selectedTargets = useMemo(
    () =>
      combinedDomains
        .filter((domain) => selectedDomains.has(domain.key))
        .map(({ host, port }) => ({ host, port })),
    [combinedDomains, selectedDomains]
  )
  const allDomainsSelected = Boolean(
    combinedDomains.length && selectedTargets.length === combinedDomains.length
  )
  const allNodesSelected = proxies.length > 0 && selectedProxyNames.length === proxies.length
  const progressValue = state.progress
    ? Math.min(100, (state.progress.completed / state.progress.total) * 100)
    : 0
  const rows = useMemo(() => {
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
  }, [proxies, sortDirection, sortKey, visibleResults])

  const toggleSort = (key: SortKey): void => {
    if (key === sortKey) {
      setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'))
      return
    }
    setSortKey(key)
    setSortDirection(key === 'successRate' ? 'desc' : 'asc')
  }

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
    <TestResultSortHeader
      label={label}
      active={key === sortKey}
      direction={sortDirection}
      onPress={() => toggleSort(key)}
    />
  )

  const renderRow = useCallback(
    (_index: number, proxy: ControllerProxiesDetail) => (
      <ProcessTestRow
        proxy={proxy}
        result={visibleResults[proxy.name]}
        selected={selectedNodes.has(proxy.name)}
        testing={state.testing}
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
      selectedNodes,
      state.testing,
      switchableProxyNames,
      switchingProxy,
      switchGroup?.name,
      switchGroup?.now,
      switchProxy,
      visibleResults
    ]
  )

  return (
    <TestPageShell title="进程测速" onBack={() => navigate('/speed-test')}>
      <TestPageControls>
        <TestPageControlRow>
          <Autocomplete
            ref={processPickerRef}
            label="添加进程"
            size="sm"
            className="min-w-56 flex-1"
            placeholder="搜索进程名称、路径或来源 IP"
            allowsCustomValue
            inputValue={processSearch}
            selectedKey={processPickerSelection}
            isClearable
            onInputChange={(value) => {
              setProcessPickerSelection(null)
              setProcessSearch(value)
            }}
            onClear={() => setProcessSearch('')}
            onOpenChange={(isOpen) => {
              if (isOpen) setProcessPickerSelection(null)
            }}
            onSelectionChange={(key) => {
              if (!key) return
              setProcessPickerSelection(String(key))
              selectionTouchedRef.current = true
              setSelectedProcessKeys((current) => {
                const next = new Set(current)
                const processKey = String(key)
                if (next.has(processKey)) next.delete(processKey)
                else next.add(processKey)
                return next
              })
              window.requestAnimationFrame(() => processPickerRef.current?.blur())
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

          <TestGroupSelectors
            groups={groups}
            testGroupName={group?.name}
            switchGroupName={switchGroupName}
            testGroupDisabled={state.testing}
            onTestGroupChange={setGroupName}
            onSwitchGroupChange={setSwitchGroupName}
          />

          <TestRoundSelector value={rounds} disabled={state.testing} onChange={setRounds} />

          <TestNodeConcurrencySelect
            value={concurrencyInput}
            disabled={state.testing}
            onValueChange={setConcurrencyInput}
            onValidBlur={(value) => void patchAppConfig({ processTestConcurrency: value })}
          />

          <TestRunButton
            running={state.testing}
            stopping={state.cancelling}
            disabled={
              selectedProxyNames.length === 0 ||
              selectedTargets.length === 0 ||
              concurrency === undefined
            }
            startLabel={`测试 ${selectedProxyNames.length} 个节点`}
            onStart={() =>
              runProcessTest(selectedProxyNames, selectedTargets, rounds, concurrency!, [
                ...selectedProcessKeys
              ])
            }
            onStop={stopProcessTest}
          />
        </TestPageControlRow>

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
          来源：连接监控保留的活动连接和最近约 200 条关闭记录。443 端口测试代理 CONNECT + TLS，其他
          TCP 端口只测试 CONNECT；不会发送 HTTP 请求或业务数据。
        </div>

        <TestHistoryNotice
          savedAt={state.savedAt}
          visible={testingProcessSelectionKey === selectedProcessSelectionKey && !state.testing}
        />

        {state.testing && state.progress && (
          <TestProgressBar
            label={`${stageText[state.progress.stage]}：${state.progress.proxy}${
              state.progress.target ? ` · ${state.progress.target}` : ''
            }${
              state.progress.round
                ? ` · 第 ${state.progress.round}/${state.progress.rounds} 轮`
                : ''
            }`}
            detail={`${state.progress.completed}/${state.progress.total}`}
            value={progressValue}
            ariaLabel="进程测速进度"
          />
        )}
        {state.testing && testingProcessSelectionKey !== selectedProcessSelectionKey && (
          <div className="rounded-xl bg-warning/10 px-3 py-2 text-sm text-warning-700 dark:text-warning-400">
            后台仍在测试：{processSelectionLabel(testingCatalogs)}。当前选择为
            {processSelectionLabel(selectedCatalogs)}，不会改变正在执行的目标。
          </div>
        )}
        {state.error && !state.testing && (
          <div className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">{state.error}</div>
        )}
      </TestPageControls>

      <section className="border-b border-divider p-3">
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <Checkbox
              classNames={{ base: 'data-[disabled=true]:opacity-100' }}
              isSelected={allDomainsSelected}
              isIndeterminate={selectedTargets.length > 0 && !allDomainsSelected}
              isDisabled={state.testing || combinedDomains.length === 0}
              onValueChange={setAllDomainsSelected}
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
                  onValueChange={(checked) => setDomainSelected(domain.key, checked)}
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
          <TestResultSelectionHeader
            selected={allNodesSelected}
            indeterminate={selectedProxyNames.length > 0 && !allNodesSelected}
            disabled={state.testing || proxies.length === 0}
            label="全选节点"
            hint="悬停指标可查看各域名和逐轮结果"
            onChange={setAllNodesSelected}
          />

          <TestResultTableViewport minWidthClassName="min-w-190">
            <TestResultTableHeader columnsClassName={PROCESS_TABLE_COLUMNS}>
              {sortHeader('name', '节点')}
              {sortHeader('score', '综合耗时')}
              {sortHeader('successRate', '成功率')}
              {sortHeader('medianMs', '中位耗时')}
              {sortHeader('p95Ms', 'P95')}
              {sortHeader('failedTargets', '失败目标')}
              {sortHeader('grade', '评级')}
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

export default ProcessTest
