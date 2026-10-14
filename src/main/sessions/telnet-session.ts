import net from 'node:net'
import type { OpenTelnetParams } from '@shared/types'
import type { Emitter } from '../services/emitter'
import type { HistoryService } from '../services/history'
import type { VaultService } from '../vault/vault-service'
import { BaseSession } from './base'
import { makeCodec, type TextCodec } from './codec'

const IAC = 255
const DONT = 254
const DO = 253
const WONT = 252
const WILL = 251
const SB = 250
const SE = 240
const OPT_ECHO = 1
const OPT_SGA = 3
const OPT_TTYPE = 24
const OPT_NAWS = 31

/**
 * Minimal Telnet client (RFC 854) with ECHO / SGA / TTYPE / NAWS negotiation.
 * Exported for tests.
 */
export class TelnetProtocol {
  private state: 'data' | 'iac' | 'opt' | 'sb' | 'sb-iac' = 'data'
  private cmd = 0
  private sbBuf: number[] = []
  private nawsEnabled = false

  constructor(
    private readonly sendRaw: (buf: Buffer) => void,
    private cols: number,
    private rows: number,
    private readonly termType = 'XTERM-256COLOR'
  ) {}

  /** Feeds network bytes; returns the payload bytes for the terminal. */
  receive(chunk: Buffer): Buffer {
    const out: number[] = []
    for (const b of chunk) {
      switch (this.state) {
        case 'data':
          if (b === IAC) this.state = 'iac'
          else out.push(b)
          break
        case 'iac':
          if (b === IAC) {
            out.push(IAC)
            this.state = 'data'
          } else if (b === DO || b === DONT || b === WILL || b === WONT) {
            this.cmd = b
            this.state = 'opt'
          } else if (b === SB) {
            this.sbBuf = []
            this.state = 'sb'
          } else this.state = 'data'
          break
        case 'opt':
          this.negotiate(this.cmd, b)
          this.state = 'data'
          break
        case 'sb':
          if (b === IAC) this.state = 'sb-iac'
          else this.sbBuf.push(b)
          break
        case 'sb-iac':
          if (b === SE) {
            this.subnegotiation(this.sbBuf)
            this.state = 'data'
          } else {
            this.sbBuf.push(b)
            this.state = 'sb'
          }
          break
      }
    }
    return Buffer.from(out)
  }

  private negotiate(cmd: number, opt: number): void {
    if (cmd === DO) {
      if (opt === OPT_TTYPE || opt === OPT_SGA) this.sendRaw(Buffer.from([IAC, WILL, opt]))
      else if (opt === OPT_NAWS) {
        this.nawsEnabled = true
        this.sendRaw(Buffer.from([IAC, WILL, OPT_NAWS]))
        this.sendWindowSize()
      } else this.sendRaw(Buffer.from([IAC, WONT, opt]))
    } else if (cmd === WILL) {
      if (opt === OPT_ECHO || opt === OPT_SGA) this.sendRaw(Buffer.from([IAC, DO, opt]))
      else this.sendRaw(Buffer.from([IAC, DONT, opt]))
    } else if (cmd === DONT) {
      if (opt === OPT_NAWS) this.nawsEnabled = false
      this.sendRaw(Buffer.from([IAC, WONT, opt]))
    } else if (cmd === WONT) {
      this.sendRaw(Buffer.from([IAC, DONT, opt]))
    }
  }

  private subnegotiation(buf: number[]): void {
    if (buf[0] === OPT_TTYPE && buf[1] === 1) {
      this.sendRaw(Buffer.concat([Buffer.from([IAC, SB, OPT_TTYPE, 0]), Buffer.from(this.termType, 'ascii'), Buffer.from([IAC, SE])]))
    }
  }

