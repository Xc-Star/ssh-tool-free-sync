/**
 * Hybrid logical clock. Timestamps are fixed-width strings so that plain string comparison
 * gives a total order: `<15-digit ms>:<5-digit counter>:<deviceId>`.
 *
 * Any timestamp produced after `receive(x)` is strictly greater than `x`, which keeps
 * last-writer-wins correct even when device clocks drift.
 */
export class Hlc {
  private lastMs = 0
  private counter = 0

  constructor(
    readonly deviceId: string,
    private readonly now: () => number = Date.now
  ) {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(deviceId)) throw new Error('invalid device id')
  }

  tick(): string {
    const pt = this.now()
    if (pt > this.lastMs) {
      this.lastMs = pt
      this.counter = 0
    } else {
      this.counter++
      if (this.counter > 99_999) {
        this.lastMs++
        this.counter = 0
      }
    }
    return formatHlc(this.lastMs, this.counter, this.deviceId)
  }

  receive(ts: string): void {
    const parsed = parseHlc(ts)
    if (!parsed) return
    if (parsed.ms > this.lastMs || (parsed.ms === this.lastMs && parsed.counter > this.counter)) {
      this.lastMs = parsed.ms
      this.counter = parsed.counter
    }
  }
}

export function formatHlc(ms: number, counter: number, deviceId: string): string {
  return `${String(ms).padStart(15, '0')}:${String(counter).padStart(5, '0')}:${deviceId}`
}

export function parseHlc(ts: string): { ms: number; counter: number; deviceId: string } | null {
  const m = /^(\d{15}):(\d{5}):(.+)$/.exec(ts)
  if (!m) return null
  return { ms: Number(m[1]), counter: Number(m[2]), deviceId: m[3] }
}

export function hlcTime(ts: string): number {
  return parseHlc(ts)?.ms ?? 0
}
