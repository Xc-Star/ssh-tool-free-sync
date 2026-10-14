import { Command } from 'cmdk'
import { Check, ChevronDown, ChevronRight, HardDrive, LoaderCircle, Plus, Search, Server, Unplug } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Item } from '@shared/schemas'
import { HostAvatar } from '@/components/HostAvatar'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/controls'
import { Input } from '@/components/ui/input'
import { EmptyState } from '@/components/ui/misc'
import { cn } from '@/lib/utils'
import { openEditor } from '@/stores/ui'
import { useItem, useItems } from '@/stores/vault'
import { switchSource } from './actions'
import { SourceAvatar } from './icons'
import type { PaneId, PaneState } from './store'
import { hostSubtitle, hostTitle } from './utils'

/** Hosts usable for SFTP (SSH enabled), sorted by title. */
function useSortedHosts(): Item<'host'>[] {
  const hosts = useItems('host')
  return useMemo(
    () =>
      hosts
        .filter((h) => h.data.sshEnabled !== false)
        .sort((a, b) => hostTitle(a.data).localeCompare(hostTitle(b.data), undefined, { numeric: true, sensitivity: 'base' })),
    [hosts]
  )
}

function matches(h: Item<'host'>, q: string): boolean {
  if (!q) return true
  const s = q.toLowerCase()
  return [h.data.label, h.data.address, h.data.username ?? ''].some((x) => x.toLowerCase().includes(s))
}

/** Title of the pane's current source. */
export function useSourceTitle(pane: PaneState): string {
  const { t } = useTranslation('sftp')
  const host = useItem('host', pane.source.kind === 'host' ? pane.source.hostId : undefined)
  if (pane.source.kind === 'none') return t('selectHost')
  if (pane.source.kind === 'local') return t('local')
  return host ? hostTitle(host.data) : (pane.fs?.label ?? t('unknownHost'))
}

const itemClass =
  'flex h-9 cursor-default items-center gap-2.5 rounded-md px-2 text-[13px] text-fg outline-none data-[selected=true]:bg-accent-soft [&>svg]:size-4 [&>svg]:shrink-0'

