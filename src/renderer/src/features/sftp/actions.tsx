import { toast } from 'sonner'
import type { FileEntry } from '@shared/types'
import { joinPath, parentPath } from '@shared/util'
import i18n from '@/i18n'
import { confirm, promptText } from '@/components/ui/confirm'
import { call, errorMessage, isWin } from '@/lib/api'
import { copyText } from '@/lib/utils'
import { useApp } from '@/stores/app'
import { useTransfers } from '@/stores/prompts'
import { getItem } from '@/stores/vault'
import {
  connect,
  getPane,
  navigate,
  openChmodDialog,
  openEditorDialog,
  otherPane,
  type PaneId,
  type PaneSource,
  type PaneState,
  refreshMatching
} from './store'
import { type Direction, directionOf, isDirEntry, isFileEntry, isWithin, samePath, type TransferEnd, transferProblem, upPath, validateName } from './utils'

const t = (key: string, opts?: Record<string, unknown>): string => i18n.t(key, { ns: 'sftp', ...opts })
const tc = (key: string, opts?: Record<string, unknown>): string => i18n.t(key, { ns: 'common', ...opts })

function fail(titleKey: string, err: unknown): void {
  toast.error(t(titleKey), { description: errorMessage(err) })
}

/** True when the pane shows a real folder that can receive new files (not the Windows drive list). */
export function canWriteHere(p: PaneState): boolean {
  return p.status === 'ready' && !!p.fs && p.loaded && !p.listError && !(p.fs.flavor === 'win32' && p.path === '')
}

// ------------------------------------------------------------------ sources

/** Number of queued/running transfers that use the pane's current remote file system. */
function activeTransfersOn(id: PaneId): number {
  const fs = getPane(id).fs
  if (!fs || fs.kind !== 'sftp') return 0
  return useTransfers
    .getState()
    .transfers.filter((x) => (x.status === 'queued' || x.status === 'running') && (x.srcFsId === fs.id || x.dstFsId === fs.id)).length
}

/** Changes the source of a pane, asking first when transfers on the current connection are still running. */
export async function switchSource(id: PaneId, source: PaneSource): Promise<void> {
  const p = getPane(id)
  const cur = p.source
  const same = cur.kind === source.kind && (cur.kind !== 'host' || (source.kind === 'host' && cur.hostId === source.hostId))
  if (same && source.kind !== 'none' && (p.status === 'ready' || p.status === 'connecting')) return
  const active = activeTransfersOn(id)
  if (active) {
    const ok = await confirm({
      title: t('activeTransfersTitle'),
      message: t('activeTransfersMessage', { count: active }),
      confirmLabel: t('disconnectAnyway'),
      danger: true
    })
    if (!ok) return
  }
  await connect(id, source)
}

// ------------------------------------------------------------------ navigation helpers

export function goUp(id: PaneId): void {
  const p = getPane(id)
  if (!p.fs) return
  const up = upPath(p.path, p.fs.flavor)
  if (up === null) return
  // Select the folder we came from so keyboard users keep their place.
  void navigate(id, up, { select: [p.path] })
}

export function openEntry(id: PaneId, entry: FileEntry): void {
  const p = getPane(id)
  const fs = p.fs
  if (!fs) return
  if (isDirEntry(entry)) {
    void navigate(id, entry.path)
    return
  }
  if (entry.type === 'symlink' && !entry.targetType) {
    toast.warning(t('brokenLink'))
    return
  }
  if (!isFileEntry(entry)) {
    toast.warning(t('cannotOpenType'))
    return
  }
  if (fs.kind === 'local') {
    void call('fs.openLocalPath', entry.path).catch((err) => fail('openFailed', err))
    return
  }
  editEntry(id, entry)
}

export function editEntry(id: PaneId, entry: FileEntry): void {
  const p = getPane(id)
  if (!p.fs || !isFileEntry(entry)) return
  openEditorDialog({ fsId: p.fs.id, path: entry.path, name: entry.name, dir: p.path, flavor: p.fs.flavor })
}

