import {
  Autocomplete,
  AutocompleteItem,
  Button,
  Checkbox,
  Chip,
  Progress,
  Select,
  SelectItem
} from '@heroui/react'
import BasePage from '@renderer/components/base/base-page'
import {
  TestResultActionHeader,
  TestResultEmptyState,
  TestResultNodeCell,
  TestPageControlRow,
  TestPageControls,
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
  getCodexTestSnapshot,
  runCodexTest,
  stopCodexTest,
  subscribeCodexTestStore
} from '@renderer/utils/codex-test-store'
import {
  getCodexActualTestSnapshot,
  runCodexActualTest,
  stopCodexActualTest,
  subscribeCodexActualTestStore
} from '@renderer/utils/codex-actual-test-store'
import { formatLatency } from '@renderer/utils/format-latency'
import { mihomoChangeProxy, mihomoCloseConnections } from '@renderer/utils/ipc'
import { notify } from '@renderer/utils/notification'
import { isTestableProxy } from '@renderer/utils/testable-proxy'
import { formatTestHistoryTime } from '@renderer/utils/test-history'
import { copyText } from '@renderer/utils/clipboard'
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
import { MdCheckCircle, MdContentCopy, MdErrorOutline, MdStop } from 'react-icons/md'
import { Virtuoso } from 'react-virtuoso'
import { useNavigate } from 'react-router-dom'

type SortKey =
  'name' | 'score' | 'tunnelMs' | 'tlsMs' | 'httpsTtfbMs' | 'websocketMs' | 'successRate' | 'grade'
type SortDirection = 'asc' | 'desc'
type RoundMetricKey = 'combinedMs' | 'tunnelMs' | 'tlsMs' | 'httpsTtfbMs' | 'websocketMs'
type TestMode = 'link' | 'actual'
type ActualSortKey =
  | 'name'
  | 'linkScore'
  | 'score'
  | 'firstTokenMs'
  | 'totalMs'
  | 'successRate'
  | 'routeVerifiedRate'
  | 'tokens'
  | 'grade'

const stageText: Record<CodexTestStage, string> = {
  selecting: '正在切换测试节点',
  probing: '正在并行测试 HTTPS 和 WebSocket',
  completed: '本轮测试完成'
}

const actualStageText: Record<CodexActualTestStage, string> = {
  selecting: '正在切换并清理隐藏测速通道',
  starting: '正在准备独立 Codex 后台',
  requesting: '已发送真实 Codex 请求',
  streaming: '正在接收 Codex 流式返回',
  completed: '本轮真实响应测试完成'
}

const MIN_CONCURRENCY = 1
const MAX_CONCURRENCY = 16
const FOLLOW_TEST_GROUP = '__FOLLOW_TEST_GROUP__'
const ACTUAL_TABLE_COLUMNS = 'grid-cols-[minmax(180px,1.7fr)_repeat(7,minmax(86px,1fr))_82px_72px]'
const LINK_TABLE_COLUMNS = 'grid-cols-[minmax(160px,1.7fr)_repeat(6,minmax(74px,1fr))_82px_72px]'
const EMPTY_LINK_RESULTS: Record<string, CodexTestResult> = {}
const EMPTY_ACTUAL_RESULTS: Record<string, CodexActualTestResult> = {}

function normalizeConcurrency(value?: number): number {
  if (!Number.isFinite(value)) return 6
  return Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY, Math.trunc(value!)))
}

function metric(value?: number): string {
  return formatLatency(value)
}

function logTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour12: false })
}

function actualLogsText(logs: CodexActualTestLogEntry[]): string {
  return logs
    .map((entry) => {
      const context = entry.proxy
        ? `${entry.proxy}${entry.round ? ` · 第 ${entry.round} 轮` : ''}`
        : '测试任务'
      return `${logTime(entry.timestamp)}\t${context}\t${entry.message}`
    })
    .join('\n')
}

const roundMetricLabels: Record<RoundMetricKey, string> = {
  combinedMs: '综合耗时',
  tunnelMs: 'CONNECT',
  tlsMs: 'TLS',
  httpsTtfbMs: 'HTTPS',
  websocketMs: 'WebSocket'
}

function roundMetricStatus(round: CodexTestRoundResult, key: RoundMetricKey): string {
  if (key === 'httpsTtfbMs' && round.httpsStatus) return ` · HTTP ${round.httpsStatus}`
  if (key === 'websocketMs' && round.websocketStatus) {
    return ` · HTTP ${round.websocketStatus}`
  }
  return ''
}

