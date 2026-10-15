import { SyncAdapterError } from '../adapter'

const REQUEST_TIMEOUT_MS = 30_000
const MAX_RATE_LIMIT_RETRIES = 3
const MAX_RETRY_AFTER_MS = 60_000

export interface WebdavClientConfig {
  /** Absolute URL of the collection (folder). A trailing slash is added when missing. */
  url: string
  username?: string
  password?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** Delay between rate-limit retries (overridable for tests). */
  sleep?: (ms: number) => Promise<void>
}

/** Result of reading a file; `body` is null when the file does not exist. */
export interface WebdavReadResult {
  body: string | null
  etag: string | null
  /** The server answered `304 Not Modified` (only when `ifNoneMatch` was supplied). */
  notModified: boolean
}

/** Thrown by `write` when the server rejects a conditional request (HTTP 412). */
export class WebdavConflictError extends Error {
  constructor() {
    super('The remote file changed since it was read.')
    this.name = 'WebdavConflictError'
  }
}

/** Strong ETag usable in `If-Match`; weak validators (`W/"…"`) are not. */
export function strongEtag(etag: string | null): string | null {
  return etag && !etag.trimStart().startsWith('W/') ? etag : null
}

/** Normalises the collection URL: strips credentials (they move into auth) and ensures a trailing slash. */
export function normalizeWebdavUrl(raw: string): { url: string; username?: string; password?: string } {
  const trimmed = raw.trim()
  if (!/^https?:\/\//i.test(trimmed) || !URL.canParse(trimmed)) {
    throw new SyncAdapterError('config', 'The WebDAV URL must be an absolute http(s) address.')
  }
  const parsed = new URL(trimmed)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SyncAdapterError('config', 'The WebDAV URL must use http or https.')
  }
  const username = parsed.username ? decodeURIComponent(parsed.username) : undefined
  const password = parsed.password ? decodeURIComponent(parsed.password) : undefined
  parsed.username = ''
  parsed.password = ''
  if (!parsed.pathname.endsWith('/')) parsed.pathname += '/'
  return { url: parsed.toString(), username, password }
}

/** Human readable target without credentials, e.g. "cloud.example.com/remote.php/dav/files/me/sshtool". */
export function webdavHostPath(url: string): string {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname.replace(/\/+$/, '')
    return `${parsed.host}${path}`
  } catch {
    // Never let an unparsable URL leak embedded credentials into a label.
    return url.trim().replace(/\/\/[^/@\s]*@/, '//')
  }
}

/**
 * Minimal WebDAV client: `GET` / `PUT` / `PROPFIND` / `MKCOL` over `fetch` with HTTP Basic auth.
 * Conditional writes (`If-Match` / `If-None-Match: *`) provide the compare-and-swap primitive the
 * adapter uses for conflict-free updates.
 */
export class WebdavClient {
  readonly url: string
  private readonly username?: string
  private readonly password?: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly sleep: (ms: number) => Promise<void>
  private authHeader?: string

