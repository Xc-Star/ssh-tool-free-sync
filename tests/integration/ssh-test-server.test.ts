import { createHash, randomBytes } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import {
  connect as netConnect,
  createServer as createNetServer,
  type AddressInfo,
  type Server as NetServer
} from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import {
  Client,
  utils,
  type AuthenticationType,
  type ClientChannel,
  type ConnectConfig,
  type ExecOptions,
  type FileEntryWithStats,
  type PseudoTtyOptions,
  type SFTPWrapper,
  type Stats,
  type TcpConnectionDetails
} from 'ssh2'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateClientKey, startTestSshServer, type TestSshServer } from '../helpers/ssh-test-server'

const isWindows = process.platform === 'win32'
const SFTP_NO_SUCH_FILE = 2
const SFTP_PERMISSION_DENIED = 3
const SFTP_FAILURE = 4

const openClients = new Set<Client>()

function base(server: TestSshServer): ConnectConfig {
  return { host: server.host, port: server.port, readyTimeout: 20_000 }
}

function connect(config: ConnectConfig, setup?: (client: Client) => void): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    let ready = false
    // Keep an error listener for the client's whole lifetime: late socket errors must not crash the worker.
    client.on('error', (err) => {
      if (!ready) reject(err)
    })
    client.once('ready', () => {
      ready = true
      openClients.add(client)
      resolve(client)
    })
    client.once('close', () => openClients.delete(client))
    setup?.(client)
    client.connect(config)
  })
}

function endClient(client: Client): Promise<void> {
  if (!openClients.has(client)) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 3_000)
    client.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
    client.end()
  })
}

interface ExecResult {
  stdout: string
  stderr: string
  code: number | undefined
}

function run(client: Client, command: string, options: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    client.exec(command, options, (err, stream) => {
      if (err) {
        reject(err)
        return
      }
      let stdout = ''
      let stderr = ''
      let code: number | undefined
      stream.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
      stream.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
      stream.on('exit', (exitCode: number) => (code = exitCode))
      stream.on('close', () => setImmediate(() => resolve({ stdout, stderr, code })))
    })
  })
}

function call<T = void>(fn: (cb: (err?: Error | null, value?: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => fn((err, value) => (err ? reject(err) : resolve(value as T))))
}

function openSftp(client: Client): Promise<SFTPWrapper> {
  return call<SFTPWrapper>((cb) => client.sftp(cb))
}

function forwardOut(
  client: Client,
  srcPort: number,
  dstHost: string,
  dstPort: number
): Promise<ClientChannel> {
  return call<ClientChannel>((cb) => client.forwardOut('127.0.0.1', srcPort, dstHost, dstPort, cb))
}

function openShell(
  client: Client,
  window: PseudoTtyOptions,
  env: Record<string, string>
): Promise<ClientChannel> {
  return call<ClientChannel>((cb) => client.shell(window, { env }, cb))
}

/** Collects terminal output and lets tests wait for a substring / predicate. */
function terminal(stream: ClientChannel) {
  let output = ''
  const waiters = new Set<() => void>()
  stream.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8')
    for (const waiter of [...waiters]) waiter()
  })
  return {
    get output(): string {
      return output
    },
    clear(): void {
      output = ''
    },
    waitFor(expected: string | ((output: string) => boolean), timeoutMs = 15_000): Promise<string> {
      const matches = typeof expected === 'string' ? (o: string) => o.includes(expected) : expected
      return new Promise((resolve, reject) => {
        const check = (): void => {
          if (!matches(output)) return
          waiters.delete(check)
          clearTimeout(timer)
          resolve(output)
        }
        const timer = setTimeout(() => {
          waiters.delete(check)
          const tail = JSON.stringify(output.slice(-300))
          reject(new Error(`Timed out waiting for ${JSON.stringify(String(expected))}; output tail: ${tail}`))
        }, timeoutMs)
        waiters.add(check)
        check()
      })
    }
  }
}

function readBytes(stream: Duplex, length: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    const onData = (chunk: Buffer): void => {
      data += chunk.toString('utf8')
      if (data.length >= length) {
        stream.off('data', onData)
        resolve(data)
      }
    }
    stream.on('data', onData)
    stream.once('error', reject)
  })
}

function listenLocal(server: NetServer): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

