import type { ClientChannel } from 'ssh2'
import type { OpenSshParams } from '@shared/types'
import type { Emitter } from '../services/emitter'
import type { HistoryService } from '../services/history'
import { type ConnectDeps, connectEndpoint, type SshConnection } from '../ssh/connect'
import { detectOs } from '../ssh/os-detect'
import { type Endpoint, resolveHostById, resolveQuickHost } from '../ssh/resolve'
import { BaseSession } from './base'
import { makeCodec, type TextCodec } from './codec'

export interface SshSessionDeps extends ConnectDeps {
  history: HistoryService
}

/** Converts a multi-line script to keystrokes (each line submitted with Enter). */
export function scriptToKeystrokes(script: string): string {
  const text = script.replace(/\r\n/g, '\n').replace(/\n+$/, '')
  return text ? `${text.replace(/\n/g, '\r')}\r` : ''
}

export class SshSession extends BaseSession {
  private conn?: SshConnection
  private stream?: ClientChannel
  private codec: TextCodec = makeCodec('utf-8')
  private abort?: AbortController
  private historyId?: number
  private cols: number
  private rows: number
  private initialCommandSent = false

  constructor(
    id: string,
    private readonly params: OpenSshParams,
    private readonly deps: SshSessionDeps,
    emitter: Emitter
  ) {
    super(id, 'ssh', params.inline?.label || params.inline?.address || 'SSH', emitter)
    this.cols = params.cols
    this.rows = params.rows
    this.info.hostId = params.hostId
  }

  private resolve(): Endpoint {
    const defaults = { keepAliveSec: this.deps.defaultKeepAliveSec }
    if (this.params.hostId) return resolveHostById(this.deps.vault, this.params.hostId, defaults)
    if (this.params.inline) return resolveQuickHost(this.params.inline, defaults)
    throw new Error('No host given')
  }

  async start(): Promise<void> {
    this.setStatus('connecting')
    let ep: Endpoint
    try {
      ep = this.resolve()
    } catch (err) {
      this.setStatus('error', (err as Error).message)
      return
    }
    this.info.title = ep.label
    if (this.params.hostId) {
      const host = this.deps.vault.get(this.params.hostId, 'host')
      if (host?.data.osHint) this.info.osHint = host.data.osHint
    }
    this.emitInfo()
    this.abort = new AbortController()
    const startedAt = Date.now()
    try {
      const conn = await connectEndpoint(ep, this.deps, {
        log: (line, level) => this.log(line, level),
        sessionId: this.id,
        signal: this.abort.signal
      })
      if (this.disposed) {
        conn.close()
        return
      }
      this.conn = conn
      const env: Record<string, string> = {}
      for (const v of ep.envVars) env[v.name] = v.value
      this.log('Starting shell…')
      const stream = await conn.shell({ cols: this.cols, rows: this.rows, env: Object.keys(env).length ? env : undefined })
      if (this.disposed) {
        conn.close()
        return
      }
      this.stream = stream
      this.codec = makeCodec(ep.charset)
      stream.on('data', (d: Buffer) => this.pump.push(this.codec.decode(d)))
      stream.stderr.on('data', (d: Buffer) => this.pump.push(this.codec.decode(d)))
      stream.on('close', () => this.onRemoteClosed())
      conn.onClose(() => this.onRemoteClosed())
      this.setStatus('connected')
      this.historyId = this.deps.history.add({
        hostId: ep.hostId,
        label: ep.label,
        address: `${ep.address}:${ep.port}`,
        username: ep.username || undefined,
        protocol: 'ssh',
        startedAt,
        status: 'connected'
      })
      if (ep.startupScript) this.write(scriptToKeystrokes(ep.startupScript))
      if (this.params.initialCommand && !this.initialCommandSent) {
        this.initialCommandSent = true
        this.write(scriptToKeystrokes(this.params.initialCommand))
      }
      if (ep.hostId) void this.updateOsHint(conn, ep.hostId)
    } catch (err) {
      if (this.disposed) return
      const msg = (err as Error).message
      this.log(msg, 'error')
      this.setStatus('error', msg)
      this.deps.history.add({
        hostId: ep.hostId,
        label: ep.label,
        address: `${ep.address}:${ep.port}`,
        username: ep.username || undefined,
        protocol: 'ssh',
        startedAt,
        endedAt: Date.now(),
        status: 'failed',
        error: msg
      })
    }
  }

  private async updateOsHint(conn: SshConnection, hostId: string): Promise<void> {
    const hint = await detectOs(conn)
    if (this.disposed || hint === 'unknown') return
    this.info.osHint = hint
    this.emitInfo()
    const host = this.deps.vault.get(hostId, 'host')
    if (host && host.data.osHint !== hint) {
      try {
        this.deps.vault.patch(hostId, { osHint: hint })
      } catch {
        // ignore
      }
    }
  }

  private onRemoteClosed(): void {
    if (this.disposed || this.info.status === 'disconnected') return
    this.pump.flush()
    this.setStatus('disconnected')
    this.deps.history.update(this.historyId, { endedAt: Date.now(), status: 'closed' })
    this.historyId = undefined
    this.conn?.close()
  }

  write(data: string): void {
    if (this.stream && this.info.status === 'connected') this.stream.write(this.codec.encode(data))
  }

  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    this.stream?.setWindow(rows, cols, rows * 16, cols * 8)
  }

  protected pauseSource(): void {
    this.stream?.pause()
  }

  protected resumeSource(): void {
    this.stream?.resume()
  }

  /** The underlying connection (used to open SFTP on the same connection). */
  get connection(): SshConnection | undefined {
    return this.conn && !this.conn.isClosed ? this.conn : undefined
  }

  protected teardown(): void {
    this.abort?.abort()
    this.deps.prompts.cancelForSession(this.id)
    this.stream?.removeAllListeners('close')
    try {
      this.stream?.close()
    } catch {
      // ignore
    }
    this.conn?.close()
    if (this.historyId !== undefined) {
      this.deps.history.update(this.historyId, { endedAt: Date.now(), status: 'closed' })
      this.historyId = undefined
    }
    this.stream = undefined
    this.conn = undefined
  }
}
