import { Braces, ClipboardCopy, ClipboardPaste, Eraser, FolderOpen, Radio, RotateCw, Save, Search, SquareSplitHorizontal, SquareSplitVertical, TextSelect, X } from 'lucide-react'
import { Fragment, useEffect, useRef } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { useTranslation } from 'react-i18next'
import { create } from 'zustand'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger, Tip } from '@/components/ui/controls'
import { call } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useApp } from '@/stores/app'
import { activatePane, closePane, type PaneNode, reconnectSession, splitPane, type TerminalTab, toggleBroadcast, useTabs, leaves } from '@/stores/tabs'
import { openInSftp } from '@/stores/ui'
import { useTerminalPrefs } from '@/stores/vault'
import { Autocomplete } from './Autocomplete'
import { ConnectingOverlay, DisconnectedBanner } from './ConnectingOverlay'
import {
  applyTerminalPrefs,
  attachTerminal,
  bufferText,
  clearTerminal,
  copySelection,
  detachTerminal,
  focusTerminal,
  pasteInto,
  scheduleFit,
  selectAllTerminal,
  themeBackground
} from './registry'
import { SearchBar } from './SearchBar'
import { SnippetsPanel } from './SnippetsPanel'

interface TerminalUiState {
  searchTabId: string | null
  snippetsOpen: boolean
}

export const useTerminalUi = create<TerminalUiState>(() => ({ searchTabId: null, snippetsOpen: false }))

/** Keeps xterm options in sync with the synced terminal preferences and theme. */
export function TerminalPrefsSync(): null {
  const prefs = useTerminalPrefs()
  const dark = useApp((s) => s.resolvedTheme === 'dark')
  useEffect(() => applyTerminalPrefs(prefs, dark), [prefs, dark])
  return null
}

export function TerminalView({ tab, visible }: { tab: TerminalTab; visible: boolean }): React.JSX.Element {
  const { t } = useTranslation('terminal')
  const searchOpen = useTerminalUi((s) => s.searchTabId === tab.id)
  const snippetsOpen = useTerminalUi((s) => s.snippetsOpen)
  const activeLeaf = leaves(tab.root).find((l) => l.id === tab.activePaneId) ?? leaves(tab.root)[0]
  const multi = leaves(tab.root).length > 1

  return (
    <div className={cn('absolute inset-0 flex', !visible && 'invisible pointer-events-none')} data-testid="terminal-view">
      <div className="relative flex min-w-0 flex-1 flex-col">
        {tab.broadcast && (
          <div className="flex h-7 shrink-0 items-center gap-2 bg-warning/15 px-3 text-xs text-warning">
            <Radio className="size-3.5" />
            <span className="flex-1 truncate">{t('broadcastActive')}</span>
            <button className="rounded px-1.5 hover:bg-warning/20" onClick={() => toggleBroadcast(tab.id)}>
              {t('broadcastOff')}
            </button>
          </div>
        )}
        <div className="relative min-h-0 flex-1">
          <PaneTree tab={tab} node={tab.root} visible={visible} multi={multi} />
          {searchOpen && activeLeaf && <SearchBar sessionId={activeLeaf.sessionId} onClose={() => useTerminalUi.setState({ searchTabId: null })} />}
          <div className="absolute right-2 top-2 z-10 flex gap-1 opacity-0 transition-opacity hover:opacity-100 focus-within:opacity-100">
            <ToolbarButton tip={t('find')} onClick={() => useTerminalUi.setState({ searchTabId: tab.id })}>
              <Search />
            </ToolbarButton>
            <ToolbarButton tip={t('snippets')} active={snippetsOpen} onClick={() => useTerminalUi.setState((s) => ({ snippetsOpen: !s.snippetsOpen }))}>
              <Braces />
            </ToolbarButton>
            <ToolbarButton tip={t('splitRight')} onClick={() => activeLeaf && void splitPane(tab.id, activeLeaf.id, 'horizontal')}>
              <SquareSplitHorizontal />
            </ToolbarButton>
            <ToolbarButton tip={t('splitDown')} onClick={() => activeLeaf && void splitPane(tab.id, activeLeaf.id, 'vertical')}>
              <SquareSplitVertical />
            </ToolbarButton>
            {multi && (
              <ToolbarButton tip={tab.broadcast ? t('broadcastOff') : t('broadcastOn')} active={tab.broadcast} onClick={() => toggleBroadcast(tab.id)}>
                <Radio />
              </ToolbarButton>
            )}
          </div>
        </div>
      </div>
      {snippetsOpen && visible && <SnippetsPanel sessionId={activeLeaf?.sessionId} onClose={() => useTerminalUi.setState({ snippetsOpen: false })} />}
    </div>
  )
}

function ToolbarButton({ tip, onClick, children, active }: { tip: string; onClick: () => void; children: React.ReactNode; active?: boolean }): React.JSX.Element {
  return (
    <Tip content={tip}>
      <button
        onClick={onClick}
        className={cn(
          'flex size-7 items-center justify-center rounded-md border border-line bg-elevated/90 text-muted shadow-sm backdrop-blur hover:text-fg [&_svg]:size-3.5',
          active && 'text-accent'
        )}
      >
        {children}
      </button>
    </Tip>
  )
}

