import { ArrowLeft, ArrowLeftRight, ArrowRight, ArrowUp, Download, Eye, EyeOff, FilePlus, FolderPlus, House, LoaderCircle, Pencil, RotateCw, Search, TriangleAlert, Upload, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FsInfo } from '@shared/types'
import { formatBytes } from '@shared/util'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/controls'
import { getPathForFile } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useApp } from '@/stores/app'
import { openEditor } from '@/stores/ui'
import { getItem } from '@/stores/vault'
import { canWriteHere, createFile, createFolder, enqueueTransfer, goUp, planTransfer, switchSource, toggleHidden, transferToOther, uploadLocalPaths } from './actions'
import { currentDrag, endDrag, isOsFileDrag, isPaneDrag } from './dnd'
import { FileList } from './FileList'
import { SourceAvatar } from './icons'
import { PathBar } from './PathBar'
import { HostPicker, SourceSwitcher, useSourceTitle } from './SourcePicker'
import { getPane, goBack, goForward, goHome, otherPane, type PaneId, type PaneState, refresh, retryConnect, setFilter, usePane } from './store'
import { type Direction, directionOf, hostSubtitle, isDirEntry, transferProblem, upPath, visibleRows } from './utils'

interface DropTarget {
  dir: string
  /** Folder row under the pointer (when dropping into a sub folder). */
  row?: string
  direction: Direction
}

function IconButton({
  tip,
  onClick,
  disabled,
  active,
  children,
  testId,
  className
}: {
  tip: string
  onClick: () => void
  disabled?: boolean
  active?: boolean
  children: React.ReactNode
  testId?: string
  className?: string
}): React.JSX.Element {
  return (
    <Tip content={tip}>
      <span className="inline-flex">
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onClick}
          disabled={disabled}
          aria-label={tip}
          data-testid={testId}
          className={cn(active && 'bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent', className)}
        >
          {children}
        </Button>
      </span>
    </Tip>
  )
}

export function FilePane({ paneId }: { paneId: PaneId }): React.JSX.Element {
  const pane = usePane(paneId)
  const showHidden = useApp((s) => s.settings.sftp.showHidden)
  const [drop, setDrop] = useState<DropTarget | null>(null)
  const rows = useMemo(() => visibleRows(pane.entries, showHidden, pane.filter, pane.sort), [pane.entries, showHidden, pane.filter, pane.sort])
  const selected = useMemo(() => rows.filter((r) => pane.selection.has(r.path)), [rows, pane.selection])
  const ready = pane.status === 'ready' && !!pane.fs

  const resolveDrop = (e: React.DragEvent): DropTarget | null => {
    const p = getPane(paneId)
    const fs = p.fs
    if (!fs || p.status !== 'ready' || !p.loaded || p.listError) return null
    const internal = isPaneDrag(e)
    const drag = internal ? currentDrag() : null
    if (internal ? !drag || drag.paneId === paneId : !isOsFileDrag(e)) return null
    const candidates: { dir: string; row?: string }[] = []
    const rowEl = (e.target as HTMLElement).closest?.('[data-sftp-row]') as HTMLElement | null
    if (rowEl?.dataset.dir === '1' && rowEl.dataset.path) candidates.push({ dir: rowEl.dataset.path, row: rowEl.dataset.path })
    candidates.push({ dir: p.path })
    for (const c of candidates) {
      if (drag ? transferProblem(drag, { fsId: fs.id, dir: c.dir, flavor: fs.flavor }) : fs.flavor === 'win32' && c.dir === '') continue
      return { ...c, direction: directionOf(drag ? drag.fsId : 'local', fs.id) }
    }
    return null
  }

  const onDragOver = (e: React.DragEvent): void => {
    const target = resolveDrop(e)
    if (!target) {
      if (drop) setDrop(null)
      return
    }
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    if (drop?.dir !== target.dir || drop?.row !== target.row) setDrop(target)
  }

  const onDrop = (e: React.DragEvent): void => {
    const target = resolveDrop(e)
    setDrop(null)
    if (!target) return
    e.preventDefault()
    const fs = getPane(paneId).fs!
    const drag = isPaneDrag(e) ? currentDrag() : null
    endDrag()
    if (drag) void enqueueTransfer(drag, { fsId: fs.id, dir: target.dir, flavor: fs.flavor })
    else {
      const paths = Array.from(e.dataTransfer.files)
        .map((f) => getPathForFile(f))
        .filter(Boolean)
      void uploadLocalPaths(paneId, paths, target.dir)
    }
  }

  return (
    <div
      data-testid={`sftp-pane-${paneId}`}
      className={cn(
        '@container relative flex h-full min-w-0 flex-col overflow-hidden rounded-lg border bg-panel transition-colors',
        drop && !drop.row ? 'border-accent ring-2 ring-accent/30' : 'border-line focus-within:border-line-strong'
      )}
      onDragOver={onDragOver}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null)
      }}
      onDrop={onDrop}
    >
      <PaneHeader paneId={paneId} pane={pane} selectedPaths={selected.map((e) => e.path)} />
      {ready && pane.fs ? (
        <>
          <PathRow paneId={paneId} pane={pane} fs={pane.fs} />
          {pane.listError ? (
            <ListError paneId={paneId} pane={pane} fs={pane.fs} />
          ) : (
            <FileList paneId={paneId} pane={pane} fs={pane.fs} rows={rows} selected={selected} dropRow={drop?.row} />
          )}
          <StatusBar pane={pane} rows={rows} selected={selected} showHidden={showHidden} />
        </>
      ) : pane.source.kind === 'none' ? (
        <HostPicker paneId={paneId} />
      ) : pane.status === 'error' ? (
        <ConnectError paneId={paneId} pane={pane} />
      ) : (
        <Connecting paneId={paneId} pane={pane} />
      )}
      {drop && <DropHint target={drop} />}
    </div>
  )
}

