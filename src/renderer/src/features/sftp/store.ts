import { toast } from 'sonner'
import { create } from 'zustand'
import type { FileEntry, FsInfo } from '@shared/types'
import i18n from '@/i18n'
import { call, errorMessage } from '@/lib/api'
import { useApp } from '@/stores/app'
import { type Flavor, samePath, type SortKey, type SortSpec } from './utils'

export type PaneId = 'left' | 'right'
export const PANE_IDS: readonly PaneId[] = ['left', 'right']

export function otherPane(id: PaneId): PaneId {
  return id === 'left' ? 'right' : 'left'
}

export type PaneSource = { kind: 'none' } | { kind: 'local' } | { kind: 'host'; hostId: string; sessionId?: string }

export interface PaneState {
  source: PaneSource
  /** Connection state of the pane's file system. */
  status: 'idle' | 'connecting' | 'ready' | 'error'
  error?: string
  fs?: FsInfo
  path: string
  entries: FileEntry[]
  /** A listing has been loaded at least once for the current file system. */
  loaded: boolean
  loading: boolean
  listError?: string
  history: string[]
  historyIndex: number
  selection: ReadonlySet<string>
  /** Shift+click range anchor (path). */
  anchor?: string
  /** Keyboard cursor (path). */
  cursor?: string
  filter: string
  sort: SortSpec
}

export interface EditorTarget {
  fsId: string
  path: string
  name: string
  /** Directory containing the file (refreshed after saving). */
  dir: string
  flavor: Flavor
}

export interface ChmodTarget {
  fsId: string
  dir: string
  entries: FileEntry[]
}

interface SftpState {
  panes: Record<PaneId, PaneState>
  editor: EditorTarget | null
  chmod: ChmodTarget | null
}

const EMPTY: ReadonlySet<string> = new Set()
const MAX_HISTORY = 100

function initialPane(source: PaneSource, sort?: SortSpec): PaneState {
  return {
    source,
    status: 'idle',
    path: '',
    entries: [],
    loaded: false,
    loading: false,
    history: [],
    historyIndex: -1,
    selection: EMPTY,
    filter: '',
    sort: sort ?? { key: 'name', desc: false }
  }
}

function initialState(): SftpState {
  return { panes: { left: initialPane({ kind: 'local' }), right: initialPane({ kind: 'none' }) }, editor: null, chmod: null }
}

export const useSftp = create<SftpState>(initialState)

export function usePane(id: PaneId): PaneState {
  return useSftp((s) => s.panes[id])
}

export function getPane(id: PaneId): PaneState {
  return useSftp.getState().panes[id]
}

function patchPane(id: PaneId, patch: Partial<PaneState> | ((p: PaneState) => Partial<PaneState>)): void {
  useSftp.setState((s) => {
    const cur = s.panes[id]
    return { panes: { ...s.panes, [id]: { ...cur, ...(typeof patch === 'function' ? patch(cur) : patch) } } }
  })
}

const t = (key: string, opts?: Record<string, unknown>): string => i18n.t(key, { ns: 'sftp', ...opts })

// Sequence numbers so late results of superseded connects / listings are ignored.
const connectSeq: Record<PaneId, number> = { left: 0, right: 0 }
const listSeq: Record<PaneId, number> = { left: 0, right: 0 }

function releaseFs(fs: FsInfo | undefined): void {
  if (fs && fs.kind === 'sftp') void call('fs.close', fs.id).catch(() => {})
}

// ------------------------------------------------------------------ lifecycle

/** Opens the default sources (left = local disk). Called when the SFTP page mounts. */
export function initSftp(): void {
  const left = getPane('left')
  if (left.status === 'idle' && left.source.kind === 'local') void connect('left', { kind: 'local' })
}

/** Closes every remote file system and resets the page (unmount / app lock). */
export function resetSftp(): void {
  for (const id of PANE_IDS) {
    connectSeq[id]++
    listSeq[id]++
    releaseFs(getPane(id).fs)
  }
  useSftp.setState(initialState())
}

/** Switches the source of a pane, closing the previous remote file system. */
export async function connect(id: PaneId, source: PaneSource): Promise<void> {
  const seq = ++connectSeq[id]
  listSeq[id]++
  const prev = getPane(id)
  releaseFs(prev.fs)
  useSftp.setState((s) => ({
    panes: { ...s.panes, [id]: { ...initialPane(source, prev.sort), status: source.kind === 'none' ? 'idle' : 'connecting' } },
    editor: s.editor && prev.fs && s.editor.fsId === prev.fs.id && prev.fs.kind === 'sftp' ? null : s.editor
  }))
  if (source.kind === 'none') return
  try {
    const fs = source.kind === 'local' ? await call('fs.openLocal') : await call('fs.openSftp', source.hostId, source.sessionId)
    if (seq !== connectSeq[id]) {
      releaseFs(fs)
      return
    }
    patchPane(id, { fs, status: 'ready' })
    if (source.kind === 'local') {
      const preferred = useApp.getState().settings.sftp.defaultLocalPath?.trim()
      if (preferred && (await navigate(id, preferred, { silent: true }))) return
      if (seq !== connectSeq[id]) return
    }
    await navigate(id, fs.home)
  } catch (err) {
    if (seq !== connectSeq[id]) return
    patchPane(id, { status: 'error', error: errorMessage(err) })
  }
}

export function retryConnect(id: PaneId): void {
  const src = getPane(id).source
  if (src.kind !== 'none') void connect(id, src)
}

// ------------------------------------------------------------------ navigation

