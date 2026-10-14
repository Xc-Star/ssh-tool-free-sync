import { CircleAlert, CircleCheck, Info, Minus, Plus, TriangleAlert } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

/** Title + description at the top of a settings section. */
export function SettingsHeader({
  title,
  description,
  actions
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
}): React.JSX.Element {
  return (
    <header className="mb-7 flex items-start gap-4">
      <div className="min-w-0 flex-1">
        <h1 className="text-[20px] font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-[13px] leading-relaxed text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  )
}

/** Small uppercase group label with an optional action, followed by its content (usually a SettingsCard). */
export function SettingsGroup({
  title,
  description,
  action,
  children,
  className,
  testId
}: {
  title?: ReactNode
  description?: ReactNode
  action?: ReactNode
  children: ReactNode
  className?: string
  testId?: string
}): React.JSX.Element {
  return (
    <section className={cn('mt-8 first:mt-0', className)} data-testid={testId}>
      {(title || action) && (
        <div className="mb-2.5 flex min-h-6 items-end justify-between gap-3 px-1">
          <div className="min-w-0">
            {title && (
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-subtle">{title}</h2>
            )}
            {description && <p className="mt-1 text-xs text-muted">{description}</p>}
          </div>
          {action && <div className="flex shrink-0 items-center gap-1.5">{action}</div>}
        </div>
      )}
      {children}
    </section>
  )
}

export function SettingsCard({
  children,
  className,
  testId
}: {
  children: ReactNode
  className?: string
  testId?: string
}): React.JSX.Element {
  return (
    <div
      className={cn('divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel', className)}
      data-testid={testId}
    >
      {children}
    </div>
  )
}

/** Termius-like row: label + description on the left, control on the right. */
export function SettingsRow({
  label,
  description,
  children,
  icon,
  htmlFor,
  align = 'center',
  disabled,
  className,
  testId
}: {
  label: ReactNode
  description?: ReactNode
  children?: ReactNode
  icon?: ReactNode
  htmlFor?: string
  align?: 'center' | 'start'
  disabled?: boolean
  className?: string
  testId?: string
}): React.JSX.Element {
  return (
    <div
      className={cn('flex gap-4 px-4 py-3.5', align === 'center' ? 'items-center' : 'items-start', className)}
      data-testid={testId}
    >
      {icon && (
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-panel-hover text-muted [&_svg]:size-4">
          {icon}
        </div>
      )}
      <div className={cn('min-w-0 flex-1', disabled && 'opacity-55')}>
        <label htmlFor={htmlFor} className="block text-[13px] font-medium text-fg">
          {label}
        </label>
        {description && <div className="mt-0.5 text-xs leading-relaxed text-muted">{description}</div>}
      </div>
      {children !== undefined && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  )
}

const CALLOUT_TONES = {
  info: { box: 'border-accent/25 bg-accent-soft', icon: 'text-accent', Icon: Info },
  success: { box: 'border-success/30 bg-success/10', icon: 'text-success', Icon: CircleCheck },
  warning: { box: 'border-warning/35 bg-warning/10', icon: 'text-warning', Icon: TriangleAlert },
  danger: { box: 'border-danger/35 bg-danger/10', icon: 'text-danger', Icon: CircleAlert }
}

export function Callout({
  tone = 'info',
  icon,
  title,
  children,
  action,
  className,
  testId
}: {
  tone?: keyof typeof CALLOUT_TONES
  icon?: ReactNode
  title?: ReactNode
  children?: ReactNode
  action?: ReactNode
  className?: string
  testId?: string
}): React.JSX.Element {
  const t = CALLOUT_TONES[tone]
  return (
    <div
      className={cn('flex items-start gap-3 rounded-xl border px-4 py-3', t.box, className)}
      data-testid={testId}
      role={tone === 'danger' ? 'alert' : undefined}
    >
      <span className={cn('mt-px shrink-0 [&_svg]:size-4', t.icon)}>{icon ?? <t.Icon />}</span>
      <div className="min-w-0 flex-1">
        {title && <div className="text-[13px] font-medium text-fg">{title}</div>}
        {children && (
          <div className={cn('text-xs leading-relaxed text-muted', title && 'mt-0.5')}>{children}</div>
        )}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2 self-center">{action}</div>}
    </div>
  )
}

function formatNumber(n: number, step: number): string {
  return step < 1 ? n.toFixed(Math.max(1, String(step).split('.')[1]?.length ?? 1)) : String(n)
}

/**
 * Numeric input with − / + steppers. Typing is kept local and committed (clamped to [min, max]) on blur,
 * Enter or a stepper click, so stores are not written on every keystroke.
 */
export function NumberField({
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
  disabled,
  className,
  inputClassName,
  testId,
  ariaLabel
}: {
  value: number
  onChange: (v: number) => void
  min: number
  max: number
  step?: number
  suffix?: ReactNode
  disabled?: boolean
  className?: string
  inputClassName?: string
  testId?: string
  ariaLabel?: string
}): React.JSX.Element {
  const [text, setText] = useState(formatNumber(value, step))
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    if (!editing) setText(formatNumber(value, step))
  }, [value, step, editing])

  const clampRound = (n: number): number => {
    // Round to the precision of `step` (0.1 → one decimal); integer fields keep any typed integer.
    const decimals = step < 1 ? (String(step).split('.')[1]?.length ?? 1) : 0
    const rounded = Number(n.toFixed(decimals))
    return Math.min(max, Math.max(min, rounded))
  }
  const commit = (raw: string): void => {
    setEditing(false)
    const n = Number(raw.replace(',', '.'))
    if (raw.trim() === '' || !Number.isFinite(n)) {
      setText(formatNumber(value, step))
      return
    }
    const next = clampRound(n)
    setText(formatNumber(next, step))
    if (next !== value) onChange(next)
  }
  const parsed = Number(text.replace(',', '.'))
  // Steppers build on the displayed number so quick repeated clicks do not depend on a slow store round trip.
  const shown = text.trim() !== '' && Number.isFinite(parsed) ? parsed : value
  const bump = (dir: 1 | -1): void => {
    const next = clampRound(shown + dir * step)
    setEditing(false)
    setText(formatNumber(next, step))
    if (next !== value) onChange(next)
  }
  const btn =
    'flex h-full w-7 shrink-0 items-center justify-center text-subtle transition-colors hover:bg-panel-hover hover:text-fg disabled:pointer-events-none disabled:opacity-40'
  return (
    <div
      className={cn(
        'flex h-8 items-stretch overflow-hidden rounded-md border border-line bg-input transition-colors focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20',
        disabled && 'opacity-50',
        className
      )}
    >
      <button
        type="button"
        tabIndex={-1}
        className={btn}
        disabled={disabled || shown <= min}
        onClick={() => bump(-1)}
        aria-label="-"
      >
        <Minus className="size-3.5" />
      </button>
      <input
        value={text}
        disabled={disabled}
        inputMode="decimal"
        spellCheck={false}
        aria-label={ariaLabel}
        data-testid={testId}
        onFocus={(e) => {
          setEditing(true)
          e.currentTarget.select()
        }}
        onChange={(e) => {
          setEditing(true)
          setText(e.target.value)
        }}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit(e.currentTarget.value)
          else if (e.key === 'ArrowUp') {
            e.preventDefault()
            bump(1)
          } else if (e.key === 'ArrowDown') {
            e.preventDefault()
            bump(-1)
          } else if (e.key === 'Escape') {
            setEditing(false)
            setText(formatNumber(value, step))
          }
        }}
        className={cn(
          'w-14 min-w-0 flex-1 bg-transparent text-center text-[13px] tabular-nums text-fg outline-none',
          inputClassName
        )}
      />
      {suffix && <span className="flex items-center pr-1 text-xs text-subtle">{suffix}</span>}
      <button
        type="button"
        tabIndex={-1}
        className={btn}
        disabled={disabled || shown >= max}
        onClick={() => bump(1)}
        aria-label="+"
      >
        <Plus className="size-3.5" />
      </button>
    </div>
  )
}

/** Re-renders every `ms` so relative times ("2 minutes ago") stay fresh. */
export function useNow(ms = 15_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms)
    return () => window.clearInterval(id)
  }, [ms])
  return now
}
