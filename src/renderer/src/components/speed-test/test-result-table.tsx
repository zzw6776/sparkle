import { Button, Checkbox, Tooltip, cn } from '@heroui/react'
import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type WheelEvent
} from 'react'
import { MdArrowDownward, MdArrowUpward, MdUnfoldMore } from 'react-icons/md'
import { Virtuoso } from 'react-virtuoso'

type SortDirection = 'asc' | 'desc'
type TestResultTooltipProps = ComponentProps<typeof Tooltip>

function hasScrollableTooltipContent(target: HTMLElement, boundary: HTMLElement): boolean {
  let element: HTMLElement | null = target
  while (element && element !== boundary) {
    const overflowY = window.getComputedStyle(element).overflowY
    if (
      (overflowY === 'auto' || overflowY === 'scroll') &&
      element.scrollHeight > element.clientHeight
    ) {
      return true
    }
    element = element.parentElement
  }
  return false
}

function passWheelToPage(event: WheelEvent<HTMLDivElement>): void {
  if (
    event.ctrlKey ||
    hasScrollableTooltipContent(event.target as HTMLElement, event.currentTarget)
  ) {
    return
  }

  const page = document.querySelector<HTMLElement>('.content')
  if (!page) return
  const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? page.clientHeight : 1
  event.preventDefault()
  page.scrollBy({
    top: event.deltaY * multiplier,
    left: event.deltaX * multiplier
  })
}

export function TestResultTooltip({
  content,
  closeDelay = 0,
  disableAnimation = true,
  ...props
}: TestResultTooltipProps): React.JSX.Element {
  return (
    <Tooltip
      {...props}
      closeDelay={closeDelay}
      disableAnimation={disableAnimation}
      content={
        <div className="contents" onWheel={passWheelToPage}>
          {content}
        </div>
      }
    />
  )
}

interface TestResultTableViewportProps {
  minWidthClassName: string
  children: ReactNode
}

export function TestResultTableViewport({
  minWidthClassName,
  children
}: TestResultTableViewportProps): React.JSX.Element {
  return (
    <div className="overflow-x-auto">
      <div className={minWidthClassName}>{children}</div>
    </div>
  )
}

interface TestResultSelectionHeaderProps {
  selected: boolean
  indeterminate: boolean
  disabled?: boolean
  label?: ReactNode
  hint: ReactNode
  onChange: (selected: boolean) => void
}

export function TestResultSelectionHeader({
  selected,
  indeterminate,
  disabled = false,
  label = '全选',
  hint,
  onChange
}: TestResultSelectionHeaderProps): React.JSX.Element {
  return (
    <div className="flex items-center justify-between border-b border-divider px-4 py-3">
      <Checkbox
        classNames={{ base: 'data-[disabled=true]:opacity-100' }}
        isSelected={selected}
        isIndeterminate={indeterminate}
        isDisabled={disabled}
        onValueChange={onChange}
      >
        {label}
      </Checkbox>
      <span className="text-xs text-foreground-500">{hint}</span>
    </div>
  )
}

interface TestResultVirtualRowsProps {
  items: unknown[]
  defaultItemHeight?: number
  itemKey: (item: unknown) => React.Key
  itemContent: (index: number, item: unknown) => ReactNode
}

