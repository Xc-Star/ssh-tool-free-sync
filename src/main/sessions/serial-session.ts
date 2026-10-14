import type { SerialPort } from 'serialport'
import { serialProfileSchema, type SerialProfileData } from '@shared/schemas'
import type { OpenSerialParams, SerialPortInfo } from '@shared/types'
import type { Emitter } from '../services/emitter'
import type { VaultService } from '../vault/vault-service'
import { BaseSession } from './base'

export async function listSerialPorts(): Promise<SerialPortInfo[]> {
  const { SerialPort } = await import('serialport')
  const ports = await SerialPort.list()
  return ports.map((p) => ({
    path: p.path,
    manufacturer: p.manufacturer,
    serialNumber: p.serialNumber,
    vendorId: p.vendorId,
    productId: p.productId
  }))
}

export function defaultSerialProfile(): SerialProfileData {
  return serialProfileSchema.parse({ label: 'Serial', path: process.platform === 'win32' ? 'COM1' : '/dev/ttyUSB0' })
}

export class SerialSession extends BaseSession {
  private port?: SerialPort
  private profile?: SerialProfileData

  constructor(
    id: string,
    private readonly params: OpenSerialParams,
    private readonly vault: VaultService,
    emitter: Emitter
  ) {
    super(id, 'serial', params.inline?.label ?? 'Serial', emitter)
  }

  async start(): Promise<void> {
    this.setStatus('connecting')
    const profile = this.params.profileId
      ? this.vault.get(this.params.profileId, 'serialProfile')?.data
      : this.params.inline
        ? serialProfileSchema.parse(this.params.inline)
        : undefined
    if (!profile) return this.setStatus('error', 'Serial profile not found')
    this.profile = profile
    this.info.title = `${profile.label} (${profile.path})`
    this.log(`Opening ${profile.path} at ${profile.baudRate} baud…`)
    try {
      const { SerialPort } = await import('serialport')
      const port = new SerialPort({
        path: profile.path,
        baudRate: profile.baudRate,
        dataBits: profile.dataBits,
        stopBits: profile.stopBits,
        parity: profile.parity,
        rtscts: profile.flowControl === 'hardware',
        xon: profile.flowControl === 'software',
        xoff: profile.flowControl === 'software',
        autoOpen: false
      })
      this.port = port
      await new Promise<void>((resolve, reject) => port.open((err) => (err ? reject(err) : resolve())))
      port.on('data', (d: Buffer) => this.pump.push(d.toString('utf8')))
      port.on('close', () => {
        if (this.disposed) return
        this.pump.flush()
        this.setStatus('disconnected')
      })
      port.on('error', (err) => this.log(err.message, 'error'))
      this.setStatus('connected')
    } catch (err) {
      this.setStatus('error', (err as Error).message)
    }
  }

  write(data: string): void {
    if (!this.port || this.info.status !== 'connected' || !this.profile) return
    const eol = this.profile.lineEnding === 'lf' ? '\n' : this.profile.lineEnding === 'crlf' ? '\r\n' : '\r'
    const out = data.replace(/\r/g, eol)
    this.port.write(Buffer.from(out, 'utf8'))
    if (this.profile.localEcho) this.pump.push(data.replace(/\r/g, '\r\n'))
  }

  resize(): void {
    // serial lines have no window size
  }

  protected pauseSource(): void {
    this.port?.pause()
  }

  protected resumeSource(): void {
    this.port?.resume()
  }

  protected teardown(): void {
    if (this.port?.isOpen) this.port.close(() => {})
    this.port?.removeAllListeners()
    this.port = undefined
  }
}
