import type { FileEntry, FsInfo } from '@shared/types'
import { parentPath, posixNormalize } from '@shared/util'
import type { HostData } from '@shared/schemas'

export type Flavor = FsInfo['flavor']
export type SortKey = 'name' | 'mtime' | 'size' | 'permissions' | 'owner'
export interface SortSpec {
  key: SortKey
  desc: boolean
}

/** A symlink whose target is a directory behaves like a folder. */
export function isDirEntry(e: Pick<FileEntry, 'type' | 'targetType'>): boolean {
  return e.type === 'dir' || (e.type === 'symlink' && e.targetType === 'dir')
}

/** Regular file or a symlink pointing to one (things that can be opened / edited). */
export function isFileEntry(e: Pick<FileEntry, 'type' | 'targetType'>): boolean {
  return e.type === 'file' || (e.type === 'symlink' && e.targetType === 'file')
}

export function isDriveEntry(e: Pick<FileEntry, 'path'>): boolean {
  return /^[a-zA-Z]:\\$/.test(e.path)
}

/** Canonical form used to compare paths (case-insensitive and without trailing separators on Windows). */
export function normPath(p: string, flavor: Flavor): string {
  if (flavor === 'posix') return posixNormalize(p || '/')
  const s = p.replace(/\//g, '\\')
  if (!s) return ''
  if (/^[a-zA-Z]:\\*$/.test(s)) return `${s.slice(0, 2).toLowerCase()}\\`
  return s.replace(/\\+$/, '').toLowerCase()
}

export function samePath(a: string, b: string, flavor: Flavor): boolean {
  return normPath(a, flavor) === normPath(b, flavor)
}

/** True when `child` equals `parent` or lies somewhere below it. */
export function isWithin(child: string, parent: string, flavor: Flavor): boolean {
  const c = normPath(child, flavor)
  const p = normPath(parent, flavor)
  if (c === p || p === '') return true
  const sep = flavor === 'posix' ? '/' : '\\'
  return c.startsWith(p.endsWith(sep) ? p : p + sep)
}

function normalizeWin(p: string): string {
  const s = p.replace(/\//g, '\\')
  const unc = s.startsWith('\\\\')
  const out: string[] = []
  for (const part of s.split('\\').filter(Boolean)) {
    if (part === '.') continue
    if (part === '..') {
      if (out.length > (unc ? 2 : 1)) out.pop()
      continue
    }
    out.push(part)
  }
  if (unc) return `\\\\${out.join('\\')}`
  if (out.length && /^[a-zA-Z]:$/.test(out[0])) out[0] = out[0].toUpperCase()
  if (out.length === 1 && /^[A-Z]:$/.test(out[0])) return `${out[0]}\\`
  return out.join('\\')
}

/** Resolves what the user typed into the path field (supports `~`, relative paths and `..`). */
export function resolveInputPath(input: string, fs: FsInfo, cur: string): string | null {
  let v = input.trim()
  if (fs.flavor === 'posix') {
    if (!v) return null
    if (v === '~' || v.startsWith('~/')) v = fs.home + v.slice(1)
    else if (!v.startsWith('/')) v = `${cur || '/'}/${v}`
    return posixNormalize(v)
  }
  v = v.replace(/\//g, '\\')
  if (!v) return ''
  if (v === '~' || v.startsWith('~\\')) v = fs.home + v.slice(1)
  else if (!/^[a-zA-Z]:/.test(v) && !v.startsWith('\\\\')) {
    if (!cur) return null
    v = `${cur}\\${v}`
  }
  return normalizeWin(v)
}

/** Parent of `p`, or null when already at the top. */
export function upPath(p: string, flavor: Flavor): string | null {
  const parent = parentPath(p, flavor)
  return samePath(parent, p, flavor) ? null : parent
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

function globToRegExp(glob: string): RegExp {
  const re = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${re}$`, 'i')
}

/** Filters (hidden + name filter, `*`/`?` wildcards supported) and sorts entries; folders always come first. */
export function visibleRows(entries: FileEntry[], showHidden: boolean, filter: string, sort: SortSpec): FileEntry[] {
  let rows = showHidden ? entries : entries.filter((e) => !e.hidden)
  const f = filter.trim()
  if (f) {
    if (/[*?]/.test(f)) {
      const re = globToRegExp(f)
      rows = rows.filter((e) => re.test(e.name))
    } else {
      const q = f.toLowerCase()
      rows = rows.filter((e) => e.name.toLowerCase().includes(q))
    }
  }
  const dir = sort.desc ? -1 : 1
  const cmp = (a: FileEntry, b: FileEntry): number => {
    switch (sort.key) {
      case 'mtime':
        return a.mtime - b.mtime
      case 'size':
        return a.size - b.size
      case 'permissions':
        return a.permissions < b.permissions ? -1 : a.permissions > b.permissions ? 1 : 0
      case 'owner':
        return collator.compare(a.owner ?? '', b.owner ?? '')
      default:
        return collator.compare(a.name, b.name)
    }
  }
  return [...rows].sort((a, b) => Number(isDirEntry(b)) - Number(isDirEntry(a)) || cmp(a, b) * dir || collator.compare(a.name, b.name))
}

export type Direction = 'upload' | 'download' | 'remote' | 'local'

export function directionOf(srcFsId: string, dstFsId: string): Direction {
  const srcLocal = srcFsId === 'local'
  const dstLocal = dstFsId === 'local'
  if (srcLocal && !dstLocal) return 'upload'
  if (!srcLocal && dstLocal) return 'download'
  return srcLocal ? 'local' : 'remote'
}

export interface TransferEnd {
  fsId: string
  dir: string
  flavor: Flavor
}

/** Returns an i18n key (namespace `sftp`) describing why a transfer is not possible, or null. */
export function transferProblem(src: TransferEnd & { paths: string[] }, dst: TransferEnd): string | null {
  if (!src.paths.length) return 'nothingSelected'
  if (dst.flavor === 'win32' && dst.dir === '') return 'noTargetFolder'
  if (src.flavor === 'win32' && src.dir === '') return 'cannotTransferDrives'
  if (src.fsId === dst.fsId) {
    if (samePath(src.dir, dst.dir, dst.flavor)) return 'sameFolder'
    if (src.paths.some((p) => isWithin(dst.dir, p, dst.flavor))) return 'intoItself'
  }
  return null
}

export function validateName(name: string, flavor: Flavor): 'nameRequired' | 'nameInvalid' | null {
  const v = name.trim()
  if (!v) return 'nameRequired'
  if (v === '.' || v === '..') return 'nameInvalid'
  if (flavor === 'posix' ? /[/\x00]/.test(v) : /[\\/:*?"<>|\x00-\x1f]/.test(v)) return 'nameInvalid'
  return null
}

export function hostTitle(h: HostData): string {
  return h.label || h.address
}

export function hostSubtitle(h: HostData): string {
  return `${h.username ? `${h.username}@` : ''}${h.address}${h.port && h.port !== 22 ? `:${h.port}` : ''}`
}

export function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1).toLowerCase() : ''
}
