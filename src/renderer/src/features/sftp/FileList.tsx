import { useVirtualizer } from '@tanstack/react-virtual'
import {
  AppWindow,
  ArrowLeftRight,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FilePlus,
  FolderOpen,
  FolderPlus,
  FolderSearch,
  ListChecks,
  LoaderCircle,
  LockKeyhole,
  Pencil,
  RotateCw,
  SquarePen,
  Trash2,
  Upload
} from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FileEntry, FsInfo } from '@shared/types'
import { clamp, formatBytes } from '@shared/util'
import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/controls'
import { EmptyState } from '@/components/ui/misc'
import { isMac } from '@/lib/api'
import { cn, formatDate } from '@/lib/utils'
import { useApp } from '@/stores/app'
import {
  canWriteHere,
  copyPaths,
  createFile,
  createFolder,
  deleteEntries,
  editEntry,
  editExternal,
  goUp,
  openEntry,
  openPermissions,
  planTransfer,
  renameEntry,
  showInFolder,
  toggleHidden,
  transferToOther
} from './actions'
import { startDrag, endDrag } from './dnd'
import { EntryIcon } from './icons'
import { getPane, type PaneId, type PaneState, refresh, setCursor, setFilter, setSelection, toggleSort } from './store'
import { isDirEntry, isFileEntry, type SortKey } from './utils'

const ROW_H = 28
const HEAD_H = 28

/** Column widths; less important columns disappear when the pane gets narrow (container queries). */
const COL = {
  mtime: 'hidden w-[132px] shrink-0 @sm:block',
  size: 'w-[76px] shrink-0 text-right',
  perms: 'hidden w-[92px] shrink-0 @lg:block',
  owner: 'hidden w-[88px] shrink-0 @xl:block'
}

const isMod = (e: React.MouseEvent | React.KeyboardEvent): boolean => (isMac ? e.metaKey : e.ctrlKey)

function rowIndex(target: EventTarget | null): number {
  const el = (target as HTMLElement | null)?.closest?.('[data-sftp-row]') as HTMLElement | null
  return el ? Number(el.dataset.index) : -1
}

interface FileListProps {
  paneId: PaneId
  pane: PaneState
  fs: FsInfo
  rows: FileEntry[]
  selected: FileEntry[]
  /** Folder row currently targeted by a drag & drop. */
  dropRow?: string
}