  setWindowSize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    this.sendWindowSize()
  }

  private sendWindowSize(): void {
    if (!this.nawsEnabled) return
    const bytes = [this.cols >> 8, this.cols & 0xff, this.rows >> 8, this.rows & 0xff]
    const escaped: number[] = []
    for (const b of bytes) {
      escaped.push(b)
      if (b === IAC) escaped.push(IAC)
    }
    this.sendRaw(Buffer.from([IAC, SB, OPT_NAWS, ...escaped, IAC, SE]))
  }

  /** Escapes user input for the wire (IAC doubling, CR → CR LF). */
  static encodeInput(data: Buffer): Buffer {
    const out: number[] = []
    for (let i = 0; i < data.length; i++) {
      const b = data[i]
      if (b === IAC) out.push(IAC, IAC)
      else if (b === 13 && data[i + 1] !== 10) out.push(13, 10)
      else out.push(b)
    }
    return Buffer.from(out)
  }
}

export class TelnetSession extends BaseSession {
  private socket?: net.Socket
  private proto?: TelnetProtocol
  private codec: TextCodec = makeCodec('utf-8')
  private historyId?: number

  constructor(
    id: string,
    private readonly params: OpenTelnetParams,
    private readonly vault: VaultService,
    private readonly history: HistoryService,
    emitter: Emitter
  ) {
    super(id, 'telnet', params.inline?.label ?? params.inline?.address ?? 'Telnet', emitter)
    this.info.hostId = params.hostId
  }

  async start(): Promise<void> {
    this.setStatus('connecting')
    let address: string
    let port: number
    let label: string
    let charset = 'utf-8'
    if (this.params.hostId) {
      const host = this.vault.get(this.params.hostId, 'host')
      if (!host) return this.setStatus('error', 'Host not found')
      address = host.data.address
      port = host.data.telnetPort ?? 23
      label = host.data.label || host.data.address
      charset = host.data.charset ?? 'utf-8'
      this.info.osHint = host.data.osHint
    } else if (this.params.inline) {
      address = this.params.inline.address
      port = this.params.inline.port ?? 23
      label = this.params.inline.label ?? address
    } else return this.setStatus('error', 'No host given')
    this.info.title = label
    this.codec = makeCodec(charset)
    this.log(`Connecting to ${address}:${port} (telnet)…`)
    const startedAt = Date.now()
    await new Promise<void>((resolve) => {
      const socket = net.connect({ host: address, port })
      this.socket = socket
      socket.setNoDelay(true)
      const timer = setTimeout(() => socket.destroy(new Error(`Connection to ${address}:${port} timed out`)), 20_000)
      this.proto = new TelnetProtocol((b) => socket.write(b), this.params.cols, this.params.rows)
      socket.once('connect', () => {
        clearTimeout(timer)
        this.setStatus('connected')
        this.historyId = this.history.add({ hostId: this.params.hostId, label, address: `${address}:${port}`, protocol: 'telnet', startedAt, status: 'connected' })
        resolve()
      })
      socket.on('data', (chunk: Buffer) => {
        const payload = this.proto!.receive(chunk)
        if (payload.length) this.pump.push(this.codec.decode(payload))
      })
      socket.once('error', (err) => {
        clearTimeout(timer)
        if (this.info.status === 'connecting') {
          this.setStatus('error', err.message)
          this.history.add({ hostId: this.params.hostId, label, address: `${address}:${port}`, protocol: 'telnet', startedAt, endedAt: Date.now(), status: 'failed', error: err.message })
          resolve()
        }
      })
      socket.once('close', () => {
        if (this.disposed || this.info.status !== 'connected') return
        this.pump.flush()
        this.setStatus('disconnected')
        this.history.update(this.historyId, { endedAt: Date.now(), status: 'closed' })
      })
    })
  }

  write(data: string): void {
    if (this.socket && this.info.status === 'connected') this.socket.write(TelnetProtocol.encodeInput(this.codec.encode(data)))
  }

  resize(cols: number, rows: number): void {
    this.proto?.setWindowSize(cols, rows)
  }

  protected pauseSource(): void {
    this.socket?.pause()
  }

  protected resumeSource(): void {
    this.socket?.resume()
  }

  protected teardown(): void {
    this.socket?.removeAllListeners()
    this.socket?.on('error', () => {})
    this.socket?.destroy()
    this.socket = undefined
    if (this.historyId !== undefined) this.history.update(this.historyId, { endedAt: Date.now(), status: 'closed' })
    this.historyId = undefined
  }
}
