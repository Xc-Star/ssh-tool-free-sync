import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite'

// Loaded without an import statement: Playwright's TS loader hook cannot resolve the `node:sqlite` builtin.
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite')
type DatabaseSync = DatabaseSyncType

/**
 * Local stand-in for the Cloudflare D1 REST API (`POST /client/v4/accounts/:acc/d1/database/:db/query`)
 * backed by an in-memory SQLite database. Requests execute one at a time, like D1's single writer.
 */
export interface D1MockOptions {
  token?: string
  accountId?: string
  databaseId?: string
  /** Answer the first N requests with HTTP 429 (`Retry-After: 0`). */
  failFirst429?: number
  latencyMs?: number
  /** Reject `{ batch: [...] }` bodies with HTTP 400. */
  disableBatch?: boolean
}

export interface D1Mock {
  baseUrl: string
  accountId: string
  databaseId: string
  token: string
  /** Number of HTTP requests received so far. */
  readonly requests: number
  db: DatabaseSync
  close(): Promise<void>
}

interface Statement {
  sql: string
  params?: unknown[]
}

const ROUTE = /^\/client\/v4\/accounts\/([^/]+)\/d1\/database\/([^/]+)\/query\/?$/
// Real D1 limits, enforced so adapters cannot accidentally depend on more.
const MAX_PARAMS = 100
const MAX_SQL_LENGTH = 100_000

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: number,
    message: string
  ) {
    super(message)
  }
}

export async function startD1Mock(opts: D1MockOptions = {}): Promise<D1Mock> {
  const token = opts.token ?? 'd1-mock-token-0123456789'
  const accountId = opts.accountId ?? '0123456789abcdef0123456789abcdef'
  const databaseId = opts.databaseId ?? 'f00dfeed-0000-4000-8000-000000000001'
  const db = new DatabaseSync(':memory:')
  let pending429 = opts.failFirst429 ?? 0
  let requests = 0
  let closed = false
  let queue: Promise<void> = Promise.resolve()

  const server = createServer((req, res) => {
    requests++
    handle(req, res).catch((err: unknown) => reply(res, 500, failure(7500, String(err))))
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req)
    if (opts.latencyMs) await new Promise((resolve) => setTimeout(resolve, opts.latencyMs))
    const run = queue.then(() => respond(req, res, body))
    queue = run.catch(() => undefined)
    await run
  }

  function respond(req: IncomingMessage, res: ServerResponse, raw: string): void {
    if (pending429 > 0) {
      pending429--
      reply(res, 429, failure(971, 'Please wait and consider throttling your request speed'), {
        'Retry-After': '0'
      })
      return
    }
    const match = ROUTE.exec(new URL(req.url ?? '/', 'http://localhost').pathname)
    if (req.method !== 'POST' || !match) return reply(res, 404, failure(7000, 'No route for that URI'))
    if (req.headers.authorization !== `Bearer ${token}`) {
      return reply(res, 401, failure(10000, 'Authentication error'))
    }
    if (decodeURIComponent(match[1]) !== accountId || decodeURIComponent(match[2]) !== databaseId) {
      return reply(res, 404, failure(7404, 'The database could not be found'))
    }
    try {
      const { statements, batch } = parseBody(raw)
      if (batch && opts.disableBatch) {
        throw new HttpError(400, 7400, "The request is malformed: 'batch' is not supported")
      }
      reply(res, 200, { success: true, errors: [], messages: [], result: execute(statements, batch) })
    } catch (err) {
      if (err instanceof HttpError) return reply(res, err.status, failure(err.code, err.message))
      reply(res, 400, failure(7500, `${(err as Error).message}: SQLITE_ERROR`))
    }
  }

  function execute(statements: Statement[], batch: boolean): unknown[] {
    if (!batch) return [runStatement(statements[0])]
    db.exec('BEGIN')
    try {
      const results = statements.map(runStatement)
      db.exec('COMMIT')
      return results
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  function runStatement(s: Statement): unknown {
    const started = performance.now()
    const before = totalChanges()
    const rows = db.prepare(s.sql).all(...((s.params ?? []) as string[]))
    const changes = totalChanges() - before
    const lastRowId = (db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id
    return {
      results: rows.map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([k, v]) => [k, v instanceof Uint8Array ? Array.from(v) : v])
        )
      ),
      success: true,
      meta: {
        changed_db: changes > 0,
        changes,
        duration: performance.now() - started,
        last_row_id: lastRowId,
        rows_read: rows.length,
        rows_written: changes
      }
    }
  }

  function totalChanges(): number {
    return (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const { port } = server.address() as AddressInfo

  return {
    baseUrl: `http://127.0.0.1:${port}/client/v4`,
    accountId,
    databaseId,
    token,
    db,
    get requests() {
      return requests
    },
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
      if (!closed) db.close()
      closed = true
    }
  }
}

function parseBody(raw: string): { statements: Statement[]; batch: boolean } {
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    throw new HttpError(400, 7400, 'The request is malformed: invalid JSON body')
  }
  const b = (body ?? {}) as { sql?: unknown; params?: unknown; batch?: unknown }
  const batch = b.batch !== undefined
  const list = batch ? b.batch : [b]
  if (!Array.isArray(list) || !list.length) {
    throw new HttpError(400, 7400, 'The request is malformed: empty batch')
  }
  const statements = list.map((entry: unknown) => {
    const s = (entry ?? {}) as { sql?: unknown; params?: unknown }
    if (typeof s.sql !== 'string' || !s.sql.trim()) {
      throw new HttpError(400, 7400, "The request is malformed: 'sql' is required")
    }
    if (s.sql.length > MAX_SQL_LENGTH) throw new HttpError(400, 7500, 'SQL statement too long: SQLITE_TOOBIG')
    const params = s.params ?? []
    if (!Array.isArray(params) || params.some((p) => typeof p !== 'string')) {
      throw new HttpError(400, 7400, "The request is malformed: 'params' must be an array of strings")
    }
    if (params.length > MAX_PARAMS) throw new HttpError(400, 7500, 'too many SQL variables: SQLITE_ERROR')
    return { sql: s.sql, params }
  })
  return { statements, batch }
}

function failure(code: number, message: string): object {
  return { success: false, errors: [{ code, message }], messages: [], result: null }
}

function reply(
  res: ServerResponse,
  status: number,
  body: object,
  headers: Record<string, string> = {}
): void {
  if (res.headersSent) return
  const json = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
    ...headers
  })
  res.end(json)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
