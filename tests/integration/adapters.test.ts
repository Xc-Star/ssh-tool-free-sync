import { spawnSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection, type ConnectionOptions, type RowDataPacket } from 'mysql2/promise'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest'
import type { D1DbConfig, SqlDbConfig, SslMode, WebdavDbConfig } from '@shared/types'
import { SyncAdapterError, type SyncAdapter } from '../../src/main/sync/adapter'
import { createAdapter, describeDbConfig } from '../../src/main/sync/adapters'
import { D1Client } from '../../src/main/sync/adapters/d1-client'
import { formatHlc } from '../../src/main/vault/hlc'
import { startD1Mock, type D1Mock } from '../helpers/d1-mock-server'
import { startWebdavMock, type WebdavMock } from '../helpers/webdav-mock-server'
import { newPrefix, runAdapterConformance, type ConformanceOptions } from './adapter-conformance'

type RawHooks = Pick<ConformanceOptions, 'getSchemaVersion' | 'setSchemaVersion' | 'dropTables'>

const env = process.env
const TABLES = ['meta', 'items', 'devices', 'counter']

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo
      srv.close(() => resolve(port))
    })
  })
}

async function expectAdapterError(
  promise: Promise<unknown>,
  code: SyncAdapterError['code'],
  secret?: string
): Promise<SyncAdapterError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e
  )
  expect(err).toBeInstanceOf(SyncAdapterError)
  expect((err as SyncAdapterError).code).toBe(code)
  if (secret) expect((err as Error).message).not.toContain(secret)
  return err as SyncAdapterError
}

async function closeQuietly(adapter: SyncAdapter): Promise<void> {
  await adapter.close().catch(() => undefined)
}

// ---------------------------------------------------------------- factory / labels

describe('createAdapter / describeDbConfig', () => {
  it('describes targets without credentials', () => {
    const configs: [SqlDbConfig | D1DbConfig | WebdavDbConfig, string][] = [
      [
        {
          kind: 'postgres',
          url: 'postgresql://alice:s3cr3t-pw@db.example.com:6543/vault?sslmode=require',
          ssl: 'require',
          tablePrefix: 'sshtool_'
        },
        'PostgreSQL · db.example.com:6543/vault'
      ],
      [
        {
          kind: 'postgres',
          host: 'db.internal',
          database: 'sync',
          user: 'bob',
          password: 'hunter22',
          ssl: 'disable',
          tablePrefix: 'sshtool_'
        },
        'PostgreSQL · db.internal:5432/sync'
      ],
      [
        {
          kind: 'mysql',
          url: 'mysql://root:topsecret@mysql.example.com/app',
          ssl: 'verify-full',
          tablePrefix: 'x_'
        },
        'MySQL · mysql.example.com:3306/app'
      ],
      [
        {
          kind: 'mysql',
          host: 'my.local',
          port: 3307,
          database: 'db',
          password: 'pw-123',
          ssl: 'require',
          tablePrefix: 'x_'
        },
        'MySQL · my.local:3307/db'
      ],
      [
        {
          kind: 'd1',
          accountId: 'acc',
          databaseId: '0123456789abcdef',
          apiToken: 'cf-token-xyz',
          tablePrefix: 'sshtool_'
        },
        'Cloudflare D1 · 01234567'
      ],
      [
        {
          kind: 'webdav',
          url: 'https://cloud.example.com/dav/sshtool/',
          username: 'alice',
          password: 's3cr3t-webdav',
          tablePrefix: 'sshtool_'
        },
        'WebDAV · cloud.example.com/dav/sshtool'
      ]
    ]
    for (const [config, label] of configs) {
      expect(describeDbConfig(config)).toBe(label)
      const adapter = createAdapter(config)
      expect(adapter.kind).toBe(config.kind)
      expect(adapter.label).toBe(label)
      expect(adapter.label).not.toMatch(/s3cr3t|hunter22|topsecret|pw-123|cf-token|alice|bob/)
    }
  })

  it('rejects invalid table prefixes as configuration errors', () => {
    const bad = {
      kind: 'd1',
      accountId: 'a',
      databaseId: 'b',
      apiToken: 'c',
      tablePrefix: 'x; DROP'
    } as const
    expect(() => createAdapter(bad)).toThrow(SyncAdapterError)
    expect(() => createAdapter({ kind: 'postgres', ssl: 'disable', tablePrefix: '1abc' })).toThrow(
      SyncAdapterError
    )
    expect(() =>
      createAdapter({ kind: 'webdav', url: 'https://cloud.example.com/dav/', tablePrefix: '1abc' })
    ).toThrow(SyncAdapterError)
  })

  it('never leaks WebDAV credentials embedded in the URL', () => {
    const adapter = createAdapter({
      kind: 'webdav',
      url: 'https://alice:s3cr3t-webdav@cloud.example.com/dav/x/',
      tablePrefix: 'sshtool_'
    })
    expect(adapter.label).toBe('WebDAV · cloud.example.com/dav/x')
    expect(adapter.label).not.toMatch(/alice|s3cr3t/)
  })
})

