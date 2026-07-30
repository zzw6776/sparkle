import BasePage from '@renderer/components/base/base-page'
import RuleItem from '@renderer/components/rules/rule-item'
import { mihomoMatchRule } from '@renderer/utils/ipc'
import { Virtuoso } from 'react-virtuoso'
import { useCallback, useMemo, useState } from 'react'
import { Button, Card, CardBody, Chip, Divider, Input } from '@heroui/react'
import { useRules } from '@renderer/hooks/use-rules'
import { includesIgnoreCase } from '@renderer/utils/includes'

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
    return rules.rules.filter((rule) => {
      return (
        includesIgnoreCase(rule.payload, filter) ||
        includesIgnoreCase(rule.type, filter) ||
        includesIgnoreCase(rule.proxy, filter)
      )
    })
  }, [rules, filter])

  const matchRule = useCallback(async () => {
    if (matching) return
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
            <Input
              size="sm"
              value={testUrl}
              placeholder="输入网址查看实际命中的规则"
              isClearable
              isInvalid={Boolean(matchError)}
              errorMessage={matchError}
              onValueChange={(value) => {
                setTestUrl(value)
                setMatchError('')
                setMatchResult(undefined)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void matchRule()
              }}
            />
            <Button
              size="sm"
              color="primary"
              className="shrink-0"
              isLoading={matching}
              isDisabled={!testUrl.trim()}
              onPress={() => void matchRule()}
            >
              测试规则
            </Button>
          </div>
          <div className="px-2 pb-2 text-xs text-foreground-400">
            测试会通过本机代理建立一次短暂连接，以内核的实际匹配结果为准。
          </div>
          {matchResult && (
            <div className="px-2 pb-2">
              <Card shadow="none" className="border border-default-200 bg-content2">
                <CardBody className="gap-2 px-3 py-2.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <Chip size="sm" color={matchResult.rule ? 'primary' : 'default'} variant="flat">
                      {matchResult.ruleIndex === undefined
                        ? '匹配结果'
                        : `规则 #${matchResult.ruleIndex + 1}`}
                    </Chip>
                    <span className="min-w-0 truncate font-medium">{matchedRuleText}</span>
                  </div>
                  <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                    <span className="text-foreground-400">规则策略</span>
                    <span className="truncate">
                      {matchResult.ruleProxy || (matchResult.rule ? '未知' : 'DIRECT')}
                    </span>
                    <span className="text-foreground-400">实际链路</span>
                    <span className="truncate">{proxyChain || 'DIRECT'}</span>
                    <span className="text-foreground-400">测试目标</span>
                    <span className="truncate">
                      {matchResult.host}:{matchResult.port}
                      {matchResult.destinationIP ? ` (${matchResult.destinationIP})` : ''}
                    </span>
                  </div>
                </CardBody>
              </Card>
            </div>
          )}
          <Divider />
          <div className="p-2">
            <Input
              size="sm"
              value={filter}
              placeholder="筛选规则列表"
              isClearable
              onValueChange={setFilter}
            />
          </div>
          <Divider />
        </div>
        <div className="min-h-0 flex-1">
          <Virtuoso
            data={filteredRules}
            itemContent={(i, rule) => <RuleItem index={i} rule={rule} />}
          />
        </div>
      </div>
    </BasePage>
  )
}

export default Rules