function closeServer(server: NetServer): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = netConnect(port, '127.0.0.1')
    probe.once('connect', () => {
      probe.destroy()
      resolve(true)
    })
    probe.once('error', () => resolve(false))
  })
}

describe('ssh-test-server helper', () => {
  let server: TestSshServer
  let localDir: string
  let edKey: { privateKey: string; publicKey: string }
  let rsaKey: { privateKey: string; publicKey: string }
  let encryptedEcdsaKey: { privateKey: string; publicKey: string }
  let strangerKey: { privateKey: string; publicKey: string }

  beforeAll(async () => {
    edKey = generateClientKey('ed25519')
    rsaKey = generateClientKey('rsa')
    encryptedEcdsaKey = generateClientKey('ecdsa', 'passphrase')
    strangerKey = generateClientKey('ed25519')
    localDir = await fsp.mkdtemp(path.join(tmpdir(), 'ssh-test-client-'))
    server = await startTestSshServer({
      users: {
        test: { password: 'test' },
        alice: { publicKeys: [edKey.publicKey, rsaKey.publicKey, encryptedEcdsaKey.publicKey] },
        kbd: {
          keyboardInteractive: {
            prompts: [
              { prompt: 'Password: ', echo: false },
              { prompt: 'Verification code: ', echo: true }
            ],
            answers: ['s3cret', '123456']
          }
        }
      },
      execHandler: (command, stream) => {
        if (command !== 'custom-cmd') return false
        stream.write('handled by execHandler\n')
        stream.exit(0)
        stream.end()
        return true
      }
    })
  })

  afterAll(async () => {
    await Promise.all([...openClients].map((client) => endClient(client)))
    await server?.close()
    if (localDir) await fsp.rm(localDir, { recursive: true, force: true })
  })

  describe('authentication', () => {
    it('accepts the right password and logs the attempts', async () => {
      const client = await connect({ ...base(server), username: 'test', password: 'test' })
      expect(server.authLog).toContainEqual({ username: 'test', method: 'none', success: false })
      expect(server.authLog.at(-1)).toEqual({ username: 'test', method: 'password', success: true })
      await endClient(client)
    })

    it('rejects a wrong password', async () => {
      await expect(connect({ ...base(server), username: 'test', password: 'nope' })).rejects.toMatchObject({
        level: 'client-authentication'
      })
      expect(server.authLog.at(-1)).toEqual({ username: 'test', method: 'password', success: false })
    })

    it('accepts an ed25519 public key', async () => {
      const client = await connect({ ...base(server), username: 'alice', privateKey: edKey.privateKey })
      expect(server.authLog.at(-1)).toEqual({ username: 'alice', method: 'publickey', success: true })
      await endClient(client)
    })

    it('accepts an RSA public key', async () => {
      const client = await connect({ ...base(server), username: 'alice', privateKey: rsaKey.privateKey })
      expect(server.authLog.at(-1)).toEqual({ username: 'alice', method: 'publickey', success: true })
      await endClient(client)
    })

    it('accepts a passphrase-protected ECDSA key', async () => {
      expect(encryptedEcdsaKey.publicKey).toMatch(/^ecdsa-sha2-nistp256 /)
      expect(encryptedEcdsaKey.privateKey).toContain('BEGIN OPENSSH PRIVATE KEY')
      const client = await connect({
        ...base(server),
        username: 'alice',
        privateKey: encryptedEcdsaKey.privateKey,
        passphrase: 'passphrase'
      })
      expect(server.authLog.at(-1)).toEqual({ username: 'alice', method: 'publickey', success: true })
      await endClient(client)
    })

    it('rejects keys that are not authorized', async () => {
      await expect(
        connect({ ...base(server), username: 'alice', privateKey: strangerKey.privateKey })
      ).rejects.toMatchObject({ level: 'client-authentication' })
      expect(server.authLog.at(-1)).toEqual({ username: 'alice', method: 'publickey', success: false })
    })

    it('answers "none" with the methods available for that user', async () => {
      const methodsAfterNone = async (username: string): Promise<AuthenticationType[] | null> => {
        let methods: AuthenticationType[] | null = null
        await expect(
          connect({
            ...base(server),
            username,
            authHandler: (methodsLeft, _partialSuccess, next) => {
              // ssh2 passes null before the first attempt, then the server's list of remaining methods
              if (methodsLeft === null) return next('none')
              methods = methodsLeft
              next(false as unknown as AuthenticationType) // false = give up (not in the typings)
            }
          })
        ).rejects.toMatchObject({ level: 'client-authentication' })
        return methods
      }
      expect(await methodsAfterNone('test')).toEqual(['password'])
      expect(await methodsAfterNone('alice')).toEqual(['publickey'])
      expect(await methodsAfterNone('kbd')).toEqual(['keyboard-interactive'])
      expect(await methodsAfterNone('nobody')).toEqual(['publickey', 'password', 'keyboard-interactive'])
      expect(server.authLog.at(-1)).toEqual({ username: 'nobody', method: 'none', success: false })
    })

    it('supports keyboard-interactive', async () => {
      const seenPrompts: { prompt: string; echo?: boolean }[] = []
      const client = await connect({ ...base(server), username: 'kbd', tryKeyboard: true }, (c) => {
        c.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
          seenPrompts.push(...prompts)
          finish(['s3cret', '123456'])
        })
      })
      expect(seenPrompts).toEqual([
        { prompt: 'Password: ', echo: false },
        { prompt: 'Verification code: ', echo: true }
      ])
      expect(server.authLog.at(-1)).toEqual({
        username: 'kbd',
        method: 'keyboard-interactive',
        success: true
      })
      await endClient(client)

      await expect(
        connect({ ...base(server), username: 'kbd', tryKeyboard: true }, (c) => {
          c.on('keyboard-interactive', (_name, _instructions, _lang, _prompts, finish) =>
            finish(['s3cret', '000000'])
          )
        })
      ).rejects.toMatchObject({ level: 'client-authentication' })
      expect(server.authLog.at(-1)).toEqual({
        username: 'kbd',
        method: 'keyboard-interactive',
        success: false
      })
    })

    it('presents the host key whose fingerprint is hostKeyFingerprint', async () => {
      let seenKey: Buffer | undefined
      const client = await connect({
        ...base(server),
        username: 'test',
        password: 'test',
        hostVerifier: (key: Buffer) => {
          seenKey = key
          return true
        }
      })
      expect(seenKey).toBeInstanceOf(Buffer)
      const fingerprint = `SHA256:${createHash('sha256')
        .update(seenKey as Buffer)
        .digest('base64')
        .replace(/=+$/, '')}`
      expect(fingerprint).toBe(server.hostKeyFingerprint)
      expect(server.hostKeyFingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)
      expect((seenKey as Buffer).equals(server.hostPublicKey)).toBe(true)
      expect(server.hostKeyType).toBe('ssh-ed25519')
      await endClient(client)
    })
  })

  describe('shell', () => {
    it('handles pty, env, echo, backspace, stty size after resize, cat-big and exit', async () => {
      const client = await connect({ ...base(server), username: 'test', password: 'test' })
      const stream = await openShell(
        client,
        { term: 'xterm-256color', cols: 100, rows: 30 },
        { FOO: 'bar', LANG: 'C.UTF-8' }
      )
      const term = terminal(stream)
      await term.waitFor('Welcome to test-ssh\r\n$ ')
      expect(server.ptyLog.at(-1)).toEqual({ cols: 100, rows: 30, term: 'xterm-256color' })
      expect(server.envLog.at(-1)).toEqual({ FOO: 'bar', LANG: 'C.UTF-8' })

      term.clear()
      stream.write('echo hello\r')
      await term.waitFor('hello\r\n$ ')
      expect(term.output).toBe('echo hello\r\nhello\r\n$ ')

      term.clear()
      stream.write('echo hellp\x7fo\r')
      await term.waitFor('hello\r\n$ ')
      expect(term.output).toBe('echo hellp\b \bo\r\nhello\r\n$ ')

      term.clear()
      stream.write('pwd\r')
      await term.waitFor('$ ')
      expect(term.output).toBe('pwd\r\n/home/test\r\n$ ')

      term.clear()
      stream.write('whoami\r')
      await term.waitFor('$ ')
      expect(term.output).toBe('whoami\r\ntest\r\n$ ')

      stream.setWindow(40, 120, 480, 640)
      term.clear()
      stream.write('stty size\r')
      await term.waitFor('$ ')
      expect(term.output).toBe('stty size\r\n40 120\r\n$ ')
      expect(server.ptyLog.at(-1)).toEqual({ cols: 120, rows: 40, term: 'xterm-256color' })

      term.clear()
      stream.write('env\r')
      await term.waitFor('$ ')
      expect(term.output).toBe('env\r\nFOO=bar\r\nLANG=C.UTF-8\r\n$ ')

      term.clear()
      stream.write('frobnicate --now\r')
      await term.waitFor('$ ')
      expect(term.output).toBe('frobnicate --now\r\nfrobnicate: command not found\r\n$ ')

      // More than the 2 MiB SSH window: exercises flow control in both directions of the helper.
      const size = 3 * 1024 * 1024
      term.clear()
      stream.write(`cat-big ${size}\r`)
      await term.waitFor((o) => o.endsWith('\r\n$ ') && o.length >= size)
      const expectedPrefix = `cat-big ${size}\r\n`
      expect(term.output.length).toBe(expectedPrefix.length + size + '\r\n$ '.length)
      expect(term.output.startsWith(expectedPrefix)).toBe(true)
      expect(/^x+$/.test(term.output.slice(expectedPrefix.length, expectedPrefix.length + size))).toBe(true)

      const exitCode = new Promise<number>((resolve) => stream.once('exit', (code: number) => resolve(code)))
      const closed = new Promise<void>((resolve) => stream.once('close', () => resolve()))
      term.clear()
      stream.write('exit\r')
      expect(await exitCode).toBe(0)
      await closed
      expect(term.output).toBe('exit\r\n')
      await endClient(client)
    })
  })

  describe('exec', () => {
    let client: Client

    beforeAll(async () => {
      client = await connect({ ...base(server), username: 'test', password: 'test' })
    })

    afterAll(async () => {
      if (client) await endClient(client)
    })

    it('serves /etc/os-release and uname', async () => {
      const osRelease = await run(client, 'cat /etc/os-release')
      expect(osRelease.code).toBe(0)
      expect(osRelease.stdout).toContain('ID=ubuntu\n')
      expect(osRelease.stdout).toContain('VERSION_ID="24.04"\n')
      expect(osRelease.stderr).toBe('')

      const chained = await run(client, 'cat /etc/os-release 2>/dev/null; uname -s && uname -m')
      expect(chained).toEqual({ stdout: `${osRelease.stdout}Linux\nx86_64\n`, stderr: '', code: 0 })

      const unameAll = await run(client, 'uname -a')
      expect(unameAll.stdout).toMatch(/^Linux test-ssh \S+ .+ x86_64 GNU\/Linux\n$/)
      expect(server.execLog).toEqual(
        expect.arrayContaining([
          'cat /etc/os-release',
          'cat /etc/os-release 2>/dev/null; uname -s && uname -m'
        ])
      )
    })

    it('reports unknown commands on stderr with exit status 127', async () => {
      const result = await run(client, 'definitely-not-a-command --flag')
      expect(result).toEqual({
        stdout: '',
        stderr: 'definitely-not-a-command: command not found\n',
        code: 127
      })
    })

    it('runs echo / whoami / true / exit with quoting and && / || semantics', async () => {
      expect(await run(client, `echo "hello world"; echo 'single quoted'; whoami && true`)).toEqual({
        stdout: 'hello world\nsingle quoted\ntest\n',
        stderr: '',
        code: 0
      })
      expect(await run(client, 'echo before; exit 3; echo after')).toEqual({
        stdout: 'before\n',
        stderr: '',
        code: 3
      })
      expect((await run(client, 'false || echo fallback')).stdout).toBe('fallback\n')
      expect((await run(client, 'false && echo skipped')).code).toBe(1)
    })

    it('passes env requests to the command and honours execHandler', async () => {
      const result = await run(client, 'printenv GREETING; echo $USER', { env: { GREETING: 'hi there' } })
      expect(result.stdout).toBe('hi there\ntest\n')
      expect(server.envLog.at(-1)).toEqual({ GREETING: 'hi there' })

      expect(await run(client, 'custom-cmd')).toEqual({
        stdout: 'handled by execHandler\n',
        stderr: '',
        code: 0
      })
      expect(server.execLog.at(-1)).toBe('custom-cmd')
    })

    it('uses CRLF and merges stderr when a pty is allocated', async () => {
      expect(await run(client, 'echo hi; nope', { pty: { cols: 90, rows: 20, term: 'vt100' } })).toEqual({
        stdout: 'hi\r\nnope: command not found\r\n',
        stderr: '',
        code: 127
      })
      expect(server.ptyLog.at(-1)).toEqual({ cols: 90, rows: 20, term: 'vt100' })
    })

    it('supports redirects, cat of files, sh -c and $?', async () => {
      expect(
        await run(client, 'echo saved > note.txt && cat note.txt ~/note.txt /home/test/note.txt')
      ).toEqual({
        stdout: 'saved\nsaved\nsaved\n',
        stderr: '',
        code: 0
      })
      expect(await fsp.readFile(path.join(server.rootDir, 'home', 'test', 'note.txt'), 'utf8')).toBe(
        'saved\n'
      )
      expect(await run(client, 'cat missing.txt')).toEqual({
        stdout: '',
        stderr: 'cat: missing.txt: No such file or directory\n',
        code: 1
      })
      expect(await run(client, 'nope 2>&1')).toEqual({
        stdout: 'nope: command not found\n',
        stderr: '',
        code: 127
      })
      expect(await run(client, 'nope 2>/dev/null')).toEqual({ stdout: '', stderr: '', code: 127 })
      expect(await run(client, `sh -c 'echo inner; exit 4'; echo "status=$?"`)).toEqual({
        stdout: 'inner\nstatus=4\n',
        stderr: '',
        code: 0
      })
    })

    it('echoes stdin with cat and streams large output with cat-big', async () => {
      const echoed = await new Promise<string>((resolve, reject) => {
        client.exec('cat', (err, stream) => {
          if (err) {
            reject(err)
            return
          }
          let out = ''
          stream.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')))
          stream.on('close', () => resolve(out))
          stream.end('piped through stdin')
        })
      })
      expect(echoed).toBe('piped through stdin')

      const big = await run(client, 'cat-big 5000000')
      expect(big.code).toBe(0)
      expect(big.stdout.length).toBe(5_000_001)
      expect(big.stdout.endsWith('xx\n')).toBe(true)
    })

    it('terminates a running command when the client sends a signal', async () => {
      const exit = await new Promise<{ code: number | null; signal: string | undefined }>(
        (resolve, reject) => {
          client.exec('sleep 30', (err, stream) => {
            if (err) {
              reject(err)
              return
            }
            stream.resume()
            stream.on('exit', (code: number | null, signal?: string) => resolve({ code, signal }))
            stream.signal('INT')
          })
        }
      )
      expect(exit).toEqual({ code: null, signal: 'SIGINT' })
    })
  })

  describe('sftp', () => {
    it('supports the common SFTP operations against the real filesystem', async () => {
      const client = await connect({ ...base(server), username: 'test', password: 'test' })
      const sftp = await openSftp(client)

      expect(await call<string>((cb) => sftp.realpath('.', cb))).toBe('/home/test')
      expect(await call<string>((cb) => sftp.realpath('a/../b/./c', cb))).toBe('/home/test/b/c')

      await call((cb) => sftp.mkdir('upload', cb))
      expect((await call<Stats>((cb) => sftp.stat('/home/test/upload', cb))).isDirectory()).toBe(true)
      await expect(call((cb) => sftp.mkdir('upload', cb))).rejects.toMatchObject({ code: SFTP_FAILURE })

      const data = randomBytes(3 * 1024 * 1024 + 123)
      const localSource = path.join(localDir, 'source.bin')
      const localCopy = path.join(localDir, 'copy.bin')
      await fsp.writeFile(localSource, data)
      await call((cb) => sftp.fastPut(localSource, 'upload/big.bin', cb))
      const onDisk = await fsp.readFile(path.join(server.rootDir, 'home', 'test', 'upload', 'big.bin'))
      expect(sha256(onDisk)).toBe(sha256(data))
      await call((cb) => sftp.fastGet('/home/test/upload/big.bin', localCopy, cb))
      expect(sha256(await fsp.readFile(localCopy))).toBe(sha256(data))

      const uploadList = await call<FileEntryWithStats[]>((cb) => sftp.readdir('upload', cb))
      expect(uploadList.map((e) => e.filename)).toEqual(['big.bin'])
      const big = uploadList[0]
      expect(big.attrs.size).toBe(data.length)
      expect(big.attrs.isFile()).toBe(true)
      expect(big.attrs.isDirectory()).toBe(false)
      expect(big.longname).toMatch(
        /^-[rwxsStT-]{9} +\d+ test +test +3145851 \w{3} [ \d]\d [\d:]{4,5} big\.bin$/
      )

      const homeList = await call<FileEntryWithStats[]>((cb) => sftp.readdir('/home/test', cb))
      const uploadEntry = homeList.find((e) => e.filename === 'upload')
      expect(uploadEntry?.attrs.isDirectory()).toBe(true)
      expect(uploadEntry?.longname.startsWith('d')).toBe(true)

      await call((cb) => sftp.rename('upload/big.bin', 'upload/renamed.bin', cb))
      await call((cb) => sftp.writeFile('upload/other.txt', 'other content', cb))
      // SFTP v3 rename must not overwrite an existing target
      await expect(
        call((cb) => sftp.rename('upload/other.txt', 'upload/renamed.bin', cb))
      ).rejects.toMatchObject({
        code: SFTP_FAILURE
      })
      expect((await call<Buffer>((cb) => sftp.readFile('upload/other.txt', cb))).toString()).toBe(
        'other content'
      )

      const stats = await call<Stats>((cb) => sftp.stat('upload/renamed.bin', cb))
      expect(stats.isFile()).toBe(true)
      expect(stats.size).toBe(data.length)
      expect(Math.abs(stats.mtime * 1000 - Date.now())).toBeLessThan(5 * 60 * 1000)
      const lstats = await call<Stats>((cb) => sftp.lstat('upload', cb))
      expect(lstats.isDirectory()).toBe(true)

      await call((cb) => sftp.chmod('upload/renamed.bin', 0o600, cb))
      if (!isWindows) {
        expect((await call<Stats>((cb) => sftp.stat('upload/renamed.bin', cb))).mode & 0o777).toBe(0o600)
      }
      await call((cb) => sftp.utimes('upload/other.txt', 1_000_000_000, 1_000_000_000, cb))
      expect((await call<Stats>((cb) => sftp.stat('upload/other.txt', cb))).mtime).toBe(1_000_000_000)

      // removing a directory with unlink / a non-empty directory with rmdir must fail
      await expect(call((cb) => sftp.unlink('upload', cb))).rejects.toMatchObject({ code: SFTP_FAILURE })
      await expect(call((cb) => sftp.rmdir('upload', cb))).rejects.toMatchObject({ code: SFTP_FAILURE })

      await call((cb) => sftp.unlink('upload/renamed.bin', cb))
      await call((cb) => sftp.unlink('upload/other.txt', cb))
      await expect(call<Stats>((cb) => sftp.stat('upload/renamed.bin', cb))).rejects.toMatchObject({
        code: SFTP_NO_SUCH_FILE
      })
      await call((cb) => sftp.rmdir('upload', cb))
      await expect(call<Stats>((cb) => sftp.stat('upload', cb))).rejects.toMatchObject({
        code: SFTP_NO_SUCH_FILE
      })

      sftp.end()
      await endClient(client)
    })

    it('never lets a client escape rootDir', async () => {
      const client = await connect({ ...base(server), username: 'test', password: 'test' })
      const sftp = await openSftp(client)
      for (const escape of ['/..', '../../..', '/home/test/../../../outside', '..\\..\\..\\outside.txt']) {
        await expect(call<Stats>((cb) => sftp.stat(escape, cb))).rejects.toMatchObject({
          code: SFTP_PERMISSION_DENIED
        })
      }
      await expect(call((cb) => sftp.writeFile('/../escape.txt', 'nope', cb))).rejects.toMatchObject({
        code: SFTP_PERMISSION_DENIED
      })
      await expect(fsp.stat(path.join(path.dirname(server.rootDir), 'escape.txt'))).rejects.toMatchObject({
        code: 'ENOENT'
      })
      expect(await call<string>((cb) => sftp.realpath('/', cb))).toBe('/')
      sftp.end()
      await endClient(client)
    })

    it('supports truncate, open flags without a string form, and best-effort symlinks', async () => {
      const client = await connect({ ...base(server), username: 'test', password: 'test' })
      const sftp = await openSftp(client)
      await call((cb) => sftp.writeFile('extra.txt', 'hello world', cb))
      await call((cb) => sftp.setstat('extra.txt', { size: 5 }, cb))
      expect((await call<Buffer>((cb) => sftp.readFile('extra.txt', cb))).toString()).toBe('hello')

      // WRITE|CREAT without TRUNC has no fs flag string: must still open and keep the existing content
      const { OPEN_MODE } = utils.sftp
      const handle = await call<Buffer>((cb) => sftp.open('extra.txt', OPEN_MODE.WRITE | OPEN_MODE.CREAT, cb))
      await call((cb) => sftp.write(handle, Buffer.from('J'), 0, 1, 0, cb))
      expect((await call<Stats>((cb) => sftp.fstat(handle, cb))).size).toBe(5)
      await call((cb) => sftp.close(handle, cb))
      expect((await call<Buffer>((cb) => sftp.readFile('extra.txt', cb))).toString()).toBe('Jello')

      // Real symlinks on POSIX; Windows may refuse them (no privilege / developer mode) => FAILURE status.
      const symlinked = await call((cb) => sftp.symlink('extra.txt', 'link.txt', cb)).then(
        () => undefined,
        (err: Error & { code?: number }) => err
      )
      if (symlinked === undefined) {
        expect(await call<string>((cb) => sftp.readlink('link.txt', cb))).toBe('extra.txt')
        expect((await call<Stats>((cb) => sftp.lstat('link.txt', cb))).isSymbolicLink()).toBe(true)
        expect((await call<Stats>((cb) => sftp.stat('link.txt', cb))).isFile()).toBe(true)
        await call((cb) => sftp.unlink('link.txt', cb))
        // absolute targets are virtual paths: stored as real paths, reported back as virtual ones
        await call((cb) => sftp.symlink('/home/test/extra.txt', 'abs-link.txt', cb))
        expect(await call<string>((cb) => sftp.readlink('abs-link.txt', cb))).toBe('/home/test/extra.txt')
        expect((await call<Buffer>((cb) => sftp.readFile('abs-link.txt', cb))).toString()).toBe('Jello')
        await call((cb) => sftp.unlink('abs-link.txt', cb))
      } else {
        expect(isWindows).toBe(true)
        expect(symlinked.code).toBe(SFTP_FAILURE)
      }
      await expect(call((cb) => sftp.symlink('../../../../etc/passwd', 'evil', cb))).rejects.toMatchObject({
        code: SFTP_PERMISSION_DENIED
      })

      await call((cb) => sftp.unlink('extra.txt', cb))
      sftp.end()
      await endClient(client)
    })
  })

  describe('port forwarding', () => {
    it('forwards direct-tcpip channels (local forwarding)', async () => {
      const echoServer = createNetServer((socket) => socket.pipe(socket))
      const echoPort = await listenLocal(echoServer)
      const client = await connect({ ...base(server), username: 'test', password: 'test' })
      try {
        const channel = await forwardOut(client, 40_000, '127.0.0.1', echoPort)
        const reply = readBytes(channel, 'ping-through-ssh'.length)
        channel.write('ping-through-ssh')
        expect(await reply).toBe('ping-through-ssh')
        channel.end()

        const unused = createNetServer()
        const closedPort = await listenLocal(unused)
        await closeServer(unused)
        await expect(forwardOut(client, 40_001, '127.0.0.1', closedPort)).rejects.toThrow()
      } finally {
        await endClient(client)
        await closeServer(echoServer)
      }
    })

    it('forwards remote connections back to the client (tcpip-forward)', async () => {
      const client = await connect({ ...base(server), username: 'test', password: 'test' })
      const incoming = new Promise<{ info: TcpConnectionDetails; data: string }>((resolve) => {
        client.on('tcp connection', (info, accept) => {
          const channel = accept()
          void readBytes(channel, 'hello-remote'.length).then((data) => {
            channel.write(`ack:${data}`)
            resolve({ info, data })
          })
        })
      })
      const port = await call<number>((cb) => client.forwardIn('127.0.0.1', 0, cb))
      expect(port).toBeGreaterThan(0)

      const socket = netConnect(port, '127.0.0.1')
      try {
        const ack = readBytes(socket, 'ack:hello-remote'.length)
        socket.write('hello-remote')
        const { info, data } = await incoming
        expect(data).toBe('hello-remote')
        expect(info.destIP).toBe('127.0.0.1')
        expect(info.destPort).toBe(port)
        expect(await ack).toBe('ack:hello-remote')
      } finally {
        socket.destroy()
      }

      await call((cb) => client.unforwardIn('127.0.0.1', port, cb))
      expect(await canConnect(port)).toBe(false)

      // listeners also go away when the client disconnects without cancelling
      const port2 = await call<number>((cb) => client.forwardIn('127.0.0.1', 0, cb))
      expect(await canConnect(port2)).toBe(true)
      await endClient(client)
      await waitUntil(async () => !(await canConnect(port2)))
    })

    it('works as a jump host (ProxyJump via forwardOut)', async () => {
      const target = await startTestSshServer({
        users: { bob: { password: 'bob-pw' } },
        osRelease: 'ID=debian\nVERSION_ID="12"\n'
      })
      try {
        const jump = await connect({ ...base(server), username: 'test', password: 'test' })
        const tunnel = await forwardOut(jump, 0, '127.0.0.1', target.port)
        const inner = await connect({
          sock: tunnel,
          username: 'bob',
          password: 'bob-pw',
          readyTimeout: 20_000
        })
        const result = await run(inner, 'cat /etc/os-release && whoami')
        expect(result).toEqual({ stdout: 'ID=debian\nVERSION_ID="12"\nbob\n', stderr: '', code: 0 })
        expect(target.execLog).toEqual(['cat /etc/os-release && whoami'])
        expect(server.execLog).not.toContain('cat /etc/os-release && whoami')
        expect(target.authLog.at(-1)).toEqual({ username: 'bob', method: 'password', success: true })
        await endClient(inner)
        await endClient(jump)
      } finally {
        await target.close()
      }
    })
  })

  describe('lifecycle', () => {
    it('survives clients that disconnect abruptly', async () => {
      const before = server.activeConnections()
      const client = await connect({ ...base(server), username: 'test', password: 'test' })
      expect(server.activeConnections()).toBe(before + 1)
      const sftp = await openSftp(client)
      await call((cb) => sftp.writeFile('abrupt.txt', 'x', cb))
      await call<Buffer>((cb) => sftp.open('abrupt.txt', 'r', cb))
      await new Promise<void>((resolve, reject) =>
        client.exec('sleep 30', (err) => (err ? reject(err) : resolve()))
      )
      client.destroy()
      await waitUntil(() => server.activeConnections() === before)

      const again = await connect({ ...base(server), username: 'test', password: 'test' })
      expect((await run(again, 'echo still-alive')).stdout).toBe('still-alive\n')
      const sftp2 = await openSftp(again)
      await call((cb) => sftp2.unlink('abrupt.txt', cb))
      sftp2.end()
      await endClient(again)
    })
    it('close() ends open connections (even with open SFTP handles) and removes its temp rootDir', async () => {
      const temp = await startTestSshServer()
      const rootDir = temp.rootDir
      expect((await fsp.stat(rootDir)).isDirectory()).toBe(true)

      const client = await connect({ ...base(temp), username: 'test', password: 'test' })
      expect(temp.activeConnections()).toBe(1)
      const sftp = await openSftp(client)
      await call((cb) => sftp.writeFile('keep-open.txt', 'x', cb))
      const handle = await call<Buffer>((cb) => sftp.open('keep-open.txt', 'r', cb))
      expect(handle.length).toBeGreaterThan(0)

      const clientClosed = new Promise<void>((resolve) => client.once('close', () => resolve()))
      await temp.close()
      await clientClosed
      expect(temp.activeConnections()).toBe(0)
      await expect(fsp.stat(rootDir)).rejects.toMatchObject({ code: 'ENOENT' })
      await temp.close() // idempotent
    })

    it('keeps a caller-provided rootDir and can disable TCP forwarding', async () => {
      const rootDir = path.join(localDir, 'custom-root')
      const temp = await startTestSshServer({ rootDir, allowTcpForwarding: false })
      try {
        expect(temp.rootDir).toBe(path.resolve(rootDir))
        const client = await connect({ ...base(temp), username: 'test', password: 'test' })
        await expect(forwardOut(client, 0, '127.0.0.1', temp.port)).rejects.toThrow()
        await expect(call<number>((cb) => client.forwardIn('127.0.0.1', 0, cb))).rejects.toThrow()
        const sftp = await openSftp(client)
        await call((cb) => sftp.writeFile('file.txt', 'kept', cb))
        sftp.end()
        await endClient(client)
      } finally {
        await temp.close()
      }
      expect(await fsp.readFile(path.join(rootDir, 'home', 'test', 'file.txt'), 'utf8')).toBe('kept')
    })
  })
})
