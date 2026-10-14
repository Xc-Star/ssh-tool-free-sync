import { Command } from 'cmdk'
import { Check, ChevronsUpDown, Search, TriangleAlert } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { HostAvatar } from '@/components/HostAvatar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/controls'
import { cn } from '@/lib/utils'
import { useItems } from '@/stores/vault'
import { hostName, hostTarget } from './format'

/** Searchable host combobox (works inside sheets: the popover is modal so its list can scroll). */
export function HostPicker({
  value,
  onChange,
  invalid,
  id,
  testId
}: {
  value: string | undefined
  onChange: (hostId: string) => void
  invalid?: boolean
  id?: string
  testId?: string
}): React.JSX.Element {
  const { t } = useTranslation('forwarding')
  const hosts = useItems('host')
  const [open, setOpen] = useState(false)
  const selected = hosts.find((h) => h.id === value)
  const sorted = useMemo(
    () =>
      hosts
        .filter((h) => h.data.sshEnabled !== false || h.id === value)
        .sort((a, b) => hostName(a).localeCompare(hostName(b))),
    [hosts, value]
  )

  return (
    <Popover open={open} onOpenChange={setOpen} modal>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          data-testid={testId}
          aria-invalid={invalid || undefined}
          className={cn(
            'flex h-10 w-full items-center gap-2.5 rounded-md border bg-input px-2 text-left text-[13px] text-fg outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20',
            invalid ? 'border-danger' : 'border-line',
            open && 'border-accent ring-2 ring-accent/20'
          )}
        >
          {selected ? (
            <>
              <HostAvatar size="sm" osHint={selected.data.osHint} label={hostName(selected)} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium leading-tight">{hostName(selected)}</span>
                <span className="block truncate text-[11px] leading-tight text-muted">
                  {hostTarget(selected)}
                </span>
              </span>
            </>
          ) : value ? (
            <span className="flex flex-1 items-center gap-1.5 truncate pl-0.5 font-medium text-warning">
              <TriangleAlert className="size-4 shrink-0" />
              {t('missingHost')}
            </span>
          ) : (
            <span className="flex-1 truncate pl-0.5 text-subtle">{t('hostPlaceholder')}</span>
          )}
          <ChevronsUpDown className="size-4 shrink-0 text-subtle" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[var(--radix-popover-trigger-width)] min-w-[260px] overflow-hidden p-0"
        align="start"
      >
        <Command loop className="flex flex-col">
          <div className="flex items-center gap-2 border-b border-line px-3">
            <Search className="size-4 shrink-0 text-subtle" />
            <Command.Input
              placeholder={t('hostSearch')}
              className="h-9 min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-subtle"
            />
          </div>
          <Command.List className="max-h-64 overflow-y-auto p-1">
            <Command.Empty className="px-3 py-6 text-center text-xs text-subtle">
              {sorted.length ? t('noHostsMatch') : t('noHosts')}
            </Command.Empty>
            {sorted.map((h) => (
              <Command.Item
                key={h.id}
                value={`${hostName(h)} ${h.data.address} ${h.data.username ?? ''} ${h.id}`}
                onSelect={() => {
                  onChange(h.id)
                  setOpen(false)
                }}
                className="flex h-10 cursor-default items-center gap-2.5 rounded-md px-2 text-[13px] data-[selected=true]:bg-accent-soft"
              >
                <HostAvatar size="sm" osHint={h.data.osHint} label={hostName(h)} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium leading-tight">{hostName(h)}</div>
                  <div className="truncate text-[11px] leading-tight text-muted">{hostTarget(h)}</div>
                </div>
                {h.id === value && <Check className="size-4 shrink-0 text-accent" />}
              </Command.Item>
            ))}
          </Command.List>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
