import {
  ArrowLeftRight,
  ArrowRight,
  Copy,
  CopyPlus,
  Globe,
  Laptop,
  Pencil,
  Play,
  Plus,
  Server,
  Square,
  Trash2,
  TriangleAlert,
  Zap
} from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { Item, PortForwardData } from '@shared/schemas'
import type { ForwardState } from '@shared/types'
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
  Switch,
  Tip
} from '@/components/ui/controls'
import { Badge, EmptyState, SectionTitle, Spinner } from '@/components/ui/misc'
import { call, errorMessage, vaultApi } from '@/lib/api'
import { cn, copyText } from '@/lib/utils'
import { useApp } from '@/stores/app'
import { openEditor } from '@/stores/ui'
import { useItems } from '@/stores/vault'
import {
  DEFAULT_BIND_ADDRESS,
  FORWARD_TYPES,
  type ForwardType,
  formatHostPort,
  hostName,
  useForwardFormat
} from './format'

const TYPE_ICONS: Record<ForwardType, React.ComponentType<{ className?: string }>> = {
  local: Laptop,
  remote: Server,
  dynamic: Globe
}

export function PortForwardingPage(): React.JSX.Element {
  const { t } = useTranslation('forwarding')
  const rules = useItems('portForward')
  const hosts = useItems('host')
  const forwards = useApp((s) => s.forwards)
  const fmt = useForwardFormat()
  const [search, setSearch] = useState('')

  const hostById = useMemo(() => new Map(hosts.map((h) => [h.id, h])), [hosts])
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rules
      .map((rule) => ({ rule, title: fmt.title(rule.data), host: hostById.get(rule.data.hostId) }))
      .filter(({ rule, title, host }) => {
        if (!q) return true
        const d = rule.data
        const hay = [
          title,
          host && hostName(host),
          host?.data.address,
          d.bindAddress,
          String(d.bindPort),
          d.destHost,
          d.destPort && String(d.destPort),
          t(`types.${d.type}`)
        ]
        return hay.some((s) => s && s.toLowerCase().includes(q))
      })
      .sort((a, b) => a.title.localeCompare(b.title))
  }, [rules, hostById, search, fmt, t])
  const running = rules.filter((r) => forwards[r.id]?.status === 'running').length

  return (
    <Page>
      <PageHeader
        search={search}
        onSearch={setSearch}
        searchPlaceholder={t('searchPlaceholder')}
        actions={
          <Button variant="primary" onClick={() => openEditor('portForward')} data-testid="new-forward">
            <Plus />
            {t('newRule')}
          </Button>
        }
      />
      <PageBody>
        {rules.length === 0 ? (
          <ForwardingEmptyState />
        ) : rows.length === 0 ? (
          <EmptyState icon={<ArrowLeftRight />} title={t('noMatch')} />
        ) : (
          <>
            <SectionTitle
              right={
                running > 0 && (
                  <Badge tone="success">
                    <span className="size-1.5 rounded-full bg-success" />
                    {t('runningCount', { count: running })}
                  </Badge>
                )
              }
            >
              {t('rules')} · {rules.length}
            </SectionTitle>
            <div className="flex flex-col gap-2">
              {rows.map(({ rule, title, host }) => (
                <ForwardRow key={rule.id} rule={rule} title={title} host={host} state={forwards[rule.id]} />
              ))}
            </div>
          </>
        )}
      </PageBody>
    </Page>
  )
}

// ------------------------------------------------------------------ row

