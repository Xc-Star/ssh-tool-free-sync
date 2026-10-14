import { type ConnectDeps, connectEndpoint, type ConnectOptions, type SshConnection } from './connect'
import { resolveHostById } from './resolve'

interface PoolEntry {
  conn: Promise<SshConnection>
  refs: number
  idleTimer?: NodeJS.Timeout
}

export interface Lease {
  conn: SshConnection
  release(): void
}

/**
 * Shared, reference-counted connections per host for SFTP and port forwarding. Terminal
 * sessions use dedicated connections so each tab can be closed/reconnected independently.
 */
export class ConnectionPool {
  private entries = new Map<string, PoolEntry>()

  constructor(
    private readonly deps: ConnectDeps,
    private readonly idleMs = 15_000
  ) {}

  async acquire(hostId: string, opts: ConnectOptions = {}): Promise<Lease> {
    let entry = this.entries.get(hostId)
    if (entry) {
      const conn = await entry.conn.catch(() => null)
      if (!conn || conn.isClosed) {
        this.entries.delete(hostId)
        entry = undefined
      }
    }
    if (!entry) {
      const ep = resolveHostById(this.deps.vault, hostId, { keepAliveSec: this.deps.defaultKeepAliveSec })
      const created: PoolEntry = { conn: connectEndpoint(ep, this.deps, opts), refs: 0 }
      this.entries.set(hostId, created)
      created.conn.then(
        (c) =>
          c.onClose(() => {
            if (this.entries.get(hostId) === created) this.entries.delete(hostId)
          }),
        () => {
          if (this.entries.get(hostId) === created) this.entries.delete(hostId)
        }
      )
      entry = created
    }
    const e = entry
    e.refs++
    if (e.idleTimer) {
      clearTimeout(e.idleTimer)
      e.idleTimer = undefined
    }
    let conn: SshConnection
    try {
      conn = await e.conn
    } catch (err) {
      e.refs--
      throw err
    }
    let released = false
    return {
      conn,
      release: () => {
        if (released) return
        released = true
        e.refs--
        if (e.refs <= 0) {
          e.idleTimer = setTimeout(() => {
            if (e.refs <= 0 && this.entries.get(hostId) === e) {
              this.entries.delete(hostId)
              conn.close()
            }
          }, this.idleMs)
        }
      }
    }
  }

  closeAll(): void {
    for (const e of this.entries.values()) {
      if (e.idleTimer) clearTimeout(e.idleTimer)
      e.conn.then((c) => c.close(), () => {})
    }
    this.entries.clear()
  }
}
