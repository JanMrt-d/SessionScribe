import type { ButtonHTMLAttributes, ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import * as Select from '@radix-ui/react-select'
import * as Tooltip from '@radix-ui/react-tooltip'
import { Check, ChevronDown, X } from 'lucide-react'

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'default' | 'small' | 'icon'
}

export function Button({
  variant = 'secondary',
  size = 'default',
  className = '',
  type = 'button',
  ...props
}: ButtonProps): React.JSX.Element {
  return (
    <button
      type={type}
      className={`button button--${variant} button--${size} ${className}`.trim()}
      {...props}
    />
  )
}

export function IconButton({
  label,
  children,
  ...props
}: ButtonProps & { label: string; children: ReactNode }): React.JSX.Element {
  return (
    <Tooltip.Provider delayDuration={400}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <Button size="icon" aria-label={label} {...props}>
            {children}
          </Button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className="tooltip" sideOffset={7}>
            {label}
            <Tooltip.Arrow className="tooltip__arrow" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  )
}

interface ModalProps {
  open: boolean
  onOpenChange(open: boolean): void
  title: string
  description?: string
  children: ReactNode
  size?: 'default' | 'wide'
}

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  size = 'default'
}: ModalProps): React.JSX.Element {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className={`dialog-content dialog-content--${size}`}>
          <div className="dialog-heading">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              {description ? <Dialog.Description>{description}</Dialog.Description> : null}
            </div>
            <Dialog.Close asChild>
              <IconButton label="Close" variant="ghost">
                <X size={18} />
              </IconButton>
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

interface SelectFieldProps {
  label: string
  value: string
  onValueChange(value: string): void
  options: Array<{ value: string; label: string; disabled?: boolean }>
  placeholder?: string
  disabled?: boolean
  id?: string
}

export function SelectField({
  label,
  value,
  onValueChange,
  options,
  placeholder = 'Select an option',
  disabled,
  id
}: SelectFieldProps): React.JSX.Element {
  const controlId = id ?? `select-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  return (
    <label className="field" htmlFor={controlId}>
      <span className="field__label">{label}</span>
      <Select.Root
        value={value}
        {...(disabled === undefined ? {} : { disabled })}
        onValueChange={onValueChange}
      >
        <Select.Trigger className="select-trigger" id={controlId} aria-label={label}>
          <Select.Value placeholder={placeholder} />
          <Select.Icon>
            <ChevronDown size={16} />
          </Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Content className="select-content" position="popper" sideOffset={5}>
            <Select.Viewport>
              {options.map((option) => (
                <Select.Item
                  className="select-item"
                  value={option.value}
                  {...(option.disabled === undefined ? {} : { disabled: option.disabled })}
                  key={option.value}
                >
                  <Select.ItemText>{option.label}</Select.ItemText>
                  <Select.ItemIndicator>
                    <Check size={15} />
                  </Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.Viewport>
          </Select.Content>
        </Select.Portal>
      </Select.Root>
    </label>
  )
}

export function SegmentedControl<T extends string>({
  label,
  value,
  onChange,
  options
}: {
  label: string
  value: T
  onChange(value: T): void
  options: Array<{ value: T; label: string; icon?: ReactNode }>
}): React.JSX.Element {
  return (
    <fieldset className="segmented-field">
      <legend>{label}</legend>
      <div className="segmented-control">
        {options.map((option) => (
          <button
            type="button"
            className={value === option.value ? 'is-selected' : ''}
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
            key={option.value}
          >
            {option.icon}
            {option.label}
          </button>
        ))}
      </div>
    </fieldset>
  )
}

export function InlineNotice({
  tone = 'neutral',
  icon,
  children,
  actions
}: {
  tone?: 'neutral' | 'success' | 'warning' | 'danger'
  icon?: ReactNode
  children: ReactNode
  actions?: ReactNode
}): React.JSX.Element {
  return (
    <div
      className={`inline-notice inline-notice--${tone}`}
      role={tone === 'danger' ? 'alert' : 'status'}
    >
      {icon ? <span className="inline-notice__icon">{icon}</span> : null}
      <div className="inline-notice__body">{children}</div>
      {actions ? <div className="inline-notice__actions">{actions}</div> : null}
    </div>
  )
}

export function EmptyState({
  icon,
  title,
  description,
  actions
}: {
  icon: ReactNode
  title: string
  description: string
  actions?: ReactNode
}): React.JSX.Element {
  return (
    <div className="empty-state">
      <div className="empty-state__icon">{icon}</div>
      <h2>{title}</h2>
      <p>{description}</p>
      {actions ? <div className="empty-state__actions">{actions}</div> : null}
    </div>
  )
}