function ForwardRow({
  rule,
  title,
  host,
  state
}: {
  rule: Item<'portForward'>
  title: string
  host?: Item<'host'>
  state?: ForwardState
}): React.JSX.Element {
  const { t } = useTranslation('forwarding')
  const { t: tc } = useTranslation()
  const status = state?.status ?? 'stopped'
  const active = status === 'running' || status === 'starting'
  const d = rule.data

  const toggle = async (on: boolean): Promise<void> => {
    try {
      if (on) await call('forward.start', rule.id)
      else await call('forward.stop', rule.id)
    } catch (err) {
      toast.error(t(on ? 'startFailed' : 'stopFailed', { name: title }), { description: errorMessage(err) })
    }
  }
  const edit = (): void => openEditor('portForward', rule.id)
  const duplicate = async (): Promise<void> => {
    try {
      const copy = await call('vault.duplicate', rule.id)
      toast.success(t('duplicated'), {
        action: { label: tc('edit'), onClick: () => openEditor('portForward', copy.id) }
      })
    } catch (err) {
      toast.error(tc('errorTitle'), { description: errorMessage(err) })
    }
  }
  const remove = async (): Promise<void> => {
    const ok = await confirm({
      title: tc('deleteConfirmTitle'),
      message: t('deleteMessage', { name: title }),
      confirmLabel: tc('delete'),
      danger: true
    })
    if (!ok) return
    try {
      if (status !== 'stopped') await call('forward.stop', rule.id).catch(() => {})
      await vaultApi.remove([rule.id])
      toast.success(tc('deletedToast'))
    } catch (err) {
      toast.error(tc('errorTitle'), { description: errorMessage(err) })
    }
  }
  const copyAddress = async (): Promise<void> => {
    await copyText(formatHostPort(d.bindAddress || DEFAULT_BIND_ADDRESS, d.bindPort))
    toast.success(t('addressCopied'))
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-testid="forward-row"
          data-status={status}
          onDoubleClick={edit}
          className={cn(
            'group flex min-h-[68px] cursor-default items-center gap-4 rounded-xl border bg-panel px-4 py-3 transition-colors hover:bg-panel-hover',
            status === 'error' ? 'border-danger/40' : 'border-transparent hover:border-line'
          )}
        >
          <RuleIcon type={d.type} status={status} />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-[13.5px] font-semibold">{title}</span>
              <Badge tone="accent" className="shrink-0">
                {t(`types.${d.type}`)}
              </Badge>
              {d.autoStart && (
                <Tip content={t('autoStartTip')}>
                  <Badge className="shrink-0">
                    <Zap className="size-3" />
                    {t('autoStart')}
                  </Badge>
                </Tip>
              )}
            </div>
            <Mapping data={d} host={host} />
            {status === 'error' && state?.error && (
              <Tip content={<span className="break-words">{state.error}</span>}>
                <div className="mt-1 truncate text-xs text-danger">{state.error}</div>
              </Tip>
            )}
          </div>
          <div
            className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100"
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <IconAction tip={tc('edit')} onClick={edit}>
              <Pencil />
            </IconAction>
            <IconAction tip={tc('duplicate')} onClick={() => void duplicate()}>
              <CopyPlus />
            </IconAction>
            <IconAction tip={tc('delete')} onClick={() => void remove()} danger>
              <Trash2 />
            </IconAction>
          </div>
          <StatusLabel state={state} />
          {/* The span keeps the tooltip's data-state off the switch (it styles itself from its own data-state). */}
          <Tip content={active ? t('stop') : t('start')}>
            <span className="inline-flex shrink-0" onDoubleClick={(e) => e.stopPropagation()}>
              <Switch
                checked={active}
                onCheckedChange={(v) => void toggle(v)}
                aria-label={active ? t('stop') : t('start')}
                data-testid="forward-toggle"
              />
            </span>
          </Tip>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {active ? (
          <ContextMenuItem onSelect={() => void toggle(false)}>
            <Square />
            {t('stop')}
          </ContextMenuItem>
        ) : (
          <ContextMenuItem onSelect={() => void toggle(true)}>
            <Play />
            {t('start')}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={edit}>
          <Pencil />
          {tc('edit')}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void duplicate()}>
          <CopyPlus />
          {tc('duplicate')}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void copyAddress()}>
          <Copy />
          {t('copyAddress')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem danger onSelect={() => void remove()}>
          <Trash2 />
          {tc('delete')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

function IconAction({
  tip,
  onClick,
  danger,
  children
}: {
  tip: string
  onClick: () => void
  danger?: boolean
  children: ReactNode
}): React.JSX.Element {
  return (
    <Tip content={tip}>
      <Button size="icon-sm" variant={danger ? 'danger-ghost' : 'ghost'} aria-label={tip} onClick={onClick}>
        {children}
      </Button>
    </Tip>
  )
}

function RuleIcon({
  type,
  status
}: {
  type: ForwardType
  status: ForwardState['status']
}): React.JSX.Element {
  const Icon = TYPE_ICONS[type]
  const tone =
    status === 'running'
      ? 'bg-success/15 text-success'
      : status === 'error'
        ? 'bg-danger/15 text-danger'
        : status === 'starting'
          ? 'bg-accent-soft text-accent'
          : 'bg-line/70 text-muted'
  return (
    <div
      className={cn(
        'relative flex size-10 shrink-0 items-center justify-center rounded-xl transition-colors',
        tone
      )}
    >
      <Icon className="size-[18px]" />
      {status === 'starting' && (
        <span className="absolute -bottom-1 -right-1 flex size-4 items-center justify-center rounded-full border-2 border-panel bg-accent text-white group-hover:border-panel-hover">
          <Spinner className="size-2.5 text-white" />
        </span>
      )}
    </div>
  )
}

function StatusLabel({ state }: { state?: ForwardState }): React.JSX.Element {
  const { t } = useTranslation('forwarding')
  const status = state?.status ?? 'stopped'
  return (
    <div className="flex w-[118px] shrink-0 flex-col items-end gap-0.5 text-right">
      <span
        className={cn(
          'inline-flex items-center gap-1.5 text-xs font-medium',
          status === 'running'
            ? 'text-success'
            : status === 'error'
              ? 'text-danger'
              : status === 'starting'
                ? 'text-accent'
                : 'text-subtle'
        )}
      >
        {status === 'running' ? (
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60" />
            <span className="relative inline-flex size-2 rounded-full bg-success" />
          </span>
        ) : status === 'starting' ? (
          <Spinner className="size-3 text-accent" />
        ) : status === 'error' ? (
          <TriangleAlert className="size-3.5" />
        ) : (
          <span className="size-2 rounded-full border border-line-strong" />
        )}
        {t(`status.${status}`)}
      </span>
      {status === 'running' && (
        <span className="text-[11px] text-muted">
          {t('connections', { count: Math.round(state?.connections ?? 0) })}
        </span>
      )}
    </div>
  )
}

/** Human readable mapping, e.g. `127.0.0.1:8080 → web-server → 10.0.0.1:80`. */
function Mapping({ data, host }: { data: PortForwardData; host?: Item<'host'> }): React.JSX.Element {
  const { t } = useTranslation('forwarding')
  const bind = formatHostPort(data.bindAddress || DEFAULT_BIND_ADDRESS, data.bindPort)
  const dest = formatHostPort(data.destHost || '?', data.destPort)
  const arrow = <ArrowRight className="size-3.5 shrink-0 text-subtle" />
  const mono = (s: string): React.JSX.Element => (
    <span className="shrink-0 font-mono text-[11.5px] text-fg">{s}</span>
  )
  const computer = <Laptop className="size-3.5 shrink-0 text-subtle" />
  const hostChip = <HostChip host={host} />
  let parts: ReactNode
  if (data.type === 'local') {
    parts = (
      <>
        {computer}
        {mono(bind)}
        {arrow}
        {hostChip}
        {arrow}
        {mono(dest)}
      </>
    )
  } else if (data.type === 'remote') {
    parts = (
      <>
        {hostChip}
        {mono(bind)}
        {arrow}
        {computer}
        {mono(dest)}
        <span className="shrink-0 text-subtle">({t('thisComputer')})</span>
      </>
    )
  } else {
    parts = (
      <>
        <span className="shrink-0 font-semibold text-muted">SOCKS5</span>
        {mono(bind)}
        <span className="shrink-0 text-subtle">{t('via')}</span>
        {hostChip}
      </>
    )
  }
  return (
    <div className="mt-1 flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-xs text-muted">
      {parts}
    </div>
  )
}

function HostChip({ host }: { host?: Item<'host'> }): React.JSX.Element {
  const { t } = useTranslation('forwarding')
  if (!host) {
    return (
      <Tip content={t('missingHostTip')}>
        <span className="inline-flex shrink-0 items-center gap-1 font-medium text-warning">
          <TriangleAlert className="size-3.5" />
          {t('missingHost')}
        </span>
      </Tip>
    )
  }
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <HostAvatar
        size="sm"
        osHint={host.data.osHint}
        label={hostName(host)}
        className="size-4 rounded [&_svg]:size-2.5"
      />
      <span className="truncate font-medium text-fg">{hostName(host)}</span>
    </span>
  )
}

// ------------------------------------------------------------------ empty state

function ForwardingEmptyState(): React.JSX.Element {
  const { t } = useTranslation('forwarding')
  const examples: Record<ForwardType, { text: string; example: string }> = {
    local: { text: t('emptyLocal'), example: 'localhost:5432 → db:5432' },
    remote: { text: t('emptyRemote'), example: 'server:8080 → localhost:3000' },
    dynamic: { text: t('emptyDynamic'), example: 'SOCKS5 localhost:1080' }
  }
  return (
    <div className="mx-auto flex max-w-3xl flex-col items-center pb-10 pt-8">
      <EmptyState
        icon={<ArrowLeftRight />}
        title={t('emptyTitle')}
        description={t('emptyDescription')}
        className="py-0 pb-6"
      />
      <div className="grid w-full grid-cols-3 gap-3">
        {FORWARD_TYPES.map((type) => {
          const Icon = TYPE_ICONS[type]
          return (
            <button
              key={type}
              type="button"
              onClick={() => openEditor('portForward', undefined, { type })}
              className="group flex flex-col items-start gap-2 rounded-xl border border-line bg-panel p-4 text-left transition-colors hover:border-accent/60 hover:bg-panel-hover"
              data-testid={`new-forward-${type}`}
            >
              <div className="flex w-full items-center justify-between">
                <div className="flex size-9 items-center justify-center rounded-lg bg-accent-soft text-accent">
                  <Icon className="size-[18px]" />
                </div>
                <Plus className="size-4 text-subtle transition-colors group-hover:text-accent" />
              </div>
              <div className="text-[13.5px] font-semibold">{t(`types.${type}`)}</div>
              <div className="text-xs leading-relaxed text-muted">{examples[type].text}</div>
              <div className="mt-auto rounded-md bg-input px-2 py-1 font-mono text-[11px] text-muted">
                {examples[type].example}
              </div>
            </button>
          )
        })}
      </div>
      <Button variant="primary" className="mt-6" onClick={() => openEditor('portForward')}>
        <Plus />
        {t('newRule')}
      </Button>
    </div>
  )
}
