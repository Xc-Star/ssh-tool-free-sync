import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { SocksClient } from 'socks'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PromptRequest } from '../../src/shared/types'
import { AppContext } from '../../src/main/context'
import { createHandlers, type PlatformBridge } from '../../src/main/ipc/handlers'
import { MemoryEmitter } from '../../src/main/services/emitter'
import { connectEndpoint, HostKeyRejectedError } from '../../src/main/ssh/connect'
import { resolveHostById } from '../../src/main/ssh/resolve'
import { TEST_KDF } from '../../src/main/vault/crypto'
import { testProtector } from '../helpers/device'
import { generateClientKey, startTestSshServer, type TestSshServer } from '../helpers/ssh-test-server'

let server: TestSshServer
let server2: TestSshServer
let ctx: AppContext
let emitter: MemoryEmitter
let tmp: string
const prompts: PromptRequest[] = []
let answer: (req: PromptRequest) => unknown = () => null
const clientKey = generateClientKey('ed25519')
const encryptedKey = generateClientKey('ed25519', 'pass123')

const platform: PlatformBridge = {
  appInfo: () => ({ name: 'test', version: '0', platform: process.platform, arch: process.arch, electron: '', node: process.versions.node, userData: tmp }),
  openExternal: async () => {},
  showItemInFolder: () => {},
  openFileDialog: async () => [],
  saveFileDialog: async () => null,
  setTitleBarTheme: () => {},
  openPath: async () => ''
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port
      s.close(() => resolve(port))
    })
  })
}

async function waitFor(fn: () => boolean, timeoutMs = 15000, what = 'condition'): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

function trustAll(req: PromptRequest): unknown {
  if (req.type === 'hostkey') return 'accept-save'
  return null
}

function connDeps() {
  return { vault: ctx.vault, prompts: ctx.prompts, knownHosts: ctx.knownHosts, defaultKeepAliveSec: 0 }
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sshtool-stack-'))
  server = await startTestSshServer({
    users: {
      test: { password: 'test', publicKeys: [clientKey.publicKey, encryptedKey.publicKey] },
      ki: {
        keyboardInteractive: {
          prompts: [
            { prompt: 'Password: ', echo: false },
            { prompt: 'Verification code: ', echo: true }
          ],
          answers: ['kipass', '123456']
        }
      }
    },
    execHandler: (command, stream) => {
      if (!command.includes('authorized_keys')) return false
      stream.write('SSHTOOL_ADDED\n')
      stream.exit(0)
      stream.end()
      return true
    }
  })
  server2 = await startTestSshServer({ users: { test: { password: 'test2' } } })
  emitter = new MemoryEmitter()
  ctx = new AppContext({
    userData: tmp,
    emitter,
    protector: testProtector,
    appVersion: 'test',
    createAdapter: () => {
      throw new Error('no sync in this test')
    },
    describeDb: () => '',
    kdf: TEST_KDF,
    dbFile: ':memory:'
  })
  await ctx.init()
  ctx.prompts.autoResponder = (req) => {
    prompts.push(req)
    return answer(req)
  }
})