type HistoryMode = 'push' | 'none' | { index: number }

/** Lists `path` and makes it the pane's current folder. Resolves to false when the folder could not be read. */
export async function navigate(id: PaneId, path: string, opts: { history?: HistoryMode; silent?: boolean; select?: string[] } = {}): Promise<boolean> {
  const pane = getPane(id)
  const fs = pane.fs
  if (!fs || pane.status !== 'ready') return false
  const seq = ++listSeq[id]
  patchPane(id, { loading: true })
  try {
    const entries = await call('fs.list', fs.id, path)
    if (seq !== listSeq[id] || getPane(id).fs?.id !== fs.id) return false
    patchPane(id, (p) => {
      const mode = opts.history ?? 'push'
      let { history, historyIndex } = p
      if (mode === 'push') {
        if (history[historyIndex] !== path) {
          history = [...history.slice(0, historyIndex + 1), path].slice(-MAX_HISTORY)
          historyIndex = history.length - 1
        }
      } else if (mode !== 'none') historyIndex = mode.index
      const changed = !p.loaded || !samePath(p.path, path, fs.flavor)
      const select = opts.select ?? []
      return {
        path,
        entries,
        loaded: true,
        loading: false,
        listError: undefined,
        history,
        historyIndex,
        selection: new Set(select),
        anchor: select[0],
        cursor: select[0],
        filter: changed ? '' : p.filter
      }
    })
    return true
  } catch (err) {
    if (seq !== listSeq[id]) return false
    const p = getPane(id)
    if (opts.silent) {
      patchPane(id, { loading: false })
    } else if (p.loaded && !p.listError) {
      // Keep the current listing and just report the problem (e.g. permission denied).
      patchPane(id, { loading: false })
      toast.error(t('navigateFailed'), { description: errorMessage(err) })
    } else {
      patchPane(id, { loading: false, path, entries: [], listError: errorMessage(err), selection: EMPTY })
    }
    return false
  }
}

/** Re-lists the current folder, keeping the selection of entries that still exist. */
export async function refresh(id: PaneId, opts: { select?: string[] } = {}): Promise<void> {
  const pane = getPane(id)
  const fs = pane.fs
  if (!fs || pane.status !== 'ready' || pane.loading) return
  if (!pane.loaded && !pane.listError) return
  const path = pane.path
  const seq = ++listSeq[id]
  patchPane(id, { loading: true })
  try {
    const entries = await call('fs.list', fs.id, path)
    if (seq !== listSeq[id] || getPane(id).fs?.id !== fs.id) return
    patchPane(id, (p) => {
      const exists = new Set(entries.map((e) => e.path))
      const keep = (x?: string): string | undefined => (x && exists.has(x) ? x : undefined)
      const selection = opts.select ? opts.select.filter((x) => exists.has(x)) : [...p.selection].filter((x) => exists.has(x))
      const history = p.history.length ? p.history : [path]
      return {
        entries,
        loaded: true,
        loading: false,
        listError: undefined,
        history,
        historyIndex: p.history.length ? p.historyIndex : 0,
        selection: new Set(selection),
        anchor: opts.select ? selection[0] : keep(p.anchor),
        cursor: opts.select ? selection[0] : keep(p.cursor)
      }
    })
  } catch (err) {
    if (seq !== listSeq[id]) return
    patchPane(id, { loading: false, listError: errorMessage(err), entries: [], selection: EMPTY })
  }
}

/** Refreshes every pane that currently shows `dir` of file system `fsId`. */
export async function refreshMatching(fsId: string, dir: string, select?: string[]): Promise<void> {
  await Promise.all(
    PANE_IDS.map((id) => {
      const p = getPane(id)
      if (p.status === 'ready' && p.fs?.id === fsId && samePath(p.path, dir, p.fs.flavor)) return refresh(id, { select })
      return undefined
    })
  )
}

export function goBack(id: PaneId): void {
  const p = getPane(id)
  if (p.historyIndex > 0) void navigate(id, p.history[p.historyIndex - 1], { history: { index: p.historyIndex - 1 } })
}

export function goForward(id: PaneId): void {
  const p = getPane(id)
  if (p.historyIndex < p.history.length - 1) void navigate(id, p.history[p.historyIndex + 1], { history: { index: p.historyIndex + 1 } })
}

export function goHome(id: PaneId): void {
  const p = getPane(id)
  if (p.fs) void navigate(id, p.fs.home)
}

// ------------------------------------------------------------------ selection / view state

export function setSelection(id: PaneId, selection: Iterable<string>, anchor?: string, cursor?: string): void {
  patchPane(id, { selection: new Set(selection), anchor, cursor })
}

export function setCursor(id: PaneId, cursor: string | undefined): void {
  patchPane(id, { cursor })
}

export function setFilter(id: PaneId, filter: string): void {
  patchPane(id, { filter })
}

export function toggleSort(id: PaneId, key: SortKey): void {
  patchPane(id, (p) => ({ sort: p.sort.key === key ? { key, desc: !p.sort.desc } : { key, desc: key === 'mtime' || key === 'size' } }))
}

// ------------------------------------------------------------------ dialogs

export function openEditorDialog(target: EditorTarget): void {
  useSftp.setState({ editor: target })
}

export function closeEditorDialog(): void {
  useSftp.setState({ editor: null })
}

export function openChmodDialog(target: ChmodTarget): void {
  useSftp.setState({ chmod: target })
}

export function closeChmodDialog(): void {
  useSftp.setState({ chmod: null })
}
