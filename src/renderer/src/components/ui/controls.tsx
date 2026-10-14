import { Check, ChevronDown, ChevronRight, Circle, Minus } from 'lucide-react'
import { Checkbox as CheckboxPrimitive, ContextMenu as CM, DropdownMenu as DM, Popover as PopoverPrimitive, Select as SelectPrimitive, Switch as SwitchPrimitive, Tooltip as TooltipPrimitive } from 'radix-ui'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from '@/lib/utils'

// ------------------------------------------------------------------ switch / checkbox

export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>): React.JSX.Element {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'peer inline-flex h-[18px] w-8 shrink-0 items-center rounded-full border border-transparent bg-line-strong transition-colors data-[state=checked]:bg-accent disabled:opacity-50',
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="pointer-events-none block size-3.5 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[15px]" />
    </SwitchPrimitive.Root>
  )
}

/** Pass `checked="indeterminate"` for a "some selected" state (drawn as a dash). */
export function Checkbox({ className, checked, ...props }: ComponentProps<typeof CheckboxPrimitive.Root>): React.JSX.Element {
  return (
    <CheckboxPrimitive.Root
      checked={checked}
      className={cn(
        'flex size-4 shrink-0 items-center justify-center rounded border border-line-strong bg-input data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=indeterminate]:border-accent data-[state=indeterminate]:bg-accent disabled:opacity-50',
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator>
        {checked === 'indeterminate' ? (
          <Minus className="size-3 text-white" strokeWidth={3} />
        ) : (
          <Check className="size-3 text-white" strokeWidth={3} />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

// ------------------------------------------------------------------ select

export interface SelectOption {
  value: string
  label: ReactNode
  hint?: ReactNode
  disabled?: boolean
}

const EMPTY = '__empty__'

export function Select({
  value,
  onChange,
  options,
  placeholder,
  className,
  disabled,
  allowEmpty,
  emptyLabel
}: {
  value: string | undefined
  onChange: (v: string | undefined) => void
  options: SelectOption[]
  placeholder?: string
  className?: string
  disabled?: boolean
  allowEmpty?: boolean
  emptyLabel?: ReactNode
}): React.JSX.Element {
  return (
    <SelectPrimitive.Root
      value={value === undefined || value === '' ? (allowEmpty ? EMPTY : undefined) : value}
      onValueChange={(v) => onChange(v === EMPTY ? undefined : v)}
      disabled={disabled}
    >
      <SelectPrimitive.Trigger
        className={cn(
          'flex h-8 w-full items-center justify-between gap-2 rounded-md border border-line bg-input px-2.5 text-left text-[13px] text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:opacity-50 data-[placeholder]:text-subtle',
          className
        )}
      >
        <span className="truncate">
          <SelectPrimitive.Value placeholder={placeholder} />
        </span>
        <SelectPrimitive.Icon>
          <ChevronDown className="size-4 text-subtle" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={4}
          className="z-50 max-h-[min(360px,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg border border-line bg-elevated p-1 shadow-pop animate-fade-in"
        >
          <SelectPrimitive.Viewport>
            {allowEmpty && (
              <SelectItem value={EMPTY}>
                <span className="text-muted">{emptyLabel ?? '—'}</span>
              </SelectItem>
            )}
            {options.map((o) => (
              <SelectItem key={o.value} value={o.value} disabled={o.disabled}>
                <span className="flex items-center gap-2">
                  {o.label}
                  {o.hint && <span className="text-xs text-subtle">{o.hint}</span>}
                </span>
              </SelectItem>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  )
}

function SelectItem({ children, ...props }: ComponentProps<typeof SelectPrimitive.Item>): React.JSX.Element {
  return (
    <SelectPrimitive.Item
      className="relative flex h-8 cursor-default items-center rounded-md pl-7 pr-2 text-[13px] text-fg outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-accent-soft"
      {...props}
    >
      <SelectPrimitive.ItemIndicator className="absolute left-2">
        <Check className="size-3.5 text-accent" />
      </SelectPrimitive.ItemIndicator>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  )
}

// ------------------------------------------------------------------ menus (dropdown + context share styles)

const menuContent = 'z-50 min-w-[180px] overflow-hidden rounded-lg border border-line bg-elevated p-1 text-[13px] text-fg shadow-pop animate-fade-in'
const menuItem =
  'relative flex h-8 cursor-default select-none items-center gap-2 rounded-md px-2 outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-accent-soft [&_svg]:size-4 [&_svg]:text-muted'

export const DropdownMenu = DM.Root
export const DropdownMenuTrigger = DM.Trigger
export function DropdownMenuContent({ className, sideOffset = 4, ...props }: ComponentProps<typeof DM.Content>): React.JSX.Element {
  return (
    <DM.Portal>
      <DM.Content sideOffset={sideOffset} className={cn(menuContent, className)} {...props} />
    </DM.Portal>
  )
}
export function DropdownMenuItem({ className, danger, ...props }: ComponentProps<typeof DM.Item> & { danger?: boolean }): React.JSX.Element {
  return <DM.Item className={cn(menuItem, danger && 'text-danger [&_svg]:text-danger', className)} {...props} />
}
export function DropdownMenuCheckboxItem({ className, children, ...props }: ComponentProps<typeof DM.CheckboxItem>): React.JSX.Element {
  return (
    <DM.CheckboxItem className={cn(menuItem, 'pl-7', className)} {...props}>
      <DM.ItemIndicator className="absolute left-2">
        <Check className="size-3.5 !text-accent" />
      </DM.ItemIndicator>
      {children}
    </DM.CheckboxItem>
  )
}
export function DropdownMenuRadioItem({ className, children, ...props }: ComponentProps<typeof DM.RadioItem>): React.JSX.Element {
  return (
    <DM.RadioItem className={cn(menuItem, 'pl-7', className)} {...props}>
      <DM.ItemIndicator className="absolute left-2.5">
        <Circle className="size-2 fill-accent !text-accent" />
      </DM.ItemIndicator>
      {children}
    </DM.RadioItem>
  )
}
export const DropdownMenuRadioGroup = DM.RadioGroup
export function DropdownMenuSeparator(): React.JSX.Element {
  return <DM.Separator className="my-1 h-px bg-line" />
}
export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof DM.Label>): React.JSX.Element {
  return <DM.Label className={cn('px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-subtle', className)} {...props} />
}
export const DropdownMenuSub = DM.Sub
export function DropdownMenuSubTrigger({ className, children, ...props }: ComponentProps<typeof DM.SubTrigger>): React.JSX.Element {
  return (
    <DM.SubTrigger className={cn(menuItem, 'data-[state=open]:bg-accent-soft', className)} {...props}>
      {children}
      <ChevronRight className="ml-auto" />
    </DM.SubTrigger>
  )
}
export function DropdownMenuSubContent({ className, ...props }: ComponentProps<typeof DM.SubContent>): React.JSX.Element {
  return (
    <DM.Portal>
      <DM.SubContent className={cn(menuContent, 'max-h-[320px] overflow-y-auto', className)} {...props} />
    </DM.Portal>
  )
}

export const ContextMenu = CM.Root
export const ContextMenuTrigger = CM.Trigger
export function ContextMenuContent({ className, ...props }: ComponentProps<typeof CM.Content>): React.JSX.Element {
  return (
    <CM.Portal>
      <CM.Content className={cn(menuContent, className)} {...props} />
    </CM.Portal>
  )
}
export function ContextMenuItem({ className, danger, ...props }: ComponentProps<typeof CM.Item> & { danger?: boolean }): React.JSX.Element {
  return <CM.Item className={cn(menuItem, danger && 'text-danger [&_svg]:text-danger', className)} {...props} />
}
export function ContextMenuSeparator(): React.JSX.Element {
  return <CM.Separator className="my-1 h-px bg-line" />
}
export const ContextMenuSub = CM.Sub
export function ContextMenuSubTrigger({ className, children, ...props }: ComponentProps<typeof CM.SubTrigger>): React.JSX.Element {
  return (
    <CM.SubTrigger className={cn(menuItem, 'data-[state=open]:bg-accent-soft', className)} {...props}>
      {children}
      <ChevronRight className="ml-auto" />
    </CM.SubTrigger>
  )
}
export function ContextMenuSubContent({ className, ...props }: ComponentProps<typeof CM.SubContent>): React.JSX.Element {
  return (
    <CM.Portal>
      <CM.SubContent className={cn(menuContent, 'max-h-[320px] overflow-y-auto', className)} {...props} />
    </CM.Portal>
  )
}

// ------------------------------------------------------------------ tooltip / popover

export function TooltipProvider({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <TooltipPrimitive.Provider delayDuration={400} skipDelayDuration={200}>
      {children}
    </TooltipPrimitive.Provider>
  )
}

export function Tip({ content, children, side = 'bottom' }: { content: ReactNode; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }): React.JSX.Element {
  if (!content) return <>{children}</>
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className="z-[60] max-w-xs rounded-md border border-line bg-elevated px-2 py-1 text-xs text-fg shadow-pop animate-fade-in"
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}

export const Popover = PopoverPrimitive.Root
export const PopoverTrigger = PopoverPrimitive.Trigger
export const PopoverAnchor = PopoverPrimitive.Anchor
export function PopoverContent({ className, sideOffset = 6, align = 'start', ...props }: ComponentProps<typeof PopoverPrimitive.Content>): React.JSX.Element {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        sideOffset={sideOffset}
        align={align}
        className={cn('z-50 rounded-lg border border-line bg-elevated p-3 text-fg shadow-pop outline-none animate-fade-in', className)}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}