// ---------------------------------------------------------------- Cloudflare D1 (local mock)

describe('Cloudflare D1 (local mock)', () => {
  let mock: D1Mock
  beforeAll(async () => {
    mock = await startD1Mock()
  })
  afterAll(async () => {
    await mock?.close()
  })

  const configFor = (m: D1Mock, prefix = newPrefix(), overrides: Partial<D1DbConfig> = {}): D1DbConfig => ({
    kind: 'd1',
    accountId: m.accountId,
    databaseId: m.databaseId,
    apiToken: m.token,
    baseUrl: m.baseUrl,
    tablePrefix: prefix,
    ...overrides
  })

  runAdapterConformance('Cloudflare D1 (mock)', (prefix) => createAdapter(configFor(mock, prefix)), {
    getSchemaVersion: async (prefix) => {
      const row = mock.db.prepare(`SELECT v FROM "${prefix}meta" WHERE k = 'schema_version'`).get() as
        { v: string } | undefined
      return row?.v ?? null
    },
    setSchemaVersion: async (prefix, version) => {
      mock.db.prepare(`UPDATE "${prefix}meta" SET v = ? WHERE k = 'schema_version'`).run(version)
    },
    dropTables: async (prefix) => {
      for (const t of TABLES) mock.db.exec(`DROP TABLE IF EXISTS "${prefix}${t}"`)
    },
    secrets: () => [mock.token]
  })

  describe('REST client behaviour', () => {
    it('retries HTTP 429 responses', async () => {
      const limited = await startD1Mock({ failFirst429: 2 })
      const adapter = createAdapter(configFor(limited))
      try {
        await adapter.connect()
        expect(limited.requests).toBe(3)
        await adapter.ensureSchema()
        expect(await adapter.head()).toBe(0)
      } finally {
        await closeQuietly(adapter)
        await limited.close()
      }
    })

    it('gives up with a transient rate-limit error after three retries', async () => {
      const limited = await startD1Mock({ failFirst429: 10 })
      try {
        const err = await expectAdapterError(createAdapter(configFor(limited)).connect(), 'rate-limit')
        expect(err.transient).toBe(true)
        expect(limited.requests).toBe(4)
      } finally {
        await limited.close()
      }
    })

    it('falls back to one request per statement when batches are rejected', async () => {
      const noBatch = await startD1Mock({ disableBatch: true, latencyMs: 2 })
      const adapter = createAdapter(configFor(noBatch))
      try {
        await adapter.connect()
        const beforeSchema = noBatch.requests
        await adapter.ensureSchema()
        expect(noBatch.requests - beforeSchema).toBe(7)
        const items = [1, 2, 3].map((n) => ({
          id: randomUUID(),
          payload: randomBytes(n * 10),
          hlc: formatHlc(1_700_000_000_000 + n, 0, 'dev'),
          deleted: false,
          deviceId: 'dev'
        }))
        const beforePush = noBatch.requests
        await adapter.push(items)
        expect(noBatch.requests - beforePush).toBe(3)
        const pulled = await adapter.pull(0, 10)
        expect(pulled.map((r) => r.id).sort()).toEqual(items.map((i) => i.id).sort())
        expect(pulled.map((r) => r.seq)).toEqual([1, 2, 3])
      } finally {
        await closeQuietly(adapter)
        await noBatch.close()
      }
    })

    it('maps a rejected token to an auth error without leaking the token', async () => {
      const token = 'bad-token-SECRET-1234567'
      const err = await expectAdapterError(
        createAdapter(configFor(mock, newPrefix(), { apiToken: token })).connect(),
        'auth',
        token
      )
      expect(err.transient).toBe(false)
    })

    it('maps an unknown database to a config error', async () => {
      await expectAdapterError(
        createAdapter(
          configFor(mock, newPrefix(), { databaseId: '00000000-0000-0000-0000-000000000000' })
        ).connect(),
        'config'
      )
    })

    it('maps an unreachable API to a network error', async () => {
      const baseUrl = `http://127.0.0.1:${await freePort()}/client/v4`
      const err = await expectAdapterError(
        createAdapter(configFor(mock, newPrefix(), { baseUrl })).connect(),
        'network'
      )
      expect(err.transient).toBe(true)
    })

    it('maps Cloudflare API failures to error codes', async () => {
      const respond = (status: number, body: string, headers: Record<string, string> = {}) => {
        let calls = 0
        const fetchImpl = (async () => {
          calls++
          return new Response(body, { status, headers })
        }) as typeof fetch
        const client = new D1Client({ accountId: 'a', databaseId: 'b', apiToken: 'tok-SECRET-99', fetchImpl })
        return { client, calls: () => calls }
      }
      const cf = (code: number, message: string) =>
        JSON.stringify({ success: false, errors: [{ code, message }] })
      await expectAdapterError(respond(503, 'upstream unavailable').client.query('SELECT 1'), 'network')
      await expectAdapterError(
        respond(200, '<html>captive portal</html>').client.query('SELECT 1'),
        'network'
      )
      await expectAdapterError(
        respond(400, cf(9109, 'Invalid access token')).client.query('SELECT 1'),
        'auth'
      )
      await expectAdapterError(
        respond(400, cf(7500, 'UNIQUE constraint failed: SQLITE_CONSTRAINT')).client.query('x'),
        'unknown'
      )
      const tooLong = respond(429, cf(971, 'slow down'), { 'Retry-After': '3600' })
      await expectAdapterError(tooLong.client.query('SELECT 1'), 'rate-limit')
      expect(tooLong.calls()).toBe(1)
      const ok = respond(
        200,
        JSON.stringify({ success: true, errors: [], result: [{ results: [{ n: 1 }], meta: {} }] })
      )
      expect((await ok.client.query('SELECT 1')).rows).toEqual([{ n: 1 }])
      expect(
        () => new D1Client({ accountId: 'a', databaseId: 'b', apiToken: 'c', baseUrl: 'not a url' })
      ).toThrow(SyncAdapterError)
    })

    it('reports SQL errors and missing tables', async () => {
      const client = new D1Client({
        accountId: mock.accountId,
        databaseId: mock.databaseId,
        apiToken: mock.token,
        baseUrl: mock.baseUrl
      })
      await expectAdapterError(client.query('SELECT * FROM no_such_table_here'), 'schema')
      await expectAdapterError(client.query('SELEC 1'), 'unknown')
      const [a, b] = await client.batch<{ n: number }>([
        { sql: 'SELECT 1 AS n' },
        { sql: 'SELECT ? AS n', params: ['2'] }
      ])
      expect(a.rows).toEqual([{ n: 1 }])
      expect(b.rows).toEqual([{ n: '2' }])
    })
  })
})