// ------------------------------------------------------------------ header / toolbars

function PaneHeader({ paneId, pane, selectedPaths }: { paneId: PaneId; pane: PaneState; selectedPaths: string[] }): React.JSX.Element {
  const { t } = useTranslation('sftp')
  const { t: tc } = useTranslation()
  const showHidden = useApp((s) => s.settings.sftp.showHidden)
  // The transfer button depends on the other pane (connected? which folder?), so re-render when it changes.
  usePane(otherPane(paneId))
  const ready = pane.status === 'ready' && !!pane.fs
  const writable = canWriteHere(pane)
  const plan = planTransfer(paneId, selectedPaths)
  const TransferGlyph = plan.direction === 'upload' ? Upload : plan.direction === 'download' ? Download : ArrowLeftRight
  return (
    <div className="flex h-11 shrink-0 items-center gap-1 border-b border-line pl-1.5 pr-1.5">
      <SourceSwitcher paneId={paneId} pane={pane} />
      <div className="min-w-2 flex-1" />
      {ready && (
        <>
          <FilterInput paneId={paneId} value={pane.filter} />
          <div className="mx-0.5 h-4 w-px shrink-0 bg-line" />
          <IconButton tip={showHidden ? t('hideHidden') : t('showHidden')} active={showHidden} onClick={() => void toggleHidden()} testId={`sftp-toggle-hidden-${paneId}`}>
            {showHidden ? <Eye /> : <EyeOff />}
          </IconButton>
          <IconButton tip={t('newFolder')} disabled={!writable} onClick={() => void createFolder(paneId)} testId="sftp-new-folder">
            <FolderPlus />
          </IconButton>
          <IconButton tip={t('newFile')} disabled={!writable} onClick={() => void createFile(paneId)} testId={`sftp-new-file-${paneId}`}>
            <FilePlus />
          </IconButton>
          <IconButton tip={tc('refresh')} onClick={() => void refresh(paneId)} testId={`sftp-refresh-${paneId}`}>
            <RotateCw className={cn(pane.loading && 'animate-spin')} />
          </IconButton>
          <IconButton
            tip={selectedPaths.length ? (plan.ok ? plan.label : (plan.reason ?? plan.label)) : t('transferHint')}
            disabled={!selectedPaths.length || !plan.ok}
            onClick={() => void transferToOther(paneId, selectedPaths)}
            testId={`sftp-transfer-${paneId}`}
            className={cn(selectedPaths.length > 0 && plan.ok && 'text-accent hover:text-accent')}
          >
            <TransferGlyph />
          </IconButton>
        </>
      )}
    </div>
  )
}

