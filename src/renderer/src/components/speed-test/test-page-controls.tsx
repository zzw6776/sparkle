import { Autocomplete, AutocompleteItem, Button, Progress, Tooltip } from '@heroui/react'
import BasePage from '@renderer/components/base/base-page'
import { formatTestHistoryTime } from '@renderer/utils/test-history'
import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import { IoIosArrowBack } from 'react-icons/io'
import { MdStop } from 'react-icons/md'

export const FOLLOW_TEST_GROUP = '__FOLLOW_TEST_GROUP__'

const DISABLED_ACTION_CLASS =
  'data-[disabled=true]:!bg-default-100 data-[disabled=true]:!text-foreground-400 data-[disabled=true]:!opacity-100 data-[disabled=true]:shadow-none'

export function TestPageShell({
  title,
  children,
  onBack
}: {
  title: string
  children: ReactNode
  onBack: () => void
}): React.JSX.Element {
  return (
    <BasePage
      title={title}
      header={
        <Button
          size="sm"
          isIconOnly
          variant="light"
          className="app-nodrag"
          title="返回测速中心"
          onPress={onBack}
        >
          <IoIosArrowBack className="text-lg" />
        </Button>
      }
    >
      <div className="flex min-h-full w-full flex-col">{children}</div>
    </BasePage>
  )
}

export function TestPageControls({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <section className="border-b border-divider p-3">
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  )
}

export function TestPageControlRow({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex flex-wrap items-end gap-3">{children}</div>
}

interface TestGroupOption {
  name: string
}

interface TestGroupSelectorsProps {
  groups: TestGroupOption[]
  testGroupName?: string
  switchGroupName: string
  testGroupDisabled?: boolean
  switchGroupDisabled?: boolean
  onTestGroupChange: (name: string) => void
  onSwitchGroupChange: (name: string) => void
}

export function TestGroupSelectors({
  groups,
  testGroupName,
  switchGroupName,
  testGroupDisabled = false,
  switchGroupDisabled = false,
  onTestGroupChange,
  onSwitchGroupChange
}: TestGroupSelectorsProps): React.JSX.Element {
  const groupOptions = groups.map((group) => ({
    key: group.name,
    label: group.name
  }))

  return (
    <>
      <TestOptionSelect
        label="测试节点组"
        value={testGroupName ?? ''}
        options={groupOptions}
        className="min-w-52 flex-1"
        disabled={testGroupDisabled}
        onChange={onTestGroupChange}
      />

      <TestOptionSelect
        label="切换目标组"
        value={switchGroupName}
        options={[{ key: FOLLOW_TEST_GROUP, label: '跟随测试节点组' }, ...groupOptions]}
        className="min-w-52 flex-1"
        disabled={switchGroupDisabled || groups.length === 0}
        onChange={onSwitchGroupChange}
      />
    </>
  )
}

interface TestOptionSelectOption {
  key: string
  label: string
  description?: string
}

interface TestOptionSelectProps {
  label: string
  value: string
  options: TestOptionSelectOption[]
  disabled?: boolean
  loading?: boolean
  className?: string
  onChange: (value: string) => void
}

export function TestOptionSelect({
  label,
  value,
  options,
  disabled = false,
  loading = false,
  className = 'min-w-40',
  onChange
}: TestOptionSelectProps): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const selectedOption = options.find((option) => option.key === value)
  const selectedLabel = selectedOption?.label ?? ''
  const [inputValue, setInputValue] = useState(selectedLabel)
  const committedLabelRef = useRef(selectedLabel)

  useEffect(() => {
    committedLabelRef.current = selectedLabel
    setInputValue(selectedLabel)
  }, [selectedLabel])

  return (
    <div className={className}>
      <Autocomplete
        ref={inputRef}
        label={label}
        size="sm"
        className="w-full"
        classNames={{ base: 'data-[disabled=true]:opacity-100' }}
        inputProps={{
          classNames: {
            label: 'text-foreground-500',
            helperWrapper: 'hidden'
          }
        }}
        inputValue={inputValue}
        selectedKey={selectedOption?.key ?? null}
        allowsCustomValue={false}
        isClearable={false}
        isDisabled={disabled || options.length === 0}
        isLoading={loading}
        onInputChange={setInputValue}
        onSelectionChange={(key) => {
          if (key === null) return
          const next = String(key)
          const nextOption = options.find((option) => option.key === next)
          if (!nextOption) return

          committedLabelRef.current = nextOption.label
          setInputValue(nextOption.label)
          onChange(next)
          window.requestAnimationFrame(() => inputRef.current?.blur())
        }}
        onBlur={() => {
          setInputValue(committedLabelRef.current)
        }}
      >
        {options.map((option) => (
          <AutocompleteItem
            key={option.key}
            textValue={option.description ? `${option.label} ${option.description}` : option.label}
            description={option.description}
          >
            {option.label}
          </AutocompleteItem>
        ))}
      </Autocomplete>
    </div>
  )
}

