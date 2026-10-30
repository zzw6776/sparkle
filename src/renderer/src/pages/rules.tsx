import { Button, InputGroup, Separator } from '@heroui/react'
import BasePage from '@renderer/components/base/base-page'
import RuleItem from '@renderer/components/rules/rule-item'
import { useRules } from '@renderer/hooks/use-rules'
import { includesIgnoreCase } from '@renderer/utils/includes'
import { mihomoMatchRule } from '@renderer/utils/ipc'
import { useCallback, useMemo, useState } from 'react'
import { Virtuoso } from 'react-virtuoso'

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

const Rules: React.FC = () => {
  const { rules } = useRules()
  const [filter, setFilter] = useState('')
  const [testUrl, setTestUrl] = useState('')
  const [matchResult, setMatchResult] = useState<ControllerRuleMatchResult>()
  const [matchError, setMatchError] = useState('')
  const [matching, setMatching] = useState(false)

  const filteredRules = useMemo(() => {
    if (!rules) return []
    if (filter === '') return rules.rules
    return rules.rules.filter(
      (rule) =>
        includesIgnoreCase(rule.payload, filter) ||
        includesIgnoreCase(rule.type, filter) ||
        includesIgnoreCase(rule.proxy, filter)
    )
  }, [rules, filter])

  const matchRule = useCallback(async () => {
    if (matching || !testUrl.trim()) return
    setMatching(true)
    setMatchError('')
    setMatchResult(undefined)
    try {
      setMatchResult(await mihomoMatchRule(testUrl))
    } catch (error) {
      setMatchError(formatError(error))
    } finally {
      setMatching(false)
    }
  }, [matching, testUrl])

  const matchedRuleText = matchResult
    ? matchResult.rule
      ? `${matchResult.rule}${matchResult.rulePayload ? `,${matchResult.rulePayload}` : ''}`
      : '未命中规则'
    : ''
  const proxyChain = matchResult ? [...matchResult.chains].reverse().join(' → ') : ''

  return (
    <BasePage title="分流规则" contentClassName="overflow-hidden">
      <div className="flex h-full min-h-0 flex-col">
        <div className="shrink-0">
          <div className="flex gap-2 p-2">
            <InputGroup fullWidth>
              <InputGroup.Input
                value={testUrl}
                placeholder="输入网址查看实际命中的规则"
                onChange={(event) => {
                  setTestUrl(event.target.value)
                  setMatchError('')
                  setMatchResult(undefined)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void matchRule()
                }}
              />
            </InputGroup>
            <Button
              className="shrink-0"
              variant="primary"
              data-color="primary"
              isPending={matching}
              isDisabled={!testUrl.trim() || matching}
              onPress={() => void matchRule()}
            >
              {matching ? '测试中' : '测试规则'}
            </Button>
          </div>
          <div className="px-2 pb-2 text-xs text-foreground-500">
            测试会通过本机代理建立一次短暂连接，以内核的实际匹配结果为准。
          </div>
          {matchError && <div className="px-2 pb-2 text-xs text-danger">{matchError}</div>}
          {matchResult && (
            <div className="mx-2 mb-2 rounded-xl bg-content2 px-3 py-2.5">
              <div className="truncate font-medium">{matchedRuleText}</div>
              <div className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                <span className="text-foreground-500">规则策略</span>
                <span className="truncate">
                  {matchResult.ruleProxy || (matchResult.rule ? '未知' : 'DIRECT')}
                </span>
                <span className="text-foreground-500">实际链路</span>
                <span className="truncate">{proxyChain || 'DIRECT'}</span>
                <span className="text-foreground-500">测试目标</span>
                <span className="truncate">
                  {matchResult.host}:{matchResult.port}
                  {matchResult.destinationIP ? ` (${matchResult.destinationIP})` : ''}
                </span>
              </div>
            </div>
          )}
          <Separator />
          <div className="p-2">
            <InputGroup fullWidth>
              <InputGroup.Input
                value={filter}
                placeholder="筛选规则列表"
                onChange={(event) => setFilter(event.target.value)}
              />
              {filter && (
                <InputGroup.Suffix>
                  <Button
                    size="sm"
                    variant="ghost"
                    isIconOnly
                    aria-label="清空"
                    onPress={() => setFilter('')}
                  >
                    ×
                  </Button>
                </InputGroup.Suffix>
              )}
            </InputGroup>
          </div>
          <Separator />
        </div>
        <div className="min-h-0 flex-1">
          <Virtuoso
            data={filteredRules}
            itemContent={(index, rule) => <RuleItem index={index} rule={rule} />}
          />
        </div>
      </div>
    </BasePage>
  )
}

export default Rules