// ---------------------------------------------------------------- WebDAV (local mock)

describe('WebDAV (local mock)', () => {
  let mock: WebdavMock
  beforeAll(async () => {
    mock = await startWebdavMock()
  })
  afterAll(async () => {
    await mock?.close()
  })

  const configFor = (
    m: WebdavMock,
    prefix = newPrefix(),
    overrides: Partial<WebdavDbConfig> = {}
  ): WebdavDbConfig => ({
    kind: 'webdav',
    url: m.url,
    username: m.username,
    password: m.password,
    tablePrefix: prefix,
    ...overrides
  })

  const rawHooks = (
    get: () => WebdavMock
  ): Pick<ConformanceOptions, 'getSchemaVersion' | 'setSchemaVersion' | 'dropTables'> => ({
    getSchemaVersion: async (prefix) => {
      const text = get().read(`${prefix}sync.json`)
      if (!text) return null
      return String((JSON.parse(text) as { schemaVersion?: number }).schemaVersion)
    },
    setSchemaVersion: async (prefix, version) => {
      const m = get()
      const name = `${prefix}sync.json`
      const doc = JSON.parse(m.read(name) ?? '{}') as Record<string, unknown>
      doc.schemaVersion = Number(version)
      m.write(name, JSON.stringify(doc))
    },
    dropTables: async (prefix) => {
      const m = get()
      for (const file of m.files()) if (file.startsWith(prefix)) m.remove(file)
    }
  })

  runAdapterConformance('WebDAV (mock)', (prefix) => createAdapter(configFor(mock, prefix)), {
    ...rawHooks(() => mock),
    secrets: () => [mock.password]
  })

  describe('client behaviour', () => {
    it('retries HTTP 429 responses', async () => {
      const limited = await startWebdavMock({ failFirst429: 2 })
      const adapter = createAdapter(configFor(limited))
      try {
        await adapter.connect()
        expect(limited.requests).toBe(4)
        await adapter.ensureSchema()
        expect(await adapter.head()).toBe(0)
      } finally {
        await closeQuietly(adapter)
        await limited.close()
      }
    })

    it('gives up with a transient rate-limit error after three retries', async () => {
      const limited = await startWebdavMock({ failFirst429: 10 })
      try {
        const err = await expectAdapterError(createAdapter(configFor(limited)).connect(), 'rate-limit')
        expect(err.transient).toBe(true)
        expect(limited.requests).toBe(4)
      } finally {
        await limited.close()
      }
    })

    it('maps rejected credentials to an auth error without leaking them', async () => {
      const password = 'wrong-password-SECRET-42'
      const err = await expectAdapterError(
        createAdapter(configFor(mock, newPrefix(), { password })).connect(),
        'auth',
        password
      )
      expect(err.transient).toBe(false)
    })

    it('maps a missing folder to a config error', async () => {
      const port = new URL(mock.url).port
      await expectAdapterError(
        createAdapter(configFor(mock, newPrefix(), { url: `http://127.0.0.1:${port}/nope/` })).connect(),
        'config'
      )
    })

    it('maps an unreachable server to a network error', async () => {
      const url = `http://127.0.0.1:${await freePort()}/dav/`
      const err = await expectAdapterError(
        createAdapter(configFor(mock, newPrefix(), { url })).connect(),
        'network'
      )
      expect(err.transient).toBe(true)
    })

    it('reports a read-only / full server as a configuration error', async () => {
      const readOnly = await startWebdavMock({ readOnly: true })
      const adapter = createAdapter(configFor(readOnly))
      try {
        await adapter.connect()
        await expectAdapterError(adapter.ensureSchema(), 'config')
      } finally {
        await closeQuietly(adapter)
        await readOnly.close()
      }
    })
  })

  describe('servers without strong ETags', () => {
    let plain: WebdavMock
    beforeAll(async () => {
      plain = await startWebdavMock({ noEtag: true })
    })
    afterAll(async () => {
      await plain?.close()
    })
    runAdapterConformance('WebDAV (no ETag)', (prefix) => createAdapter(configFor(plain, prefix)), {
      ...rawHooks(() => plain),
      secrets: () => [plain.password],
      writers: 2,
      itemsPerWriter: 20
    })
  })
})

