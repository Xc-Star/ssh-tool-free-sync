import type { Readable, Writable } from 'node:stream'
import type { FileEntry } from '@shared/types'

/** Uniform file system API over the local disk and SFTP. */
export interface FsAdapter {
  readonly id: string
  readonly kind: 'local' | 'sftp'
  readonly flavor: 'posix' | 'win32'
  readonly label: string
  readonly hostId?: string
  home(): Promise<string>
  list(path: string): Promise<FileEntry[]>
  stat(path: string): Promise<FileEntry>
  /** Like stat but returns null when the path does not exist. */
  exists(path: string): Promise<FileEntry | null>
  realpath(path: string): Promise<string>
  mkdir(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  removeFile(path: string): Promise<void>
  removeDir(path: string): Promise<void>
  chmod(path: string, mode: number): Promise<void>
  utimes?(path: string, atime: number, mtime: number): Promise<void>
  createReadStream(path: string): Promise<Readable>
  createWriteStream(path: string, mode?: number): Promise<Writable>
  readFile(path: string): Promise<Buffer>
  writeFile(path: string, data: Buffer): Promise<void>
  join(dir: string, name: string): string
  dirname(p: string): string
  basename(p: string): string
  close(): void
}

export const S_IFMT = 0o170000
export const S_IFDIR = 0o040000
export const S_IFREG = 0o100000
export const S_IFLNK = 0o120000

export function typeFromMode(mode: number): FileEntry['type'] {
  const t = mode & S_IFMT
  if (t === S_IFDIR) return 'dir'
  if (t === S_IFLNK) return 'symlink'
  if (t === S_IFREG) return 'file'
  return 'other'
}

/** Sort: directories first, then case-insensitive natural name order. */
export function sortEntries(entries: FileEntry[]): FileEntry[] {
  const isDir = (e: FileEntry): boolean => e.type === 'dir' || (e.type === 'symlink' && e.targetType === 'dir')
  return entries.sort((a, b) => {
    const d = Number(isDir(b)) - Number(isDir(a))
    if (d) return d
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  })
}

export function isDirEntry(e: FileEntry): boolean {
  return e.type === 'dir' || (e.type === 'symlink' && e.targetType === 'dir')
}
