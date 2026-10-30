import { Button, Checkbox, Chip, ProgressBar, Tooltip } from '@heroui/react'
import {
  Children,
  forwardRef,
  isValidElement,
  type ChangeEvent,
  type FocusEvent,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode
} from 'react'

export interface LegacyTooltipProps {
  children: ReactNode
  content: ReactNode
  placement?: 'top' | 'bottom' | 'left' | 'right'
  delay?: number
  closeDelay?: number
  isDisabled?: boolean
  isOpen?: boolean
  onOpenChange?: (open: boolean) => void
  disableAnimation?: boolean
}

interface LegacyAutocompleteItemProps {
  children: ReactNode
  value?: string
  textValue?: string
  description?: ReactNode
  startContent?: ReactNode
}

export function LegacyAutocompleteItem(_props: LegacyAutocompleteItemProps): null {
  return null
}

interface LegacyAutocompleteProps {
  children: ReactNode
  label?: string
  className?: string
  placeholder?: string
  inputValue?: string
  isDisabled?: boolean
  isLoading?: boolean
  isClearable?: boolean
  allowsCustomValue?: boolean
  selectedKey?: string | number | null
  classNames?: unknown
  inputProps?: unknown
  size?: string
  'aria-invalid'?: boolean
  onInputChange?: (value: string) => void
  onSelectionChange?: (key: string | null) => void
  onClear?: () => void
  onOpenChange?: (open: boolean) => void
  onBlur?: () => void
}

export const LegacyAutocomplete = forwardRef<HTMLInputElement, LegacyAutocompleteProps>(
  function LegacyAutocomplete(
    {
      children,
      label,
      className,
      placeholder,
      inputValue = '',
      isDisabled,
      isLoading,
      isClearable,
      size: _size,
      selectedKey: _selectedKey,
      allowsCustomValue: _allowsCustomValue,
      classNames: _classNames,
      inputProps: _inputProps,
      onInputChange,
      onSelectionChange,
      onClear,
      onOpenChange,
      onBlur,
      ...props
    },
    ref
  ) {
    const entries = Children.toArray(children)
      .filter(isValidElement<LegacyAutocompleteItemProps>)
      .map((child: ReactElement<LegacyAutocompleteItemProps>) => ({
        key: child.props.value ?? String(child.key),
        value: child.props.textValue || String(child.props.children),
        label:
          typeof child.props.children === 'string'
            ? child.props.children
            : child.props.textValue || ''
      }))
    const listId = `autocomplete-${label || 'options'}-${entries.length}`.replace(/\s+/g, '-')

    const updateValue = (event: ChangeEvent<HTMLInputElement>): void => {
      const next = event.target.value
      onInputChange?.(next)
      const selected = entries.find((entry) => entry.value === next || entry.label === next)
      if (selected) onSelectionChange?.(selected.key)
    }

    return (
      <label className={`flex flex-col gap-1 text-sm ${className || ''}`}>
        {label && <span className="text-foreground-500">{label}</span>}
        <div className="flex items-center rounded-xl bg-content2 px-3">
          <input
            {...props}
            ref={ref}
            list={listId}
            className="h-9 min-w-0 flex-1 bg-transparent outline-none"
            value={inputValue}
            placeholder={isLoading ? '加载中…' : placeholder}
            disabled={isDisabled}
            onFocus={() => onOpenChange?.(true)}
            onChange={updateValue}
            onBlur={() => {
              onOpenChange?.(false)
              onBlur?.()
            }}
          />
          {isClearable && inputValue && (
            <button
              type="button"
              className="px-1 text-foreground-500"
              aria-label="清空"
              onClick={() => {
                onInputChange?.('')
                onSelectionChange?.(null)
                onClear?.()
              }}
            >
              ×
            </button>
          )}
        </div>
        <datalist id={listId}>
          {entries.map((entry) => (
            <option key={entry.key} value={entry.value} label={entry.label} />
          ))}
        </datalist>
      </label>
    )
  }
)

interface LegacyInputProps {
  label?: string
  className?: string
  type?: string
  value?: string
  defaultValue?: string
  placeholder?: string
  isDisabled?: boolean
  min?: number
  max?: number
  size?: string
  onBlur?: (event: FocusEvent<HTMLInputElement>) => void
  onValueChange?: (value: string) => void
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void
}

export function LegacyInput({
  label,
  className,
  isDisabled,
  onValueChange,
  size: _size,
  ...props
}: LegacyInputProps): React.JSX.Element {
  return (
    <label className={`flex flex-col gap-1 text-sm ${className || ''}`}>
      {label && <span className="text-foreground-500">{label}</span>}
      <input
        {...props}
        disabled={isDisabled}
        className="h-9 rounded-xl bg-content2 px-3 outline-none"
        onChange={onValueChange ? (event) => onValueChange(event.target.value) : undefined}
      />
    </label>
  )
}

interface LegacySelectItemProps {
  children: ReactNode
  value: string
}

export function LegacySelectItem(_props: LegacySelectItemProps): null {
  return null
}

interface LegacySelectProps {
  children: ReactNode
  label?: string
  className?: string
  selectedKeys?: Set<string>
  isDisabled?: boolean
  size?: string
  disallowEmptySelection?: boolean
  onSelectionChange?: (selection: { currentKey: string }) => void
}

