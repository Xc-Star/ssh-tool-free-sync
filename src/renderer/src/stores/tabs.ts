import { create } from 'zustand'
import type { QuickHost, SessionInfo, SessionKind } from '@shared/types'
import { uuidv7 } from '@shared/util'
import { call, on, send } from '@/lib/api'
import { createTerminal, disposeTerminal, focusTerminal, setInputRouter } from '@/features/terminal/registry'
import { getItem } from './vault'

export type OpenSpec =
  | { kind: 'ssh'; hostId?: string; inline?: QuickHost; initialCommand?: string }
  | { kind: 'local'; shellId?: string; cwd?: string }
  | { kind: 'telnet'; hostId?: string; inline?: { address: string; port?: number; label?: string } }
  | { kind: 'serial'; profileId?: string; inline?: import('@shared/schemas').SerialProfileData }

export type SplitDirection = 'horizontal' | 'vertical'

export type PaneNode =
  | { type: 'leaf'; id: string; sessionId: string }
  | { type: 'split'; id: string; direction: SplitDirection; children: PaneNode[] }

export interface TerminalTab {
  id: string
  kind: 'terminal'
  root: PaneNode
  activePaneId: string
  broadcast: boolean
  customTitle?: string
}

export type Tab = { id: 'vault'; kind: 'vault' } | { id: 'sftp'; kind: 'sftp' } | TerminalTab

export interface SessionState extends SessionInfo {
  spec: OpenSpec
  logs: { line: string; level: 'info' | 'warn' | 'error' }[]
}

interface TabsState {
  tabs: Tab[]
  activeTabId: string
  sessions: Record<string, SessionState>
}

export const useTabs = create<TabsState>(() => ({
  tabs: [
    { id: 'vault', kind: 'vault' },
    { id: 'sftp', kind: 'sftp' }
  ],
  activeTabId: 'vault',
  sessions: {}
}))

// ------------------------------------------------------------------ tree helpers

export function leaves(node: PaneNode): { id: string; sessionId: string }[] {
  return node.type === 'leaf' ? [node] : node.children.flatMap(leaves)
}

function mapTree(node: PaneNode, fn: (n: PaneNode) => PaneNode | null): PaneNode | null {
  const replaced = fn(node)
  if (replaced !== node) return replaced
  if (node.type === 'leaf') return node
  const children = node.children.map((c) => mapTree(c, fn)).filter((c): c is PaneNode => !!c)
  if (!children.length) return null
  if (children.length === 1) return children[0]
  return { ...node, children }
}

export function findTabBySession(sessionId: string): TerminalTab | undefined {
  return useTabs.getState().tabs.find((t): t is TerminalTab => t.kind === 'terminal' && leaves(t.root).some((l) => l.sessionId === sessionId))
}

export function activeTerminalTab(): TerminalTab | undefined {
  const s = useTabs.getState()
  const t = s.tabs.find((x) => x.id === s.activeTabId)
  return t?.kind === 'terminal' ? t : undefined
}

export function activeSessionId(): string | undefined {
  const t = activeTerminalTab()
  if (!t) return undefined
  return leaves(t.root).find((l) => l.id === t.activePaneId)?.sessionId ?? leaves(t.root)[0]?.sessionId
}

export function tabTitle(tab: TerminalTab, sessions: Record<string, SessionState>): string {
  if (tab.customTitle) return tab.customTitle
  const ls = leaves(tab.root)
  const first = sessions[ls[0]?.sessionId]
  const base = first?.title ?? '…'
  return ls.length > 1 ? `${base} +${ls.length - 1}` : base
}

// ------------------------------------------------------------------ input routing (broadcast)

setInputRouter((sessionId, data) => {
  const own = useTabs.getState().sessions[sessionId]
  if (own?.status === 'disconnected' && data === '\r') {
    void reconnectSession(sessionId)
    return
  }
  const tab = findTabBySession(sessionId)
  if (tab?.broadcast) {
    for (const l of leaves(tab.root)) {
      const s = useTabs.getState().sessions[l.sessionId]
      if (s?.status === 'connected') send('session.write', l.sessionId, data)
    }
  } else {
    send('session.write', sessionId, data)
  }
})

// ------------------------------------------------------------------ sessions

function estimateSize(): { cols: number; rows: number } {
  return { cols: Math.max(40, Math.floor((window.innerWidth - 60) / 8.4)), rows: Math.max(10, Math.floor((window.innerHeight - 90) / 17)) }
}