export async function editExternal(id: PaneId, entry: FileEntry): Promise<void> {
  const fs = getPane(id).fs
  if (!fs || !isFileEntry(entry)) return
  try {
    await call('fs.editExternal', fs.id, entry.path)
    if (fs.kind === 'sftp') toast.info(t('externalEditStarted', { name: entry.name }), { description: t('externalEditHint') })
  } catch (err) {
    fail('openFailed', err)
  }
}

export function showInFolder(entry: FileEntry): void {
  void call('app.showItemInFolder', entry.path).catch((err) => fail('openFailed', err))
}

export async function copyPaths(paths: string[]): Promise<void> {
  if (!paths.length) return
  try {
    await copyText(paths.join('\n'))
    toast.success(tc('copied'))
  } catch (err) {
    toast.error(errorMessage(err))
  }
}

export async function toggleHidden(): Promise<void> {
  const { settings, updateSettings } = useApp.getState()
  await updateSettings({ sftp: { ...settings.sftp, showHidden: !settings.sftp.showHidden } }).catch((err) => toast.error(errorMessage(err)))
}

// ------------------------------------------------------------------ file operations

async function createItem(id: PaneId, kind: 'folder' | 'file'): Promise<void> {
  const p = getPane(id)
  const fs = p.fs
  if (!fs || !canWriteHere(p)) return
  const dir = p.path
  const name = await promptText({
    title: kind === 'folder' ? t('newFolder') : t('newFile'),
    label: kind === 'folder' ? t('folderName') : t('fileName'),
    placeholder: kind === 'folder' ? t('folderPlaceholder') : t('filePlaceholder'),
    confirmLabel: tc('create'),
    validate: (v) => {
      const problem = validateName(v, fs.flavor)
      return problem ? t(problem) : undefined
    }
  })
  if (name === null) return
  const path = joinPath(dir, name.trim(), fs.flavor)
  try {
    await call(kind === 'folder' ? 'fs.mkdir' : 'fs.newFile', fs.id, path)
  } catch (err) {
    fail(kind === 'folder' ? 'mkdirFailed' : 'newFileFailed', err)
    return
  }
  await refreshMatching(fs.id, dir, [path])
}

export const createFolder = (id: PaneId): Promise<void> => createItem(id, 'folder')
export const createFile = (id: PaneId): Promise<void> => createItem(id, 'file')

export async function renameEntry(id: PaneId, entry: FileEntry): Promise<void> {
  const p = getPane(id)
  const fs = p.fs
  if (!fs || !canWriteHere(p)) return
  const dir = p.path
  const name = await promptText({
    title: tc('rename'),
    label: t('newName'),
    initial: entry.name,
    selectStem: !isDirEntry(entry),
    confirmLabel: tc('rename'),
    validate: (v) => {
      const problem = validateName(v, fs.flavor)
      return problem ? t(problem) : undefined
    }
  })
  if (name === null || name.trim() === entry.name) return
  const to = joinPath(dir, name.trim(), fs.flavor)
  try {
    await call('fs.rename', fs.id, entry.path, to)
  } catch (err) {
    fail('renameFailed', err)
    return
  }
  await refreshMatching(fs.id, dir, [to])
}

export async function deleteEntries(id: PaneId, entries: FileEntry[]): Promise<void> {
  const p = getPane(id)
  const fs = p.fs
  if (!fs || !entries.length || !canWriteHere(p)) return
  const dir = p.path
  const hasDir = entries.some(isDirEntry)
  const ok = await confirm({
    title: tc('deleteConfirmTitle'),
    message: (
      <>
        {entries.length === 1 ? tc('deleteConfirm', { name: entries[0].name }) : tc('deleteManyConfirm', { count: entries.length })}
        {hasDir && <span className="mt-2 block text-xs text-subtle">{t('deleteFolderHint')}</span>}
      </>
    ),
    confirmLabel: tc('delete'),
    danger: true
  })
  if (!ok) return
  const tid = toast.loading(t('deleting', { count: entries.length }))
  try {
    await call(
      'fs.remove',
      fs.id,
      entries.map((e) => e.path)
    )
    toast.success(tc('deletedToast'), { id: tid })
  } catch (err) {
    toast.error(t('deleteFailed'), { id: tid, description: errorMessage(err) })
  }
  await refreshMatching(fs.id, dir)
}