// ---------------------------------------------------------------- PostgreSQL

const PG_DB = 'sshtool_test'

interface EmbeddedPg {
  port: number
  password: string
  url: string
  stop(): Promise<void>
}

async function waitForPostgres(port: number, password: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const client = new pg.Client({
      host: '127.0.0.1',
      port,
      user: 'postgres',
      password,
      database: 'postgres'
    })
    client.on('error', () => undefined)
    try {
      await client.connect()
      await client.end()
      return
    } catch (err) {
      await client.end().catch(() => undefined)
      if (Date.now() > deadline) throw err
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
}

/** PostgreSQL refuses to run with administrator rights on Windows (e.g. GitHub's Windows runners). */
function isElevatedWindows(): boolean {
  if (process.platform !== 'win32') return false
  // `net session` only succeeds in an elevated process.
  return spawnSync('net', ['session'], { stdio: 'ignore', windowsHide: true }).status === 0
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms / 1000}s`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function startEmbeddedPostgres(): Promise<EmbeddedPg> {
  if (isElevatedWindows()) throw new Error('PostgreSQL cannot run with administrator rights on Windows')
  const { default: EmbeddedPostgres } = await import('embedded-postgres')
  const dir = await mkdtemp(join(tmpdir(), 'sshtool-pg-'))
  const port = await freePort()
  const password = `pw-${randomBytes(8).toString('hex')}`
  const logs: string[] = []
  const server = new EmbeddedPostgres({
    databaseDir: dir,
    port,
    user: 'postgres',
    password,
    persistent: false,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: (message) => logs.push(String(message)),
    onError: (message) => logs.push(String(message))
  })
  const stop = async (): Promise<void> => {
    await withTimeout(server.stop(), 15_000, 'Stopping PostgreSQL').catch(() => undefined)
    // On Windows the data files can stay locked for a moment after the server process exits.
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }).catch(() => undefined)
  }
  // Every step has a deadline (within the 180 s hook timeout): an environment where the server cannot start
  // skips the suite with a warning instead of failing the whole run on a hook timeout.
  try {
    await withTimeout(server.initialise(), 60_000, 'initdb')
    const started = server.start()
    started.catch(() => undefined)
    // start() waits for an English log line; also accept a server that is simply reachable.
    await Promise.race([started, waitForPostgres(port, password, 45_000)])
    await withTimeout(server.createDatabase(PG_DB), 20_000, 'CREATE DATABASE')
  } catch (err) {
    await stop()
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(`${reason}\n${logs.slice(-15).join('')}`, { cause: err })
  }
  return { port, password, url: `postgresql://postgres:${password}@127.0.0.1:${port}/${PG_DB}`, stop }
}

