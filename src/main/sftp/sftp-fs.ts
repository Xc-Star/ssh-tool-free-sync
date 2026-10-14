import type { Readable, Writable } from 'node:stream'
import type { SFTPWrapper, Stats } from 'ssh2'
import type { FileEntry } from '@shared/types'
import { modeToPermissions, posixBasename, posixDirname, posixJoin } from '@shared/util'
import type { SshConnection } from '../ssh/connect'
import { type FsAdapter, sortEntries, typeFromMode } from './fs-types'

const STATUS_NO_SUCH_FILE = 2

function attrsToEntry(name: string, full: string, attrs: { mode: number; size: number; mtime: number }, longname?: string): FileEntry {
  const type = typeFromMode(attrs.mode)
  let owner: string | undefined
  let group: string | undefined
  if (longname) {
    const parts = longname.split(/\s+/)
    if (parts.length >= 9) {
      owner = parts[2]
      group = parts[3]
    }
  }
  return {
    name,
    path: full,
    type,
    size: type === 'dir' ? 0 : Number(attrs.size ?? 0),
    mtime: Number(attrs.mtime ?? 0) * 1000,
    mode: attrs.mode & 0o7777,
    permissions: modeToPermissions(attrs.mode & 0o777, type),
    owner,
    group,
    hidden: name.startsWith('.')
  }
}

export function openSftpChannel(conn: SshConnection): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => conn.client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp))))
}

function wrapErr(err: unknown, path: string): Error {
  const e = err as { code?: number; message?: string }
  if (e?.code === STATUS_NO_SUCH_FILE) return Object.assign(new Error(`No such file: ${path}`), { code: 'ENOENT' })
  if (e?.code === 3) return Object.assign(new Error(`Permission denied: ${path}`), { code: 'EACCES' })
  return err instanceof Error ? err : new Error(String(err))
}

/** SFTP file system over an SSH connection. */
export class SftpFs implements FsAdapter {
  readonly kind = 'sftp' as const
  readonly flavor = 'posix' as const
  private homeDir?: string

  constructor(
    readonly id: string,
    readonly label: string,
    readonly hostId: string | undefined,
    readonly conn: SshConnection,
    readonly sftp: SFTPWrapper,
    private readonly onClose?: () => void
  ) {}

  private call<T>(fn: (cb: (err: Error | null | undefined, res?: T) => void) => void, p: string): Promise<T> {
    return new Promise((resolve, reject) => fn((err, res) => (err ? reject(wrapErr(err, p)) : resolve(res as T))))
  }

  async home(): Promise<string> {
    if (!this.homeDir) this.homeDir = await this.realpath('.')
    return this.homeDir
  }

  async list(dir: string): Promise<FileEntry[]> {
    const list = await this.call<{ filename: string; longname: string; attrs: Stats }[]>((cb) => this.sftp.readdir(dir, cb as any), dir)
    const entries = list
      .filter((f) => f.filename !== '.' && f.filename !== '..')
      .map((f) => attrsToEntry(f.filename, posixJoin(dir, f.filename), f.attrs, f.longname))
    const links = entries.filter((e) => e.type === 'symlink')
    await Promise.all(
      links.map(async (e) => {
        try {
          const st = await this.call<Stats>((cb) => this.sftp.stat(e.path, cb as any), e.path)
          e.targetType = typeFromMode(st.mode)
          if (e.targetType === 'file') e.size = Number(st.size)
        } catch {
          e.targetType = undefined
        }
      })
    )
    return sortEntries(entries)
  }

  async stat(p: string): Promise<FileEntry> {
    const st = await this.call<Stats>((cb) => this.sftp.stat(p, cb as any), p)
    return attrsToEntry(posixBasename(p), p, st)
  }

  async exists(p: string): Promise<FileEntry | null> {
    try {
      return await this.stat(p)
    } catch {
      return null
    }
  }

  realpath(p: string): Promise<string> {
    return this.call<string>((cb) => this.sftp.realpath(p, cb as any), p)
  }

  mkdir(p: string): Promise<void> {
    return this.call<void>((cb) => this.sftp.mkdir(p, cb as any), p)
  }

  async rename(from: string, to: string): Promise<void> {
    await this.call<void>((cb) => this.sftp.rename(from, to, cb as any), from)
  }

  removeFile(p: string): Promise<void> {
    return this.call<void>((cb) => this.sftp.unlink(p, cb as any), p)
  }

  removeDir(p: string): Promise<void> {
    return this.call<void>((cb) => this.sftp.rmdir(p, cb as any), p)
  }

  chmod(p: string, mode: number): Promise<void> {
    return this.call<void>((cb) => this.sftp.chmod(p, mode, cb as any), p)
  }

  utimes(p: string, atime: number, mtime: number): Promise<void> {
    return this.call<void>((cb) => this.sftp.utimes(p, atime / 1000, mtime / 1000, cb as any), p)
  }

  async createReadStream(p: string): Promise<Readable> {
    return this.sftp.createReadStream(p, { highWaterMark: 64 * 1024 })
  }

  async createWriteStream(p: string, mode?: number): Promise<Writable> {
    return this.sftp.createWriteStream(p, { mode: mode ?? 0o644 })
  }

  readFile(p: string): Promise<Buffer> {
    return this.call<Buffer>((cb) => this.sftp.readFile(p, cb as any), p)
  }

  writeFile(p: string, data: Buffer): Promise<void> {
    return this.call<void>((cb) => this.sftp.writeFile(p, data, cb as any), p)
  }

  join(dir: string, name: string): string {
    return posixJoin(dir, name)
  }

  dirname(p: string): string {
    return posixDirname(p)
  }

  basename(p: string): string {
    return posixBasename(p)
  }

  /** Opens an extra SFTP channel on the same connection (used per transfer so it can be aborted). */
  openChannel(): Promise<SFTPWrapper> {
    return openSftpChannel(this.conn)
  }

  close(): void {
    try {
      this.sftp.end()
    } catch {
      // ignore
    }
    this.onClose?.()
  }
}
