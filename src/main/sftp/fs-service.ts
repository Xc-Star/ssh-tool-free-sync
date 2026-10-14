import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FsInfo, FileEntry, TextFileContent } from '@shared/types'
import { uuidv7 } from '@shared/util'
import type { Emitter } from '../services/emitter'
import type { SessionManager } from '../sessions/session-manager'
import { SshSession } from '../sessions/ssh-session'
import type { ConnectionPool } from '../ssh/pool'
import type { VaultService } from '../vault/vault-service'
import { type FsAdapter, isDirEntry } from './fs-types'
import { LocalFs } from './local-fs'
import { openSftpChannel, SftpFs } from './sftp-fs'

const MAX_TEXT_BYTES = 5 * 1024 * 1024

export interface FsServiceDeps {
  pool: ConnectionPool
  sessions: SessionManager
  vault: VaultService
  emitter: Emitter
  /** Opens a local file with the OS default application (Electron shell.openPath). */
  openPath?: (p: string) => Promise<string>
  /** Watches a file for changes; returns an unsubscribe function. */
  watchFile?: (p: string, onChange: () => void) => () => void
}

interface ExternalEdit {
  fsId: string
  remotePath: string
  localPath: string
  stop: () => void
}

/** Manages open file systems (local + SFTP) and file operations requested by the renderer. */
export class FsService {
  private systems = new Map<string, FsAdapter>()
  private edits = new Map<string, ExternalEdit>()
  readonly local = new LocalFs()

  constructor(private readonly deps: FsServiceDeps) {
    this.systems.set('local', this.local)
  }

  get(fsId: string): FsAdapter {
    const f = this.systems.get(fsId)
    if (!f) throw new Error('File system is not open (connection closed?)')
    return f
  }

  private info(f: FsAdapter, home: string): FsInfo {
    return { id: f.id, kind: f.kind, hostId: f.hostId, label: f.label, home, flavor: f.flavor }
  }

  async openLocal(): Promise<FsInfo> {
    return this.info(this.local, await this.local.home())
  }

  async openSftp(hostId: string, sessionId?: string): Promise<FsInfo> {
    const host = this.deps.vault.get(hostId, 'host')
    if (!host) throw new Error('Host not found')
    const label = host.data.label || host.data.address
    const id = `sftp-${uuidv7()}`
    const session = sessionId ? this.deps.sessions.get(sessionId) : undefined
    const sessionConn = session instanceof SshSession ? session.connection : undefined
    let fsys: SftpFs
    if (sessionConn) {
      const sftp = await openSftpChannel(sessionConn)
      fsys = new SftpFs(id, label, hostId, sessionConn, sftp)
    } else {
      const lease = await this.deps.pool.acquire(hostId)
      try {
        const sftp = await openSftpChannel(lease.conn)
        fsys = new SftpFs(id, label, hostId, lease.conn, sftp, () => lease.release())
      } catch (err) {
        lease.release()
        throw err
      }
    }
    this.systems.set(id, fsys)
    fsys.conn.onClose(() => {
      if (this.systems.get(id) === fsys) this.systems.delete(id)
    })
    return this.info(fsys, await fsys.home())
  }

  close(fsId: string): void {
    if (fsId === 'local') return
    const f = this.systems.get(fsId)
    if (!f) return
    this.systems.delete(fsId)
    for (const [k, e] of this.edits) {
      if (e.fsId === fsId) {
        e.stop()
        this.edits.delete(k)
      }
    }
    f.close()
  }

  closeAll(): void {
    for (const id of [...this.systems.keys()]) this.close(id)
  }

  list(fsId: string, dir: string): Promise<FileEntry[]> {
    return this.get(fsId).list(dir)
  }

  stat(fsId: string, p: string): Promise<FileEntry> {
    return this.get(fsId).stat(p)
  }

  realpath(fsId: string, p: string): Promise<string> {
    return this.get(fsId).realpath(p)
  }

  async mkdir(fsId: string, p: string): Promise<void> {
    await this.get(fsId).mkdir(p)
  }

  async newFile(fsId: string, p: string): Promise<void> {
    const f = this.get(fsId)
    if (await f.exists(p)) throw new Error('A file with this name already exists')
    await f.writeFile(p, Buffer.alloc(0))
  }

  async rename(fsId: string, from: string, to: string): Promise<void> {
    const f = this.get(fsId)
    if (from === to) return
    if (await f.exists(to)) throw new Error('A file with this name already exists')
    await f.rename(from, to)
  }

