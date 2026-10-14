import type { Emitter } from '../services/emitter'

const HIGH_WATERMARK = 512 * 1024
const LOW_WATERMARK = 128 * 1024
const MAX_BATCH = 64 * 1024
const FLUSH_MS = 5

/**
 * Batches terminal output into IPC messages and applies backpressure: when the renderer has
 * not acknowledged more than HIGH_WATERMARK characters the source is paused until it catches up.
 */
export class OutputPump {
  private chunks: string[] = []
  private size = 0
  private timer: NodeJS.Timeout | null = null
  private unacked = 0
  private paused = false
  private disposed = false

  constructor(
    private readonly id: string,
    private readonly emitter: Emitter,
    private readonly pauseSource: () => void,
    private readonly resumeSource: () => void
  ) {}

  push(data: string): void {
    if (this.disposed || !data) return
    this.chunks.push(data)
    this.size += data.length
    if (this.size >= MAX_BATCH) this.flush()
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), FLUSH_MS)
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.chunks.length || this.disposed) return
    const data = this.chunks.join('')
    this.chunks = []
    this.size = 0
    this.emitter.sessionData(this.id, data)
    this.unacked += data.length
    if (!this.paused && this.unacked > HIGH_WATERMARK) {
      this.paused = true
      this.pauseSource()
    }
  }

  ack(n: number): void {
    this.unacked = Math.max(0, this.unacked - n)
    if (this.paused && this.unacked < LOW_WATERMARK) {
      this.paused = false
      this.resumeSource()
    }
  }

  /** Forget outstanding acks (e.g. renderer reloaded). */
  reset(): void {
    this.unacked = 0
    if (this.paused) {
      this.paused = false
      this.resumeSource()
    }
  }

  dispose(): void {
    this.flush()
    this.disposed = true
  }
}