  constructor(cfg: WebdavClientConfig) {
    const normalized = normalizeWebdavUrl(cfg.url)
    this.url = normalized.url
    this.username = cfg.username?.trim() || normalized.username
    this.password = cfg.password ?? normalized.password
    this.fetchImpl = cfg.fetchImpl ?? ((input, init) => fetch(input, init))
    this.timeoutMs = cfg.timeoutMs ?? REQUEST_TIMEOUT_MS
    this.sleep = cfg.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  private auth(): string | undefined {
    if (!this.username) return undefined
    this.authHeader ??= `Basic ${Buffer.from(`${this.username}:${this.password ?? ''}`).toString('base64')}`
    return this.authHeader
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { ...extra }
    const auth = this.auth()
    if (auth) headers.Authorization = auth
    return headers
  }

  /** Reads a file. Passing `ifNoneMatch` enables `304 Not Modified` revalidation. */
  async read(path: string, ifNoneMatch?: string): Promise<WebdavReadResult> {
    const extra: Record<string, string> = ifNoneMatch ? { 'If-None-Match': ifNoneMatch } : {}
    const res = await this.send('GET', path, { headers: extra })
    if (res.status === 304) return { body: null, etag: ifNoneMatch ?? null, notModified: true }
    if (res.status === 404 || res.status === 410) return { body: null, etag: null, notModified: false }
    if (!res.ok) throw this.toError(res, 'read')
    const body = await res.text()
    return { body, etag: res.headers.get('etag'), notModified: false }
  }

  /**
   * Writes a file. When `exists` is false the request is guarded with `If-None-Match: *`; when a
   * strong ETag is known it is guarded with `If-Match`. Throws `WebdavConflictError` on HTTP 412 so
   * the caller can re-read and retry.
   */
  async write(
    path: string,
    body: string,
    opts: { etag: string | null; exists: boolean }
  ): Promise<string | null> {
    const strong = strongEtag(opts.etag)
    const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' }
    if (!opts.exists) headers['If-None-Match'] = '*'
    else if (strong) headers['If-Match'] = strong
    const res = await this.send('PUT', path, { method: 'PUT', headers, body })
    if (res.status === 412) throw new WebdavConflictError()
    if (!res.ok) throw this.toError(res, 'write')
    await res.arrayBuffer().catch(() => undefined)
    return res.headers.get('etag')
  }

  /** Ensures the base collection exists, creating it with MKCOL when missing. */
  async ensureCollection(): Promise<void> {
    const res = await this.send('PROPFIND', '', {
      method: 'PROPFIND',
      headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
      body: '<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>'
    })
    if (res.status === 207 || res.ok) return
    if (res.status === 404 || res.status === 410) return this.createCollection()
    // Some servers refuse PROPFIND on the root; a DAV-aware OPTIONS response is good enough.
    if (res.status === 405 || res.status === 501) {
      const opt = await this.send('OPTIONS', '', { method: 'OPTIONS' })
      if (opt.ok) return
      throw this.toError(opt, 'probe')
    }
    throw this.toError(res, 'probe')
  }

  private async createCollection(): Promise<void> {
    const res = await this.send('MKCOL', '', { method: 'MKCOL' })
    // 405 means it already exists on several servers; 409 means the parent is missing.
    if (res.ok || res.status === 405) return
    throw this.toError(res, 'collection')
  }

  private async send(
    method: string,
    path: string,
    init: RequestInit & { method?: string }
  ): Promise<Response> {
    const target = this.url + path
    for (let attempt = 0; ; attempt++) {
      let res: Response
      try {
        res = await this.fetchImpl(target, {
          ...init,
          method: init.method ?? method,
          headers: this.headers((init.headers as Record<string, string>) ?? {}),
          redirect: 'follow',
          signal: AbortSignal.timeout(this.timeoutMs)
        })
      } catch (err) {
        throw new SyncAdapterError('network', this.redact(describeFetchError(err)), err)
      }
      if (res.status !== 429) return res
      const delay = attempt < MAX_RATE_LIMIT_RETRIES ? retryDelay(res.headers.get('retry-after'), attempt) : null
      if (delay === null) throw new SyncAdapterError('rate-limit', 'The WebDAV server is rate limiting requests.')
      await res.arrayBuffer().catch(() => undefined)
      await this.sleep(delay)
    }
  }

  private toError(res: Response, action: string): SyncAdapterError {
    const status = res.status
    const detail = `HTTP ${status}`
    if (status === 401 || status === 403) {
      return new SyncAdapterError('auth', `The WebDAV server rejected the credentials (${detail}).`)
    }
    if (status === 404 || status === 410) {
      return new SyncAdapterError(
        'config',
        `The WebDAV folder was not found (${detail}). Check the URL and that the folder exists.`
      )
    }
    if (status === 409) {
      return new SyncAdapterError('config', `The WebDAV folder could not be created (${detail}).`)
    }
    if (status === 405 || status === 501) {
      return new SyncAdapterError(
        'config',
        `The server does not support WebDAV ${action} requests (${detail}). Is this really a WebDAV URL?`
      )
    }
    if (status === 507 || status === 413) {
      return new SyncAdapterError('config', `The WebDAV server refused the upload (${detail}: not enough space).`)
    }
    if (status === 408 || status === 423 || status >= 500) {
      return new SyncAdapterError('network', `The WebDAV server is unavailable (${detail}).`)
    }
    if (status === 429) return new SyncAdapterError('rate-limit', 'The WebDAV server is rate limiting requests.')
    return new SyncAdapterError('unknown', `The WebDAV ${action} request failed (${detail}).`)
  }

  private redact(message: string): string {
    let out = message
    const password = this.password
    if (password && password.length >= 4) out = out.split(password).join('***')
    if (this.authHeader) out = out.split(this.authHeader).join('***')
    return out
  }
}

/** Milliseconds to wait before retrying a 429, or null when the server asks for too long a pause. */
function retryDelay(header: string | null, attempt: number): number | null {
  let ms = 1000 * 2 ** attempt
  const value = header?.trim()
  if (value) {
    const seconds = Number(value)
    if (Number.isFinite(seconds)) ms = Math.max(0, seconds * 1000)
    else {
      const at = Date.parse(value)
      if (!Number.isNaN(at)) ms = Math.max(0, at - Date.now())
    }
  }
  return ms > MAX_RETRY_AFTER_MS ? null : ms
}

function describeFetchError(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } } | null
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'The WebDAV request timed out.'
  const detail = e?.cause?.code ?? e?.cause?.message ?? e?.message ?? 'request failed'
  return `Cannot reach the WebDAV server: ${detail}`
}