function metricResult(
  result: CodexTestResult | undefined,
  value: number | undefined,
  roundKey: RoundMetricKey
): React.ReactNode {
  if (!result) return <span>—</span>

  const failurePenalty = (1 - result.successRate) * 2000
  const roundResults = result.roundResults ?? []
  return (
    <TestResultTooltip
      placement="top"
      closeDelay={0}
      content={
        <div className="min-w-52 space-y-1 px-1 py-0.5 text-xs">
          <div className="font-medium">
            {roundMetricLabels[roundKey]}聚合：{metric(value)}
          </div>
          {roundKey === 'combinedMs' && (
            <div className="border-b border-divider pb-1 text-foreground-500">
              基础 {metric(result.totalMs)} · 抖动 {metric(result.jitterMs)} · 失败惩罚{' '}
              {metric(failurePenalty)}
            </div>
          )}
          {roundResults.length === 0 && (
            <div className="text-foreground-500">旧测试结果没有逐轮数据，请重新测试</div>
          )}
          {roundResults.map((round) => (
            <div key={round.round} className="flex max-w-80 justify-between gap-3">
              <span className="shrink-0">第 {round.round} 轮</span>
              {round.success ? (
                <span className="text-right">
                  {metric(round[roundKey])}
                  {roundMetricStatus(round, roundKey)}
                </span>
              ) : (
                <span className="break-all text-right text-danger" title={round.error}>
                  失败{round.error ? ` · ${round.error}` : ''}
                </span>
              )}
            </div>
          ))}
        </div>
      }
    >
      <span className="inline-flex">{metric(value)}</span>
    </TestResultTooltip>
  )
}

function resultGrade(result: CodexTestResult): {
  label: string
  color: 'success' | 'primary' | 'warning' | 'danger'
} {
  if (result.successRate < 0.67 || result.score === undefined) {
    return { label: '较差', color: 'danger' }
  }
  if (result.score < 500) return { label: '优秀', color: 'success' }
  if (result.score < 900) return { label: '良好', color: 'primary' }
  if (result.score < 1600) return { label: '一般', color: 'warning' }
  return { label: '较差', color: 'danger' }
}

function actualResultGrade(result: CodexActualTestResult): {
  label: string
  color: 'success' | 'primary' | 'warning' | 'danger'
} {
  if (result.successRate < 0.67 || result.routeVerifiedRate < 1 || result.score === undefined) {
    return { label: '较差', color: 'danger' }
  }
  if (result.score < 4000) return { label: '优秀', color: 'success' }
  if (result.score < 8000) return { label: '良好', color: 'primary' }
  if (result.score < 15000) return { label: '一般', color: 'warning' }
  return { label: '较差', color: 'danger' }
}

function actualGradeRank(result?: CodexActualTestResult): number | undefined {
  if (!result) return undefined
  const label = actualResultGrade(result).label
  return label === '优秀' ? 0 : label === '良好' ? 1 : label === '一般' ? 2 : 3
}

function actualMetricResult(
  result: CodexActualTestResult | undefined,
  value: number | undefined,
  key: 'score' | 'firstTokenMs' | 'totalMs',
  label: string
): React.ReactNode {
  if (!result) return <span>—</span>
  return (
    <TestResultTooltip
      placement="top"
      closeDelay={0}
      content={
        <div className="min-w-64 space-y-1 px-1 py-0.5 text-xs">
          <div className="font-medium">
            {label}聚合：{metric(value)}
          </div>
          {key === 'score' && (
            <div className="border-b border-divider pb-1 text-foreground-500">
              首字 {metric(result.firstTokenMs)} · 完整 {metric(result.totalMs)} · 排队{' '}
              {metric(result.queueMs)} · 抖动 {metric(result.jitterMs)}
            </div>
          )}
          {result.roundResults.map((round) => (
            <div key={round.round} className="flex max-w-96 justify-between gap-3">
              <span className="shrink-0">第 {round.round} 轮</span>
              {round.success ? (
                <span className="text-right">
                  {metric(key === 'score' ? round.firstTokenMs : round[key])}
                  {key === 'score'
                    ? ` · 完整 ${metric(round.totalMs)} · 排队 ${metric(round.queueMs)}`
                    : ''}
                </span>
              ) : (
                <span className="break-all text-right text-danger" title={round.error}>
                  失败{round.error ? ` · ${round.error}` : ''}
                </span>
              )}
            </div>
          ))}
        </div>
      }
    >
      <span className="inline-flex">{metric(value)}</span>
    </TestResultTooltip>
  )
}

function gradeRank(result?: CodexTestResult): number | undefined {
  if (!result) return undefined
  const label = resultGrade(result).label
  return label === '优秀' ? 0 : label === '良好' ? 1 : label === '一般' ? 2 : 3
}

function sortValue(
  proxy: ControllerProxiesDetail | ControllerGroupDetail,
  result: CodexTestResult | undefined,
  key: SortKey
): string | number | undefined {
  if (key === 'name') return proxy.name
  if (key === 'grade') return gradeRank(result)
  return result?.[key]
}

function fastestLinkProxies(
  proxies: ControllerProxiesDetail[],
  results: Record<string, CodexTestResult>,
  limit: number
): ControllerProxiesDetail[] {
  return proxies
    .filter((proxy) => results[proxy.name]?.score !== undefined)
    .sort((left, right) => {
      const compared = results[left.name].score! - results[right.name].score!
      return compared || left.name.localeCompare(right.name)
    })
    .slice(0, limit)
}

function parseTopCount(value: string, max: number): number | undefined {
  if (!/^[1-9]\d*$/.test(value) || max < 1) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed <= max ? parsed : undefined
}

interface GradeCellProps {
  grade?: ReturnType<typeof resultGrade>
}

/* eslint-disable react/prop-types */
const GradeCell = memo<GradeCellProps>(({ grade }) =>
  grade ? (
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
  )
)