export function parseTestInteger(value: string, min: number, max: number): number | undefined {
  if (!/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : undefined
}

interface TestRoundSelectorProps {
  value: number
  disabled?: boolean
  onChange: (value: number) => void
}

export function TestRoundSelector({
  value,
  disabled = false,
  onChange
}: TestRoundSelectorProps): React.JSX.Element {
  return (
    <div>
      <div className="mb-1 text-xs text-foreground-500">测试轮数</div>
      <div className="flex gap-1">
        {[1, 3, 5].map((option) => (
          <Button
            key={option}
            size="sm"
            className="min-w-16 data-[disabled=true]:opacity-100"
            color={value === option ? 'primary' : 'default'}
            variant={value === option ? 'solid' : 'flat'}
            isDisabled={disabled}
            onPress={() => onChange(option)}
          >
            {option} 轮
          </Button>
        ))}
      </div>
    </div>
  )
}

interface TestNumberAutocompleteProps {
  label: string
  value: string
  disabled?: boolean
  min?: number
  max?: number
  options?: number[]
  className?: string
  emptyPlaceholder?: string
  invalid?: boolean
  validationMessage?: string
  onValueChange: (value: string) => void
  onValidBlur?: (value: number) => void
}

export function TestNumberAutocomplete({
  label,
  value,
  disabled = false,
  min = 1,
  max = 16,
  options = [1, 2, 4, 6, 8, 12, 16],
  className = 'w-28',
  emptyPlaceholder = '请输入数值',
  invalid: invalidOverride,
  validationMessage,
  onValueChange,
  onValidBlur
}: TestNumberAutocompleteProps): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const parsed = parseTestInteger(value, min, max)
  const invalid = !disabled && (invalidOverride ?? parsed === undefined)
  const invalidMessage =
    validationMessage || (value === '' ? emptyPlaceholder : `请输入 ${min}-${max} 的整数`)

  useEffect(() => {
    if (selectedKey !== null && selectedKey !== value) setSelectedKey(null)
  }, [selectedKey, value])

  return (
    <Tooltip content={invalidMessage} placement="top" closeDelay={0} isDisabled={!invalid}>
      <div className={className}>
        <Autocomplete
          ref={inputRef}
          label={label}
          size="sm"
          className="w-full"
          classNames={{ base: 'data-[disabled=true]:opacity-100' }}
          inputProps={{
            classNames: {
              inputWrapper: invalid
                ? '!border !border-danger/60 !bg-content2 data-[hover=true]:!bg-content2 focus-within:!border-danger'
                : undefined,
              label: 'text-foreground-500',
              input: invalid ? 'text-danger placeholder:text-danger/70' : undefined,
              helperWrapper: 'hidden'
            }
          }}
          placeholder={value === '' ? emptyPlaceholder : undefined}
          aria-invalid={invalid}
          allowsCustomValue
          isClearable={false}
          inputValue={value}
          selectedKey={selectedKey}
          isDisabled={disabled}
          onInputChange={(nextValue) => {
            setSelectedKey(null)
            onValueChange(nextValue)
          }}
          onSelectionChange={(key) => {
            if (key === null) return
            const nextValue = String(key)
            setSelectedKey(nextValue)
            onValueChange(nextValue)
            window.requestAnimationFrame(() => inputRef.current?.blur())
          }}
          onBlur={() => {
            if (parsed !== undefined) onValidBlur?.(parsed)
          }}
        >
          {options
            .filter((option) => option >= min && option <= max)
            .map((option) => (
              <AutocompleteItem key={String(option)} textValue={String(option)}>
                {option}
              </AutocompleteItem>
            ))}
        </Autocomplete>
      </div>
    </Tooltip>
  )
}

type TestNodeConcurrencySelectProps = Omit<
  TestNumberAutocompleteProps,
  'label' | 'emptyPlaceholder'
>

export function TestNodeConcurrencySelect(
  props: TestNodeConcurrencySelectProps
): React.JSX.Element {
  return <TestNumberAutocomplete label="并发节点" emptyPlaceholder="请输入并发数" {...props} />
}

interface TestRunButtonProps {
  running?: boolean
  stopping?: boolean
  blocked?: boolean
  disabled?: boolean
  startLabel: ReactNode
  stopLabel?: ReactNode
  blockedLabel?: ReactNode
  startContent?: ReactNode
  onStart: () => void | Promise<void>
  onStop: () => void | Promise<void>
}

export function TestRunButton({
  running = false,
  stopping = false,
  blocked = false,
  disabled = false,
  startLabel,
  stopLabel = '停止测试',
  blockedLabel = '其他测试正在运行',
  startContent,
  onStart,
  onStop
}: TestRunButtonProps): React.JSX.Element {
  if (blocked) {
    return (
      <Button variant="flat" className={DISABLED_ACTION_CLASS} isDisabled>
        {blockedLabel}
      </Button>
    )
  }

  return (
    <Button
      color={running ? 'danger' : 'primary'}
      variant={running ? 'flat' : 'solid'}
      className={DISABLED_ACTION_CLASS}
      isLoading={running && stopping}
      isDisabled={!running && disabled}
      startContent={running && !stopping ? <MdStop /> : !running ? startContent : undefined}
      onPress={() => void (running ? onStop() : onStart())}
    >
      {running ? stopLabel : startLabel}
    </Button>
  )
}

export function TestHistoryNotice({
  savedAt,
  visible = true
}: {
  savedAt?: number
  visible?: boolean
}): React.JSX.Element | null {
  if (!savedAt || !visible) return null
  return (
    <div className="text-xs text-foreground-500">
      已恢复上次测试结果 · {formatTestHistoryTime(savedAt)}
    </div>
  )
}

interface TestProgressBarProps {
  label: ReactNode
  detail: ReactNode
  value: number
  ariaLabel: string
  color?: ComponentProps<typeof Progress>['color']
}

export function TestProgressBar({
  label,
  detail,
  value,
  ariaLabel,
  color = 'primary'
}: TestProgressBarProps): React.JSX.Element {
  return (
    <div>
      <div className="mb-1 flex justify-between gap-3 text-xs">
        <span className="min-w-0 truncate flag-emoji">{label}</span>
        <span className="shrink-0">{detail}</span>
      </div>
      <Progress aria-label={ariaLabel} value={value} color={color} />
    </div>
  )
}