export function FileList({ paneId, pane, fs, rows, selected, dropRow }: FileListProps): React.JSX.Element {
  const { t, i18n } = useTranslation('sftp')
  const scrollRef = useRef<HTMLDivElement>(null)
  const pending = useRef<number | null>(null)
  const typeahead = useRef({ text: '', at: 0 })
  const [focused, setFocused] = useState(false)
  const [menu, setMenu] = useState<'row' | 'empty'>('empty')
  const showOwner = useMemo(() => rows.some((r) => r.owner), [rows])
  const atDrives = fs.flavor === 'win32' && pane.path === ''

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    getItemKey: (i) => rows[i]?.path ?? i,
    overscan: 12,
    paddingStart: HEAD_H,
    paddingEnd: 6,
    scrollPaddingStart: HEAD_H
  })

  // New folder: start at the top, or reveal the entry that should stay selected (e.g. after going up).
  useEffect(() => {
    const p = getPane(paneId)
    const i = p.cursor ? rows.findIndex((r) => r.path === p.cursor) : -1
    if (i >= 0) virtualizer.scrollToIndex(i, { align: 'center' })
    else scrollRef.current?.scrollTo({ top: 0 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.path, fs.id])

  const indexOf = (path?: string): number => (path ? rows.findIndex((r) => r.path === path) : -1)

  const selectRange = (from: number, to: number, add: boolean): void => {
    const [a, b] = from < to ? [from, to] : [to, from]
    const range = rows.slice(a, b + 1).map((r) => r.path)
    setSelection(paneId, add ? [...getPane(paneId).selection, ...range] : range, rows[from].path, rows[to].path)
  }

  const moveTo = (to: number, extend: boolean): void => {
    if (!rows.length) return
    const i = clamp(to, 0, rows.length - 1)
    if (extend) {
      const a = indexOf(getPane(paneId).anchor)
      selectRange(a >= 0 ? a : i, i, false)
    } else setSelection(paneId, [rows[i].path], rows[i].path, rows[i].path)
    virtualizer.scrollToIndex(i, { align: 'auto' })
  }

  const typeAhead = (ch: string): void => {
    const now = Date.now()
    const ta = typeahead.current
    ta.text = now - ta.at > 900 ? ch : ta.text + ch
    ta.at = now
    const q = ta.text.toLowerCase()
    const repeat = [...q].every((c) => c === q[0])
    const needle = repeat ? q[0] : q
    const cur = indexOf(getPane(paneId).cursor)
    const start = repeat ? cur + 1 : Math.max(cur, 0)
    for (let k = 0; k < rows.length; k++) {
      const i = (start + k) % rows.length
      if (rows[i].name.toLowerCase().startsWith(needle)) {
        moveTo(i, false)
        return
      }
    }
  }

  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    if (target.closest('[data-sftp-header]') || target.closest('button')) return
    const i = rowIndex(target)
    const p = getPane(paneId)
    if (i < 0) {
      const el = e.currentTarget
      if (target === el && e.nativeEvent.offsetX >= el.clientWidth) return
      if (!isMod(e) && !e.shiftKey && p.selection.size) setSelection(paneId, [], undefined, undefined)
      return
    }
    const entry = rows[i]
    if (e.shiftKey) {
      const a = indexOf(p.anchor)
      selectRange(a >= 0 ? a : i, i, isMod(e))
    } else if (isMod(e)) {
      const next = new Set(p.selection)
      if (next.has(entry.path)) next.delete(entry.path)
      else next.add(entry.path)
      setSelection(paneId, next, entry.path, entry.path)
    } else if (p.selection.has(entry.path)) {
      // Might be the start of a drag of the whole selection: collapse it on click instead.
      pending.current = i
      setCursor(paneId, entry.path)
    } else setSelection(paneId, [entry.path], entry.path, entry.path)
  }

  const onClick = (e: React.MouseEvent): void => {
    const i = rowIndex(e.target)
    if (pending.current !== null && i === pending.current && !e.shiftKey && !isMod(e)) setSelection(paneId, [rows[i].path], rows[i].path, rows[i].path)
    pending.current = null
  }

  const onDoubleClick = (e: React.MouseEvent): void => {
    const i = rowIndex(e.target)
    if (i >= 0 && !e.shiftKey && !isMod(e)) openEntry(paneId, rows[i])
  }

  const onContextMenu = (e: React.MouseEvent): void => {
    const target = e.target as HTMLElement
    if (target.closest('[data-sftp-header]')) {
      e.preventDefault()
      return
    }
    const i = rowIndex(target)
    if (i < 0) {
      if (getPane(paneId).selection.size) setSelection(paneId, [], undefined, undefined)
      setMenu('empty')
      return
    }
    const entry = rows[i]
    if (!getPane(paneId).selection.has(entry.path)) setSelection(paneId, [entry.path], entry.path, entry.path)
    else setCursor(paneId, entry.path)
    setMenu('row')
  }

  const onDragStart = (e: React.DragEvent): void => {
    pending.current = null
    const i = rowIndex(e.target)
    if (i < 0 || atDrives) {
      e.preventDefault()
      return
    }
    const entry = rows[i]
    const p = getPane(paneId)
    let paths: string[]
    if (p.selection.has(entry.path)) paths = rows.filter((r) => p.selection.has(r.path)).map((r) => r.path)
    else {
      paths = [entry.path]
      setSelection(paneId, paths, entry.path, entry.path)
    }
    startDrag(e, { paneId, fsId: fs.id, dir: p.path, flavor: fs.flavor, paths }, paths.length === 1 ? entry.name : t('dragItems', { count: paths.length }))
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const p = getPane(paneId)
    const cur = indexOf(p.cursor)
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 300) / ROW_H) - 2)
    const focusEntry = (): FileEntry | undefined => (cur >= 0 ? rows[cur] : selected.length === 1 ? selected[0] : undefined)
    switch (e.key) {
      case 'ArrowDown':
        moveTo(cur < 0 ? 0 : cur + 1, e.shiftKey)
        break
      case 'ArrowUp':
        moveTo(cur < 0 ? 0 : cur - 1, e.shiftKey)
        break
      case 'Home':
        moveTo(0, e.shiftKey)
        break
      case 'End':
        moveTo(rows.length - 1, e.shiftKey)
        break
      case 'PageDown':
        moveTo(Math.max(cur, 0) + page, e.shiftKey)
        break
      case 'PageUp':
        moveTo(cur - page, e.shiftKey)
        break
      case 'Enter': {
        const entry = focusEntry()
        if (entry) openEntry(paneId, entry)
        break
      }
      case 'Delete':
        if (selected.length) void deleteEntries(paneId, selected)
        break
      case 'Backspace':
        if (isMac && e.metaKey) {
          if (selected.length) void deleteEntries(paneId, selected)
        } else goUp(paneId)
        break
      case 'F2': {
        const entry = focusEntry()
        if (entry) void renameEntry(paneId, entry)
        break
      }
      case 'F5':
        void refresh(paneId)
        break
      case 'Escape':
        if (!p.selection.size) return
        setSelection(paneId, [], undefined, undefined)
        break
      default:
        if (isMod(e) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'a') {
          setSelection(paneId, rows.map((r) => r.path), rows[0]?.path, p.cursor ?? rows[0]?.path)
          break
        }
        if (isMod(e) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'r') {
          void refresh(paneId)
          break
        }
        if (e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) {
          typeAhead(e.key)
          break
        }
        return
    }
    e.preventDefault()
    e.stopPropagation()
  }

  const items = virtualizer.getVirtualItems()
  const cursorPath = focused && pane.selection.size > 1 ? pane.cursor : undefined
  const locale = i18n.language

  return (
    <div className="relative min-h-0 flex-1">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={scrollRef}
            tabIndex={0}
            className="absolute inset-0 overflow-y-auto overflow-x-hidden outline-none"
            onMouseDown={onMouseDown}
            onClick={onClick}
            onDoubleClick={onDoubleClick}
            onContextMenu={onContextMenu}
            onDragStart={onDragStart}
            onDragEnd={endDrag}
            onKeyDown={onKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            data-testid={`sftp-list-${paneId}`}
          >
            <div className="relative w-full" style={{ height: Math.max(virtualizer.getTotalSize(), HEAD_H) }}>
              <ListHeader paneId={paneId} pane={pane} showOwner={showOwner} />
              {items.map((vi) => {
                const entry = rows[vi.index]
                if (!entry) return null
                return (
                  <Row
                    key={vi.key}
                    entry={entry}
                    index={vi.index}
                    start={vi.start}
                    selected={pane.selection.has(entry.path)}
                    cursor={cursorPath === entry.path}
                    drop={dropRow === entry.path}
                    showOwner={showOwner}
                    locale={locale}
                  />
                )
              })}
            </div>
            {rows.length === 0 && <ListPlaceholder paneId={paneId} pane={pane} />}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-[220px]">
          {menu === 'row' && selected.length > 0 ? <RowMenu paneId={paneId} pane={pane} fs={fs} selected={selected} /> : <EmptyMenu paneId={paneId} pane={pane} rows={rows} />}
        </ContextMenuContent>
      </ContextMenu>
      {pane.loading && pane.loaded && <div className="pointer-events-none absolute inset-x-0 top-0 z-20 h-0.5 bg-accent animate-soft-pulse" />}
    </div>
  )
}

