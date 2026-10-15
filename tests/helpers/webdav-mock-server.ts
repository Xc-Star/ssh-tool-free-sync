import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * Local stand-in for a WebDAV collection backed by an in-memory file map. It implements the subset
 * the adapter relies on — `GET` / `PUT` / `DELETE` / `OPTIONS` / `PROPFIND` / `MKCOL`, HTTP Basic
 * auth and ETag compare-and-swap — so the conformance suite can exercise the real client code.
 */
export interface WebdavMockOptions {
  username?: string
  password?: string
  /** Answer the first N requests with HTTP 429 (`Retry-After: 0`). */
  failFirst429?: number
  latencyMs?: number
  /** Do not send ETag headers, forcing the adapter onto its revision-verification fallback. */
  noEtag?: boolean
  /** Reject writes with HTTP 507 (insufficient storage). */
  readOnly?: boolean
}

export interface WebdavMock {
  /** Collection URL, always ending with a slash. */
  url: string
  username: string
  password: string
  /** Number of HTTP requests received so far. */
  readonly requests: number
  /** File names currently stored in the collection. */
  files(): string[]
  read(name: string): string | null
  write(name: string, body: string): void
  remove(name: string): void
  close(): Promise<void>
}

interface Entry {
  body: string
  etag: string
}

const COLLECTION = '/dav/'

export async function startWebdavMock(opts: WebdavMockOptions = {}): Promise<WebdavMock> {
  const username = opts.username ?? 'alice'
  const password = opts.password ?? 'webdav-secret-0123456789'
  const store = new Map<string, Entry>()
  let pending429 = opts.failFirst429 ?? 0
  let requests = 0

  const server = createServer((req, res) => {
    requests++
    handle(req, res).catch(() => reply(res, 500, 'internal error'))
  })

  const etagFor = (body: string): string => `"${createHash('sha1').update(body).digest('hex')}"`

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = req.method === 'PUT' ? await readBody(req) : ''
    if (opts.latencyMs) await new Promise((resolve) => setTimeout(resolve, opts.latencyMs))
    if (pending429 > 0) {
      pending429--
      return reply(res, 429, 'slow down', { 'Retry-After': '0' })
    }
    const parsed = new URL(req.url ?? '/', 'http://localhost')
    if (!parsed.pathname.startsWith(COLLECTION)) return reply(res, 404, 'not found')

    const expected = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
    if (req.headers.authorization !== expected) {
      return reply(res, 401, 'unauthorized', { 'WWW-Authenticate': 'Basic realm="dav"' })
    }

    const name = decodeURIComponent(parsed.pathname.slice(COLLECTION.length))
    switch (req.method) {
      case 'OPTIONS':
        return reply(res, 200, '', { DAV: '1,2', Allow: 'OPTIONS, GET, PUT, DELETE, PROPFIND, MKCOL' })
      case 'PROPFIND':
        return propfind(res, name)
      case 'MKCOL':
        // The collection always exists in this mock.
        return reply(res, 405, 'collection exists')
      case 'GET':
        return get(req, res, name)
      case 'PUT':
        return put(req, res, name, body)
      case 'DELETE': {
        if (!store.has(name)) return reply(res, 404, 'not found')
        store.delete(name)
        return reply(res, 204, '')
      }
      default:
        return reply(res, 405, 'method not allowed', { Allow: 'OPTIONS, GET, PUT, DELETE, PROPFIND' })
    }
  }

  function propfind(res: ServerResponse, name: string): void {
    const target = name.replace(/\/+$/, '')
    if (target === '') {
      const children = [...store.keys()].map(
        (file) => `<D:response><D:href>${COLLECTION}${file}</D:href></D:response>`
      )
      return reply(
        res,
        207,
        `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${children.join('')}</D:multistatus>`,
        { 'Content-Type': 'application/xml; charset=utf-8' }
      )
    }
    if (!store.has(target)) return reply(res, 404, 'not found')
    return reply(res, 207, '<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:"/>', {
      'Content-Type': 'application/xml; charset=utf-8'
    })
  }

  function get(req: IncomingMessage, res: ServerResponse, name: string): void {
    const entry = store.get(name)
    if (!entry) return reply(res, 404, 'not found')
    const inm = headerValue(req, 'if-none-match')
    if (inm !== null && etagMatches(inm, entry.etag)) return reply(res, 304, '')
    return reply(res, 200, entry.body, {
      'Content-Type': 'application/json; charset=utf-8',
      ...(opts.noEtag ? {} : { ETag: entry.etag })
    })
  }

  function put(req: IncomingMessage, res: ServerResponse, name: string, body: string): void {
    if (opts.readOnly) return reply(res, 507, 'insufficient storage')
    const entry = store.get(name)
    const ifNoneMatch = headerValue(req, 'if-none-match')
    const ifMatch = headerValue(req, 'if-match')
    if (ifNoneMatch !== null) {
      const blocked = ifNoneMatch.trim() === '*' ? !!entry : !!entry && etagMatches(ifNoneMatch, entry.etag)
      if (blocked) return reply(res, 412, 'precondition failed')
    }
    if (ifMatch !== null && (!entry || !etagMatches(ifMatch, entry.etag))) {
      return reply(res, 412, 'precondition failed')
    }
    const next: Entry = { body, etag: etagFor(body) }
    store.set(name, next)
    return reply(res, entry ? 204 : 201, '', opts.noEtag ? {} : { ETag: next.etag })
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const { port } = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${port}${COLLECTION}`,
    username,
    password,
    get requests() {
      return requests
    },
    files: () => [...store.keys()],
    read: (name) => store.get(name)?.body ?? null,
    write: (name, body) => {
      store.set(name, { body, etag: etagFor(body) })
    },
    remove: (name) => {
      store.delete(name)
    },
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
    }
  }
}

function headerValue(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name]
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

function etagMatches(header: string, etag: string): boolean {
  const candidates = header.split(',').map((v) => v.trim())
  if (candidates.includes('*')) return true
  return candidates.some((c) => c === etag || c.replace(/^W\//, '') === etag.replace(/^W\//, ''))
}

function reply(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  if (res.headersSent) return
  res.writeHead(status, { 'Content-Length': Buffer.byteLength(body), ...headers })
  res.end(body)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
