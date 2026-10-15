import { Copy, FolderOpen, Monitor, Pencil, Plus, Radio, RotateCw, SquareSplitHorizontal, SquareSplitVertical, Terminal, Usb, Vault, X, Zap } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { isMac, isWin, platform } from '@/lib/api'
import { cn } from '@/lib/utils'

const isLinux = platform === 'linux'
import {
  activateTab,
  closeTab,
  duplicateTab,
  leaves,
  moveTab,
  openTab,
  reconnectSession,
  renameTab,
  splitPane,
  type TerminalTab,
  tabTitle,
  toggleBroadcast,
  useTabs
} from '@/stores/tabs'
import { openInSftp, useUi } from '@/stores/ui'
import { HostAvatar } from './HostAvatar'
import { promptText } from './ui/confirm'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tip
} from './ui/controls'
import { useApp } from '@/stores/app'

function StatusDot({ status }: { status?: string }): React.JSX.Element {
  const color =
    status === 'connected' ? 'bg-success' : status === 'connecting' ? 'bg-warning animate-soft-pulse' : status === 'error' ? 'bg-danger' : 'bg-subtle'
  return <span className={cn('size-1.5 shrink-0 rounded-full', color)} />
}

export function TabBar(): React.JSX.Element {
  const { t } = useTranslation()
  const tabs = useTabs((s) => s.tabs)
  const activeTabId = useTabs((s) => s.activeTabId)
  const sessions = useTabs((s) => s.sessions)
  const [dragId, setDragId] = useState<string | null>(null)

  return (
    <div
      className={cn('flex h-10 shrink-0 items-stretch border-b border-line bg-titlebar', !isLinux && 'drag-region')}
      style={{ paddingLeft: isMac ? 78 : 6, paddingRight: isWin ? 144 : 8 }}
    >
      <div className="no-drag flex min-w-0 items-stretch gap-0.5 overflow-x-auto py-1.5 [scrollbar-width:none]">
        <PinnedTab id="vault" active={activeTabId === 'vault'} icon={<Vault className="size-4" />} label={t('nav.vault')} />
        <PinnedTab id="sftp" active={activeTabId === 'sftp'} icon={<FolderOpen className="size-4" />} label={t('nav.sftp')} />
        {tabs.length > 2 && <div className="mx-1 my-1.5 w-px bg-line" />}
        {tabs.map((tab) => {
          if (tab.kind !== 'terminal') return null
          const first = sessions[leaves(tab.root)[0]?.sessionId]
          const title = tabTitle(tab, sessions)
          const active = tab.id === activeTabId
          const anyError = leaves(tab.root).some((l) => sessions[l.sessionId]?.status === 'error')
          const status = anyError ? 'error' : first?.status
          return (
            <TabContextMenu key={tab.id} tab={tab}>
              <div
                draggable
                onDragStart={(e) => {
                  setDragId(tab.id)
                  e.dataTransfer.effectAllowed = 'move'
                }}
                onDragOver={(e) => {
                  if (dragId && dragId !== tab.id) e.preventDefault()
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  if (dragId) moveTab(dragId, tab.id)
                  setDragId(null)
                }}
                onDragEnd={() => setDragId(null)}
                onMouseDown={(e) => {
                  if (e.button === 1) {
                    e.preventDefault()
                    closeTab(tab.id)
                  }
                }}
                onClick={() => activateTab(tab.id)}
                data-testid="terminal-tab"
                className={cn(
                  'group relative flex h-full min-w-[120px] max-w-[220px] shrink-0 items-center gap-2 rounded-md pl-2 pr-1 text-[12.5px] transition-colors',
                  active ? 'bg-app text-fg shadow-sm' : 'text-muted hover:bg-panel-hover hover:text-fg'
                )}
              >
                <HostAvatar size="sm" kind={first?.kind === 'local' ? 'local' : first?.kind === 'serial' ? 'serial' : first?.kind === 'telnet' ? 'telnet' : 'ssh'} osHint={first?.osHint} label={title} className="size-5 rounded [&_svg]:size-3" />
                <span className="min-w-0 flex-1 truncate">{title}</span>
                {tab.broadcast && <Radio className="size-3.5 shrink-0 text-warning" />}
                <StatusDot status={status} />
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    closeTab(tab.id)
                  }}
                  className="flex size-5 shrink-0 items-center justify-center rounded text-subtle opacity-0 hover:bg-panel-hover hover:text-fg group-hover:opacity-100 data-[active=true]:opacity-100"
                  data-active={active}
                  aria-label="close tab"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            </TabContextMenu>
          )
        })}
        <NewTabMenu />
      </div>
      <div className="flex-1" />
    </div>
  )
}