// ------------------------------------------------------------------ header + rows

function ListHeader({ paneId, pane, showOwner }: { paneId: PaneId; pane: PaneState; showOwner: boolean }): React.JSX.Element {
  const { t } = useTranslation('sftp')
  const col = (key: SortKey, label: string, className: string): React.JSX.Element => {
    const active = pane.sort.key === key
    const Arrow = pane.sort.desc ? ChevronDown : ChevronUp
    return (
      <button
        type="button"
        onClick={() => toggleSort(paneId, key)}
        className={cn(
          'flex h-full min-w-0 cursor-default items-center gap-1 truncate text-left transition-colors hover:text-fg',
          active && 'text-muted',
          className.includes('text-right') && 'justify-end',
          className
        )}
        data-testid={`sftp-sort-${key}`}
      >
        <span className="truncate">{label}</span>
        {active && <Arrow className="size-3 shrink-0" />}
      </button>
    )
  }
  return (
    <div
      data-sftp-header=""
      className="sticky top-0 z-10 flex items-center gap-3 border-b border-line bg-panel px-3 text-[11px] font-semibold uppercase tracking-wide text-subtle"
      style={{ height: HEAD_H }}
    >
      {col('name', t('columns.name'), 'flex-1')}
      {col('mtime', t('columns.modified'), COL.mtime)}
      {col('size', t('columns.size'), COL.size)}
      {col('permissions', t('columns.permissions'), COL.perms)}
      {showOwner && col('owner', t('columns.owner'), COL.owner)}
    </div>
  )
}