function pgRawHooks(url: () => string): RawHooks {
  const run = async <R extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<R[]> => {
    const client = new pg.Client({ connectionString: url() })
    client.on('error', () => undefined)
    await client.connect()
    try {
      return (await client.query<R>(sql, params)).rows
    } finally {
      await client.end()
    }
  }
  return {
    getSchemaVersion: async (prefix) =>
      (await run<{ v: string }>(`SELECT v FROM "${prefix}meta" WHERE k = 'schema_version'`))[0]?.v ?? null,
    setSchemaVersion: async (prefix, version) => {
      await run(`UPDATE "${prefix}meta" SET v = $1 WHERE k = 'schema_version'`, [version])
    },
    dropTables: async (prefix) => {
      await run(`DROP TABLE IF EXISTS ${TABLES.map((t) => `"${prefix}${t}"`).join(', ')}`)
    }
  }
}

describe('PostgreSQL (embedded)', () => {
  let server: EmbeddedPg | null = null
  beforeAll(async () => {
    try {
      server = await startEmbeddedPostgres()
    } catch (err) {
      console.warn(
        `[adapters.test] Skipping the embedded PostgreSQL suite: the server could not be started.\n${String(err)}`
      )
    }
  })
  afterAll(async () => {
    await server?.stop()
  })

  const pgConfig = (prefix: string, overrides: Partial<SqlDbConfig> = {}): SqlDbConfig => ({
    kind: 'postgres',
    host: '127.0.0.1',
    port: server!.port,
    database: PG_DB,
    user: 'postgres',
    password: server!.password,
    ssl: 'disable',
    tablePrefix: prefix,
    ...overrides
  })
  const requireServer = (ctx: TestContext): EmbeddedPg => {
    if (!server) return ctx.skip('embedded PostgreSQL is not available')
    return server
  }

  runAdapterConformance('PostgreSQL (embedded)', (prefix) => createAdapter(pgConfig(prefix)), {
    available: () => server !== null,
    secrets: () => [server!.password],
    ...pgRawHooks(() => server!.url)
  })

  describe('connection settings and error mapping', () => {
    it('accepts a connection URL and lets the explicit ssl setting win over sslmode', async (ctx) => {
      const s = requireServer(ctx)
      const prefix = newPrefix()
      const url = `postgresql://postgres:${encodeURIComponent(s.password)}@127.0.0.1:${s.port}/${PG_DB}?sslmode=require`
      const adapter = createAdapter({ kind: 'postgres', url, ssl: 'disable', tablePrefix: prefix })
      expect(adapter.label).toBe(`PostgreSQL · 127.0.0.1:${s.port}/${PG_DB}`)
      try {
        await adapter.connect()
        await adapter.ensureSchema()
        expect(await adapter.head()).toBe(0)
      } finally {
        await closeQuietly(adapter)
        await pgRawHooks(() => s.url).dropTables!(prefix)
      }
    })

    it('maps a wrong password to an auth error without leaking it', async (ctx) => {
      requireServer(ctx)
      const password = 'wrong-password-SECRET-42'
      await expectAdapterError(createAdapter(pgConfig(newPrefix(), { password })).connect(), 'auth', password)
    })

    it('maps an unknown database to a config error', async (ctx) => {
      requireServer(ctx)
      await expectAdapterError(
        createAdapter(pgConfig(newPrefix(), { database: 'no_such_db' })).connect(),
        'config'
      )
    })

    it('maps a refused connection to a network error', async (ctx) => {
      requireServer(ctx)
      const port = await freePort()
      await expectAdapterError(createAdapter(pgConfig(newPrefix(), { port })).connect(), 'network')
    })

    it('maps a TLS negotiation failure to a config error', async (ctx) => {
      requireServer(ctx)
      await expectAdapterError(createAdapter(pgConfig(newPrefix(), { ssl: 'require' })).connect(), 'config')
    })

    it('reports the realtime feed as failed when its connection is terminated', async (ctx) => {
      const s = requireServer(ctx)
      const adapter = createAdapter(pgConfig(newPrefix()))
      try {
        await adapter.connect()
        const failed = new Promise<Error>((resolve) => {
          void adapter.subscribe!(() => undefined, resolve)
        })
        // Give LISTEN a moment, then kill every other backend listening on our database.
        await new Promise((resolve) => setTimeout(resolve, 300))
        const admin = new pg.Client({ connectionString: s.url })
        await admin.connect()
        await admin.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND query ILIKE 'LISTEN%'"
        )
        await admin.end()
        const err = await failed
        expect(err).toBeInstanceOf(SyncAdapterError)
        expect((err as SyncAdapterError).code).toBe('network')
      } finally {
        await closeQuietly(adapter)
      }
    })
  })
})