export function openPermissions(id: PaneId, entries: FileEntry[]): void {
  const p = getPane(id)
  if (!p.fs || !entries.length) return
  openChmodDialog({ fsId: p.fs.id, dir: p.path, entries })
}

// ------------------------------------------------------------------ transfers

export interface TransferPlan {
  ok: boolean
  direction: Direction
  label: string
  /** Why the transfer is not possible (only when !ok). */
  reason?: string
}

function fsTitle(p: PaneState): string {
  if (!p.fs) return ''
  if (p.fs.kind === 'local') return t('local')
  const hostId = p.source.kind === 'host' ? p.source.hostId : p.fs.hostId
  const host = getItem('host', hostId)
  return host ? host.data.label || host.data.address : p.fs.label
}

/** Describes "transfer the selection of `id` to the other pane" (label + whether it is currently possible). */
export function planTransfer(id: PaneId, paths: string[]): TransferPlan {
  const src = getPane(id)
  const dst = getPane(otherPane(id))
  if (!src.fs || !dst.fs || dst.status !== 'ready' || !dst.loaded || dst.listError) {
    return { ok: false, direction: 'remote', label: t('transferToOther'), reason: t('otherPaneNotReady') }
  }
  const direction = directionOf(src.fs.id, dst.fs.id)
  const target = fsTitle(dst)
  const label =
    direction === 'upload'
      ? t('uploadTo', { target })
      : direction === 'download'
        ? t('downloadLocal')
        : direction === 'remote'
          ? t('copyTo', { target })
          : t('copyLocal')
  const problem = transferProblem({ fsId: src.fs.id, dir: src.path, flavor: src.fs.flavor, paths }, { fsId: dst.fs.id, dir: dst.path, flavor: dst.fs.flavor })
  return problem ? { ok: false, direction, label, reason: t(problem) } : { ok: true, direction, label }
}

export async function enqueueTransfer(src: TransferEnd & { paths: string[] }, dst: TransferEnd): Promise<boolean> {
  const problem = transferProblem(src, dst)
  if (problem) {
    toast.warning(t(problem))
    return false
  }
  try {
    await call('transfer.enqueue', { srcFsId: src.fsId, srcPaths: src.paths, dstFsId: dst.fsId, dstDir: dst.dir })
    return true
  } catch (err) {
    fail('transferFailed', err)
    return false
  }
}

/** Copies the given paths of pane `id` into the folder shown by the other pane (or `dstDir`). */
export async function transferToOther(id: PaneId, paths: string[], dstDir?: string): Promise<void> {
  const src = getPane(id)
  const dst = getPane(otherPane(id))
  if (!src.fs || !dst.fs || dst.status !== 'ready' || !dst.loaded) {
    toast.warning(t('otherPaneNotReady'))
    return
  }
  await enqueueTransfer(
    { fsId: src.fs.id, dir: src.path, flavor: src.fs.flavor, paths },
    { fsId: dst.fs.id, dir: dstDir ?? dst.path, flavor: dst.fs.flavor }
  )
}

/** Files dropped from the OS file manager onto a pane. */
export async function uploadLocalPaths(id: PaneId, localPaths: string[], dstDir: string): Promise<void> {
  const dst = getPane(id)
  const fs = dst.fs
  if (!fs || !localPaths.length) return
  let paths = localPaths
  const localFlavor = isWin ? 'win32' : 'posix'
  if (fs.kind === 'local') {
    // Dropping files back into the folder they come from (or a folder into itself) is a no-op.
    paths = paths.filter((p) => !samePath(parentPath(p, fs.flavor), dstDir, fs.flavor) && !isWithin(dstDir, p, fs.flavor))
    if (!paths.length) {
      toast.warning(t('sameFolder'))
      return
    }
  }
  await enqueueTransfer({ fsId: 'local', dir: parentPath(paths[0], localFlavor), flavor: localFlavor, paths }, { fsId: fs.id, dir: dstDir, flavor: fs.flavor })
}