afterAll(async () => {
  await ctx?.shutdown()
  await server?.close()
  await server2?.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('ssh connections', () => {
  it('authenticates with a stored password and trusts the host key on first use', async () => {
    const host = ctx.vault.upsert('host', { label: 'srv', address: '127.0.0.1', port: server.port, username: 'test', password: 'test' })
    prompts.length = 0
    answer = trustAll
    const conn = await connectEndpoint(resolveHostById(ctx.vault, host.id, { keepAliveSec: 0 }), connDeps())
    const res = await conn.exec('echo hi')
    expect(res.stdout.trim()).toBe('hi')
    conn.close()
    expect(prompts.map((p) => p.type)).toEqual(['hostkey'])
    const known = ctx.knownHosts.find('127.0.0.1', server.port)
    expect(known[0]?.data.fingerprint).toBe(server.hostKeyFingerprint)
    // second connection: key already trusted, no prompt
    prompts.length = 0
    const again = await connectEndpoint(resolveHostById(ctx.vault, host.id, { keepAliveSec: 0 }), connDeps())
    again.close()
    expect(prompts).toHaveLength(0)
  })

  it('refuses a changed host key unless the user accepts it', async () => {
    const host = ctx.vault.list('host').find((h) => h.data.label === 'srv')!
    const known = ctx.knownHosts.find('127.0.0.1', server.port)[0]
    ctx.vault.patch(known.id, { fingerprint: 'SHA256:not-the-real-one' })
    prompts.length = 0
    answer = (req) => (req.type === 'hostkey' ? 'reject' : null)
    await expect(connectEndpoint(resolveHostById(ctx.vault, host.id, { keepAliveSec: 0 }), connDeps())).rejects.toBeInstanceOf(HostKeyRejectedError)
    const p = prompts.find((x) => x.type === 'hostkey')
    expect(p && p.type === 'hostkey' && p.changed).toBe(true)
    answer = trustAll
    const conn = await connectEndpoint(resolveHostById(ctx.vault, host.id, { keepAliveSec: 0 }), connDeps())
    conn.close()
    expect(ctx.knownHosts.find('127.0.0.1', server.port)[0].data.fingerprint).toBe(server.hostKeyFingerprint)
  })

  it('authenticates with keys and asks for (and saves) an unknown passphrase', async () => {
    const handlers = createHandlers(ctx, platform)
    const key = await handlers['keys.import']({ label: 'k1', privateKey: clientKey.privateKey })
    const host = ctx.vault.upsert('host', { label: 'keyhost', address: '127.0.0.1', port: server.port, username: 'test', keyId: key.id })
    answer = trustAll
    const conn = await connectEndpoint(resolveHostById(ctx.vault, host.id, { keepAliveSec: 0 }), connDeps())
    conn.close()
    expect(server.authLog.some((a) => a.method === 'publickey' && a.success)).toBe(true)

    // Encrypted key stored without its passphrase → prompt → saved.
    const enc = ctx.vault.upsert('key', { label: 'enc', privateKey: encryptedKey.privateKey })
    ctx.vault.patch(host.id, { keyId: enc.id })
    prompts.length = 0
    answer = (req) => (req.type === 'passphrase' ? { value: 'pass123', save: true } : trustAll(req))
    const c2 = await connectEndpoint(resolveHostById(ctx.vault, host.id, { keepAliveSec: 0 }), connDeps())
    c2.close()
    expect(prompts.some((p) => p.type === 'passphrase')).toBe(true)
    expect(ctx.vault.get(enc.id, 'key')?.data.passphrase).toBe('pass123')
  })

  it('prompts for a password, retries a wrong one and saves the right one', async () => {
    const host = ctx.vault.upsert('host', { label: 'pw', address: '127.0.0.1', port: server.port, username: 'test' })
    let attempt = 0
    prompts.length = 0
    answer = (req) => (req.type === 'password' ? { value: attempt++ === 0 ? 'wrong' : 'test', save: true } : trustAll(req))
    const conn = await connectEndpoint(resolveHostById(ctx.vault, host.id, { keepAliveSec: 0 }), connDeps())
    conn.close()
    const pw = prompts.filter((p) => p.type === 'password')
    expect(pw).toHaveLength(2)
    expect(pw[1].type === 'password' && pw[1].message).toBeTruthy()
    expect(ctx.vault.get(host.id, 'host')?.data.password).toBe('test')
  })

  it('handles keyboard-interactive (2FA) prompts', async () => {
    const host = ctx.vault.upsert('host', { label: 'ki', address: '127.0.0.1', port: server.port, username: 'ki' })
    prompts.length = 0
    answer = (req) => (req.type === 'keyboard-interactive' ? { answers: ['kipass', '123456'] } : trustAll(req))
    const conn = await connectEndpoint(resolveHostById(ctx.vault, host.id, { keepAliveSec: 0 }), connDeps())
    conn.close()
    const ki = prompts.find((p) => p.type === 'keyboard-interactive')
    expect(ki && ki.type === 'keyboard-interactive' && ki.prompts).toHaveLength(2)
  })

  it('connects through a jump host', async () => {
    const jump = ctx.vault.list('host').find((h) => h.data.label === 'srv')!
    const target = ctx.vault.upsert('host', { label: 'behind', address: '127.0.0.1', port: server2.port, username: 'test', password: 'test2', jumpHostIds: [jump.id] })
    answer = trustAll
    const conn = await connectEndpoint(resolveHostById(ctx.vault, target.id, { keepAliveSec: 0 }), connDeps())
    expect(conn.chain).toHaveLength(2)
    const res = await conn.exec('whoami')
    expect(res.stdout.trim()).toBe('test')
    conn.close()
    expect(server2.authLog.some((a) => a.success)).toBe(true)
  })

  it('stops a running exec on abort and keeps the connection usable', async () => {
    const host = ctx.vault.list('host').find((h) => h.data.label === 'srv')!
    answer = trustAll
    const conn = await connectEndpoint(resolveHostById(ctx.vault, host.id, { keepAliveSec: 0 }), connDeps())
    const abort = new AbortController()
    const started = Date.now()
    const running = conn.exec('sleep 30', { timeoutMs: 60_000, signal: abort.signal })
    setTimeout(() => abort.abort(), 200)
    await expect(running).rejects.toThrow('Command aborted')
    expect(Date.now() - started).toBeLessThan(5_000)
    await expect(conn.exec('echo never', { signal: AbortSignal.abort() })).rejects.toThrow('Command aborted')
    expect((await conn.exec('echo still-ok')).stdout.trim()).toBe('still-ok')
    conn.close()
  })
})

describe('terminal sessions', () => {
  it('runs an interactive shell with env vars, startup snippet, resize and OS detection', async () => {
    const snippet = ctx.vault.upsert('snippet', { label: 'boot', script: 'echo started-ok' })
    const host = ctx.vault.upsert('host', {
      label: 'shell',
      address: '127.0.0.1',
      port: server.port,
      username: 'test',
      password: 'test',
      envVars: [{ name: 'FOO', value: 'bar' }],
      startupSnippetId: snippet.id
    })
    answer = trustAll
    const info = ctx.sessions.openSsh({ hostId: host.id, cols: 100, rows: 30 })
    const out = (): string => emitter.data.get(info.id) ?? ''
    await waitFor(() => ctx.sessions.get(info.id)?.info.status === 'connected', 15000, 'connected')
    await waitFor(() => out().includes('started-ok'), 10000, 'startup snippet output')
    ctx.sessions.write(info.id, 'echo hello-world\r')
    await waitFor(() => out().includes('hello-world\r\n'), 10000, 'echo output')
    ctx.sessions.resize(info.id, 132, 43)
    await new Promise((r) => setTimeout(r, 100))
    ctx.sessions.write(info.id, 'stty size\r')
    await waitFor(() => out().includes('43 132'), 10000, 'stty size')
    expect(server.envLog.some((e) => e.FOO === 'bar')).toBe(true)
    await waitFor(() => ctx.vault.get(host.id, 'host')?.data.osHint === 'ubuntu', 10000, 'os detection')
    const hist = ctx.history.list(10)
    expect(hist[0]).toMatchObject({ hostId: host.id, status: 'connected' })
    ctx.sessions.close(info.id)
    await waitFor(() => ctx.history.list(10)[0]?.status === 'closed', 5000, 'history closed')
  })

  it('applies backpressure when the renderer does not acknowledge output', async () => {
    const host = ctx.vault.list('host').find((h) => h.data.label === 'srv')!
    const info = ctx.sessions.openSsh({ hostId: host.id, cols: 80, rows: 24 })
    await waitFor(() => ctx.sessions.get(info.id)?.info.status === 'connected', 15000, 'connected')
    const len = (): number => (emitter.data.get(info.id) ?? '').length
    const before = len()
    ctx.sessions.write(info.id, 'cat-big 3000000\r')
    await new Promise((r) => setTimeout(r, 1500))
    const stalled = len() - before
    // Without acks the pump pauses the stream after ~512 KiB (plus data already in flight).
    expect(stalled).toBeGreaterThan(100_000)
    expect(stalled).toBeLessThan(1_500_000)
    // Acknowledging resumes the stream until everything arrived.
    for (let i = 0; i < 200 && len() - before < 3_000_000; i++) {
      ctx.sessions.ack(info.id, len())
      await new Promise((r) => setTimeout(r, 25))
    }
    expect(len() - before).toBeGreaterThanOrEqual(3_000_000)
    ctx.sessions.close(info.id)
  })
})

describe('sftp', () => {
  it('lists, uploads, downloads, resolves conflicts, edits and deletes', async () => {
    const host = ctx.vault.list('host').find((h) => h.data.label === 'srv')!
    answer = (req) => (req.type === 'conflict' ? { action: 'rename', applyToAll: false } : trustAll(req))
    const fsInfo = await ctx.fs.openSftp(host.id)
    expect(fsInfo.home).toBe('/home/test')

    const localDir = path.join(tmp, 'upload-src')
    fs.mkdirSync(path.join(localDir, 'sub'), { recursive: true })
    const big = randomBytes(1024 * 1024 + 123)
    fs.writeFileSync(path.join(localDir, 'a.bin'), big)
    fs.writeFileSync(path.join(localDir, 'sub', 'b.txt'), 'hello sftp')

    await ctx.transfers.enqueue({ srcFsId: 'local', srcPaths: [localDir], dstFsId: fsInfo.id, dstDir: fsInfo.home })
    await ctx.transfers.idle()
    const remoteDir = `${fsInfo.home}/upload-src`
    const names = (await ctx.fs.list(fsInfo.id, remoteDir)).map((e) => e.name).sort()
    expect(names).toEqual(['a.bin', 'sub'])
    expect(ctx.transfers.list().every((t) => t.status === 'done')).toBe(true)

    // download back and compare
    const dlDir = path.join(tmp, 'download')
    fs.mkdirSync(dlDir)
    await ctx.transfers.enqueue({ srcFsId: fsInfo.id, srcPaths: [`${remoteDir}/a.bin`], dstFsId: 'local', dstDir: dlDir })
    await ctx.transfers.idle()
    const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')
    expect(sha(fs.readFileSync(path.join(dlDir, 'a.bin')))).toBe(sha(big))

    // conflict → keep both
    ctx.settings.set({ sftp: { ...ctx.settings.get().sftp, conflictPolicy: 'ask' } })
    prompts.length = 0
    await ctx.transfers.enqueue({ srcFsId: 'local', srcPaths: [path.join(localDir, 'a.bin')], dstFsId: fsInfo.id, dstDir: remoteDir })
    await ctx.transfers.idle()
    expect(prompts.some((p) => p.type === 'conflict')).toBe(true)
    expect((await ctx.fs.list(fsInfo.id, remoteDir)).map((e) => e.name)).toContain('a (1).bin')

    // text edit round trip + rename + delete
    const txt = `${remoteDir}/sub/b.txt`
    expect((await ctx.fs.readText(fsInfo.id, txt)).content).toBe('hello sftp')
    await ctx.fs.writeText(fsInfo.id, txt, 'changed')
    expect((await ctx.fs.readText(fsInfo.id, txt)).content).toBe('changed')
    await ctx.fs.rename(fsInfo.id, txt, `${remoteDir}/sub/c.txt`)
    expect((await ctx.fs.list(fsInfo.id, `${remoteDir}/sub`)).map((e) => e.name)).toEqual(['c.txt'])
    expect((await ctx.fs.readText(fsInfo.id, `${remoteDir}/a.bin`)).binary).toBe(true)
    await ctx.fs.remove(fsInfo.id, [remoteDir])
    expect((await ctx.fs.list(fsInfo.id, fsInfo.home)).some((e) => e.name === 'upload-src')).toBe(false)
    ctx.fs.close(fsInfo.id)
  })
})

describe('port forwarding', () => {
  let echo: net.Server
  let echoPort: number
  beforeAll(async () => {
    echo = net.createServer((s) => s.pipe(s))
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r))
    echoPort = (echo.address() as net.AddressInfo).port
  })
  afterAll(() => {
    ctx.forwards.stopAll()
    echo.close()
  })

  async function roundTrip(sock: net.Socket, msg: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let buf = ''
      sock.on('data', (d) => {
        buf += d.toString()
        if (buf.length >= msg.length) {
          sock.destroy()
          resolve(buf)
        }
      })
      sock.on('error', reject)
      sock.write(msg)
    })
  }

  it('local forwarding', async () => {
    const host = ctx.vault.list('host').find((h) => h.data.label === 'srv')!
    const bindPort = await freePort()
    const rule = ctx.vault.upsert('portForward', { type: 'local', hostId: host.id, bindPort, destHost: '127.0.0.1', destPort: echoPort })
    await ctx.forwards.start(rule.id)
    expect(ctx.forwards.states().find((s) => s.ruleId === rule.id)?.status).toBe('running')
    const sock = net.connect(bindPort, '127.0.0.1')
    await new Promise((r) => sock.once('connect', r))
    expect(await roundTrip(sock, 'ping-local')).toBe('ping-local')
  })

  it('dynamic forwarding (SOCKS5)', async () => {
    const host = ctx.vault.list('host').find((h) => h.data.label === 'srv')!
    const bindPort = await freePort()
    const rule = ctx.vault.upsert('portForward', { type: 'dynamic', hostId: host.id, bindPort })
    await ctx.forwards.start(rule.id)
    const { socket } = await SocksClient.createConnection({
      proxy: { host: '127.0.0.1', port: bindPort, type: 5 },
      command: 'connect',
      destination: { host: '127.0.0.1', port: echoPort }
    })
    expect(await roundTrip(socket, 'ping-socks')).toBe('ping-socks')
  })

  it('remote forwarding', async () => {
    const host = ctx.vault.list('host').find((h) => h.data.label === 'srv')!
    const bindPort = await freePort()
    const rule = ctx.vault.upsert('portForward', { type: 'remote', hostId: host.id, bindAddress: '127.0.0.1', bindPort, destHost: '127.0.0.1', destPort: echoPort })
    await ctx.forwards.start(rule.id)
    const sock = net.connect(bindPort, '127.0.0.1')
    await new Promise((r) => sock.once('connect', r))
    expect(await roundTrip(sock, 'ping-remote')).toBe('ping-remote')
  })

  it('reports a busy local port as an error', async () => {
    const host = ctx.vault.list('host').find((h) => h.data.label === 'srv')!
    const blocker = net.createServer()
    const port = await new Promise<number>((r) => blocker.listen(0, '127.0.0.1', () => r((blocker.address() as net.AddressInfo).port)))
    const rule = ctx.vault.upsert('portForward', { type: 'local', hostId: host.id, bindPort: port, destHost: '127.0.0.1', destPort: echoPort })
    await expect(ctx.forwards.start(rule.id)).rejects.toThrow(/in use/)
    expect(ctx.forwards.states().find((s) => s.ruleId === rule.id)?.status).toBe('error')
    blocker.close()
  })
})

describe('keychain actions', () => {
  it('exports a public key to a host', async () => {
    const handlers = createHandlers(ctx, platform)
    const key = await handlers['keys.generate']({ label: 'gen', type: 'ed25519' })
    const host = ctx.vault.list('host').find((h) => h.data.label === 'srv')!
    const res = await handlers['keys.exportToHost'](key.id, host.id)
    expect(res.added).toBe(true)
    const cmd = server.execLog.find((c) => c.includes('authorized_keys'))!
    expect(cmd).toContain(ctx.vault.get(key.id, 'key')!.data.publicKey.split(' ')[1])
  })

  it('masks secrets in list results and reveals them on demand', async () => {
    const handlers = createHandlers(ctx, platform)
    const list = await handlers['vault.list']('host')
    const srv = list.find((h) => h.kind === 'host' && h.data.label === 'srv')!
    expect(srv.kind === 'host' && srv.data.password).not.toBe('test')
    const full = await handlers['vault.reveal'](srv.id)
    expect(full?.kind === 'host' && full.data.password).toBe('test')
  })
})
