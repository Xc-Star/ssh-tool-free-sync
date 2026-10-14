import { SyncAdapterError } from '../adapter'

export const D1_DEFAULT_BASE_URL = 'https://api.cloudflare.com/client/v4'

const REQUEST_TIMEOUT_MS = 30_000
const MAX_RATE_LIMIT_RETRIES = 3
const MAX_RETRY_AFTER_MS = 60_000
/** Cloudflare API error codes meaning "bad / insufficient credentials". */
const AUTH_ERROR_CODES = new Set([9103, 9106, 9107, 9109, 10000, 10001])
/** Unknown route / account / database. */
const NOT_FOUND_ERROR_CODES = new Set([7000, 7003, 7404])

export interface D1Statement {
  sql: string
  /** The REST API only accepts string parameters. */
  params?: string[]
}

export interface D1Meta {
  changes?: number
  rows_read?: number
  rows_written?: number
  last_row_id?: number
  duration?: number
  [key: string]: unknown
}

export interface D1Result<T = Record<string, unknown>> {
  rows: T[]
  meta: D1Meta
}

export interface D1ClientConfig {
  accountId: string
  databaseId: string
  apiToken: string
  /** Defaults to https://api.cloudflare.com/client/v4 */
  baseUrl?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** Delay used between rate-limit retries (overridable for tests). */
  sleep?: (ms: number) => Promise<void>
}

interface CfMessage {
  code?: number
  message?: string
}

interface CfEnvelope {
  success?: boolean
  errors?: CfMessage[]
  result?: unknown
}

class BatchUnsupportedError extends Error {}

/** Minimal client for the Cloudflare D1 HTTP API (`POST .../d1/database/:id/query`). */
export class D1Client {
  private readonly url: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly sleep: (ms: number) => Promise<void>
  private batchSupported = true

