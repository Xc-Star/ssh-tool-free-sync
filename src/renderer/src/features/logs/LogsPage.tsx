import {
  CircleCheck,
  CircleDot,
  CircleX,
  Copy,
  History,
  Pencil,
  RotateCw,
  Server,
  Trash2,
  TriangleAlert
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { HistoryEntry } from '@shared/types'
import { formatDuration } from '@shared/util'
import { HostAvatar } from '@/components/HostAvatar'
import { Page, PageBody, PageHeader } from '@/components/Page'
import { Button } from '@/components/ui/button'
import { confirm } from '@/components/ui/confirm'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  Tip
} from '@/components/ui/controls'
import { Badge, EmptyState, Segmented, Spinner } from '@/components/ui/misc'
import { call, errorMessage, on } from '@/lib/api'
import { cn, copyText, formatDate } from '@/lib/utils'
import { useApp } from '@/stores/app'
import { openHost, openTab } from '@/stores/tabs'
import { openEditor, useUi } from '@/stores/ui'
import { getItem, useItems } from '@/stores/vault'

type Filter = 'all' | 'failed'

/** Splits `host:port` / `[v6]:port` as written by the session layer. */
function splitAddress(addr: string): { address: string; port?: number } {
  const bracket = /^\[(.+)\]:(\d+)$/.exec(addr)
  if (bracket) return { address: bracket[1], port: Number(bracket[2]) }
  const i = addr.lastIndexOf(':')
  if (i > 0 && /^\d+$/.test(addr.slice(i + 1)))
    return { address: addr.slice(0, i), port: Number(addr.slice(i + 1)) }
  return { address: addr }
}

function dayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

async function connectAgain(e: HistoryEntry): Promise<void> {
  const host = e.hostId ? getItem('host', e.hostId) : undefined
  if (host) {
    await openHost(host.id, e.protocol === 'telnet' ? 'telnet' : 'ssh')
    return
  }
  const { address, port } = splitAddress(e.address)
  const label = e.label || undefined
  switch (e.protocol) {
    case 'telnet':
      await openTab({ kind: 'telnet', inline: { address, port, label } })
      return
    case 'local':
      await openTab({ kind: 'local' })
      return
    case 'serial':
      useUi.setState({ serialDialogOpen: true })
      return
    default:
      await openTab({ kind: 'ssh', inline: { address, port, username: e.username, label } })
  }
}