const externalPg = env.SSHTOOL_TEST_PG_URL
describe.skipIf(!externalPg)('PostgreSQL (SSHTOOL_TEST_PG_URL)', () => {
  const ssl = (env.SSHTOOL_TEST_PG_SSL as SslMode | undefined) ?? 'disable'
  runAdapterConformance(
    'PostgreSQL (external)',
    (prefix) => createAdapter({ kind: 'postgres', url: externalPg!, ssl, tablePrefix: prefix }),
    pgRawHooks(() => externalPg!)
  )
})

// ---------------------------------------------------------------- MySQL / MariaDB

function mysqlRawHooks(options: () => ConnectionOptions): RawHooks {
  const run = async (sql: string, params: unknown[] = []): Promise<RowDataPacket[]> => {
    const conn = await createConnection(options())
    try {
      const [rows] = await conn.query<RowDataPacket[]>(sql, params)
      return rows
    } finally {
      await conn.end()
    }
  }
  return {
    getSchemaVersion: async (prefix) => {
      const rows = await run(`SELECT v FROM \`${prefix}meta\` WHERE k = 'schema_version'`)
      return rows.length ? String(rows[0].v) : null
    },
    setSchemaVersion: async (prefix, version) => {
      await run(`UPDATE \`${prefix}meta\` SET v = ? WHERE k = 'schema_version'`, [version])
    },
    dropTables: async (prefix) => {
      await run(`DROP TABLE IF EXISTS ${TABLES.map((t) => `\`${prefix}${t}\``).join(', ')}`)
    }
  }
}

describe.skipIf(env.SSHTOOL_TEST_MYSQL !== '1')('MySQL (mysql-memory-server)', () => {
  let db: { port: number; username: string; dbName: string; stop(): Promise<void> } | null = null
  // The first run downloads a MySQL server binary (several hundred MB).
  beforeAll(async () => {
    const { createDB } = await import('mysql-memory-server')
    db = await createDB({
      dbName: 'sshtool_test',
      logLevel: 'ERROR',
      xEnabled: 'OFF',
      version: env.SSHTOOL_TEST_MYSQL_VERSION || undefined
    })
  }, 20 * 60_000)
  afterAll(async () => {
    await db?.stop()
  })

  const mysqlConfig = (prefix: string, overrides: Partial<SqlDbConfig> = {}): SqlDbConfig => ({
    kind: 'mysql',
    host: '127.0.0.1',
    port: db!.port,
    user: db!.username,
    password: '',
    database: db!.dbName,
    ssl: 'disable',
    tablePrefix: prefix,
    ...overrides
  })

  runAdapterConformance('MySQL (mysql-memory-server)', (prefix) => createAdapter(mysqlConfig(prefix)), {
    available: () => db !== null,
    ...mysqlRawHooks(() => ({ host: '127.0.0.1', port: db!.port, user: db!.username, database: db!.dbName }))
  })

  describe('connection settings and error mapping', () => {
    it('accepts a connection URL', async () => {
      const prefix = newPrefix()
      const url = `mysql://${db!.username}@127.0.0.1:${db!.port}/${db!.dbName}?ssl=true`
      const adapter = createAdapter({ kind: 'mysql', url, ssl: 'disable', tablePrefix: prefix })
      expect(adapter.label).toBe(`MySQL · 127.0.0.1:${db!.port}/${db!.dbName}`)
      try {
        await adapter.connect()
        await adapter.ensureSchema()
        expect(await adapter.head()).toBe(0)
      } finally {
        await closeQuietly(adapter)
        await mysqlRawHooks(() => ({
          host: '127.0.0.1',
          port: db!.port,
          user: db!.username,
          database: db!.dbName
        })).dropTables!(prefix)
      }
    })

    it('maps a wrong password to an auth error without leaking it', async () => {
      const password = 'wrong-password-SECRET-42'
      await expectAdapterError(
        createAdapter(mysqlConfig(newPrefix(), { password })).connect(),
        'auth',
        password
      )
    })

    it('maps an unknown database to a config error', async () => {
      await expectAdapterError(
        createAdapter(mysqlConfig(newPrefix(), { database: 'no_such_db' })).connect(),
        'config'
      )
    })

    it('maps a refused connection to a network error', async () => {
      const port = await freePort()
      await expectAdapterError(createAdapter(mysqlConfig(newPrefix(), { port })).connect(), 'network')
    })

    it('stays correct when the server has NO_BACKSLASH_ESCAPES enabled', async () => {
      const options = { host: '127.0.0.1', port: db!.port, user: db!.username, database: db!.dbName }
      const admin = await createConnection(options)
      const [[row]] = await admin.query<RowDataPacket[]>('SELECT @@GLOBAL.sql_mode AS mode')
      const original = String(row.mode)
      await admin.query(
        `SET GLOBAL sql_mode = '${[original, 'NO_BACKSLASH_ESCAPES'].filter(Boolean).join(',')}'`
      )
      const prefix = newPrefix()
      const adapter = createAdapter(mysqlConfig(prefix))
      try {
        await adapter.connect()
        await adapter.ensureSchema()
        const meta = {
          vaultId: "id-with-'quote'",
          keyEpoch: 1,
          kdf: { alg: 'argon2id' as const, m: 1024, t: 1, p: 1 },
          salt: 'c2FsdA==',
          wrappedKey: 'a2V5',
          createdAt: 1,
          createdBy: `x'; DROP TABLE \`${prefix}items\`; -- \\`
        }
        expect(await adapter.createVaultMeta(meta)).toBe(true)
        expect(await adapter.getVaultMeta()).toEqual(meta)
      } finally {
        await admin.query(`SET GLOBAL sql_mode = ?`, [original])
        await admin.end()
        await closeQuietly(adapter)
        await mysqlRawHooks(() => options).dropTables!(prefix)
      }
    })
  })
})