function overridesFor(spec: OpenSpec): { theme?: string; fontSize?: number } {
  if ((spec.kind === 'ssh' || spec.kind === 'telnet') && spec.hostId) {
    const host = getItem('host', spec.hostId)
    if (!host) return {}
    let theme = host.data.terminalTheme
    let fontSize = host.data.fontSize
    let gid = host.data.groupId
    const seen = new Set<string>()
    while ((!theme || !fontSize) && gid && !seen.has(gid)) {
      seen.add(gid)
      const g = getItem('group', gid)
      if (!g) break
      theme ??= g.data.terminalTheme
      fontSize ??= g.data.fontSize
      gid = g.data.parentId
    }
    return { theme, fontSize }
  }
  return {}
}

async function startSession(spec: OpenSpec): Promise<SessionInfo> {
  const size = estimateSize()
  switch (spec.kind) {
    case 'ssh':
      return call('session.openSsh', { hostId: spec.hostId, inline: spec.inline, initialCommand: spec.initialCommand, ...size })
    case 'local':
      return call('session.openLocal', { shellId: spec.shellId, cwd: spec.cwd, ...size })
    case 'telnet':
      return call('session.openTelnet', { hostId: spec.hostId, inline: spec.inline, ...size })
    case 'serial':
      return call('session.openSerial', { profileId: spec.profileId, inline: spec.inline, ...size })
  }
}

function addSession(info: SessionInfo, spec: OpenSpec): void {
  createTerminal(info.id, overridesFor(spec))
  useTabs.setState((s) => ({
    sessions: { ...s.sessions, [info.id]: { ...info, ...(s.sessions[info.id] ?? {}), spec, logs: s.sessions[info.id]?.logs ?? [] } }
  }))
}

/** Opens a session in a new tab and activates it. Returns the tab id. */
export async function openTab(spec: OpenSpec, opts: { background?: boolean } = {}): Promise<string> {
  const info = await startSession(spec)
  addSession(info, spec)
  const paneId = uuidv7()
  const tab: TerminalTab = { id: uuidv7(), kind: 'terminal', root: { type: 'leaf', id: paneId, sessionId: info.id }, activePaneId: paneId, broadcast: false }
  useTabs.setState((s) => ({ tabs: [...s.tabs, tab], activeTabId: opts.background ? s.activeTabId : tab.id }))
  return tab.id
}

export function openHost(hostId: string, kind: SessionKind = 'ssh'): Promise<string> {
  return openTab(kind === 'telnet' ? { kind: 'telnet', hostId } : { kind: 'ssh', hostId })
}

/** Splits a pane; the new pane duplicates the source session unless a spec is given. */
export async function splitPane(tabId: string, paneId: string, direction: SplitDirection, spec?: OpenSpec): Promise<void> {
  const st = useTabs.getState()
  const tab = st.tabs.find((t): t is TerminalTab => t.id === tabId && t.kind === 'terminal')
  if (!tab) return
  const leaf = leaves(tab.root).find((l) => l.id === paneId)
  if (!leaf) return
  const src = st.sessions[leaf.sessionId]
  const newSpec: OpenSpec = spec ?? src?.spec ?? { kind: 'local' }
  const info = await startSession(newSpec)
  addSession(info, newSpec)
  const newLeaf: PaneNode = { type: 'leaf', id: uuidv7(), sessionId: info.id }
  const insert = (node: PaneNode): PaneNode => {
    if (node.type === 'split') {
      const idx = node.children.findIndex((c) => c.type === 'leaf' && c.id === paneId)
      if (idx >= 0 && node.direction === direction) {
        const children = [...node.children]
        children.splice(idx + 1, 0, newLeaf)
        return { ...node, children }
      }
      return { ...node, children: node.children.map(insert) }
    }
    if (node.id === paneId) return { type: 'split', id: uuidv7(), direction, children: [node, newLeaf] }
    return node
  }
  useTabs.setState((s) => ({
    tabs: s.tabs.map((t) => (t.id === tabId && t.kind === 'terminal' ? { ...t, root: insert(t.root), activePaneId: newLeaf.id } : t))
  }))
}

function closeSessions(ids: string[]): void {
  for (const id of ids) {
    void call('session.close', id).catch(() => {})
    disposeTerminal(id)
  }
  useTabs.setState((s) => {
    const sessions = { ...s.sessions }
    for (const id of ids) delete sessions[id]
    return { sessions }
  })
}

export function closeTab(tabId: string): void {
  const st = useTabs.getState()
  const idx = st.tabs.findIndex((t) => t.id === tabId)
  const tab = st.tabs[idx]
  if (!tab || tab.kind !== 'terminal') return
  closeSessions(leaves(tab.root).map((l) => l.sessionId))
  const tabs = st.tabs.filter((t) => t.id !== tabId)
  let activeTabId = st.activeTabId
  if (activeTabId === tabId) activeTabId = (tabs[idx] ?? tabs[idx - 1] ?? tabs[0]).id
  useTabs.setState({ tabs, activeTabId })
}