/** Pane header dropdown: Local / hosts (searchable) / Disconnect. */
export function SourceSwitcher({ paneId, pane }: { paneId: PaneId; pane: PaneState }): React.JSX.Element {
  const { t } = useTranslation('sftp')
  const hosts = useSortedHosts()
  const [open, setOpen] = useState(false)
  const title = useSourceTitle(pane)
  const src = pane.source

  const choose = (fn: () => Promise<void>): void => {
    setOpen(false)
    void fn()
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid={`sftp-source-${paneId}`}
          className="flex h-8 min-w-0 max-w-[60%] shrink items-center gap-2 rounded-md pl-1 pr-1.5 text-[13px] font-semibold transition-colors hover:bg-panel-hover data-[state=open]:bg-panel-hover"
        >
          {src.kind === 'none' ? (
            <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-dashed border-line-strong text-subtle">
              <Server className="size-3.5" />
            </span>
          ) : (
            <SourceAvatar source={src} />
          )}
          <span className={cn('truncate', src.kind === 'none' && 'text-muted')}>{title}</span>
          {pane.status === 'connecting' && <LoaderCircle className="size-3.5 shrink-0 animate-spin text-muted" />}
          {pane.status === 'error' && <span className="size-1.5 shrink-0 rounded-full bg-danger" />}
          {pane.status === 'ready' && src.kind === 'host' && <span className="size-1.5 shrink-0 rounded-full bg-success" />}
          <ChevronDown className="size-3.5 shrink-0 text-subtle" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[300px] p-0" align="start">
        <Command loop>
          <div className="flex items-center gap-2 border-b border-line px-3">
            <Search className="size-4 shrink-0 text-subtle" />
            <Command.Input placeholder={t('searchHosts')} className="h-10 min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-subtle" />
          </div>
          <Command.List className="max-h-[340px] overflow-y-auto p-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-subtle">
            <Command.Empty className="px-3 py-6 text-center text-xs text-subtle">{t('noHostsFound')}</Command.Empty>
            <Command.Item value={`local ${t('local')} ${t('localFiles')}`} onSelect={() => choose(() => switchSource(paneId, { kind: 'local' }))} className={itemClass}>
              <SourceAvatar source={{ kind: 'local' }} />
              <span className="min-w-0 flex-1 truncate">{t('localFiles')}</span>
              {src.kind === 'local' && <Check className="text-accent" />}
            </Command.Item>
            {hosts.length > 0 && (
              <Command.Group heading={t('hosts')}>
                {hosts.map((h) => (
                  <Command.Item
                    key={h.id}
                    value={`${h.data.label} ${h.data.address} ${h.data.username ?? ''} ${h.id}`}
                    onSelect={() => choose(() => switchSource(paneId, { kind: 'host', hostId: h.id }))}
                    className={cn(itemClass, 'h-11')}
                  >
                    <HostAvatar size="sm" osHint={h.data.osHint} label={hostTitle(h.data)} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate">{hostTitle(h.data)}</div>
                      <div className="truncate text-[11px] text-muted">{hostSubtitle(h.data)}</div>
                    </div>
                    {src.kind === 'host' && src.hostId === h.id && <Check className="text-accent" />}
                  </Command.Item>
                ))}
              </Command.Group>
            )}
            {src.kind === 'host' && (
              <>
                <Command.Separator alwaysRender className="my-1 h-px bg-line" />
                <Command.Item
                  value="__disconnect"
                  forceMount
                  onSelect={() => choose(() => switchSource(paneId, { kind: 'none' }))}
                  className={cn(itemClass, 'text-danger')}
                  data-testid="sftp-disconnect"
                >
                  <Unplug />
                  {t('disconnect')}
                </Command.Item>
              </>
            )}
          </Command.List>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/** Empty pane: searchable host list (Termius "select host" screen). */
export function HostPicker({ paneId }: { paneId: PaneId }): React.JSX.Element {
  const { t } = useTranslation('sftp')
  const hosts = useSortedHosts()
  const [q, setQ] = useState('')
  const list = useMemo(() => hosts.filter((h) => matches(h, q.trim())), [hosts, q])

  if (!hosts.length) {
    return (
      <div data-testid="sftp-host-picker" className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto">
        <EmptyState
          icon={<Server />}
          title={t('noHostsTitle')}
          description={t('noHostsDescription')}
          action={
            <div className="mt-1 flex items-center gap-2">
              <Button size="sm" variant="primary" onClick={() => openEditor('host')}>
                <Plus />
                {t('newHost')}
              </Button>
              <Button size="sm" onClick={() => void switchSource(paneId, { kind: 'local' })}>
                <HardDrive />
                {t('browseLocal')}
              </Button>
            </div>
          }
        />
      </div>
    )
  }

  return (
    <div data-testid="sftp-host-picker" className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-5 pb-6 pt-10">
      <div className="flex w-full max-w-[400px] flex-col items-center">
        <div className="flex size-12 items-center justify-center rounded-2xl bg-accent-soft text-accent">
          <Server className="size-6" />
        </div>
        <div className="mt-3 text-[15px] font-semibold">{t('pickHostTitle')}</div>
        <div className="mt-1 max-w-[340px] text-center text-xs leading-relaxed text-muted">{t('pickHostDescription')}</div>
        <Input
          icon={<Search />}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && list[0]) void switchSource(paneId, { kind: 'host', hostId: list[0].id })
          }}
          placeholder={t('searchHosts')}
          className="mt-5 w-full"
          data-testid="sftp-host-search"
        />
        <div className="mt-2 flex w-full flex-col gap-0.5">
          {list.map((h) => (
            <button
              key={h.id}
              type="button"
              onClick={() => void switchSource(paneId, { kind: 'host', hostId: h.id })}
              className="group flex h-12 w-full items-center gap-3 rounded-lg px-2.5 text-left transition-colors hover:bg-panel-hover"
              data-testid="sftp-host-option"
            >
              <HostAvatar osHint={h.data.osHint} label={hostTitle(h.data)} className="size-8" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{hostTitle(h.data)}</div>
                <div className="truncate text-xs text-muted">{hostSubtitle(h.data)}</div>
              </div>
              <ChevronRight className="size-4 shrink-0 text-subtle opacity-0 transition-opacity group-hover:opacity-100" />
            </button>
          ))}
          {!list.length && <div className="py-6 text-center text-xs text-subtle">{t('noHostsFound')}</div>}
        </div>
        <button
          type="button"
          onClick={() => void switchSource(paneId, { kind: 'local' })}
          className="mt-4 flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted transition-colors hover:bg-panel-hover hover:text-fg"
        >
          <HardDrive className="size-3.5" />
          {t('browseLocal')}
        </button>
      </div>
    </div>
  )
}
