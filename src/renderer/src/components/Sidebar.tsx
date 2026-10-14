import { ArrowLeftRight, Braces, ChevronsLeft, ChevronsRight, CloudOff, History, KeyRound, Loader2, Lock, RefreshCcw, Server, Settings, ShieldCheck, TriangleAlert, Cloud, CloudCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { call } from '@/lib/api'
import { cn, relativeTime } from '@/lib/utils'
import { type Section, useApp } from '@/stores/app'
import { Logo } from './Logo'
import { Tip } from './ui/controls'

const NAV: { id: Section; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'hosts', icon: Server },
  { id: 'keychain', icon: KeyRound },
  { id: 'portForwarding', icon: ArrowLeftRight },
  { id: 'snippets', icon: Braces },
  { id: 'knownHosts', icon: ShieldCheck },
  { id: 'logs', icon: History }
]

export function Sidebar(): React.JSX.Element {
  const { t } = useTranslation()
  const section = useApp((s) => s.section)
  const collapsed = useApp((s) => s.settings.sidebarCollapsed)
  const lock = useApp((s) => s.lock)
  const setSection = useApp((s) => s.setSection)
  const updateSettings = useApp((s) => s.updateSettings)

  const item = (id: Section, Icon: React.ComponentType<{ className?: string }>, label: string): React.JSX.Element => {
    const active = section === id
    const btn = (
      <button
        key={id}
        onClick={() => setSection(id)}
        className={cn(
          'flex h-9 w-full items-center gap-3 rounded-lg px-3 text-[13px] font-medium transition-colors',
          collapsed && 'justify-center px-0',
          active ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-panel-hover hover:text-fg'
        )}
        data-testid={`nav-${id}`}
      >
        <Icon className="size-[18px] shrink-0" />
        {!collapsed && <span className="truncate">{label}</span>}
      </button>
    )
    return collapsed ? (
      <Tip key={id} content={label} side="right">
        {btn}
      </Tip>
    ) : (
      btn
    )
  }

  return (
    <aside className={cn('flex h-full shrink-0 flex-col border-r border-line bg-sidebar transition-[width] duration-150', collapsed ? 'w-[60px]' : 'w-[216px]')}>
      <div className={cn('flex h-14 shrink-0 items-center gap-2.5 px-4', collapsed && 'justify-center px-0')}>
        <Logo />
        {!collapsed && <span className="truncate text-[14px] font-semibold tracking-tight">{t('appName')}</span>}
      </div>
      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-2.5 pt-1">{NAV.map((n) => item(n.id, n.icon, t(`nav.${n.id}`)))}</nav>
      <div className="flex flex-col gap-0.5 border-t border-line p-2.5">
        <SyncIndicator collapsed={collapsed} />
        {lock.passwordEnabled && (
          <Tip content={collapsed ? t('lock.lockNow') : undefined} side="right">
            <button
              onClick={() => void call('lock.lock')}
              className={cn('flex h-9 w-full items-center gap-3 rounded-lg px-3 text-[13px] font-medium text-muted hover:bg-panel-hover hover:text-fg', collapsed && 'justify-center px-0')}
            >
              <Lock className="size-[18px] shrink-0" />
              {!collapsed && t('lock.lockNow')}
            </button>
          </Tip>
        )}
        {item('settings', Settings, t('nav.settings'))}
        <button
          onClick={() => void updateSettings({ sidebarCollapsed: !collapsed })}
          className={cn('mt-1 flex h-7 items-center gap-2 rounded-md px-3 text-xs text-subtle hover:text-fg', collapsed && 'justify-center px-0')}
        >
          {collapsed ? <ChevronsRight className="size-4" /> : <ChevronsLeft className="size-4" />}
        </button>
      </div>
    </aside>
  )
}

function SyncIndicator({ collapsed }: { collapsed: boolean }): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const sync = useApp((s) => s.sync)
  const setSection = useApp((s) => s.setSection)
  const state = sync.state
  const Icon =
    state === 'syncing'
      ? Loader2
      : state === 'idle'
        ? CloudCheck
        : state === 'offline'
          ? CloudOff
          : state === 'error' || state === 'needs-password'
            ? TriangleAlert
            : Cloud
  const color =
    state === 'idle' ? 'text-success' : state === 'syncing' ? 'text-accent' : state === 'offline' ? 'text-warning' : state === 'disabled' ? 'text-subtle' : 'text-danger'
  const label = sync.configured ? t(`sync.${state}`) : t('sync.setup')
  const detail = sync.configured
    ? [
        sync.dbLabel,
        sync.lastSyncAt ? t('sync.lastSync', { time: relativeTime(sync.lastSyncAt, i18n.language) }) : undefined,
        sync.pendingChanges ? t('sync.pending', { count: sync.pendingChanges }) : undefined,
        sync.lastError
      ]
        .filter(Boolean)
        .join('\n')
    : undefined
  return (
    <Tip content={detail ? <span className="whitespace-pre-line">{detail}</span> : collapsed ? label : undefined} side="right">
      <div className={cn('group flex h-9 w-full items-center gap-3 rounded-lg px-3 text-[13px] hover:bg-panel-hover', collapsed && 'justify-center px-0')} data-testid="sync-indicator">
        <button className="flex min-w-0 flex-1 items-center gap-3" onClick={() => setSection('settings', 'sync')}>
          <Icon className={cn('size-[18px] shrink-0', color, state === 'syncing' && 'animate-spin')} />
          {!collapsed && <span className="truncate text-muted group-hover:text-fg">{label}</span>}
        </button>
        {!collapsed && sync.configured && state !== 'syncing' && state !== 'needs-password' && (
          <button
            className="hidden rounded p-0.5 text-subtle hover:text-fg group-hover:block"
            onClick={() => void call('sync.now').catch(() => {})}
            title="Sync now"
          >
            <RefreshCcw className="size-3.5" />
          </button>
        )}
      </div>
    </Tip>
  )
}