const externalMysql = env.SSHTOOL_TEST_MYSQL_URL
describe.skipIf(!externalMysql)('MySQL (SSHTOOL_TEST_MYSQL_URL)', () => {
  const ssl = (env.SSHTOOL_TEST_MYSQL_SSL as SslMode | undefined) ?? 'disable'
  runAdapterConformance(
    'MySQL (external)',
    (prefix) => createAdapter({ kind: 'mysql', url: externalMysql!, ssl, tablePrefix: prefix }),
    mysqlRawHooks(() => ({ uri: externalMysql! }))
  )
})

// ---------------------------------------------------------------- Cloudflare D1 (live)

const liveD1 =
  env.CF_ACCOUNT_ID && env.CF_D1_DATABASE_ID && env.CF_API_TOKEN
    ? { accountId: env.CF_ACCOUNT_ID, databaseId: env.CF_D1_DATABASE_ID, apiToken: env.CF_API_TOKEN }
    : null
describe.skipIf(!liveD1)('Cloudflare D1 (live API)', () => {
  const client = (): D1Client => new D1Client(liveD1!)
  runAdapterConformance(
    'Cloudflare D1 (live)',
    (prefix) => createAdapter({ kind: 'd1', ...liveD1!, tablePrefix: prefix }),
    {
      secrets: () => [liveD1!.apiToken],
      getSchemaVersion: async (prefix) =>
        (await client().query<{ v: string }>(`SELECT v FROM "${prefix}meta" WHERE k = 'schema_version'`))
          .rows[0]?.v ?? null,
      setSchemaVersion: async (prefix, version) => {
        await client().query(`UPDATE "${prefix}meta" SET v = ? WHERE k = 'schema_version'`, [version])
      },
      dropTables: async (prefix) => {
        await client().batch(TABLES.map((t) => ({ sql: `DROP TABLE IF EXISTS "${prefix}${t}"` })))
      }
    }
  )
})
