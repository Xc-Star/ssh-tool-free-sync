import { X } from 'lucide-react'
import { Dialog as D } from 'radix-ui'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from '@/lib/utils'

export const Dialog = D.Root
export const DialogTrigger = D.Trigger
export const DialogClose = D.Close

export function DialogContent({
  className,
  children,
  title,
  description,
  hideClose,
  width = 'max-w-md',
  ...props
}: Omit<ComponentProps<typeof D.Content>, 'title'> & { title?: ReactNode; description?: ReactNode; hideClose?: boolean; width?: string }): React.JSX.Element {
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-50 bg-overlay backdrop-blur-[1px] animate-fade-in" />
      <D.Content
        className={cn(
          'fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[calc(100vw-48px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-line bg-elevated text-fg shadow-pop outline-none animate-fade-in',
          width,
          className
        )}
        aria-describedby={description ? undefined : undefined}
        {...props}
      >
        {(title || !hideClose) && (
          <div className="flex items-start gap-3 px-5 pb-2 pt-4">
            <div className="min-w-0 flex-1">
              {title ? <D.Title className="text-[15px] font-semibold">{title}</D.Title> : <D.Title className="sr-only">dialog</D.Title>}
              {description ? (
                <D.Description className="mt-1 text-xs leading-relaxed text-muted">{description}</D.Description>
              ) : (
                <D.Description className="sr-only">dialog</D.Description>
              )}
            </div>
            {!hideClose && (
              <D.Close className="-mr-1 rounded-md p-1 text-subtle hover:bg-panel-hover hover:text-fg">
                <X className="size-4" />
              </D.Close>
            )}
          </div>
        )}
        {children}
      </D.Content>
    </D.Portal>
  )
}

export function DialogBody({ className, ...props }: ComponentProps<'div'>): React.JSX.Element {
  return <div className={cn('min-h-0 flex-1 overflow-y-auto px-5 py-2', className)} {...props} />
}

export function DialogFooter({ className, ...props }: ComponentProps<'div'>): React.JSX.Element {
  return <div className={cn('flex items-center justify-end gap-2 px-5 pb-4 pt-3', className)} {...props} />
}

/** Right-side slide-in panel (Termius style editor drawer). */
export function Sheet({
  open,
  onOpenChange,
  title,
  subtitle,
  children,
  footer,
  actions,
  width = 'w-[440px]'
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  subtitle?: ReactNode
  children: ReactNode
  footer?: ReactNode
  actions?: ReactNode
  width?: string
}): React.JSX.Element {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 top-10 z-40 bg-overlay/40" />
        <D.Content
          className={cn(
            'fixed bottom-0 right-0 top-10 z-40 flex max-w-[calc(100vw-60px)] flex-col border-l border-line bg-elevated text-fg shadow-pop outline-none animate-slide-in',
            width
          )}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4">
            <div className="min-w-0 flex-1">
              <D.Title className="truncate text-[15px] font-semibold">{title}</D.Title>
              <D.Description className={cn('truncate text-xs text-muted', !subtitle && 'sr-only')}>{subtitle ?? 'editor'}</D.Description>
            </div>
            {actions}
            <D.Close className="rounded-md p-1.5 text-subtle hover:bg-panel-hover hover:text-fg">
              <X className="size-4" />
            </D.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
          {footer && <div className="flex shrink-0 items-center gap-2 border-t border-line px-4 py-3">{footer}</div>}
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}

export function SheetSection({ title, children, className, right }: { title?: ReactNode; children: ReactNode; className?: string; right?: ReactNode }): React.JSX.Element {
  return (
    <section className={cn('border-b border-line px-4 py-4 last:border-b-0', className)}>
      {(title || right) && (
        <div className="mb-3 flex items-center justify-between">
          {title && <h3 className="text-[11px] font-semibold uppercase tracking-wider text-subtle">{title}</h3>}
          {right}
        </div>
      )}
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  )
}
