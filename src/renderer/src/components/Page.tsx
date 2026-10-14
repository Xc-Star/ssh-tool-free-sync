import { Search, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function Page({ children, className }: { children: ReactNode; className?: string }): React.JSX.Element {
  return <div className={cn('flex h-full min-h-0 flex-col', className)}>{children}</div>
}

/** Termius-like page header: large search field on the left, primary actions on the right. */
export function PageHeader({
  search,
  onSearch,
  searchPlaceholder,
  actions,
  title,
  onSearchKeyDown,
  searchTestId
}: {
  search?: string
  onSearch?: (v: string) => void
  searchPlaceholder?: string
  actions?: ReactNode
  title?: ReactNode
  onSearchKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void
  searchTestId?: string
}): React.JSX.Element {
  return (
    <div className="flex h-16 shrink-0 items-center gap-3 border-b border-line px-6">
      {title && <h1 className="mr-2 shrink-0 text-[17px] font-semibold">{title}</h1>}
      {onSearch && (
        <div className="relative flex max-w-2xl flex-1 items-center">
          <Search className="pointer-events-none absolute left-3 size-4 text-subtle" />
          <input
            value={search ?? ''}
            onChange={(e) => onSearch(e.target.value)}
            onKeyDown={onSearchKeyDown}
            placeholder={searchPlaceholder}
            spellCheck={false}
            data-testid={searchTestId}
            className="h-10 w-full rounded-lg border border-line bg-input pl-9 pr-8 text-[13.5px] text-fg outline-none placeholder:text-subtle focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
          {search && (
            <button className="absolute right-2 rounded p-1 text-subtle hover:text-fg" onClick={() => onSearch('')}>
              <X className="size-3.5" />
            </button>
          )}
        </div>
      )}
      <div className="flex-1" />
      <div className="flex shrink-0 items-center gap-2">{actions}</div>
    </div>
  )
}

export function PageBody({ children, className }: { children: ReactNode; className?: string }): React.JSX.Element {
  return <div className={cn('min-h-0 flex-1 overflow-y-auto px-6 py-5', className)}>{children}</div>
}

export function CardGrid({ children, className }: { children: ReactNode; className?: string }): React.JSX.Element {
  return <div className={cn('grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3', className)}>{children}</div>
}

/** Standard vault card (host, key, identity, snippet…). */
export function Card({
  icon,
  title,
  subtitle,
  right,
  onClick,
  onDoubleClick,
  selected,
  className,
  children,
  testId,
  ...rest
}: {
  icon?: ReactNode
  title: ReactNode
  subtitle?: ReactNode
  right?: ReactNode
  onClick?: (e: React.MouseEvent) => void
  onDoubleClick?: (e: React.MouseEvent) => void
  selected?: boolean
  className?: string
  children?: ReactNode
  testId?: string
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'title' | 'onClick' | 'onDoubleClick'>): React.JSX.Element {
  return (
    <div
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      data-testid={testId}
      className={cn(
        'group relative flex min-h-[64px] cursor-default items-center gap-3 rounded-xl border bg-panel px-3.5 py-3 transition-colors',
        selected ? 'border-accent bg-accent-soft' : 'border-transparent hover:border-line hover:bg-panel-hover',
        className
      )}
      {...rest}
    >
      {icon}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13.5px] font-semibold">{title}</div>
        {subtitle && <div className="mt-0.5 truncate text-xs text-muted">{subtitle}</div>}
        {children}
      </div>
      {right}
    </div>
  )
}