export function LegacySelect({
  children,
  label,
  className,
  selectedKeys,
  isDisabled,
  onSelectionChange
}: LegacySelectProps): React.JSX.Element {
  const entries = Children.toArray(children)
    .filter(isValidElement<LegacySelectItemProps>)
    .map((child: ReactElement<LegacySelectItemProps>) => ({
      key: child.props.value,
      label: child.props.children
    }))
  return (
    <label className={`flex flex-col gap-1 text-sm ${className || ''}`}>
      {label && <span className="text-foreground-500">{label}</span>}
      <select
        className="h-9 rounded-xl bg-content2 px-3 outline-none"
        value={selectedKeys ? [...selectedKeys][0] : ''}
        disabled={isDisabled}
        onChange={(event) => onSelectionChange?.({ currentKey: event.target.value })}
      >
        {entries.map((entry) => (
          <option key={entry.key} value={entry.key}>
            {entry.label}
          </option>
        ))}
      </select>
    </label>
  )
}

interface LegacySwitchProps {
  children?: ReactNode
  isSelected?: boolean
  isDisabled?: boolean
  onValueChange?: (selected: boolean) => void
  size?: string
}

export function LegacySwitch({
  children,
  isSelected,
  isDisabled,
  onValueChange
}: LegacySwitchProps): React.JSX.Element {
  return (
    <label className="inline-flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={isSelected}
        disabled={isDisabled}
        onChange={(event) => onValueChange?.(event.target.checked)}
      />
      {children}
    </label>
  )
}

interface LegacyButtonProps {
  children?: ReactNode
  className?: string
  size?: 'sm' | 'md' | 'lg'
  variant?: 'danger' | 'danger-soft' | 'ghost' | 'outline' | 'primary' | 'secondary' | 'tertiary'
  color?: 'default' | 'primary' | 'secondary' | 'success' | 'warning' | 'danger'
  isIconOnly?: boolean
  isDisabled?: boolean
  isLoading?: boolean
  startContent?: ReactNode
  endContent?: ReactNode
  title?: string
  onPress?: () => void
}

export function LegacyButton({
  children,
  color,
  isLoading,
  startContent,
  endContent,
  title: _title,
  ...props
}: LegacyButtonProps): React.JSX.Element {
  return (
    <Button
      {...props}
      data-color={color}
      isPending={isLoading}
      isDisabled={props.isDisabled || isLoading}
    >
      {startContent}
      {children}
      {endContent}
    </Button>
  )
}

interface LegacyChipProps {
  children?: ReactNode
  className?: string
  size?: 'sm' | 'md' | 'lg'
  color?: 'default' | 'primary' | 'secondary' | 'success' | 'warning' | 'danger'
  variant?: 'primary' | 'secondary' | 'tertiary' | 'soft'
  startContent?: ReactNode
  onClose?: () => void
}

export function LegacyChip({
  children,
  color,
  variant,
  startContent,
  onClose,
  ...props
}: LegacyChipProps): React.JSX.Element {
  return (
    <Chip {...props} data-color={color === 'primary' ? 'accent' : color} variant={variant}>
      <Chip.Label>
        {startContent}
        {children}
      </Chip.Label>
      {onClose && (
        <button type="button" className="ml-1" aria-label="移除" onClick={onClose}>
          ×
        </button>
      )}
    </Chip>
  )
}

export function LegacyTooltip({
  children,
  content,
  placement,
  delay = 0,
  isDisabled,
  isOpen,
  onOpenChange
}: LegacyTooltipProps): React.JSX.Element {
  if (isDisabled) return <>{children}</>
  return (
    <Tooltip delay={delay} isOpen={isOpen} onOpenChange={onOpenChange}>
      <Tooltip.Trigger>{children}</Tooltip.Trigger>
      <Tooltip.Content placement={placement}>{content}</Tooltip.Content>
    </Tooltip>
  )
}

interface LegacyCheckboxProps {
  children?: ReactNode
  className?: string
  classNames?: { base?: string; label?: string }
  'aria-label'?: string
  isSelected?: boolean
  isIndeterminate?: boolean
  isDisabled?: boolean
  onValueChange?: (selected: boolean) => void
}

export function LegacyCheckbox({
  children,
  className,
  classNames,
  isSelected,
  isIndeterminate,
  isDisabled,
  onValueChange,
  ...props
}: LegacyCheckboxProps): React.JSX.Element {
  return (
    <Checkbox
      {...props}
      className={[className, classNames?.base].filter(Boolean).join(' ')}
      isSelected={isSelected}
      isIndeterminate={isIndeterminate}
      isDisabled={isDisabled}
      onChange={onValueChange}
    >
      <Checkbox.Content>
        <Checkbox.Control>
          <Checkbox.Indicator />
        </Checkbox.Control>
        {children && <span className={classNames?.label}>{children}</span>}
      </Checkbox.Content>
    </Checkbox>
  )
}

interface LegacyProgressProps {
  'aria-label': string
  value?: number
  color?: 'primary' | 'secondary' | 'success' | 'warning' | 'danger'
  size?: string
  className?: string
  isIndeterminate?: boolean
  label?: ReactNode
  showValueLabel?: boolean
}

export function LegacyProgress({
  value,
  color,
  size: _size,
  isIndeterminate,
  label,
  showValueLabel,
  ...props
}: LegacyProgressProps): React.JSX.Element {
  return (
    <ProgressBar
      {...props}
      value={value ?? 0}
      isIndeterminate={isIndeterminate}
      color={color === 'primary' ? 'accent' : color === 'secondary' ? 'default' : color}
      size="sm"
    >
      {(label || showValueLabel) && (
        <div className="mb-1 flex justify-between text-xs">
          <span>{label}</span>
          {showValueLabel && <span>{Math.round(value ?? 0)}%</span>}
        </div>
      )}
      <ProgressBar.Track>
        <ProgressBar.Fill />
      </ProgressBar.Track>
    </ProgressBar>
  )
}