GradeCell.displayName = 'GradeCell'

interface CodexLinkRowProps {
  proxyName: string
  result?: CodexTestResult
  selected: boolean
  disabled: boolean
  groupName?: string
  canSwitch: boolean
  isCurrent: boolean
  isLoading: boolean
  switchBusy: boolean
  onSelectedChange: (proxyName: string, selected: boolean) => void
  onSwitch: (proxyName: string) => void
}

const CodexLinkRow = memo<CodexLinkRowProps>(
  ({
    proxyName,
    result,
    selected,
    disabled,
    groupName,
    canSwitch,
    isCurrent,
    isLoading,
    switchBusy,
    onSelectedChange,
    onSwitch
  }) => {
    const grade = result ? resultGrade(result) : undefined
    return (
      <TestResultTableRow columnsClassName={LINK_TABLE_COLUMNS}>
        <TestResultNodeCell
          name={proxyName}
          selected={selected}
          disabled={disabled}
          onSelectedChange={(checked) => onSelectedChange(proxyName, checked)}
        />
        {metricResult(result, result?.score, 'combinedMs')}
        {metricResult(result, result?.tunnelMs, 'tunnelMs')}
        {metricResult(result, result?.tlsMs, 'tlsMs')}
        {metricResult(result, result?.httpsTtfbMs, 'httpsTtfbMs')}
        {metricResult(result, result?.websocketMs, 'websocketMs')}
        {result ? (
          <TestResultTooltip
            placement="top"
            content={
              <div className="space-y-1 px-1 py-0.5 text-xs">
                <div>
                  已完成：{result.completedRounds}/{result.rounds} 轮
                </div>
                <div>成功：{result.succeeded} 轮</div>
                <div>失败：{result.failed} 轮</div>
                <div>成功率：{Math.round(result.successRate * 100)}%</div>
              </div>
            }
          >
            <span className="inline-flex">{Math.round(result.successRate * 100)}%</span>
          </TestResultTooltip>
        ) : (
          <span>—</span>
        )}
        <GradeCell grade={grade} />
        <TestResultSwitchAction
          groupName={groupName}
          canSwitch={canSwitch}
          isCurrent={isCurrent}
          isLoading={isLoading}
          switchBusy={switchBusy}
          onPress={() => onSwitch(proxyName)}
        />
      </TestResultTableRow>
    )
  }
)

CodexLinkRow.displayName = 'CodexLinkRow'

interface CodexActualRowProps extends Omit<CodexLinkRowProps, 'result'> {
  linkResult?: CodexTestResult
  result?: CodexActualTestResult
}

