import type { LocalSettings, UpdateCheckResult } from '@shared/types'
import type { Emitter } from './emitter'

const RELEASES_URL = 'https://api.github.com/repos/Xc-Star/ssh-tool-free-sync/releases/latest'
const RELEASES_ATOM_URL = 'https://github.com/Xc-Star/ssh-tool-free-sync/releases.atom'
const REQUEST_TIMEOUT_MS = 10_000
const INITIAL_DELAY_MS = 10_000
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

export interface UpdateServiceOptions {
  appVersion: string
  getSettings: () => LocalSettings
  emitter: Emitter
  fetchImpl?: typeof fetch
  initialDelayMs?: number
  intervalMs?: number
}

interface LatestRelease {
  version: string
  parts: number[]
  url: string
}

/** Parses a `v1.2.3` style tag into numeric parts; prerelease/build suffixes are not update candidates. */
function parseVersion(tag: string): number[] | null {
  const clean = tag.trim().replace(/^v/i, '')
  if (clean.includes('-') || clean.includes('+')) return null
  const parts = clean.split('.')
  if (!parts.length || parts.some((p) => !/^\d+$/.test(p))) return null
  return parts.map(Number)
}

function isNewer(candidate: number[], current: number[]): boolean {
  const len = Math.max(candidate.length, current.length)
  for (let i = 0; i < len; i++) {
    const a = candidate[i] ?? 0
    const b = current[i] ?? 0
    if (a !== b) return a > b
  }
  return false
}

/**
 * Polls GitHub Releases for a version newer than the running app and notifies the renderer; the
 * download itself stays manual (the app is unsigned, so silent self-update is not possible).
 */
export class UpdateService {
  private readonly fetchImpl: typeof fetch
  private readonly initialDelayMs: number
  private readonly intervalMs: number
  private timer: NodeJS.Timeout | null = null
  private generation = 0
  private lastNotified: string | null = null

  constructor(private readonly opts: UpdateServiceOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init))
    this.initialDelayMs = opts.initialDelayMs ?? INITIAL_DELAY_MS
    this.intervalMs = opts.intervalMs ?? CHECK_INTERVAL_MS
  }

  /** Starts the background loop: one check shortly after launch, then once a day. */
  start(): void {
    this.stop()
    this.schedule(this.initialDelayMs)
  }

  stop(): void {
    this.generation++
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** Manual check (About page button); never surfaces errors — an unreachable GitHub simply reads as "no update found". */
  async checkNow(): Promise<UpdateCheckResult> {
    let latest: { version: string; url: string } | null
    try {
      latest = await this.evaluate()
    } catch {
      return { status: 'unavailable', currentVersion: this.opts.appVersion }
    }
    if (!latest) return { status: 'up-to-date', currentVersion: this.opts.appVersion }
    this.notify(latest)
    return { status: 'available', ...latest, currentVersion: this.opts.appVersion }
  }

  private schedule(delayMs: number): void {
    const gen = this.generation
    this.timer = setTimeout(() => {
      if (gen !== this.generation) return
      void this.tick().finally(() => {
        if (gen !== this.generation) return
        this.schedule(this.intervalMs)
      })
    }, delayMs)
  }

  private async tick(): Promise<void> {
    if (!this.opts.getSettings().autoCheckUpdates) return
    try {
      const latest = await this.evaluate()
      if (latest) this.notify(latest)
    } catch {
      // Background failures stay silent: an unreachable GitHub (offline, restricted network) must
      // never disturb the user.
    }
  }

  /** The latest release when it is a real update for this app, else null. */
  private async evaluate(): Promise<{ version: string; url: string } | null> {
    const latest = await this.fetchLatest()
    const current = parseVersion(this.opts.appVersion)
    if (!latest || !current || !isNewer(latest.parts, current)) return null
    return { version: latest.version, url: latest.url }
  }

  /**
   * Latest stable release, or null when there is nothing applicable. Falls back to the Atom feed
   * whenever the API is unusable: its anonymous quota is 60 requests/hour per IP, which shared
   * proxy exit IPs routinely exhaust. Throws only when both channels fail.
   */
  private async fetchLatest(): Promise<LatestRelease | null> {
    try {
      return await this.fetchApi()
    } catch {
      return await this.fetchAtom()
    }
  }

  private async fetchApi(): Promise<LatestRelease | null> {
    const res = await this.fetchImpl(RELEASES_URL, {
      headers: {
        // GitHub rejects API requests without a User-Agent.
        'User-Agent': `ssh-tool/${this.opts.appVersion}`,
        Accept: 'application/vnd.github+json'
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    if (!res.ok) throw new Error(`GitHub API returned HTTP ${res.status}`)
    const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown }
    if (typeof body.tag_name !== 'string' || typeof body.html_url !== 'string') return null
    return toRelease(body.tag_name, body.html_url)
  }

  /**
   * The Atom feed is served by github.com (not api.github.com) and lists the newest releases
   * first, drafts and prereleases included; the newest stable tag is the first entry whose tag
   * parses as a plain version.
   */
  private async fetchAtom(): Promise<LatestRelease | null> {
    const res = await this.fetchImpl(RELEASES_ATOM_URL, {
      headers: { 'User-Agent': `ssh-tool/${this.opts.appVersion}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status}`)
    const xml = await res.text()
    for (const match of xml.matchAll(/href="(https:\/\/github\.com\/[^"]*\/releases\/tag\/([^"#?]+))"/g)) {
      const release = toRelease(match[2], match[1])
      if (release) return release
    }
    return null
  }

  private notify(latest: { version: string; url: string }): void {
    if (this.lastNotified === latest.version) return
    this.lastNotified = latest.version
    this.opts.emitter.emit('update.available', { version: latest.version, url: latest.url })
  }
}

function toRelease(tag: string, url: string): LatestRelease | null {
  const parts = parseVersion(tag)
  if (!parts) return null
  return { version: tag.trim().replace(/^v/i, ''), parts, url }
}