interface RowProps {
  entry: FileEntry
  index: number
  start: number
  selected: boolean
  cursor: boolean
  drop: boolean
  showOwner: boolean
  locale: string
}

const Row = memo(function Row({ entry, index, start, selected, cursor, drop, showOwner, locale }: RowProps): React.JSX.Element {
  const dir = isDirEntry(entry)
  return (
    <div
      data-sftp-row=""
      data-index={index}
      data-path={entry.path}
      data-dir={dir ? '1' : undefined}
      data-testid="sftp-row"
      data-name={entry.name}
      data-selected={selected || undefined}
      draggable
      className={cn(
        'absolute left-1 right-1 top-0 flex cursor-default items-center gap-3 rounded-md px-2 text-[13px]',
        selected ? 'bg-accent-soft' : 'hover:bg-panel-hover',
        cursor && 'ring-1 ring-inset ring-accent/50',
        drop && 'bg-accent/15 ring-1 ring-inset ring-accent'
      )}
      style={{ height: ROW_H, transform: `translateY(${start}px)` }}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <EntryIcon entry={entry} className={cn('size-4 shrink-0', entry.hidden && 'opacity-50')} />
        <span className={cn('truncate', entry.hidden && 'text-muted')}>{entry.name}</span>
      </div>
      <div className={cn(COL.mtime, 'truncate text-xs tabular-nums text-muted')}>{entry.mtime ? formatDate(entry.mtime, locale) : '—'}</div>
      <div className={cn(COL.size, 'truncate text-xs tabular-nums text-muted')}>{dir || entry.type === 'other' ? '—' : formatBytes(entry.size)}</div>
      <div className={cn(COL.perms, 'truncate font-mono text-[11px] text-subtle')}>{entry.permissions}</div>
      {showOwner && (
        <div className={cn(COL.owner, 'truncate text-xs text-muted')} title={entry.owner ? `${entry.owner}${entry.group ? `:${entry.group}` : ''}` : undefined}>
          {entry.owner ?? ''}
        </div>
      )}
    </div>
  )
})

function ListPlaceholder({ paneId, pane }: { paneId: PaneId; pane: PaneState }): React.JSX.Element | null {
  const { t } = useTranslation('sftp')
  if (!pane.loaded) {
    return (
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center" style={{ top: HEAD_H }}>
        <LoaderCircle className="size-5 animate-spin text-subtle" />
      </div>
    )
  }
  const content = pane.filter.trim() ? (
    <EmptyState
      className="py-10"
      icon={<FolderSearch />}
      title={t('noMatches', { filter: pane.filter.trim() })}
      action={
        <Button size="sm" onClick={() => setFilter(paneId, '')}>
          {t('clearFilter')}
        </Button>
      }
    />
  ) : pane.entries.length > 0 ? (
    <EmptyState
      className="py-10"
      icon={<EyeOff />}
      title={t('onlyHidden')}
      action={
        <Button size="sm" onClick={() => void toggleHidden()}>
          <Eye />
          {t('showHidden')}
        </Button>
      }
    />
  ) : (
    <EmptyState className="py-10" icon={<FolderOpen />} title={t('emptyFolder')} description={canWriteHere(pane) ? t('emptyFolderHint') : undefined} />
  )
  return (
    <div className="absolute inset-x-0 bottom-0 flex items-center justify-center" style={{ top: HEAD_H }}>
      {content}
    </div>
  )
}

// ------------------------------------------------------------------ context menus

