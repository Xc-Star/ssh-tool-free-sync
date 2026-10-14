import type {
  OpenLocalParams,
  OpenSerialParams,
  OpenSshParams,
  OpenTelnetParams,
  SessionInfo
} from '@shared/types'
import { uuidv7 } from '@shared/util'
import type { Emitter } from '../services/emitter'
import type { HistoryService } from '../services/history'
import type { SettingsService } from '../services/settings'
import type { ConnectDeps } from '../ssh/connect'
import type { BaseSession } from './base'
import { LocalSession } from './local-session'
import { SerialSession } from './serial-session'
import { SshSession } from './ssh-session'
import { TelnetSession } from './telnet-session'

export interface SessionManagerDeps extends ConnectDeps {
  history: HistoryService
  settings: SettingsService
  emitter: Emitter
}

/** Owns all terminal sessions and routes renderer I/O to them. */
export class SessionManager {
  private sessions = new Map<string, BaseSession>()

  constructor(private readonly deps: SessionManagerDeps) {}

  private register(session: BaseSession): SessionInfo {
    this.sessions.set(session.id, session)
    void session.start()
    return { ...session.info }
  }

  openSsh(params: OpenSshParams): SessionInfo {
    return this.register(new SshSession(uuidv7(), params, this.deps, this.deps.emitter))
  }

  openLocal(params: OpenLocalParams): SessionInfo {
    return this.register(new LocalSession(uuidv7(), params, this.deps.settings.get().localShell, this.deps.emitter))
  }

  openTelnet(params: OpenTelnetParams): SessionInfo {
    return this.register(new TelnetSession(uuidv7(), params, this.deps.vault, this.deps.history, this.deps.emitter))
  }

  openSerial(params: OpenSerialParams): SessionInfo {
    return this.register(new SerialSession(uuidv7(), params, this.deps.vault, this.deps.emitter))
  }

  get(id: string): BaseSession | undefined {
    return this.sessions.get(id)
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) return
    this.sessions.get(id)?.resize(cols, rows)
  }

  ack(id: string, bytes: number): void {
    this.sessions.get(id)?.ack(bytes)
  }

  close(id: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    this.sessions.delete(id)
    s.dispose()
  }

  reconnect(id: string): SessionInfo {
    const s = this.sessions.get(id)
    if (!s) throw new Error('Session not found')
    void s.reconnect()
    return { ...s.info }
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => ({ ...s.info }))
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id)
  }
}