function PinnedTab({ id, active, icon, label }: { id: 'vault' | 'sftp'; active: boolean; icon: React.ReactNode; label: string }): React.JSX.Element {
  return (
    <button
      onClick={() => activateTab(id)}
      data-testid={`tab-${id}`}
      data-active={active}
      className={cn(
        'flex h-full shrink-0 items-center gap-2 rounded-md px-3 text-[12.5px] font-medium transition-colors',
        active ? 'bg-app text-fg shadow-sm' : 'text-muted hover:bg-panel-hover hover:text-fg'
      )}
    >
      {icon}
      {label}
    </button>
  )
}

function NewTabMenu(): React.JSX.Element {
  const { t } = useTranslation('terminal')
  const setCommandOpen = useApp((s) => s.setCommandOpen)
  return (
    <DropdownMenu>
      <Tip content={t('newTab')}>
        <DropdownMenuTrigger asChild>
          <button className="ml-0.5 flex size-7 shrink-0 items-center justify-center self-center rounded-md text-muted hover:bg-panel-hover hover:text-fg" data-testid="new-tab-menu">
            <Plus className="size-4" />
          </button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onSelect={() => setCommandOpen(true)}>
          <Zap />
          {t('quickConnect')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void openTab({ kind: 'local' })} data-testid="new-local-terminal">
          <Terminal />
          {t('localTerminal')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => useUi.setState({ serialDialogOpen: true })}>
          <Usb />
          {t('serial')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => activateTab('sftp')}>
          <FolderOpen />
          SFTP
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function TabContextMenu({ tab, children }: { tab: TerminalTab; children: React.ReactNode }): React.JSX.Element {
  const { t } = useTranslation('terminal')
  const { t: tc } = useTranslation()
  const sessions = useTabs((s) => s.sessions)
  const ls = leaves(tab.root)
  const active = ls.find((l) => l.id === tab.activePaneId) ?? ls[0]
  const session = sessions[active.sessionId]
  const sshHostId = session?.spec.kind === 'ssh' ? session.spec.hostId : undefined
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onSelect={async () => {
            const name = await promptText({ title: t('renameTab'), initial: tabTitle(tab, sessions) })
            if (name !== null) renameTab(tab.id, name)
          }}
        >
          <Pencil />
          {tc('rename')}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void duplicateTab(tab.id)}>
          <Copy />
          {tc('duplicate')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => void splitPane(tab.id, active.id, 'horizontal')}>
          <SquareSplitHorizontal />
          {t('splitRight')}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void splitPane(tab.id, active.id, 'vertical')}>
          <SquareSplitVertical />
          {t('splitDown')}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => toggleBroadcast(tab.id)}>
          <Radio />
          {tab.broadcast ? t('broadcastOff') : t('broadcastOn')}
        </ContextMenuItem>
        {sshHostId && (
          <ContextMenuItem onSelect={() => openInSftp(sshHostId, active.sessionId)}>
            <FolderOpen />
            {t('openSftp')}
          </ContextMenuItem>
        )}
        {session && (session.status === 'disconnected' || session.status === 'error') && (
          <ContextMenuItem onSelect={() => void reconnectSession(active.sessionId)}>
            <RotateCw />
            {t('reconnect')}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => closeTab(tab.id)}>
          <X />
          {t('closeTab')}
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() => {
            for (const other of useTabs.getState().tabs) if (other.kind === 'terminal' && other.id !== tab.id) closeTab(other.id)
          }}
        >
          <Monitor />
          {t('closeOthers')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