function Hint({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <span className="ml-auto pl-6 text-[11px] text-subtle">{children}</span>
}

function TransferIcon({ direction }: { direction: string }): React.JSX.Element {
  if (direction === 'upload') return <Upload />
  if (direction === 'download') return <Download />
  return <ArrowLeftRight />
}

function RowMenu({ paneId, pane, fs, selected }: { paneId: PaneId; pane: PaneState; fs: FsInfo; selected: FileEntry[] }): React.JSX.Element {
  const { t } = useTranslation('sftp')
  const { t: tc } = useTranslation()
  const single = selected.length === 1 ? selected[0] : undefined
  const paths = selected.map((e) => e.path)
  const plan = planTransfer(paneId, paths)
  const writable = canWriteHere(pane)
  const local = fs.kind === 'local'
  const file = single && isFileEntry(single) ? single : undefined
  return (
    <>
      {single && (
        <ContextMenuItem onSelect={() => openEntry(paneId, single)} className="font-medium">
          {isDirEntry(single) ? <FolderOpen /> : local ? <ExternalLink /> : <SquarePen />}
          {tc('open')}
          <Hint>Enter</Hint>
        </ContextMenuItem>
      )}
      {file && (
        <ContextMenuItem onSelect={() => editEntry(paneId, file)} data-testid="sftp-menu-edit">
          <SquarePen />
          {t('edit')}
        </ContextMenuItem>
      )}
      {file && (
        <ContextMenuItem onSelect={() => void editExternal(paneId, file)}>
          <AppWindow />
          {t('editExternal')}
        </ContextMenuItem>
      )}
      {local && single && (
        <ContextMenuItem onSelect={() => showInFolder(single)}>
          <FolderSearch />
          {t('showInFolder')}
        </ContextMenuItem>
      )}
      {single && <ContextMenuSeparator />}
      <ContextMenuItem disabled={!plan.ok} onSelect={() => void transferToOther(paneId, paths)} data-testid="sftp-menu-transfer">
        <TransferIcon direction={plan.direction} />
        <span className="truncate">{plan.label}</span>
      </ContextMenuItem>
      <ContextMenuSeparator />
      {single && (
        <ContextMenuItem disabled={!writable} onSelect={() => void renameEntry(paneId, single)}>
          <Pencil />
          {tc('rename')}
          <Hint>F2</Hint>
        </ContextMenuItem>
      )}
      {fs.flavor === 'posix' && (
        <ContextMenuItem disabled={!writable} onSelect={() => openPermissions(paneId, selected)} data-testid="sftp-menu-permissions">
          <LockKeyhole />
          {t('permissions')}
        </ContextMenuItem>
      )}
      <ContextMenuItem onSelect={() => void copyPaths(paths)}>
        <Copy />
        {selected.length > 1 ? t('copyPaths') : t('copyPath')}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem disabled={!writable} onSelect={() => void createFolder(paneId)}>
        <FolderPlus />
        {t('newFolder')}
      </ContextMenuItem>
      <ContextMenuItem disabled={!writable} onSelect={() => void createFile(paneId)}>
        <FilePlus />
        {t('newFile')}
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => void refresh(paneId)}>
        <RotateCw />
        {tc('refresh')}
        <Hint>F5</Hint>
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem danger disabled={!writable} onSelect={() => void deleteEntries(paneId, selected)} data-testid="sftp-menu-delete">
        <Trash2 />
        {selected.length > 1 ? t('deleteCount', { count: selected.length }) : tc('delete')}
        <Hint>{isMac ? '⌘⌫' : 'Del'}</Hint>
      </ContextMenuItem>
    </>
  )
}

function EmptyMenu({ paneId, pane, rows }: { paneId: PaneId; pane: PaneState; rows: FileEntry[] }): React.JSX.Element {
  const { t } = useTranslation('sftp')
  const { t: tc } = useTranslation()
  const showHidden = useApp((s) => s.settings.sftp.showHidden)
  const writable = canWriteHere(pane)
  return (
    <>
      <ContextMenuItem disabled={!writable} onSelect={() => void createFolder(paneId)}>
        <FolderPlus />
        {t('newFolder')}
      </ContextMenuItem>
      <ContextMenuItem disabled={!writable} onSelect={() => void createFile(paneId)}>
        <FilePlus />
        {t('newFile')}
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => void refresh(paneId)}>
        <RotateCw />
        {tc('refresh')}
        <Hint>F5</Hint>
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem disabled={!rows.length} onSelect={() => setSelection(paneId, rows.map((r) => r.path), rows[0]?.path, rows[0]?.path)}>
        <ListChecks />
        {tc('selectAll')}
        <Hint>{isMac ? '⌘A' : 'Ctrl+A'}</Hint>
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => void toggleHidden()}>
        {showHidden ? <EyeOff /> : <Eye />}
        {showHidden ? t('hideHidden') : t('showHidden')}
      </ContextMenuItem>
      {pane.path !== '' && (
        <ContextMenuItem onSelect={() => void copyPaths([pane.path])}>
          <Copy />
          {t('copyCurrentPath')}
        </ContextMenuItem>
      )}
    </>
  )
}