  constructor(private readonly cfg: D1ClientConfig) {
    const base = (cfg.baseUrl?.trim() || D1_DEFAULT_BASE_URL).replace(/\/+$/, '')
    if (!/^https?:\/\/[^/]/i.test(base) || !URL.canParse(base)) {
      throw new SyncAdapterError('config', 'The Cloudflare API base URL is invalid.')
    }
    this.url = `${base}/accounts/${encodeURIComponent(cfg.accountId)}/d1/database/${encodeURIComponent(cfg.databaseId)}/query`
    this.fetchImpl = cfg.fetchImpl ?? ((input, init) => fetch(input, init))
    this.timeoutMs = cfg.timeoutMs ?? REQUEST_TIMEOUT_MS
    this.sleep = cfg.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  async query<T = Record<string, unknown>>(sql: string, params?: string[]): Promise<D1Result<T>> {
    const [result] = await this.send<T>(statementBody({ sql, params }), 1)
    return result
  }

  /**
   * Runs several statements in one HTTP request. Falls back to one request per statement when the
   * endpoint rejects batch bodies, so callers must not rely on the batch being atomic.
   */
  async batch<T = Record<string, unknown>>(statements: D1Statement[]): Promise<D1Result<T>[]> {
    if (!statements.length) return []
    if (statements.length === 1) return [await this.query<T>(statements[0].sql, statements[0].params)]
    if (this.batchSupported) {
      try {
        return await this.send<T>({ batch: statements.map(statementBody) }, statements.length)
      } catch (err) {
        if (!(err instanceof BatchUnsupportedError)) throw err
        this.batchSupported = false
      }
    }
    const results: D1Result<T>[] = []
    for (const s of statements) results.push(await this.query<T>(s.sql, s.params))
    return results
  }

  private async send<T>(body: object, expected: number): Promise<D1Result<T>[]> {
    const payload = JSON.stringify(body)
    const isBatch = 'batch' in body
    for (let attempt = 0; ; attempt++) {
      let res: Response
      let text: string
      try {
        res = await this.fetchImpl(this.url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.cfg.apiToken}`, 'Content-Type': 'application/json' },
          body: payload,
          signal: AbortSignal.timeout(this.timeoutMs)
        })
        text = await res.text()
      } catch (err) {
        throw new SyncAdapterError('network', this.redact(describeFetchError(err)), err)
      }
      const envelope = parseEnvelope(text)
      if (res.status === 429) {
        const delay =
          attempt < MAX_RATE_LIMIT_RETRIES ? retryDelay(res.headers.get('retry-after'), attempt) : null
        if (delay !== null) {
          await this.sleep(delay)
          continue
        }
        throw new SyncAdapterError('rate-limit', 'Cloudflare D1 rate limit exceeded; try again later.')
      }
      if (!res.ok || !envelope || envelope.success === false) {
        if (isBatch && isBatchUnsupported(res.status, envelope)) throw new BatchUnsupportedError()
        throw this.toError(res.status, envelope)
      }
      return toResults<T>(envelope, expected)
    }
  }

  private toError(status: number, envelope: CfEnvelope | null): SyncAdapterError {
    const errors = envelope?.errors ?? []
    const codes = errors.map((e) => e.code)
    const detail = this.redact(
      errors
        .map((e) => e.message)
        .filter(Boolean)
        .join('; ') || `HTTP ${status}`
    )
    if (status === 401 || status === 403 || codes.some((c) => c !== undefined && AUTH_ERROR_CODES.has(c))) {
      return new SyncAdapterError('auth', `Cloudflare rejected the API token: ${detail}`)
    }
    if (status === 404 || codes.some((c) => c !== undefined && NOT_FOUND_ERROR_CODES.has(c))) {
      return new SyncAdapterError(
        'config',
        `Cloudflare D1 database not found (check the account ID and database ID): ${detail}`
      )
    }
    if (status >= 500 || status === 408) {
      return new SyncAdapterError('network', `Cloudflare API is unavailable (HTTP ${status}): ${detail}`)
    }
    if (!envelope) {
      const code = status < 400 ? 'network' : 'unknown'
      return new SyncAdapterError(code, `Unexpected response from the Cloudflare API (HTTP ${status}).`)
    }
    if (/no such table/i.test(detail)) return new SyncAdapterError('schema', `D1 query failed: ${detail}`)
    return new SyncAdapterError('unknown', `D1 query failed: ${detail}`)
  }

  private redact(message: string): string {
    const token = this.cfg.apiToken
    return token && token.length >= 4 ? message.split(token).join('***') : message
  }
}

function statementBody(s: D1Statement): D1Statement {
  return s.params?.length ? { sql: s.sql, params: s.params } : { sql: s.sql }
}

function parseEnvelope(text: string): CfEnvelope | null {
  try {
    const value: unknown = JSON.parse(text)
    return value && typeof value === 'object' ? (value as CfEnvelope) : null
  } catch {
    return null
  }
}

function toResults<T>(envelope: CfEnvelope, expected: number): D1Result<T>[] {
  const result = envelope.result
  if (!Array.isArray(result) || result.length !== expected) {
    throw new SyncAdapterError('unknown', 'Unexpected response from Cloudflare D1 (result count mismatch).')
  }
  return result.map((entry: unknown) => {
    const r = (entry ?? {}) as { results?: unknown; success?: boolean; meta?: D1Meta; error?: unknown }
    if (r.success === false) {
      throw new SyncAdapterError(
        'unknown',
        `D1 statement failed: ${typeof r.error === 'string' ? r.error : 'unknown'}`
      )
    }
    return { rows: Array.isArray(r.results) ? (r.results as T[]) : [], meta: r.meta ?? {} }
  })
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

function isBatchUnsupported(status: number, envelope: CfEnvelope | null): boolean {
  if (status < 400 || status >= 500 || status === 401 || status === 403 || status === 404 || status === 429) {
    return false
  }
  const text = (envelope?.errors ?? []).map((e) => e.message ?? '').join(' ')
  // A failed batch is rolled back as a whole, so falling back is safe; real SQL errors are not retried.
  if (/SQLITE|D1_ERROR/i.test(text)) return false
  return !text || /batch|malformed|required|unrecognized|invalid (?:request|body|json)/i.test(text)
}

function describeFetchError(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } } | null
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'Cloudflare D1 request timed out.'
  const detail = e?.cause?.code ?? e?.cause?.message ?? e?.message ?? 'request failed'
  return `Cannot reach the Cloudflare API: ${detail}`
}
