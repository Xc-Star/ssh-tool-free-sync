import { Loader2 } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function Badge({ className, tone = 'neutral', ...props }: ComponentProps<'span'> & { tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' }): React.JSX.Element {
  const tones = {
    neutral: 'bg-panel-hover text-muted border-line',
    accent: 'bg-accent-soft text-accent border-transparent',
    success: 'bg-success/12 text-success border-transparent',
    warning: 'bg-warning/12 text-warning border-transparent',
    danger: 'bg-danger/12 text-danger border-transparent'
  }
  return <span className={cn('inline-flex h-5 items-center gap-1 rounded border px-1.5 text-[11px] font-medium', tones[tone], className)} {...props} />
}

export function Spinner({ className }: { className?: string }): React.JSX.Element {
  return <Loader2 className={cn('size-4 animate-spin text-muted', className)} />
}

export function Separator({ className, vertical }: { className?: string; vertical?: boolean }): React.JSX.Element {
  return <div className={cn(vertical ? 'mx-1 h-5 w-px' : 'my-1 h-px w-full', 'bg-line', className)} />
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className
}: {
  icon?: ReactNode
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-3 px-6 py-16 text-center', className)}>
      {icon && <div className="flex size-14 items-center justify-center rounded-2xl bg-accent-soft text-accent [&_svg]:size-7">{icon}</div>}
      <div className="text-[15px] font-semibold">{title}</div>
      {description && <div className="max-w-sm text-xs leading-relaxed text-muted">{description}</div>}
      {action}
    </div>
  )
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
  size = 'md'
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: ReactNode; icon?: ReactNode }[]
  className?: string
  size?: 'sm' | 'md'
}): React.JSX.Element {
  return (
    <div className={cn('inline-flex rounded-lg border border-line bg-input p-0.5', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            'flex items-center justify-center gap-1.5 rounded-md px-3 font-medium transition-colors [&_svg]:size-3.5',
            size === 'sm' ? 'h-6 text-xs' : 'h-7 text-[13px]',
            value === o.value ? 'bg-panel-hover text-fg shadow-sm' : 'text-muted hover:text-fg'
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Kbd({ children }: { children: ReactNode }): React.JSX.Element {
  return <kbd className="rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-[11px] text-muted">{children}</kbd>
}

export function SectionTitle({ children, right, className }: { children: ReactNode; right?: ReactNode; className?: string }): React.JSX.Element {
  return (
    <div className={cn('mb-3 mt-6 flex items-center justify-between first:mt-0', className)}>
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-subtle">{children}</h2>
      {right}
    </div>
  )
}

export function ProgressBar({ value, className, tone = 'accent' }: { value: number; className?: string; tone?: 'accent' | 'success' | 'danger' }): React.JSX.Element {
  const colors = { accent: 'bg-accent', success: 'bg-success', danger: 'bg-danger' }
  return (
    <div className={cn('h-1 w-full overflow-hidden rounded-full bg-line', className)}>
      <div className={cn('h-full rounded-full transition-[width] duration-300', colors[tone])} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  )
}
