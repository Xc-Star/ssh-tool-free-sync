import { Search } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { HostAvatar } from '@/components/HostAvatar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/controls'
import { useItems } from '@/stores/vault'

/** Popover with a searchable host list. */
export function HostPicker({
  children,
  onPick,
  exclude = [],
  align = 'start'
}: {
  children: ReactNode
  onPick: (hostId: string) => void
  exclude?: string[]
  align?: 'start' | 'end' | 'center'
}): React.JSX.Element {
  const hosts = useItems('host')
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const list = useMemo(() => {
    const s = q.trim().toLowerCase()
    return hosts
      .filter((h) => !exclude.includes(h.id))
      .filter((h) => !s || h.data.label.toLowerCase().includes(s) || h.data.address.toLowerCase().includes(s))
      .sort((a, b) => (a.data.label || a.data.address).localeCompare(b.data.label || b.data.address))
  }, [hosts, q, exclude])
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align={align} className="w-72 p-1.5">
        <div className="relative mb-1">
          <Search className="pointer-events-none absolute left-2 top-2 size-3.5 text-subtle" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="h-7 w-full rounded-md bg-input pl-7 pr-2 text-[13px] outline-none"
            placeholder="…"
          />
        </div>
        <div className="max-h-64 overflow-y-auto">
          {list.map((h) => (
            <button
              key={h.id}
              type="button"
              onClick={() => {
                onPick(h.id)
                setOpen(false)
                setQ('')
              }}
              className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-accent-soft"
            >
              <HostAvatar size="sm" osHint={h.data.osHint} label={h.data.label || h.data.address} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px]">{h.data.label || h.data.address}</span>
                <span className="block truncate text-[11px] text-subtle">{h.data.address}</span>
              </span>
            </button>
          ))}
          {list.length === 0 && <div className="px-2 py-4 text-center text-xs text-subtle">—</div>}
        </div>
      </PopoverContent>
    </Popover>
  )
}