export function TestResultVirtualRows<T>({
  items,
  defaultItemHeight = 49,
  itemKey,
  itemContent
}: Omit<TestResultVirtualRowsProps, 'items' | 'itemKey' | 'itemContent'> & {
  items: T[]
  itemKey: (item: T) => React.Key
  itemContent: (index: number, item: T) => ReactNode
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const [scrollParent, setScrollParent] = useState<HTMLElement>()

  useEffect(() => {
    const parent = hostRef.current?.closest<HTMLElement>('.content')
    if (parent) setScrollParent(parent)
  }, [])

  return (
    <div ref={hostRef}>
      {scrollParent && (
        <Virtuoso
          customScrollParent={scrollParent}
          data={items}
          defaultItemHeight={defaultItemHeight}
          increaseViewportBy={{ top: 100, bottom: 250 }}
          computeItemKey={(_index, item) => itemKey(item)}
          itemContent={itemContent}
        />
      )}
    </div>
  )
}

interface TestResultTableGridProps {
  columnsClassName: string
  children: ReactNode
  className?: string
}

export function TestResultTableHeader({
  columnsClassName,
  children,
  className
}: TestResultTableGridProps): React.JSX.Element {
  return (
    <div
      className={cn(
        'grid gap-2 border-b border-divider px-4 py-2 text-xs text-foreground-500',
        columnsClassName,
        className
      )}
    >
      {children}
    </div>
  )
}

export function TestResultTableRow({
  columnsClassName,
  children,
  className
}: TestResultTableGridProps): React.JSX.Element {
  return (
    <div
      className={cn(
        'grid items-center gap-2 border-b border-divider/60 px-4 py-3 text-sm last:border-b-0',
        columnsClassName,
        className
      )}
    >
      {children}
    </div>
  )
}

interface TestResultSortHeaderProps {
  label: string
  active: boolean
  direction: SortDirection
  onPress: () => void
}

export function TestResultSortHeader({
  label,
  active,
  direction,
  onPress
}: TestResultSortHeaderProps): React.JSX.Element {
  return (
    <Button
      size="sm"
      variant="light"
      className="h-6 min-w-0 justify-start gap-0.5 px-0 text-xs text-foreground-500"
      endContent={
        !active ? (
          <MdUnfoldMore className="shrink-0 text-sm opacity-50" />
        ) : direction === 'asc' ? (
          <MdArrowUpward className="shrink-0 text-sm" />
        ) : (
          <MdArrowDownward className="shrink-0 text-sm" />
        )
      }
      onPress={onPress}
    >
      <span className="truncate">{label}</span>
    </Button>
  )
}

interface TestResultNodeCellProps {
  name: string
  selected: boolean
  disabled: boolean
  onSelectedChange: (selected: boolean) => void
}

export function TestResultNodeCell({
  name,
  selected,
  disabled,
  onSelectedChange
}: TestResultNodeCellProps): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-center gap-2 overflow-hidden">
      <Checkbox
        aria-label={`选择节点 ${name}`}
        className="shrink-0"
        classNames={{ base: 'data-[disabled=true]:opacity-100' }}
        isSelected={selected}
        isDisabled={disabled}
        onValueChange={onSelectedChange}
      />
      <TestResultTooltip placement="top" content={name}>
        <span className="flag-emoji block min-w-0 flex-1 truncate">{name}</span>
      </TestResultTooltip>
    </div>
  )
}

export function TestResultActionHeader(): React.JSX.Element {
  return (
    <span className="sticky right-0 z-20 flex h-6 items-center justify-center bg-content1 px-2 shadow-[-8px_0_12px_-12px_rgba(0,0,0,0.45)]">
      操作
    </span>
  )
}

interface TestResultSwitchActionProps {
  groupName?: string
  canSwitch: boolean
  isCurrent: boolean
  isLoading: boolean
  switchBusy: boolean
  onPress: () => void
}

export function TestResultSwitchAction({
  groupName,
  canSwitch,
  isCurrent,
  isLoading,
  switchBusy,
  onPress
}: TestResultSwitchActionProps): React.JSX.Element {
  return (
    <div className="sticky right-0 z-10 flex min-w-0 justify-center bg-content1 px-2 shadow-[-8px_0_12px_-12px_rgba(0,0,0,0.45)]">
      <TestResultTooltip
        placement="top"
        isDisabled={canSwitch}
        content={`切换目标组“${groupName || '未知'}”不包含该节点`}
      >
        <span>
          <Button
            size="sm"
            color={isCurrent ? 'success' : 'primary'}
            variant="flat"
            className="min-w-0 px-2"
            isLoading={isLoading}
            isDisabled={switchBusy || isCurrent || !canSwitch}
            onPress={onPress}
          >
            {isCurrent ? '当前' : canSwitch ? '切换' : '不可用'}
          </Button>
        </span>
      </TestResultTooltip>
    </div>
  )
}

export function TestResultEmptyState(): React.JSX.Element {
  return (
    <div className="flex min-h-40 items-center justify-center text-sm text-foreground-400">
      当前代理组没有可测试节点
    </div>
  )
}