export function LogsPage(): React.JSX.Element {
  const { t, i18n } = useTranslation('logs')
  const { t: tc } = useTranslation()
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  // Re-render when hosts change so avatars / "deleted host" hints stay current.
  useItems('host')

  useEffect(() => {
    let alive = true
    let timer: number | undefined
    const load = (): void => {
      call('history.list', 500)
        .then((list) => alive && setEntries(list))
        .catch(() => alive && setEntries((cur) => cur ?? []))
    }
    load()
    const off = on('history.changed', () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(load, 150)
    })
    return () => {
      alive = false
      window.clearTimeout(timer)
      off()
    }
  }, [])

  const failedCount = useMemo(() => (entries ?? []).filter((e) => e.status === 'failed').length, [entries])

  const groups = useMemo(() => {
    const q = search.trim().toLowerCase()
    const list = (entries ?? []).filter(
      (e) =>
        (filter === 'all' || e.status === 'failed') &&
        (!q ||
          [e.label, e.address, e.username, e.protocol, e.error].some((s) => s && s.toLowerCase().includes(q)))
    )
    const now = new Date()
    const today = dayKey(now.getTime())
    const yesterday = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime())
    const out: { key: string; label: string; items: HistoryEntry[] }[] = []
    for (const e of list) {
      const key = dayKey(e.startedAt)
      let group = out[out.length - 1]
      if (!group || group.key !== key) {
        const d = new Date(e.startedAt)
        const label =
          key === today
            ? t('today')
            : key === yesterday
              ? t('yesterday')
              : d.toLocaleDateString(i18n.language, {
                  year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
                  month: 'long',
                  day: 'numeric',
                  weekday: 'short'
                })
        group = { key, label, items: [] }
        out.push(group)
      }
      group.items.push(e)
    }
    return out
  }, [entries, search, filter, t, i18n.language])

  const clearHistory = async (): Promise<void> => {
    const ok = await confirm({
      title: t('clearTitle'),
      message: t('clearMessage'),
      confirmLabel: t('clear'),
      danger: true
    })
    if (!ok) return
    try {
      await call('history.clear')
      setEntries([])
      toast.success(t('cleared'))
    } catch (err) {
      toast.error(tc('errorTitle'), { description: errorMessage(err) })
    }
  }

  const hasEntries = !!entries && entries.length > 0

  return (
    <Page>
      <PageHeader
        search={search}
        onSearch={setSearch}
        searchPlaceholder={t('searchPlaceholder')}
        actions={
          <>
            {hasEntries && (
              <Segmented
                value={filter}
                onChange={setFilter}
                options={[
                  { value: 'all', label: t('filter.all') },
                  {
                    value: 'failed',
                    label: (
                      <>
                        {t('filter.failed')}
                        {failedCount > 0 && (
                          <span className="text-[11px] tabular-nums text-danger">{failedCount}</span>
                        )}
                      </>
                    )
                  }
                ]}
              />
            )}
            <Button
              variant="secondary"
              onClick={() => void clearHistory()}
              disabled={!hasEntries}
              data-testid="logs-clear"
            >
              <Trash2 />
              {t('clear')}
            </Button>
          </>
        }
      />
      <PageBody>
        {entries === null ? (
          <div className="flex justify-center py-24">
            <Spinner className="size-5" />
          </div>
        ) : !hasEntries ? (
          <EmptyState
            icon={<History />}
            title={t('emptyTitle')}
            description={t('emptyDescription')}
            className="py-24"
            action={
              <Button
                variant="primary"
                className="mt-2"
                onClick={() => useApp.getState().setSection('hosts')}
              >
                <Server />
                {t('goToHosts')}
              </Button>
            }
          />
        ) : groups.length === 0 ? (
          <EmptyState icon={<History />} title={t('noMatch')} />
        ) : (
          <div className="flex flex-col gap-6">
            {groups.map((g) => (
              <section key={g.key}>
                <div className="mb-2 flex items-baseline gap-2 px-1">
                  <h2 className="text-[11px] font-semibold uppercase tracking-wider text-subtle">
                    {g.label}
                  </h2>
                  <span className="text-[11px] text-subtle">· {t('entries', { count: g.items.length })}</span>
                </div>
                <div className="overflow-hidden rounded-xl border border-line bg-panel">
                  {g.items.map((e) => (
                    <LogRow key={e.id} entry={e} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </PageBody>
    </Page>
  )
}

function StatusIcon({ entry }: { entry: HistoryEntry }): React.JSX.Element {
  const { t } = useTranslation('logs')
  const live = entry.status === 'connected' && !entry.endedAt
  const icon =
    entry.status === 'failed' ? (
      <CircleX className="size-[18px] text-danger" />
    ) : entry.status === 'connected' ? (
      <CircleDot className={cn('size-[18px] text-success', live && 'animate-soft-pulse')} />
    ) : (
      <CircleCheck className="size-[18px] text-subtle" />
    )
  return (
    <Tip content={t(`status.${entry.status}`)}>
      <span
        className="flex size-6 shrink-0 items-center justify-center"
        aria-label={t(`status.${entry.status}`)}
      >
        {icon}
      </span>
    </Tip>
  )
}

function LogRow({ entry: e }: { entry: HistoryEntry }): React.JSX.Element {
  const { t, i18n } = useTranslation('logs')
  const host = e.hostId ? getItem('host', e.hostId) : undefined
  const hostDeleted = !!e.hostId && !host
  const live = e.status === 'connected' && !e.endedAt
  const kind =
    e.protocol === 'telnet'
      ? 'telnet'
      : e.protocol === 'local'
        ? 'local'
        : e.protocol === 'serial'
          ? 'serial'
          : 'ssh'
  const title = e.label || host?.data.label || e.address
  const time = new Date(e.startedAt).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' })

  const reconnect = (): void => {
    connectAgain(e).catch((err: unknown) =>
      toast.error(t('connectFailed'), { description: errorMessage(err) })
    )
  }
  const copyAddress = async (): Promise<void> => {
    await copyText(e.address)
    toast.success(t('addressCopied'))
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-testid="log-row"
          data-status={e.status}
          onDoubleClick={reconnect}
          className="group flex min-h-[60px] cursor-default items-center gap-3 border-t border-line px-4 py-2.5 transition-colors first:border-t-0 hover:bg-panel-hover"
        >
          <StatusIcon entry={e} />
          <HostAvatar osHint={host?.data.osHint} label={title} kind={kind} className="size-8" />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-[13.5px] font-semibold">{title}</span>
              <Badge className="shrink-0">{t(`protocol.${e.protocol}`)}</Badge>
              {hostDeleted && (
                <Tip content={t('hostDeleted')}>
                  <TriangleAlert className="size-3.5 shrink-0 text-warning" />
                </Tip>
              )}
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted">
              <span className="selectable shrink-0 font-mono text-[11.5px]">
                {e.username && <span className="text-fg">{e.username}</span>}
                {e.username && <span className="text-subtle">@</span>}
                {e.address}
              </span>
              {e.status === 'failed' && e.error && (
                <>
                  <span className="shrink-0 text-subtle">·</span>
                  <Tip content={<span className="break-words">{e.error}</span>}>
                    <span className="selectable truncate text-danger">{e.error}</span>
                  </Tip>
                </>
              )}
            </div>
          </div>
          <div
            className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100"
            onDoubleClick={(ev) => ev.stopPropagation()}
          >
            <Button size="sm" variant="primary" onClick={reconnect} data-testid="log-connect-again">
              <RotateCw />
              {t('connectAgain')}
            </Button>
          </div>
          <div className="flex w-[104px] shrink-0 flex-col items-end gap-0.5 text-right">
            <Tip content={formatDate(e.startedAt, i18n.language)}>
              <span className="text-xs tabular-nums text-fg">{time}</span>
            </Tip>
            <span className={cn('text-[11px] tabular-nums', live ? 'text-success' : 'text-muted')}>
              {live ? t('inProgress') : e.endedAt ? formatDuration(e.endedAt - e.startedAt) : '—'}
            </span>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={reconnect}>
          <RotateCw />
          {t('connectAgain')}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void copyAddress()}>
          <Copy />
          {t('copyAddress')}
        </ContextMenuItem>
        {host && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => openEditor('host', host.id)}>
              <Pencil />
              {t('editHost')}
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