function PaneTree({ tab, node, visible, multi }: { tab: TerminalTab; node: PaneNode; visible: boolean; multi: boolean }): React.JSX.Element {
  if (node.type === 'leaf') return <TerminalPane tab={tab} paneId={node.id} sessionId={node.sessionId} visible={visible} multi={multi} />
  return (
    <Group orientation={node.direction} id={node.id} className="h-full w-full">
      {node.children.map((c, i) => (
        <Fragment key={c.id}>
          {i > 0 && <Separator className={cn('bg-line transition-colors hover:bg-accent', node.direction === 'horizontal' ? 'w-1' : 'h-1')} />}
          <Panel id={c.id} minSize="8">
            <PaneTree tab={tab} node={c} visible={visible} multi={multi} />
          </Panel>
        </Fragment>
      ))}
    </Group>
  )
}

function TerminalPane({ tab, paneId, sessionId, visible, multi }: { tab: TerminalTab; paneId: string; sessionId: string; visible: boolean; multi: boolean }): React.JSX.Element {
  const { t } = useTranslation('terminal')
  const ref = useRef<HTMLDivElement>(null)
  const session = useTabs((s) => s.sessions[sessionId])
  const prefs = useTerminalPrefs()
  const isActive = tab.activePaneId === paneId
  useApp((s) => s.resolvedTheme)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    attachTerminal(sessionId, el)
    const ro = new ResizeObserver(() => scheduleFit(sessionId))
    ro.observe(el)
    return () => {
      ro.disconnect()
      detachTerminal(sessionId, el)
    }
  }, [sessionId])

  useEffect(() => {
    if (!visible) return
    scheduleFit(sessionId)
    if (isActive) setTimeout(() => focusTerminal(sessionId, { auto: true }), 20)
  }, [visible, isActive, sessionId])

  const hostId = session && (session.spec.kind === 'ssh' ? session.spec.hostId : undefined)
  const showOverlay = session && (session.status === 'connecting' || session.status === 'error')
  const disconnected = session?.status === 'disconnected'

  const saveOutput = async (): Promise<void> => {
    const p = await call('app.saveFileDialog', { defaultPath: `${session?.title ?? 'terminal'}.log` })
    if (!p) return
    const blobText = bufferText(sessionId)
    await call('fs.writeText', 'local', p, blobText)
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn('relative h-full w-full overflow-hidden', multi && isActive && 'ring-1 ring-inset ring-accent/50')}
          style={{ backgroundColor: themeBackground(sessionId) }}
          onMouseDown={() => activatePane(tab.id, paneId)}
          onContextMenu={(e) => {
            if (prefs.rightClickPaste && !e.shiftKey && session?.status === 'connected') {
              e.preventDefault()
              void copySelection(sessionId).then((copied) => {
                if (!copied) void pasteInto(sessionId)
              })
            }
          }}
          data-testid="terminal-pane"
          data-session-id={sessionId}
        >
          <div ref={ref} className="absolute inset-0" />
          {showOverlay && <ConnectingOverlay session={session} tabId={tab.id} paneId={paneId} />}
          {disconnected && <DisconnectedBanner session={session} tabId={tab.id} paneId={paneId} />}
          {visible && isActive && session?.status === 'connected' && prefs.autocomplete && <Autocomplete sessionId={sessionId} hostId={hostId} />}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => void copySelection(sessionId)}>
          <ClipboardCopy />
          {t('copy')}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void pasteInto(sessionId)}>
          <ClipboardPaste />
          {t('paste')}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => selectAllTerminal(sessionId)}>
          <TextSelect />
          {t('selectAll')}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => clearTerminal(sessionId)}>
          <Eraser />
          {t('clear')}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => useTerminalUi.setState({ searchTabId: tab.id })}>
          <Search />
          {t('find')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => void splitPane(tab.id, paneId, 'horizontal')}>
          <SquareSplitHorizontal />
          {t('splitRight')}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void splitPane(tab.id, paneId, 'vertical')}>
          <SquareSplitVertical />
          {t('splitDown')}
        </ContextMenuItem>
        {hostId && (
          <ContextMenuItem onSelect={() => openInSftp(hostId, sessionId)}>
            <FolderOpen />
            {t('openSftp')}
          </ContextMenuItem>
        )}
        <ContextMenuItem onSelect={() => void saveOutput()}>
          <Save />
          {t('saveOutput')}
        </ContextMenuItem>
        {(session?.status === 'disconnected' || session?.status === 'error') && (
          <ContextMenuItem onSelect={() => void reconnectSession(sessionId)}>
            <RotateCw />
            {t('reconnect')}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => closePane(tab.id, paneId)}>
          <X />
          {multi ? t('closePane') : t('closeTab')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
