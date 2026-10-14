import type { SessionInfo, SessionKind, SessionStatus } from '@shared/types'
import type { Emitter } from '../services/emitter'
import { OutputPump } from './output-pump'

/** Common behavior of terminal sessions (ssh, local pty, telnet, serial). */
export abstract class BaseSession {
  readonly info: SessionInfo
  protected readonly pump: OutputPump
  protected disposed = false

  constructor(
    id: string,
    kind: SessionKind,
    title: string,
    protected readonly emitter: Emitter
  ) {
    this.info = { id, kind, title, status: 'connecting', startedAt: Date.now() }
    this.pump = new OutputPump(
      id,
      emitter,
      () => this.pauseSource(),
      () => this.resumeSource()
    )
  }

  get id(): string {
    return this.info.id
  }

  protected setStatus(status: SessionStatus, error?: string): void {
    this.info.status = status
    this.info.error = error
    this.emitter.emit('session.status', { ...this.info })
  }

  protected emitInfo(): void {
    this.emitter.emit('session.status', { ...this.info })
  }

  protected log(line: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    this.emitter.emit('session.log', { id: this.id, line, level })
  }

  ack(n: number): void {
    this.pump.ack(n)
  }

  abstract start(): Promise<void>
  abstract write(data: string): void
  abstract resize(cols: number, rows: number): void
  protected abstract pauseSource(): void
  protected abstract resumeSource(): void
  /** Tears down the transport; the session may be restarted with start(). */
  protected abstract teardown(): void

  canReconnect(): boolean {
    return this.info.status === 'disconnected' || this.info.status === 'error'
  }

  async reconnect(): Promise<void> {
    this.teardown()
    this.pump.reset()
    this.info.startedAt = Date.now()
    await this.start()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.teardown()
    this.pump.dispose()
  }
}