const CodexActualRow = memo<CodexActualRowProps>(
  ({
    proxyName,
    linkResult,
    result,
    selected,
    disabled,
    groupName,
    canSwitch,
    isCurrent,
    isLoading,
    switchBusy,
    onSelectedChange,
    onSwitch
  }) => {
    const grade = result ? actualResultGrade(result) : undefined
    return (
      <TestResultTableRow columnsClassName={ACTUAL_TABLE_COLUMNS}>
        <TestResultNodeCell
          name={proxyName}
          selected={selected}
          disabled={disabled}
          onSelectedChange={(checked) => onSelectedChange(proxyName, checked)}
        />
        {metricResult(linkResult, linkResult?.score, 'combinedMs')}
        {actualMetricResult(result, result?.score, 'score', '综合耗时')}
        {actualMetricResult(result, result?.firstTokenMs, 'firstTokenMs', '首字耗时')}
        {actualMetricResult(result, result?.totalMs, 'totalMs', '完整返回')}
        {result ? (
          <TestResultTooltip
            placement="top"
            content={
              <div className="space-y-1 px-1 py-0.5 text-xs">
                <div>模型：{result.model || '未知'}</div>
                <div>
                  成功：{result.succeeded}/{result.completedRounds} 轮
                </div>
                {result.roundResults.map((round) => (
                  <div key={round.round} className="flex max-w-96 gap-3">
                    <span>第 {round.round} 轮</span>
                    <span className={round.success ? '' : 'text-danger'}>
                      {round.success ? '成功' : round.error || '失败'}
                      {round.model ? ` · ${round.model}` : ''}
                    </span>
                  </div>
                ))}
                {result.error && <div className="max-w-80 text-danger">{result.error}</div>}
              </div>
            }
          >
            <span className="inline-flex">{Math.round(result.successRate * 100)}%</span>
          </TestResultTooltip>
        ) : (
          <span>—</span>
        )}
        {result ? (
          <TestResultTooltip
            placement="top"
            content={
              <div className="space-y-1 px-1 py-0.5 text-xs">
                <div>只有经过对应隐藏监听和隐藏代理组才算验证成功</div>
                {result.roundResults.map((round) => (
                  <div key={round.round} className="border-t border-divider pt-1">
                    <div className="flex justify-between gap-4">
                      <span>第 {round.round} 轮</span>
                      <span className={round.routeVerified ? 'text-success' : 'text-danger'}>
                        {round.routeVerified ? '已验证' : '未验证'}
                      </span>
                    </div>
                    {round.routes?.map((route, routeIndex) => (
                      <div
                        key={`${route.inboundName}-${route.host}-${routeIndex}`}
                        className="mt-1 max-w-96 space-y-0.5 text-foreground-500"
                      >
                        <div>
                          连接 {routeIndex + 1} · 入站：{route.inboundName || '未报告'}
                        </div>
                        <div>域名：{route.host || '未报告'}</div>
                        <div>DNS：{route.dnsMode || '未报告'}</div>
                        <div>
                          远端：{route.remoteDestination || route.destinationIP || '未报告'}
                        </div>
                        <div className="break-all">链路：{route.chains.join(' → ')}</div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            }
          >
            <span
              className={`inline-flex ${result.routeVerifiedRate === 1 ? 'text-success' : 'text-danger'}`}
            >
              {Math.round(result.routeVerifiedRate * 100)}%
            </span>
          </TestResultTooltip>
        ) : (
          <span>—</span>
        )}
        {result ? (
          <TestResultTooltip
            placement="top"
            content={
              <div className="space-y-1 px-1 py-0.5 text-xs">
                <div>总计：{result.tokenUsage.totalTokens}</div>
                <div>输入：{result.tokenUsage.inputTokens}</div>
                <div>缓存输入：{result.tokenUsage.cachedInputTokens}</div>
                <div>输出：{result.tokenUsage.outputTokens}</div>
                <div>推理输出：{result.tokenUsage.reasoningOutputTokens}</div>
                <div className="border-t border-divider pt-1">
                  {result.roundResults.map((round) => (
                    <div key={round.round} className="flex justify-between gap-4">
                      <span>第 {round.round} 轮</span>
                      <span>{round.tokenUsage?.totalTokens ?? '—'}</span>
                    </div>
                  ))}
                </div>
              </div>
            }
          >
            <span className="inline-flex">{result.tokenUsage.totalTokens}</span>
          </TestResultTooltip>
        ) : (
          <span>—</span>
        )}
        <GradeCell grade={grade} />
        <TestResultSwitchAction
          groupName={groupName}
          canSwitch={canSwitch}
          isCurrent={isCurrent}
          isLoading={isLoading}
          switchBusy={switchBusy}
          onPress={() => onSwitch(proxyName)}
        />
      </TestResultTableRow>
    )
  }
)

CodexActualRow.displayName = 'CodexActualRow'

const ActualLogRow = memo<{ entry: CodexActualTestLogEntry }>(({ entry }) => (
  <div
    className={`grid grid-cols-[70px_minmax(130px,240px)_1fr] gap-2 py-1 ${
      entry.level === 'error'
        ? 'text-danger'
        : entry.level === 'success'
          ? 'text-success'
          : 'text-foreground-600'
    }`}
  >
    <span className="tabular-nums text-foreground-400">{logTime(entry.timestamp)}</span>
    <span className="flag-emoji truncate" title={entry.proxy}>
      {entry.proxy ? `${entry.proxy}${entry.round ? ` · 第 ${entry.round} 轮` : ''}` : '测试任务'}
    </span>
    <span className="break-words">{entry.message}</span>
  </div>
))

ActualLogRow.displayName = 'ActualLogRow'

interface ActualLogPanelProps {
  logs: CodexActualTestLogEntry[]
  expanded: boolean
  onToggle: () => void
  onCopy: () => void
}

const ActualLogPanel = memo<ActualLogPanelProps>(({ logs, expanded, onToggle, onCopy }) => {
  if (logs.length === 0) return null
  return (
    <div className="overflow-hidden rounded-xl border border-divider bg-content1">
      <div className="flex items-center hover:bg-content2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center justify-between px-3 py-2 text-left text-sm"
          onClick={onToggle}
        >
          <span className="font-medium">实时测试日志</span>
          <span className="text-xs text-foreground-500">
            {logs.length} 条 · {expanded ? '收起' : '展开'}
          </span>
        </button>
        <Button
          size="sm"
          variant="flat"
          className="mr-2 h-7 min-w-0 shrink-0 px-2"
          startContent={<MdContentCopy />}
          onPress={onCopy}
        >
          复制全部
        </Button>
      </div>
      {expanded && (
        <Virtuoso
          className="max-h-56 cursor-text select-text overflow-y-auto border-t border-divider bg-content2/40 px-3 py-2 font-mono text-xs"
          style={{ height: Math.min(224, Math.max(32, logs.length * 28)) }}
          data={logs}
          computeItemKey={(_index, entry) => entry.id}
          initialTopMostItemIndex={logs.length - 1}
          followOutput="auto"
          itemContent={(_index, entry) => <ActualLogRow entry={entry} />}
        />
      )}
    </div>
  )
})

ActualLogPanel.displayName = 'ActualLogPanel'
/* eslint-enable react/prop-types */

const CodexTest: React.FC = () => {
  const navigate = useNavigate()
  const { groups = [], mutate } = useGroups()
  const { appConfig, patchAppConfig } = useAppConfig()
  const [mode, setMode] = useState<TestMode>('link')
  const state = useSyncExternalStore(
    subscribeCodexTestStore,
    getCodexTestSnapshot,
    getCodexTestSnapshot
  )
  const actualState = useSyncExternalStore(
    subscribeCodexActualTestStore,
    getCodexActualTestSnapshot,
    getCodexActualTestSnapshot
  )
  const [groupName, setGroupName] = useState(() => state.groupName || actualState.groupName || '')
  const [switchGroupName, setSwitchGroupName] = useState(FOLLOW_TEST_GROUP)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [actualSelected, setActualSelected] = useState<Set<string>>(new Set())
  const [rounds, setRounds] = useState(3)
  const [actualRounds, setActualRounds] = useState(1)
  const [actualTopCount, setActualTopCount] = useState('5')
  const [concurrencyInput, setConcurrencyInput] = useState(() =>
    normalizeConcurrency(appConfig?.codexTestConcurrency).toString()
  )
  const [actualConcurrencyInput, setActualConcurrencyInput] = useState('2')
  const concurrencyRef = useRef<HTMLInputElement>(null)
  const actualTopRef = useRef<HTMLInputElement>(null)
  const [sortKey, setSortKey] = useState<SortKey>('score')
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')
  const [actualSortKey, setActualSortKey] = useState<ActualSortKey>('score')
  const [actualSortDirection, setActualSortDirection] = useState<SortDirection>('asc')
  const [actualLogExpanded, setActualLogExpanded] = useState(true)
  const [switchingProxy, setSwitchingProxy] = useState<string>()
  const { autoCloseConnection = true, closeMode = 'all' } = appConfig || {}
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
  const proxyKey = useMemo(() => proxies.map((proxy) => proxy.name).join('\u0000'), [proxies])
  const visibleResults =
    state.groupName && group?.name !== state.groupName ? EMPTY_LINK_RESULTS : state.results
  const visibleActualResults =
    actualState.groupName && group?.name !== actualState.groupName
      ? EMPTY_ACTUAL_RESULTS
      : actualState.results
  const anyTesting = state.testing || actualState.testing
  const actualTopLimit = parseTopCount(actualTopCount, proxies.length)
  const concurrencyMax = mode === 'actual' ? 4 : MAX_CONCURRENCY
  const currentConcurrencyInput = mode === 'actual' ? actualConcurrencyInput : concurrencyInput
  const currentConcurrency = parseTopCount(currentConcurrencyInput, concurrencyMax)
  const concurrencyOptions = useMemo(
    () => (mode === 'actual' ? [1, 2, 3, 4] : [1, 2, 4, 6, 8, 12, 16]),
    [mode]
  )
  const actualTopOptions = useMemo(
    () =>
      [...new Set([1, 3, 5, 10, 20, proxies.length])].filter(
        (value) => value >= 1 && value <= proxies.length
      ),
    [proxies.length]
  )
  const linkScoreKey = useMemo(
    () =>
      proxies
        .map((proxy) => `${proxy.name}:${visibleResults[proxy.name]?.score ?? ''}`)
        .join('\u0000'),
    [proxies, visibleResults]
  )

  useEffect(() => {
    if (!groupName && groups[0]) {
      const historyGroup = groups.find(
        (item) => item.name === state.groupName || item.name === actualState.groupName
      )
      setGroupName(historyGroup?.name || groups[0].name)
    }
  }, [actualState.groupName, groupName, groups, state.groupName])

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
  }, [group?.name, proxyKey])

  useEffect(() => {
    if (actualTopLimit === undefined || actualState.testing) return
    const ranked = fastestLinkProxies(proxies, visibleResults, actualTopLimit)
    const nextNames = ranked.map((proxy) => proxy.name)
    setActualSelected((current) => {
      if (current.size === nextNames.length && nextNames.every((name) => current.has(name))) {
        return current
      }
      return new Set(nextNames)
    })
  }, [actualState.testing, actualTopLimit, linkScoreKey, proxyKey])

  useEffect(() => {
    if (!state.testing) {
      setConcurrencyInput(normalizeConcurrency(appConfig?.codexTestConcurrency).toString())
    }
  }, [appConfig?.codexTestConcurrency, state.testing])

  const rows = useMemo(() => {
    return [...proxies].sort((left, right) => {
      const selectedCompared = Number(selected.has(right.name)) - Number(selected.has(left.name))
      if (selectedCompared !== 0) return selectedCompared

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
  }, [proxies, selected, sortDirection, sortKey, visibleResults])
  const actualRows = useMemo(() => {
    return [...proxies].sort((left, right) => {
      const selectedCompared =
        Number(actualSelected.has(right.name)) - Number(actualSelected.has(left.name))
      if (selectedCompared !== 0) return selectedCompared

      const leftResult = visibleActualResults[left.name]
      const rightResult = visibleActualResults[right.name]
      const value = (
        proxy: ControllerProxiesDetail,
        result: CodexActualTestResult | undefined
      ): string | number | undefined => {
        if (actualSortKey === 'name') return proxy.name
        if (actualSortKey === 'linkScore') return visibleResults[proxy.name]?.score
        if (actualSortKey === 'tokens') return result?.tokenUsage.totalTokens
        if (actualSortKey === 'grade') return actualGradeRank(result)
        return result?.[actualSortKey]
      }
      const leftValue = value(left, leftResult)
      const rightValue = value(right, rightResult)
      if (leftValue === undefined && rightValue === undefined) {
        return left.name.localeCompare(right.name)
      }
      if (leftValue === undefined) return 1
      if (rightValue === undefined) return -1
      const compared =
        typeof leftValue === 'string' && typeof rightValue === 'string'
          ? leftValue.localeCompare(rightValue)
          : Number(leftValue) - Number(rightValue)
      return actualSortDirection === 'asc' ? compared : -compared
    })
  }, [
    actualSelected,
    actualSortDirection,
    actualSortKey,
    proxies,
    visibleActualResults,
    visibleResults
  ])
  const activeSelected = mode === 'actual' ? actualSelected : selected
  const activeRows = mode === 'actual' ? actualRows : rows
  const selectedNames = useMemo(
    () => proxies.filter((proxy) => activeSelected.has(proxy.name)).map((proxy) => proxy.name),
    [activeSelected, proxies]
  )
  const allSelected = proxies.length > 0 && selectedNames.length === proxies.length
  const activeProgress = mode === 'actual' ? actualState.progress : state.progress
  const progressValue = activeProgress
    ? Math.min(100, (activeProgress.completed / activeProgress.total) * 100)
    : 0
  const currentRounds = mode === 'actual' ? actualRounds : rounds
  const currentTesting = mode === 'actual' ? actualState.testing : state.testing
  const currentCancelling = mode === 'actual' ? actualState.cancelling : state.cancelling
  const currentSavedAt = mode === 'actual' ? actualState.savedAt : state.savedAt
  const currentHistoryGroup = mode === 'actual' ? actualState.groupName : state.groupName
  const currentError = mode === 'actual' ? actualState.error : state.error

  const toggleSort = useCallback(
    (key: SortKey): void => {
      if (key === sortKey) {
        setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'))
        return
      }
      setSortKey(key)
      setSortDirection(key === 'successRate' ? 'desc' : 'asc')
    },
    [sortKey]
  )

  const sortHeader = (key: SortKey, label: string): React.ReactNode => (
    <TestResultSortHeader
      label={label}
      active={key === sortKey}
      direction={sortDirection}
      onPress={() => toggleSort(key)}
    />
  )

  const toggleActualSort = useCallback(
    (key: ActualSortKey): void => {
      if (key === actualSortKey) {
        setActualSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'))
        return
      }
      setActualSortKey(key)
      setActualSortDirection(
        key === 'successRate' || key === 'routeVerifiedRate' || key === 'tokens' ? 'desc' : 'asc'
      )
    },
    [actualSortKey]
  )

  const actualSortHeader = (key: ActualSortKey, label: string): React.ReactNode => (
    <TestResultSortHeader
      label={label}
      active={key === actualSortKey}
      direction={actualSortDirection}
      onPress={() => toggleActualSort(key)}
    />
  )

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
        if (anyTesting) {
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
    [autoCloseConnection, closeMode, mutate, switchGroup, switchingProxy, anyTesting]
  )

  const copyActualLogs = useCallback(async (): Promise<void> => {
    try {
      await copyText(actualLogsText(actualState.logs))
      notify(`已复制 ${actualState.logs.length} 条测试日志`, { variant: 'success' })
    } catch (error) {
      notify(`复制测试日志失败：${String(error)}`, { variant: 'danger' })
    }
  }, [actualState.logs])

  const changeLinkSelection = useCallback((proxyName: string, checked: boolean): void => {
    setSelected((current) => {
      const hasProxy = current.has(proxyName)
      if (hasProxy === checked) return current
      const next = new Set(current)
      if (checked) next.add(proxyName)
      else next.delete(proxyName)
      return next
    })
  }, [])

  const changeActualSelection = useCallback((proxyName: string, checked: boolean): void => {
    setActualSelected((current) => {
      const hasProxy = current.has(proxyName)
      if (hasProxy === checked) return current
      const next = new Set(current)
      if (checked) next.add(proxyName)
      else next.delete(proxyName)
      return next
    })
  }, [])

  const toggleActualLogs = useCallback(() => {
    setActualLogExpanded((current) => !current)
  }, [])

  const changeMode = useCallback((nextMode: TestMode): void => {
    setMode(nextMode)
  }, [])

  const renderedRows = useMemo(
    () =>
      mode === 'actual'
        ? actualRows.map((proxy) => (
            <CodexActualRow
              key={proxy.name}
              proxyName={proxy.name}
              linkResult={visibleResults[proxy.name]}
              result={visibleActualResults[proxy.name]}
              selected={actualSelected.has(proxy.name)}
              disabled={anyTesting}
              groupName={switchGroup?.name}
              canSwitch={switchableProxyNames.has(proxy.name)}
              isCurrent={switchGroup?.now === proxy.name}
              isLoading={switchingProxy === proxy.name}
              switchBusy={Boolean(switchingProxy)}
              onSelectedChange={changeActualSelection}
              onSwitch={switchProxy}
            />
          ))
        : rows.map((proxy) => (
            <CodexLinkRow
              key={proxy.name}
              proxyName={proxy.name}
              result={visibleResults[proxy.name]}
              selected={selected.has(proxy.name)}
              disabled={anyTesting}
              groupName={switchGroup?.name}
              canSwitch={switchableProxyNames.has(proxy.name)}
              isCurrent={switchGroup?.now === proxy.name}
              isLoading={switchingProxy === proxy.name}
              switchBusy={Boolean(switchingProxy)}
              onSelectedChange={changeLinkSelection}
              onSwitch={switchProxy}
            />
          )),
    [
      actualRows,
      actualSelected,
      anyTesting,
      changeActualSelection,
      changeLinkSelection,
      mode,
      rows,
      selected,
      switchableProxyNames,
      switchingProxy,
      switchGroup?.name,
      switchGroup?.now,
      switchProxy,
      visibleActualResults,
      visibleResults
    ]
  )

  return (
    <BasePage
      title="Codex 测试"
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
        <section className="border-b border-divider px-3 py-2">
          <div className="inline-flex rounded-xl border border-divider bg-content2 p-1">
            <Button
              size="sm"
              color={mode === 'link' ? 'primary' : 'default'}
              variant={mode === 'link' ? 'solid' : 'light'}
              className="min-w-28"
              onPress={() => changeMode('link')}
            >
              链路测试{state.testing ? ' · 进行中' : ''}
            </Button>
            <Button
              size="sm"
              color={mode === 'actual' ? 'primary' : 'default'}
              variant={mode === 'actual' ? 'solid' : 'light'}
              className="min-w-28"
              onPress={() => changeMode('actual')}
            >
              真实响应{actualState.testing ? ' · 进行中' : ''}
            </Button>
          </div>
        </section>
        <TestPageControls>
          <TestPageControlRow>
            <Select
              label="测试节点组"
              size="sm"
              className="min-w-52 flex-1"
              classNames={{ base: 'data-[disabled=true]:opacity-100' }}
              selectedKeys={group ? new Set([group.name]) : new Set()}
              disallowEmptySelection
              isDisabled={anyTesting || groups.length === 0}
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
                    color={currentRounds === value ? 'primary' : 'default'}
                    variant={currentRounds === value ? 'solid' : 'flat'}
                    isDisabled={anyTesting}
                    onPress={() => {
                      if (mode === 'actual') setActualRounds(value)
                      else setRounds(value)
                    }}
                  >
                    {value} 轮
                  </Button>
                ))}
              </div>
            </div>

            <Autocomplete
              ref={concurrencyRef}
              label="并发数"
              size="sm"
              className="w-28"
              classNames={{ base: 'data-[disabled=true]:opacity-100' }}
              allowsCustomValue
              isClearable={false}
              inputValue={currentConcurrencyInput}
              selectedKey={null}
              isInvalid={!anyTesting && currentConcurrency === undefined}
              errorMessage={
                currentConcurrencyInput === ''
                  ? '请输入并发数'
                  : `请输入 ${MIN_CONCURRENCY}-${concurrencyMax} 的整数`
              }
              isDisabled={anyTesting}
              onInputChange={(value) => {
                if (mode === 'actual') {
                  setActualConcurrencyInput(value)
                } else {
                  setConcurrencyInput(value)
                }
              }}
              onSelectionChange={(key) => {
                if (key === null) return
                if (mode === 'actual') setActualConcurrencyInput(String(key))
                else setConcurrencyInput(String(key))
                concurrencyRef.current?.blur()
              }}
              onBlur={() => {
                if (mode === 'link' && currentConcurrency !== undefined) {
                  void patchAppConfig({ codexTestConcurrency: currentConcurrency })
                }
              }}
            >
              {concurrencyOptions.map((value) => (
                <AutocompleteItem key={String(value)} textValue={String(value)}>
                  {value}
                </AutocompleteItem>
              ))}
            </Autocomplete>

            {mode === 'actual' && (
              <Autocomplete
                ref={actualTopRef}
                label="优选数量"
                size="sm"
                className="w-32"
                allowsCustomValue
                isClearable={false}
                inputValue={actualTopCount}
                selectedKey={null}
                isInvalid={!anyTesting && actualTopLimit === undefined}
                errorMessage={
                  actualTopCount === ''
                    ? '请输入数量'
                    : proxies.length === 0
                      ? '当前没有可选节点'
                      : `请输入 1-${proxies.length} 的整数`
                }
                isDisabled={anyTesting}
                onInputChange={setActualTopCount}
                onSelectionChange={(key) => {
                  if (key !== null) {
                    setActualTopCount(String(key))
                    actualTopRef.current?.blur()
                  }
                }}
              >
                {actualTopOptions.map((value) => (
                  <AutocompleteItem key={String(value)} textValue={String(value)}>
                    {value}
                  </AutocompleteItem>
                ))}
              </Autocomplete>
            )}

            {currentTesting ? (
              <Button
                color="danger"
                variant="flat"
                isLoading={currentCancelling}
                startContent={currentCancelling ? undefined : <MdStop />}
                onPress={() => void (mode === 'actual' ? stopCodexActualTest() : stopCodexTest())}
              >
                停止测试
              </Button>
            ) : anyTesting ? (
              <Button variant="flat" isDisabled>
                另一模式正在测试
              </Button>
            ) : (
              <Button
                color="primary"
                variant="solid"
                isDisabled={
                  selectedNames.length === 0 ||
                  currentConcurrency === undefined ||
                  (mode === 'actual' && actualTopLimit === undefined)
                }
                onPress={() =>
                  void (mode === 'actual'
                    ? runCodexActualTest(
                        selectedNames,
                        actualRounds,
                        currentConcurrency!,
                        group?.name
                      )
                    : runCodexTest(selectedNames, rounds, currentConcurrency!, group?.name))
                }
              >
                {mode === 'actual' ? '真实测试' : '测试'} {selectedNames.length} 个节点
              </Button>
            )}
          </TestPageControlRow>

          {mode === 'link' ? (
            <div className="rounded-xl border border-divider/60 bg-content1 px-3 py-2 text-xs leading-5 text-foreground-500">
              目标：chatgpt.com:443 · 流程：代理 CONNECT → TLS → HTTPS → WebSocket Upgrade。
              不发送提示词，不调用模型；收到服务响应即可用于比较链路速度。
            </div>
          ) : (
            <div className="rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-xs leading-5 text-foreground-600">
              使用本机已登录的官方 Codex 发起真实模型请求。每轮都会消耗 Codex
              配额；请求在只读临时目录运行、禁止工具，并验证连接确实经过当前隐藏测速通道。建议先运行链路测试，再用“选中链路最快前
              X 个”筛选节点。
            </div>
          )}

          {currentSavedAt && currentHistoryGroup === group?.name && !currentTesting && (
            <div className="text-xs text-foreground-500">
              已恢复上次测试结果 · {formatTestHistoryTime(currentSavedAt)}
            </div>
          )}

          {currentTesting && activeProgress && (
            <div>
              <div className="mb-1 flex justify-between text-xs">
                <span className="flag-emoji">
                  {mode === 'actual'
                    ? actualStageText[activeProgress.stage as CodexActualTestStage]
                    : stageText[activeProgress.stage as CodexTestStage]}
                  ：{activeProgress.proxy}（第 {activeProgress.round}/{activeProgress.rounds} 轮）
                </span>
                <span>
                  {activeProgress.completed}/{activeProgress.total}
                </span>
              </div>
              <Progress
                aria-label={mode === 'actual' ? 'Codex 真实响应测试进度' : 'Codex 链路测试进度'}
                value={progressValue}
                color="primary"
              />
            </div>
          )}
          {currentError && !currentTesting && (
            <div className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
              {currentError}
            </div>
          )}

          {mode === 'actual' && (
            <ActualLogPanel
              logs={actualState.logs}
              expanded={actualLogExpanded}
              onToggle={toggleActualLogs}
              onCopy={copyActualLogs}
            />
          )}
        </TestPageControls>

        <section className="min-h-0 flex-1">
          <div>
            <div className="flex items-center justify-between border-b border-divider px-4 py-3">
              <Checkbox
                classNames={{ base: 'data-[disabled=true]:opacity-100' }}
                isSelected={allSelected}
                isIndeterminate={selectedNames.length > 0 && !allSelected}
                isDisabled={anyTesting || proxies.length === 0}
                onValueChange={(checked) => {
                  const next = checked
                    ? new Set(proxies.map((proxy) => proxy.name))
                    : new Set<string>()
                  if (mode === 'actual') setActualSelected(next)
                  else setSelected(next)
                }}
              >
                全选
              </Checkbox>
              <span className="text-xs text-foreground-500">
                {mode === 'actual'
                  ? '真实响应按首字、完整返回、成功率与路由验证综合排序'
                  : '结果按 Codex 综合表现排序'}
              </span>
            </div>

            <TestResultTableViewport
              minWidthClassName={mode === 'actual' ? 'min-w-250' : 'min-w-210'}
            >
              {mode === 'actual' ? (
                <TestResultTableHeader columnsClassName={ACTUAL_TABLE_COLUMNS}>
                  {actualSortHeader('name', '节点')}
                  {actualSortHeader('linkScore', '链路延迟')}
                  {actualSortHeader('score', '综合耗时')}
                  {actualSortHeader('firstTokenMs', '首字耗时')}
                  {actualSortHeader('totalMs', '完整返回')}
                  {actualSortHeader('successRate', '成功率')}
                  {actualSortHeader('routeVerifiedRate', '路由验证')}
                  {actualSortHeader('tokens', 'Token')}
                  {actualSortHeader('grade', '评级')}
                  <TestResultActionHeader />
                </TestResultTableHeader>
              ) : (
                <TestResultTableHeader columnsClassName={LINK_TABLE_COLUMNS}>
                  {sortHeader('name', '节点')}
                  {sortHeader('score', '综合耗时')}
                  {sortHeader('tunnelMs', 'CONNECT')}
                  {sortHeader('tlsMs', 'TLS')}
                  {sortHeader('httpsTtfbMs', 'HTTPS')}
                  {sortHeader('websocketMs', 'WebSocket')}
                  {sortHeader('successRate', '成功率')}
                  {sortHeader('grade', '评级')}
                  <TestResultActionHeader />
                </TestResultTableHeader>
              )}

              {activeRows.length === 0 ? (
                <TestResultEmptyState />
              ) : (
                <TestResultVirtualRows items={renderedRows} />
              )}
            </TestResultTableViewport>
          </div>
        </section>
      </div>
    </BasePage>
  )
}

export default CodexTest