export function closePane(tabId: string, paneId: string): void {
  const st = useTabs.getState()
  const tab = st.tabs.find((t): t is TerminalTab => t.id === tabId && t.kind === 'terminal')
  if (!tab) return
  const all = leaves(tab.root)
  if (all.length <= 1) return closeTab(tabId)
  const leaf = all.find((l) => l.id === paneId)
  if (!leaf) return
  closeSessions([leaf.sessionId])
  const root = mapTree(tab.root, (n) => (n.type === 'leaf' && n.id === paneId ? null : n))!
  const remaining = leaves(root)
  const activePaneId = tab.activePaneId === paneId ? remaining[0].id : tab.activePaneId
  useTabs.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === tabId ? { ...tab, root, activePaneId } : t)) }))
  focusTerminal(remaining.find((l) => l.id === activePaneId)?.sessionId ?? remaining[0].sessionId)
}

export function activateTab(tabId: string): void {
  useTabs.setState({ activeTabId: tabId })
  const tab = useTabs.getState().tabs.find((t) => t.id === tabId)
  if (tab?.kind === 'terminal') {
    const sid = leaves(tab.root).find((l) => l.id === tab.activePaneId)?.sessionId
    if (sid) setTimeout(() => focusTerminal(sid, { auto: true }), 30)
  }
}

export function activatePane(tabId: string, paneId: string): void {
  useTabs.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === tabId && t.kind === 'terminal' ? { ...t, activePaneId: paneId } : t)) }))
}

export function toggleBroadcast(tabId: string): void {
  useTabs.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === tabId && t.kind === 'terminal' ? { ...t, broadcast: !t.broadcast } : t)) }))
}

export function renameTab(tabId: string, title: string | undefined): void {
  useTabs.setState((s) => ({
    tabs: s.tabs.map((t) => (t.id === tabId && t.kind === 'terminal' ? { ...t, customTitle: title?.trim() || undefined } : t))
  }))
}

export function moveTab(fromId: string, toId: string): void {
  useTabs.setState((s) => {
    const tabs = [...s.tabs]
    const from = tabs.findIndex((t) => t.id === fromId)
    const to = tabs.findIndex((t) => t.id === toId)
    if (from < 2 || to < 2 || from === to) return s
    const [moved] = tabs.splice(from, 1)
    tabs.splice(to, 0, moved)
    return { tabs }
  })
}

export async function duplicateTab(tabId: string): Promise<void> {
  const st = useTabs.getState()
  const tab = st.tabs.find((t): t is TerminalTab => t.id === tabId && t.kind === 'terminal')
  if (!tab) return
  const spec = st.sessions[leaves(tab.root)[0].sessionId]?.spec
  if (spec) await openTab(spec)
}

export async function reconnectSession(sessionId: string): Promise<void> {
  useTabs.setState((s) => {
    const cur = s.sessions[sessionId]
    if (!cur) return s
    return { sessions: { ...s.sessions, [sessionId]: { ...cur, status: 'connecting', error: undefined, logs: [] } } }
  })
  await call('session.reconnect', sessionId).catch(() => {})
}

export function closeAllTabs(): void {
  for (const t of useTabs.getState().tabs) if (t.kind === 'terminal') closeTab(t.id)
}

export function cycleTab(delta: number): void {
  const st = useTabs.getState()
  const idx = st.tabs.findIndex((t) => t.id === st.activeTabId)
  const next = st.tabs[(idx + delta + st.tabs.length) % st.tabs.length]
  if (next) activateTab(next.id)
}

export function initTabs(): void {
  on('session.status', (info) => {
    const prev = useTabs.getState().sessions[info.id]?.status
    useTabs.setState((s) => {
      const cur = s.sessions[info.id]
      if (!cur) return s
      return { sessions: { ...s.sessions, [info.id]: { ...cur, ...info } } }
    })
    // Only on the transition: later status events (OS detection, title changes) must not move focus.
    if (info.status === 'connected' && prev !== 'connected' && activeSessionId() === info.id)
      setTimeout(() => focusTerminal(info.id, { auto: true }), 30)
  })
  on('session.log', ({ id, line, level }) => {
    useTabs.setState((s) => {
      const cur = s.sessions[id]
      if (!cur) return s
      return { sessions: { ...s.sessions, [id]: { ...cur, logs: [...cur.logs.slice(-199), { line, level }] } } }
    })
  })
}
