import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Readable, Writable } from 'node:stream'
import type { FileEntry } from '@shared/types'
import { modeToPermissions } from '@shared/util'
import { type FsAdapter, sortEntries } from './fs-types'

const isWin = process.platform === 'win32'

function entryFromStats(name: string, full: string, st: fs.Stats, targetType?: FileEntry['type']): FileEntry {
  const type: FileEntry['type'] = st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other'
  return {
    name,
    path: full,
    type,
    targetType,
    size: type === 'dir' ? 0 : st.size,
    mtime: st.mtimeMs,
    mode: st.mode & 0o7777,
    permissions: modeToPermissions(st.mode & 0o777, type),
    hidden: name.startsWith('.')
  }
}

/** The local disk. On Windows the virtual root '' lists the drives. */
export class LocalFs implements FsAdapter {
  readonly id = 'local'
  readonly kind = 'local' as const
  readonly flavor = isWin ? ('win32' as const) : ('posix' as const)
  readonly label = 'Local'

  async home(): Promise<string> {
    return os.homedir()
  }

  private async drives(): Promise<FileEntry[]> {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
    const found = await Promise.all(
      letters.map(async (l) => {
        try {
          await fs.promises.access(`${l}:\\`)
          return l
        } catch {
          return null
        }
      })
    )
    return found
      .filter((l): l is string => !!l)
      .map((l) => ({
        name: `${l}:`,
        path: `${l}:\\`,
        type: 'dir' as const,
        size: 0,
        mtime: 0,
        mode: 0o755,
        permissions: 'drwxr-xr-x',
        hidden: false
      }))
  }

  async list(dir: string): Promise<FileEntry[]> {
    if (isWin && (dir === '' || dir === '/')) return this.drives()
    const dirents = await fs.promises.readdir(dir, { withFileTypes: true })
    const entries = await Promise.all(
      dirents.map(async (d) => {
        const full = path.join(dir, d.name)
        try {
          const st = await fs.promises.lstat(full)
          let targetType: FileEntry['type'] | undefined
          if (st.isSymbolicLink()) {
            try {
              const t = await fs.promises.stat(full)
              targetType = t.isDirectory() ? 'dir' : t.isFile() ? 'file' : 'other'
            } catch {
              targetType = undefined
            }
          }
          return entryFromStats(d.name, full, st, targetType)
        } catch {
          return null
        }
      })
    )
    return sortEntries(entries.filter((e): e is FileEntry => !!e))
  }

  async stat(p: string): Promise<FileEntry> {
    const st = await fs.promises.stat(p)
    return entryFromStats(path.basename(p) || p, p, st)
  }

  async exists(p: string): Promise<FileEntry | null> {
    try {
      return await this.stat(p)
    } catch {
      return null
    }
  }

  async realpath(p: string): Promise<string> {
    if (isWin && (p === '' || p === '/')) return ''
    return fs.promises.realpath(p)
  }

  async mkdir(p: string): Promise<void> {
    await fs.promises.mkdir(p)
  }

  async rename(from: string, to: string): Promise<void> {
    await fs.promises.rename(from, to)
  }

  async removeFile(p: string): Promise<void> {
    await fs.promises.unlink(p)
  }

  async removeDir(p: string): Promise<void> {
    await fs.promises.rmdir(p)
  }

  async chmod(p: string, mode: number): Promise<void> {
    await fs.promises.chmod(p, mode)
  }

  async utimes(p: string, atime: number, mtime: number): Promise<void> {
    await fs.promises.utimes(p, atime / 1000, mtime / 1000)
  }

  async createReadStream(p: string): Promise<Readable> {
    return fs.createReadStream(p, { highWaterMark: 256 * 1024 })
  }

  async createWriteStream(p: string, mode?: number): Promise<Writable> {
    return fs.createWriteStream(p, { mode: mode ?? 0o644 })
  }

  async readFile(p: string): Promise<Buffer> {
    return fs.promises.readFile(p)
  }

  async writeFile(p: string, data: Buffer): Promise<void> {
    await fs.promises.writeFile(p, data)
  }

  join(dir: string, name: string): string {
    if (isWin && dir === '') return name.endsWith('\\') ? name : `${name}\\`
    return path.join(dir, name)
  }

  dirname(p: string): string {
    const d = path.dirname(p)
    if (isWin && d === p) return ''
    return d
  }

  basename(p: string): string {
    return path.basename(p) || p
  }

  close(): void {}
}