function FilterInput({ paneId, value }: { paneId: PaneId; value: string }): React.JSX.Element {
  const { t } = useTranslation('sftp')
  return (
    <div className="relative flex w-24 min-w-0 shrink items-center @md:w-32 @xl:w-40">
      <Search className="pointer-events-none absolute left-2 size-3.5 text-subtle" />
      <input
        value={value}
        onChange={(e) => setFilter(paneId, e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.preventDefault()
            setFilter(paneId, '')
          }
        }}
        placeholder={t('filterPlaceholder')}
        spellCheck={false}
        data-testid={`sftp-filter-${paneId}`}
        className="h-7 w-full rounded-md border border-line bg-input pl-7 pr-6 text-xs text-fg outline-none transition-colors placeholder:text-subtle focus:border-accent focus:ring-2 focus:ring-accent/20"
      />
      {value && (
        <button type="button" onClick={() => setFilter(paneId, '')} className="absolute right-1 rounded p-0.5 text-subtle hover:text-fg" aria-label={t('clearFilter')}>
          <X className="size-3" />
        </button>
      )}
    </div>
  )
}

function PathRow({ paneId, pane, fs }: { paneId: PaneId; pane: PaneState; fs: FsInfo }): React.JSX.Element {
  const { t } = useTranslation('sftp')
  const canUp = upPath(pane.path, fs.flavor) !== null && (pane.loaded || !!pane.listError)
  return (
    <div className="flex h-10 shrink-0 items-center gap-0.5 border-b border-line px-1.5">
      <IconButton tip={t('back')} disabled={pane.historyIndex <= 0} onClick={() => goBack(paneId)} testId={`sftp-back-${paneId}`}>
        <ArrowLeft />
      </IconButton>
      <IconButton tip={t('forward')} disabled={pane.historyIndex >= pane.history.length - 1} onClick={() => goForward(paneId)} testId={`sftp-forward-${paneId}`}>
        <ArrowRight />
      </IconButton>
      <IconButton tip={t('up')} disabled={!canUp} onClick={() => goUp(paneId)} testId={`sftp-up-${paneId}`}>
        <ArrowUp />
      </IconButton>
      <IconButton tip={t('home')} onClick={() => goHome(paneId)} testId={`sftp-home-${paneId}`}>
        <House />
      </IconButton>
      <div className="ml-1 flex min-w-0 flex-1">
        <PathBar key={`${fs.id}:${pane.path}`} paneId={paneId} fs={fs} path={pane.path} />
      </div>
    </div>
  )
}

function StatusBar({ pane, rows, selected, showHidden }: { pane: PaneState; rows: PaneState['entries']; selected: PaneState['entries']; showHidden: boolean }): React.JSX.Element {
  const { t } = useTranslation('sftp')
  const hidden = showHidden ? 0 : pane.entries.reduce((n, e) => n + (e.hidden ? 1 : 0), 0)
  const folders = rows.reduce((n, e) => n + (isDirEntry(e) ? 1 : 0), 0)
  const selSize = selected.reduce((n, e) => n + (isDirEntry(e) ? 0 : e.size), 0)
  return (
    <div className="flex h-7 shrink-0 items-center gap-3 border-t border-line px-3 text-[11px] text-subtle">
      <span className="truncate">
        {t('folderCount', { count: folders })} · {t('fileCount', { count: rows.length - folders })}
        {hidden > 0 && ` · ${t('hiddenCount', { count: hidden })}`}
      </span>
      <div className="flex-1" />
      {selected.length > 0 && (
        <span className="shrink-0 font-medium text-muted" data-testid="sftp-selection-info">
          {t('selectedCount', { count: selected.length })}
          {selSize > 0 && ` · ${formatBytes(selSize)}`}
        </span>
      )}
    </div>
  )
}