  async remove(fsId: string, paths: string[]): Promise<void> {
    const f = this.get(fsId)
    for (const p of paths) {
      let entry: FileEntry | undefined
      try {
        entry = (await f.list(f.dirname(p))).find((e) => e.path === p || e.name === f.basename(p))
      } catch {
        entry = undefined
      }
      await this.removeRecursive(f, entry ?? (await f.stat(p)), 0)
    }
  }

  /** `entry` comes from a directory listing (lstat semantics) so symlinked dirs are not followed. */
  private async removeRecursive(f: FsAdapter, entry: FileEntry, depth: number): Promise<void> {
    if (depth > 64) throw new Error('Directory nesting too deep')
    if (entry.type === 'dir') {
      for (const child of await f.list(entry.path)) await this.removeRecursive(f, child, depth + 1)
      await f.removeDir(entry.path)
    } else {
      await f.removeFile(entry.path)
    }
  }

  async chmod(fsId: string, p: string, mode: number, recursive = false): Promise<void> {
    const f = this.get(fsId)
    await f.chmod(p, mode)
    if (!recursive) return
    // Like `chmod -R` with X: directories keep traversable where readable.
    const dirMode = mode | ((mode & 0o444) >> 2)
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 64) return
      for (const e of await f.list(dir)) {
        if (e.type === 'symlink') continue
        await f.chmod(e.path, e.type === 'dir' ? dirMode : mode)
        if (e.type === 'dir') await walk(e.path, depth + 1)
      }
    }
    const st = await f.stat(p)
    if (isDirEntry(st)) await walk(p, 0)
  }

  async readText(fsId: string, p: string): Promise<TextFileContent> {
    const f = this.get(fsId)
    const st = await f.stat(p)
    if (st.size > MAX_TEXT_BYTES) return { content: '', size: st.size, mtime: st.mtime, binary: false, tooLarge: true }
    const buf = await f.readFile(p)
    const probe = buf.subarray(0, 8192)
    if (probe.includes(0)) return { content: '', size: st.size, mtime: st.mtime, binary: true, tooLarge: false }
    return { content: buf.toString('utf8'), size: st.size, mtime: st.mtime, binary: false, tooLarge: false }
  }

  async writeText(fsId: string, p: string, content: string): Promise<void> {
    await this.get(fsId).writeFile(p, Buffer.from(content, 'utf8'))
  }

  /**
   * Downloads a remote file to a temp folder, opens it with the default OS application and
   * uploads it back whenever it is saved.
   */
  async editExternal(fsId: string, remotePath: string): Promise<void> {
    const f = this.get(fsId)
    if (fsId === 'local') {
      await this.deps.openPath?.(remotePath)
      return
    }
    const key = `${fsId}:${remotePath}`
    const existing = this.edits.get(key)
    if (existing) {
      await this.deps.openPath?.(existing.localPath)
      return
    }
    const dir = path.join(os.tmpdir(), 'sshtool-edit', uuidv7())
    await fs.promises.mkdir(dir, { recursive: true })
    const localPath = path.join(dir, f.basename(remotePath))
    await fs.promises.writeFile(localPath, await f.readFile(remotePath))
    let uploading: Promise<void> = Promise.resolve()
    let lastContent = await fs.promises.readFile(localPath)
    const upload = (): void => {
      uploading = uploading.then(async () => {
        try {
          const data = await fs.promises.readFile(localPath)
          if (data.equals(lastContent)) return
          lastContent = data
          await this.get(fsId).writeFile(remotePath, data)
          this.deps.emitter.emit('toast', { level: 'success', message: `Uploaded ${f.basename(remotePath)}` })
          this.deps.emitter.emit('fs.changed', { fsId, dir: f.dirname(remotePath) })
        } catch (err) {
          this.deps.emitter.emit('toast', { level: 'error', message: `Upload of ${f.basename(remotePath)} failed`, detail: (err as Error).message })
        }
      })
    }
    const stop = this.deps.watchFile?.(localPath, upload) ?? (() => {})
    this.edits.set(key, {
      fsId,
      remotePath,
      localPath,
      stop: () => {
        stop()
        void fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {})
      }
    })
    const err = await this.deps.openPath?.(localPath)
    if (err) throw new Error(err)
  }

  stopAllEdits(): void {
    for (const e of this.edits.values()) e.stop()
    this.edits.clear()
  }
}