function DropHint({ target }: { target: DropTarget }): React.JSX.Element {
  const { t } = useTranslation('sftp')
  const name = target.dir.split(/[\\/]/).filter(Boolean).pop() ?? target.dir
  const key = target.direction === 'upload' ? 'dropUpload' : target.direction === 'download' ? 'dropDownload' : 'dropCopy'
  const Icon = target.direction === 'upload' ? Upload : target.direction === 'download' ? Download : ArrowLeftRight
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-10 z-30 flex justify-center px-4">
      <div className="flex max-w-full items-center gap-2 rounded-full bg-accent px-3.5 py-1.5 text-xs font-medium text-white shadow-pop">
        <Icon className="size-3.5 shrink-0" />
        <span className="truncate">{t(key, { name: name || '/' })}</span>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ connection states

function useHostInfo(pane: PaneState): { title: string; subtitle: string } {
  const title = useSourceTitle(pane)
  const host = pane.source.kind === 'host' ? getItem('host', pane.source.hostId) : undefined
  return { title, subtitle: host ? hostSubtitle(host.data) : '' }
}

function Connecting({ paneId, pane }: { paneId: PaneId; pane: PaneState }): React.JSX.Element {
  const { t } = useTranslation('sftp')
  const { t: tc } = useTranslation()
  const { title, subtitle } = useHostInfo(pane)
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 overflow-y-auto p-6 text-center" data-testid={`sftp-connecting-${paneId}`}>
      <div className="relative">
        <SourceAvatar source={pane.source} size="lg" />
        <span className="absolute -bottom-1 -right-1 flex size-6 items-center justify-center rounded-full border-2 border-panel bg-accent text-white">
          <LoaderCircle className="size-3.5 animate-spin" />
        </span>
      </div>
      <div>
        <div className="text-[15px] font-semibold">{title}</div>
        {subtitle && <div className="mt-0.5 font-mono text-xs text-muted">{subtitle}</div>}
      </div>
      <div className="text-[13px] text-muted">{t('connecting')}</div>
      {pane.source.kind === 'host' && (
        <Button size="sm" variant="ghost" onClick={() => void switchSource(paneId, { kind: 'none' })}>
          {tc('cancel')}
        </Button>
      )}
    </div>
  )
}

function ConnectError({ paneId, pane }: { paneId: PaneId; pane: PaneState }): React.JSX.Element {
  const { t } = useTranslation('sftp')
  const { t: tc } = useTranslation()
  const { title, subtitle } = useHostInfo(pane)
  const hostId = pane.source.kind === 'host' ? pane.source.hostId : undefined
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 overflow-y-auto p-6 text-center" data-testid={`sftp-error-${paneId}`}>
      <div className="relative">
        <SourceAvatar source={pane.source} size="lg" />
        <span className="absolute -bottom-1 -right-1 flex size-6 items-center justify-center rounded-full border-2 border-panel bg-danger text-white">
          <TriangleAlert className="size-3" />
        </span>
      </div>
      <div>
        <div className="text-[15px] font-semibold">{title}</div>
        {subtitle && <div className="mt-0.5 font-mono text-xs text-muted">{subtitle}</div>}
      </div>
      <div className="text-[13px] font-medium text-danger">{t('connectFailed')}</div>
      {pane.error && <div className="selectable max-w-md break-words rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{pane.error}</div>}
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button size="sm" variant="primary" onClick={() => retryConnect(paneId)}>
          <RotateCw />
          {tc('retry')}
        </Button>
        {hostId && (
          <Button size="sm" onClick={() => openEditor('host', hostId)}>
            <Pencil />
            {t('editHost')}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => void switchSource(paneId, { kind: 'none' })}>
          {t('chooseAnother')}
        </Button>
      </div>
    </div>
  )
}

function ListError({ paneId, pane, fs }: { paneId: PaneId; pane: PaneState; fs: FsInfo }): React.JSX.Element {
  const { t } = useTranslation('sftp')
  const { t: tc } = useTranslation()
  const canUp = upPath(pane.path, fs.flavor) !== null
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-y-auto p-6 text-center" data-testid={`sftp-list-error-${paneId}`}>
      <div className="flex size-12 items-center justify-center rounded-2xl bg-danger/10 text-danger">
        <TriangleAlert className="size-6" />
      </div>
      <div className="text-[14px] font-semibold">{t('listFailed')}</div>
      <div className="selectable max-w-md break-words rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{pane.listError}</div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button size="sm" variant="primary" onClick={() => void refresh(paneId)}>
          <RotateCw />
          {tc('retry')}
        </Button>
        {canUp && (
          <Button size="sm" onClick={() => goUp(paneId)}>
            <ArrowUp />
            {t('goUp')}
          </Button>
        )}
        <Button size="sm" onClick={() => goHome(paneId)}>
          <House />
          {t('goHome')}
        </Button>
        {fs.kind === 'sftp' && (
          <Button size="sm" variant="ghost" onClick={() => retryConnect(paneId)}>
            {t('reconnect')}
          </Button>
        )}
      </div>
    </div>
  )
}
