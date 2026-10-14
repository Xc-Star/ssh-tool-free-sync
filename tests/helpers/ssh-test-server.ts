/**
 * In-process SSH/SFTP server for integration tests (no Docker / OpenSSH needed).
 *
 * Built on ssh2's `Server`: password / publickey / keyboard-interactive auth, a tiny fake shell,
 * a mini exec interpreter, a real-filesystem SFTP v3 server jailed to `rootDir`, and local/remote
 * TCP port forwarding. Set `SSH_TEST_SERVER_DEBUG=1` to print ssh2 protocol debug output.
 */
import { createHash } from 'node:crypto'
import { constants as fsConstants, mkdirSync, promises as fsp, type Stats as FsStats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import {
  connect as netConnect,
  createServer as createNetServer,
  type AddressInfo,
  type Server as NetServer,
  type Socket
} from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { generateKey } from '../../src/main/ssh/keys'
import {
  Server as SshServer,
  utils,
  type Attributes,
  type AuthContext,
  type AuthenticationType,
  type Connection,
  type FileEntry,
  type ParsedKey,
  type ServerChannel,
  type Session,
  type SFTPWrapper,
  type TcpipBindInfo,
  type TcpipRequestInfo
} from 'ssh2'

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

export interface TestUser {
  password?: string
  /** OpenSSH public key lines (e.g. "ssh-ed25519 AAAA... comment") accepted for publickey auth. */
  publicKeys?: string[]
  /** If set, keyboard-interactive auth is offered: the client must answer each prompt with the matching answer. */
  keyboardInteractive?: { prompts: { prompt: string; echo: boolean }[]; answers: string[] }
}

export interface TestExecContext {
  username: string
  env: Record<string, string>
}

export interface TestSshServerOptions {
  /** Default: `{ test: { password: 'test' } }`. */
  users?: Record<string, TestUser>
  /** SFTP root (virtual `/`). A fresh temp dir is created (and removed by `close()`) when omitted. */
  rootDir?: string
  /** PEM/OpenSSH private host key. A fresh ed25519 key is generated when omitted. */
  hostKey?: string
  /** Contents served for `cat /etc/os-release` (default: Ubuntu 24.04). */
  osRelease?: string
  /** Allow direct-tcpip channels and tcpip-forward requests (default true). */
  allowTcpForwarding?: boolean
  /**
   * Custom exec handling. Return true when the command was handled; the handler then owns the stream
   * (it must write output, call `stream.exit(code)` and `stream.end()`). Otherwise the built-in interpreter runs.
   */
  execHandler?: (command: string, stream: ServerChannel, ctx: TestExecContext) => boolean | void
}

export interface TestSshServer {
  host: '127.0.0.1'
  port: number
  rootDir: string
  /** 'SHA256:' + base64(sha256(rawPublicKeyBlob)) without '=' padding (same format as OpenSSH). */
  hostKeyFingerprint: string
  /** Raw SSH public key blob of the host key (what ssh2's `hostVerifier` receives). */
  hostPublicKey: Buffer
  /** e.g. 'ssh-ed25519' */
  hostKeyType: string
  /** Every exec command received, in order. */
  execLog: string[]
  /**
   * Auth attempts, in order. ssh2 clients always start with a `none` attempt. A publickey "query"
   * (no signature) for an acceptable key is not logged; the signed attempt that follows is.
   */
  authLog: { username: string; method: string; success: boolean }[]
  /** One entry per pty request; the entry is updated in place by later window-change requests. */
  ptyLog: { cols: number; rows: number; term: string }[]
  /** Copy of the session env (from `env` requests) taken when each shell/exec starts. */
  envLog: Record<string, string>[]
  /** Number of open TCP connections to the SSH port. */
  activeConnections(): number
  /** Closes the server, all client connections and forwarding listeners; removes the temp rootDir if created. */
  close(): Promise<void>
}

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

const HOST = '127.0.0.1'
const HOSTNAME = 'test-ssh'
const BANNER = 'Welcome to test-ssh'
const PROMPT = '$ '
const DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
const IS_WINDOWS = process.platform === 'win32'
/** Same cap as OpenSSH's sftp-server (SFTP_MAX_READ_LENGTH). */
const MAX_READ_LENGTH = 255 * 1024
const READDIR_BATCH = 100
const CONNECT_TIMEOUT_MS = 10_000

const S_IFMT = 0o170000
const S_IFSOCK = 0o140000
const S_IFLNK = 0o120000
const S_IFBLK = 0o060000
const S_IFDIR = 0o040000
const S_IFCHR = 0o020000
const S_IFIFO = 0o010000

const { STATUS_CODE, OPEN_MODE } = utils.sftp

const DEFAULT_OS_RELEASE = [
  'PRETTY_NAME="Ubuntu 24.04.1 LTS"',
  'NAME="Ubuntu"',
  'VERSION_ID="24.04"',
  'VERSION="24.04.1 LTS (Noble Numbat)"',
  'VERSION_CODENAME=noble',
  'ID=ubuntu',
  'ID_LIKE=debian',
  'HOME_URL="https://www.ubuntu.com/"',
  'SUPPORT_URL="https://help.ubuntu.com/"',
  'BUG_REPORT_URL="https://bugs.launchpad.net/ubuntu/"',
  'PRIVACY_POLICY_URL="https://www.ubuntu.com/legal/terms-and-policies/privacy-policy"',
  'UBUNTU_CODENAME=noble',
  'LOGO=ubuntu-logo',
  ''
].join('\n')

const UNAME_FIELDS: Record<string, string> = {
  s: 'Linux',
  n: HOSTNAME,
  r: '6.8.0-45-generic',
  v: '#45-Ubuntu SMP PREEMPT_DYNAMIC Fri Aug 30 12:02:04 UTC 2024',
  m: 'x86_64',
  p: 'x86_64',
  i: 'x86_64',
  o: 'GNU/Linux'
}
const UNAME_ORDER = 'snrvmpio'
const UNAME_LONG_OPTIONS: Record<string, string> = {
  '--all': 'a',
  '--kernel-name': 's',
  '--nodename': 'n',
  '--kernel-release': 'r',
  '--kernel-version': 'v',
  '--machine': 'm',
  '--processor': 'p',
  '--hardware-platform': 'i',
  '--operating-system': 'o'
}
/** Signals whose default disposition terminates a process; others are accepted and ignored. */
const TERMINATING_SIGNALS = new Set([
  'ABRT',
  'ALRM',
  'HUP',
  'INT',
  'KILL',
  'PIPE',
  'QUIT',
  'TERM',
  'USR1',
  'USR2'
])
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** Empty attrs => flags 0 on the wire (REALPATH / READLINK responses carry no attributes). */
const NO_ATTRS = {} as Attributes

const debugLog = process.env.SSH_TEST_SERVER_DEBUG
  ? (message: string): void => console.error(`[ssh-test-server] ${message}`)
  : undefined

const noop = (): void => {}

// ---------------------------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------------------------

interface PtyState {
  cols: number
  rows: number
  term: string
}

interface SessionState {
  env: Record<string, string>
  pty: PtyState | undefined
  onSignal: ((name: string) => void) | undefined
}

interface ServerEnv {
  rootDir: string
  osRelease: string
  execHandler: TestSshServerOptions['execHandler']
  execLog: string[]
  ptyLog: PtyState[]
  envLog: Record<string, string>[]
  pendingCleanups: Set<Promise<void>>
}

export async function startTestSshServer(opts: TestSshServerOptions = {}): Promise<TestSshServer> {
  const users: Record<string, TestUser> = opts.users ?? { test: { password: 'test' } }
  const allowTcpForwarding = opts.allowTcpForwarding ?? true

  const hostKeyText = opts.hostKey ?? generateKey({ type: 'ed25519' }).privateKey
  const hostKey = parseSingleKey(hostKeyText, 'host key')
  if (!hostKey.isPrivateKey()) throw new Error('hostKey must be a private key')
  const hostPublicKey = hostKey.getPublicSSH()
  const hostKeyFingerprint = `SHA256:${createHash('sha256').update(hostPublicKey).digest('base64').replace(/=+$/, '')}`

  const userKeys = new Map<string, ParsedKey[]>()
  for (const [name, user] of Object.entries(users)) {
    const keys = (user.publicKeys ?? []).map((line, i) =>
      parseSingleKey(line, `public key #${i + 1} of user "${name}"`)
    )
    userKeys.set(name, keys)
  }
  const allMethods = authMethodsOf(Object.values(users))

  const ownsRootDir = opts.rootDir === undefined
  const rootDir =
    opts.rootDir === undefined
      ? await fsp.mkdtemp(path.join(tmpdir(), 'ssh-test-server-'))
      : path.resolve(opts.rootDir)
  if (!ownsRootDir) await fsp.mkdir(rootDir, { recursive: true })

  const srv: ServerEnv = {
    rootDir,
    osRelease: opts.osRelease ?? DEFAULT_OS_RELEASE,
    execHandler: opts.execHandler,
    execLog: [],
    ptyLog: [],
    envLog: [],
    pendingCleanups: new Set()
  }
  const authLog: TestSshServer['authLog'] = []

  const sockets = new Set<Socket>()
  const connections = new Set<Connection>()
  const forwardServers = new Set<NetServer>()
  let closing = false

  const onConnection = (conn: Connection): void => {
    connections.add(conn)
    let username = ''
    let connClosed = false
    const connSockets = new Set<Socket>()
    const forwards = new Map<string, NetServer>()

    const trackSocket = (socket: Socket): void => {
      connSockets.add(socket)
      socket.once('close', () => connSockets.delete(socket))
    }
    const closeForward = (server: NetServer): void => {
      forwardServers.delete(server)
      server.close()
    }

    conn.on('error', (err) => {
      // ECONNRESET is routine when test clients disconnect abruptly.
      if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') debugLog?.(`connection error: ${err.message}`)
    })
    conn.once('close', () => {
      connClosed = true
      connections.delete(conn)
      for (const server of forwards.values()) closeForward(server)
      forwards.clear()
      for (const socket of connSockets) socket.destroy()
    })

    conn.on('authentication', (ctx) => {
      handleAuth(ctx, users, userKeys, allMethods, authLog, (name) => {
        username = name
        ensureHomeDir(rootDir, name)
      })
    })

    conn.on('session', (accept) => {
      const session = accept()
      if (session) handleSession(session, username, srv)
    })

    conn.on('tcpip', (accept, reject, info) => {
      if (!allowTcpForwarding || closing) {
        reject()
        return
      }
      openDirectTcpip(accept, reject, info, trackSocket)
    })

    conn.on('request', (accept, reject, name, info) => {
      if (name === 'tcpip-forward') {
        if (!allowTcpForwarding || closing) {
          reject?.()
          return
        }
        startRemoteForward(conn, info, trackSocket).then(
          ({ server, port }) => {
            if (connClosed || closing) {
              server.close()
              reject?.()
              return
            }
            forwards.set(`${info.bindAddr}:${port}`, server)
            forwardServers.add(server)
            accept?.(port)
          },
          (err: Error) => {
            debugLog?.(`tcpip-forward ${info.bindAddr}:${info.bindPort} failed: ${err.message}`)
            reject?.()
          }
        )
        return
      }
      if (name === 'cancel-tcpip-forward') {
        const key = `${info.bindAddr}:${info.bindPort}`
        const server = forwards.get(key)
        if (!server) {
          reject?.()
          return
        }
        forwards.delete(key)
        closeForward(server)
        accept?.()
        return
      }
      reject?.()
    })
  }

  const ssh = new SshServer({ hostKeys: [hostKeyText], debug: debugLog }, onConnection)
  ssh.on('error', (err: Error) => debugLog?.(`server error: ${err.message}`))

  // Our own listener (instead of ssh.listen) gives direct access to the raw sockets for close().
  const tcpServer = createNetServer((socket) => {
    if (closing) {
      socket.destroy()
      return
    }
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.on('error', noop)
    ssh.injectSocket(socket)
  })

  try {
    await listen(tcpServer, 0, HOST)
  } catch (err) {
    if (ownsRootDir) await fsp.rm(rootDir, { recursive: true, force: true }).catch(noop)
    throw err
  }
  tcpServer.on('error', (err) => debugLog?.(`listener error: ${err.message}`))
  const port = (tcpServer.address() as AddressInfo).port

  let closePromise: Promise<void> | undefined
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      closing = true
      const listenerClosed = new Promise<void>((resolve) => tcpServer.close(() => resolve()))
      for (const server of forwardServers) server.close()
      forwardServers.clear()
      const socketsClosed = Promise.all(
        [...sockets].map((socket) => new Promise<void>((resolve) => socket.once('close', () => resolve())))
      )
      for (const conn of connections) {
        try {
          conn.end() // sends SSH_MSG_DISCONNECT so clients see a clean close instead of ECONNRESET
        } catch {
          // already gone
        }
      }
      for (const socket of sockets) socket.end()
      await waitWithTimeout(socketsClosed, 2_000)
      for (const socket of sockets) socket.destroy()
      await listenerClosed
      await waitWithTimeout(Promise.allSettled([...srv.pendingCleanups]), 5_000)
      if (ownsRootDir) {
        await fsp.rm(rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(noop)
      }
    })()
    return closePromise
  }

  return {
    host: HOST,
    port,
    rootDir,
    hostKeyFingerprint,
    hostPublicKey,
    hostKeyType: hostKey.type,
    execLog: srv.execLog,
    authLog,
    ptyLog: srv.ptyLog,
    envLog: srv.envLog,
    activeConnections: () => sockets.size,
    close
  }
}

/** Helper for tests: generate a client key pair (OpenSSH format). */
export function generateClientKey(
  type: 'ed25519' | 'rsa' | 'ecdsa' = 'ed25519',
  passphrase?: string
): { privateKey: string; publicKey: string } {
  // The app's generator (it works around an ssh2 bug that corrupts 1 in 256 Ed25519 keys).
  return generateKey({ type, bits: type === 'rsa' ? 2048 : type === 'ecdsa' ? 256 : undefined, passphrase, comment: `test-${type}-key` })
}

// ---------------------------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------------------------

function parseSingleKey(data: string, label: string): ParsedKey {
  const parsed = utils.parseKey(data) as ParsedKey | ParsedKey[] | Error
  if (parsed instanceof Error) throw new Error(`Invalid ${label}: ${parsed.message}`)
  const key = Array.isArray(parsed) ? parsed[0] : parsed
  if (!key) throw new Error(`Invalid ${label}: no key found`)
  return key
}

function authMethodsOf(users: TestUser[]): AuthenticationType[] {
  const methods: AuthenticationType[] = []
  if (users.some((u) => (u.publicKeys?.length ?? 0) > 0)) methods.push('publickey')
  if (users.some((u) => u.password !== undefined)) methods.push('password')
  if (users.some((u) => u.keyboardInteractive !== undefined)) methods.push('keyboard-interactive')
  return methods
}

function handleAuth(
  ctx: AuthContext,
  users: Record<string, TestUser>,
  userKeys: Map<string, ParsedKey[]>,
  allMethods: AuthenticationType[],
  authLog: TestSshServer['authLog'],
  onSuccess: (username: string) => void
): void {
  const user = Object.hasOwn(users, ctx.username) ? users[ctx.username] : undefined
  // Unknown users get the server-wide method list so user existence isn't revealed.
  const methods = user ? authMethodsOf([user]) : allMethods
  const log = (success: boolean): void => {
    authLog.push({ username: ctx.username, method: ctx.method, success })
  }
  const accept = (): void => {
    log(true)
    onSuccess(ctx.username)
    ctx.accept()
  }
  const reject = (): void => {
    log(false)
    ctx.reject(methods)
  }

  switch (ctx.method) {
    case 'password':
      if (user?.password !== undefined && ctx.password === user.password) accept()
      else reject()
      return
    case 'publickey': {
      const key = (userKeys.get(ctx.username) ?? []).find(
        (k) => k.type === ctx.key.algo && ctx.key.data.equals(k.getPublicSSH())
      )
      if (!key) {
        reject()
        return
      }
      if (!ctx.signature || !ctx.blob) {
        // Query without signature: signal that the key is acceptable (SSH_MSG_USERAUTH_PK_OK).
        ctx.accept()
        return
      }
      if (key.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true) accept()
      else reject()
      return
    }
    case 'keyboard-interactive': {
      const ki = user?.keyboardInteractive
      if (!ki) {
        reject()
        return
      }
      ctx.prompt(
        ki.prompts.map((p) => ({ ...p })),
        (answers) => {
          // On abort ssh2 passes an Error instead of the answers array.
          const ok =
            Array.isArray(answers) &&
            answers.length === ki.answers.length &&
            answers.every((answer, i) => answer === ki.answers[i])
          if (ok) accept()
          else reject()
        }
      )
      return
    }
    default:
      reject()
  }
}

// ---------------------------------------------------------------------------------------------
// Sessions: pty / env / shell / exec / sftp
// ---------------------------------------------------------------------------------------------

function handleSession(session: Session, username: string, srv: ServerEnv): void {
  const state: SessionState = { env: {}, pty: undefined, onSignal: undefined }

  // `accept` is undefined at runtime when the client didn't ask for a reply.
  session.on('pty', (accept, _reject, info) => {
    state.pty = { cols: info.cols, rows: info.rows, term: info.term }
    srv.ptyLog.push(state.pty)
    accept?.()
  })
  session.on('window-change', (accept, _reject, info) => {
    if (state.pty) {
      state.pty.cols = info.cols
      state.pty.rows = info.rows
    } else {
      state.pty = { cols: info.cols, rows: info.rows, term: '' }
      srv.ptyLog.push(state.pty)
    }
    accept?.()
  })
  session.on('env', (accept, _reject, info) => {
    state.env[info.key] = info.val
    accept?.()
  })
  session.on('signal', (accept, _reject, info) => {
    accept?.()
    state.onSignal?.(info.name)
  })

  session.on('shell', (accept) => {
    const channel = accept()
    if (!channel) return
    const tracker = trackChannel(channel)
    srv.envLog.push({ ...state.env })
    runShell(channel, createCommandContext(username, state, state.env, undefined, tracker, srv), tracker)
  })

  session.on('exec', (accept, _reject, info) => {
    const channel = accept()
    if (!channel) return
    const tracker = trackChannel(channel)
    srv.execLog.push(info.command)
    srv.envLog.push({ ...state.env })
    state.onSignal = (name) => {
      const signal = name.replace(/^SIG/, '')
      if (TERMINATING_SIGNALS.has(signal)) tracker.abort(signal)
    }
    if (srv.execHandler) {
      let handled: boolean | void
      try {
        handled = srv.execHandler(info.command, channel, { username, env: { ...state.env } })
      } catch (err) {
        channel.stderr.write(`execHandler error: ${errorMessage(err)}\n`)
        channel.exit(1)
        channel.end()
        return
      }
      if (handled === true) return
    }
    const ctx = createCommandContext(username, state, { ...state.env }, channel, tracker, srv)
    void runExec(channel, info.command, ctx, tracker)
  })

  session.on('sftp', (accept) => {
    const sftp = accept()
    if (sftp) serveSftp(sftp, username, srv)
  })
}

interface ChannelTracker {
  aborted: Promise<void>
  isClosed(): boolean
  isAborted(): boolean
  abort(signal: string): void
  signal(): string | undefined
}

function trackChannel(channel: ServerChannel): ChannelTracker {
  let closed = false
  let signal: string | undefined
  let resolveAborted: () => void = noop
  const aborted = new Promise<void>((resolve) => (resolveAborted = resolve))
  channel.on('error', noop)
  channel.once('close', () => {
    closed = true
    resolveAborted()
  })
  return {
    aborted,
    isClosed: () => closed,
    isAborted: () => closed || signal !== undefined,
    abort: (name) => {
      signal ??= name
      resolveAborted()
    },
    signal: () => signal
  }
}

function createCommandContext(
  username: string,
  state: SessionState,
  env: Record<string, string>,
  stdin: Readable | undefined,
  tracker: ChannelTracker,
  srv: ServerEnv
): CommandContext {
  const home = homeOf(username)
  return {
    username,
    home,
    env,
    pty: state.pty,
    osRelease: srv.osRelease,
    lastCode: 0,
    stdin,
    aborted: tracker.aborted,
    isAborted: tracker.isAborted,
    toRealPath: (p) => {
      const virtual = normalizeVirtualPath(p, home)
      if (virtual === null) throw permissionDenied()
      return toRealPath(srv.rootDir, virtual)
    }
  }
}

function homeOf(username: string): string {
  return normalizeVirtualPath(`/home/${username}`, '/') ?? '/'
}

/** Creates /home/<user> on demand (at login and when SFTP starts), like pam_mkhomedir. */
function ensureHomeDir(rootDir: string, username: string): void {
  try {
    mkdirSync(toRealPath(rootDir, homeOf(username)), { recursive: true })
  } catch (err) {
    debugLog?.(`cannot create home of ${username}: ${errorMessage(err)}`)
  }
}

/** Resolves once `stream` has processed `data` (or the channel closed), giving natural backpressure. */
function writeToChannel(stream: Writable, channel: ServerChannel, data: string | Buffer): Promise<void> {
  return new Promise((resolve) => {
    if (data.length === 0 || !stream.writable || stream.destroyed) {
      resolve()
      return
    }
    const done = (): void => {
      channel.off('close', done)
      resolve()
    }
    channel.once('close', done)
    stream.write(data, () => done())
  })
}

type EscapeState = 'none' | 'esc' | 'csi' | 'ss3'

function nextEscapeState(state: EscapeState, ch: string): EscapeState {
  if (state === 'esc') return ch === '[' ? 'csi' : ch === 'O' ? 'ss3' : 'none'
  if (state === 'csi') return ch >= '@' && ch <= '~' ? 'none' : 'csi'
  return 'none'
}

function runShell(channel: ServerChannel, ctx: CommandContext, tracker: ChannelTracker): void {
  const decoder = new StringDecoder('utf8')
  const write = (data: string | Buffer): Promise<void> => writeToChannel(channel, channel, data)
  const io: CommandIO = { out: (data) => write(toCrlf(data)), err: (data) => write(toCrlf(data)) }

  let line = ''
  let escape: EscapeState = 'none'
  let lastWasCR = false
  let exited = false

  const exit = (code: number): void => {
    if (exited) return
    exited = true
    if (!tracker.isClosed()) {
      channel.exit(code)
      channel.end()
    }
  }

  const runLine = async (command: string): Promise<void> => {
    if (command.trim()) {
      let result: CommandResult
      try {
        result = await runCommandLine(command, io, ctx)
      } catch (err) {
        await io.err(`${errorMessage(err)}\n`)
        result = { code: 1 }
      }
      if (result.exit) {
        exit(result.code)
        return
      }
    }
    if (!exited && !tracker.isClosed()) await write(PROMPT)
  }

  const processInput = async (text: string): Promise<void> => {
    let echo = ''
    const flush = async (): Promise<void> => {
      if (!echo) return
      const pending = echo
      echo = ''
      await write(pending)
    }
    for (const ch of text) {
      if (exited || tracker.isClosed()) return
      if (escape !== 'none') {
        escape = nextEscapeState(escape, ch) // swallow terminal escape sequences (arrow keys etc.)
        continue
      }
      if (ch === '\n' && lastWasCR) {
        lastWasCR = false
        continue
      }
      lastWasCR = ch === '\r'
      switch (ch) {
        case '\r':
        case '\n': {
          echo += '\r\n'
          await flush()
          const command = line
          line = ''
          await runLine(command)
          break
        }
        case '\x7f':
        case '\b':
          if (line) {
            line = Array.from(line).slice(0, -1).join('')
            echo += '\b \b'
          }
          break
        case '\x03':
          line = ''
          echo += `^C\r\n${PROMPT}`
          break
        case '\x04':
          if (!line) {
            await flush()
            exit(0)
            return
          }
          break
        case '\x1b':
          escape = 'esc'
          break
        default:
          if (ch >= ' ') {
            line += ch
            echo += ch
          }
      }
    }
    await flush()
  }

  let queue = write(`${BANNER}\r\n${PROMPT}`)
  channel.on('data', (data: Buffer) => {
    const text = decoder.write(data)
    queue = queue.then(() => processInput(text)).catch(noop)
  })
  channel.on('end', () => {
    queue = queue.then(() => exit(0)).catch(noop)
  })
}

async function runExec(
  channel: ServerChannel,
  command: string,
  ctx: CommandContext,
  tracker: ChannelTracker
): Promise<void> {
  // With a pty everything goes through the terminal: CRLF line endings and stderr merged into stdout.
  const out: Sink = (data) => writeToChannel(channel, channel, ctx.pty ? toCrlf(data) : data)
  const io: CommandIO = { out, err: ctx.pty ? out : (data) => writeToChannel(channel.stderr, channel, data) }
  let code: number
  try {
    code = (await runCommandLine(command, io, ctx)).code
  } catch (err) {
    await io.err(`${errorMessage(err)}\n`)
    code = 1
  }
  if (tracker.isClosed()) return
  const signal = tracker.signal()
  if (signal) channel.exit(signal, false, '')
  else channel.exit(code)
  channel.end()
}

// ---------------------------------------------------------------------------------------------
// Mini shell interpreter (shared by the fake interactive shell and exec)
// ---------------------------------------------------------------------------------------------

interface CommandResult {
  code: number
  /** Set by `exit`: stop processing and end the session with `code`. */
  exit?: boolean
}

type Sink = (data: string | Buffer) => Promise<void>

const CRLF = Buffer.from('\r\n')

/** A terminal's output processing (`onlcr`): LF becomes CRLF, for text and for file contents (`cat`) alike. */
function toCrlf(data: string | Buffer): string | Buffer {
  if (typeof data === 'string') return data.replace(/\r?\n/g, '\r\n')
  if (!data.includes(0x0a)) return data
  const parts: Buffer[] = []
  let start = 0
  for (let i = data.indexOf(0x0a); i !== -1; i = data.indexOf(0x0a, i + 1)) {
    parts.push(data.subarray(start, i > start && data[i - 1] === 0x0d ? i - 1 : i), CRLF)
    start = i + 1
  }
  parts.push(data.subarray(start))
  return Buffer.concat(parts)
}

interface CommandIO {
  out: Sink
  err: Sink
}

interface CommandContext {
  username: string
  home: string
  env: Record<string, string>
  pty: PtyState | undefined
  osRelease: string
  lastCode: number
  stdin: Readable | undefined
  aborted: Promise<void>
  isAborted(): boolean
  toRealPath(virtualPath: string): string
}

type Builtin = (args: string[], io: CommandIO, ctx: CommandContext) => Promise<CommandResult>

const OK: CommandResult = { code: 0 }

const runShellBuiltin: Builtin = async (args, io, ctx) => {
  const flagIndex = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg))
  let script: string
  if (flagIndex >= 0) {
    script = args[flagIndex + 1] ?? ''
  } else if (args.every((arg) => arg.startsWith('-'))) {
    const chunks: Buffer[] = []
    await forEachStdinChunk(ctx, async (chunk) => {
      chunks.push(Buffer.from(chunk))
    })
    script = Buffer.concat(chunks).toString('utf8')
  } else {
    await io.err(`${args[0]}: No such file or directory\n`)
    return { code: 127 }
  }
  // A subshell's `exit` only ends the subshell.
  return { code: (await runCommandLine(script, io, ctx)).code }
}

const BUILTINS: Record<string, Builtin> = {
  ':': async () => OK,
  true: async () => OK,
  false: async () => ({ code: 1 }),
  cd: async () => OK,
  echo: async (args, io) => {
    const newline = args[0] !== '-n'
    const words = newline ? args : args.slice(1)
    await io.out(`${words.join(' ')}${newline ? '\n' : ''}`)
    return OK
  },
  exit: async (args, io, ctx) => {
    if (args.length === 0) return { code: ctx.lastCode, exit: true }
    if (!/^-?\d+$/.test(args[0])) {
      await io.err(`exit: ${args[0]}: numeric argument required\n`)
      return { code: 2, exit: true }
    }
    return { code: ((Number.parseInt(args[0], 10) % 256) + 256) % 256, exit: true }
  },
  whoami: async (_args, io, ctx) => {
    await io.out(`${ctx.username}\n`)
    return OK
  },
  id: async (args, io, ctx) => {
    const id = ctx.username === 'root' ? 0 : 1000
    const flags = args.join('')
    if (flags.includes('u') || flags.includes('g'))
      await io.out(`${flags.includes('n') ? ctx.username : id}\n`)
    else await io.out(`uid=${id}(${ctx.username}) gid=${id}(${ctx.username}) groups=${id}(${ctx.username})\n`)
    return OK
  },
  pwd: async (_args, io, ctx) => {
    await io.out(`${ctx.home}\n`)
    return OK
  },
  hostname: async (_args, io) => {
    await io.out(`${HOSTNAME}\n`)
    return OK
  },
  uname: async (args, io) => {
    let flags = ''
    for (const arg of args) {
      if (Object.hasOwn(UNAME_LONG_OPTIONS, arg)) flags += UNAME_LONG_OPTIONS[arg]
      else if (/^-[asnrvmpio]+$/.test(arg)) flags += arg.slice(1)
      else {
        await io.err(`uname: invalid option -- '${arg.replace(/^-+/, '')}'\n`)
        return { code: 1 }
      }
    }
    const selected = flags.includes('a')
      ? UNAME_ORDER
      : [...UNAME_ORDER].filter((f) => flags.includes(f)).join('')
    const fields = [...(selected || 's')].map((f) => UNAME_FIELDS[f])
    await io.out(`${fields.join(' ')}\n`)
    return OK
  },
  env: async (_args, io, ctx) => {
    await io.out(formatEnv(ctx.env))
    return OK
  },
  printenv: async (args, io, ctx) => {
    if (args.length === 0) {
      await io.out(formatEnv(ctx.env))
      return OK
    }
    let code = 0
    for (const name of args) {
      if (Object.hasOwn(ctx.env, name)) await io.out(`${ctx.env[name]}\n`)
      else code = 1
    }
    return { code }
  },
  export: async (args, _io, ctx) => {
    for (const arg of args) {
      const eq = arg.indexOf('=')
      if (eq > 0) ctx.env[arg.slice(0, eq)] = arg.slice(eq + 1)
    }
    return OK
  },
  cat: async (args, io, ctx) => {
    if (args.length === 0) {
      await forEachStdinChunk(ctx, (chunk) => io.out(chunk))
      return OK
    }
    let code = 0
    for (const file of args) {
      const virtual = normalizeVirtualPath(file, ctx.home)
      if (virtual === '/etc/os-release' || virtual === '/usr/lib/os-release') {
        await io.out(ctx.osRelease)
        continue
      }
      try {
        await io.out(await fsp.readFile(ctx.toRealPath(file)))
      } catch (err) {
        code = 1
        await io.err(`cat: ${file}: ${describeFsError(err)}\n`)
      }
    }
    return { code }
  },
  sleep: async (args, io, ctx) => {
    const seconds = Number(args[0])
    if (args.length === 0 || !Number.isFinite(seconds) || seconds < 0) {
      await io.err(`sleep: invalid time interval '${args[0] ?? ''}'\n`)
      return { code: 1 }
    }
    await abortableDelay(seconds * 1000, ctx.aborted)
    return OK
  },
  stty: async (args, io, ctx) => {
    if (args[0] !== 'size') return OK // other stty invocations (e.g. `stty -echo`) are accepted and ignored
    if (!ctx.pty) {
      await io.err("stty: 'standard input': Inappropriate ioctl for device\n")
      return { code: 1 }
    }
    await io.out(`${ctx.pty.rows} ${ctx.pty.cols}\n`)
    return OK
  },
  /** `cat-big <n>`: n bytes of 'x' plus a newline, written with backpressure (flow-control tests). */
  'cat-big': async (args, io, ctx) => {
    const total = Math.max(0, Number.parseInt(args[0] ?? '0', 10) || 0)
    const chunk = Buffer.alloc(Math.min(Math.max(total, 1), 64 * 1024), 'x')
    for (let left = total; left > 0 && !ctx.isAborted(); left -= chunk.length) {
      await io.out(left >= chunk.length ? chunk : chunk.subarray(0, left))
    }
    await io.out('\n')
    return OK
  },
  which: async (args, io) => {
    let code = 0
    for (const name of args) {
      if (Object.hasOwn(BUILTINS, name)) await io.out(`/usr/bin/${name}\n`)
      else code = 1
    }
    return { code }
  },
  command: async (args, io, ctx) => {
    if (args[0] === '-v' || args[0] === '-V') return BUILTINS.which(args.slice(1), io, ctx)
    return runArgv(args, io, ctx)
  },
  sh: runShellBuiltin,
  bash: runShellBuiltin
}

type ListOperator = ';' | '&&' | '||'

/** Splits on unquoted `;`, newlines, `&&` and `||`. */
function splitCommandList(line: string): { op: ListOperator; text: string }[] {
  const parts: { op: ListOperator; text: string }[] = []
  let op: ListOperator = ';'
  let current = ''
  let quote: string | undefined
  const push = (next: ListOperator): void => {
    if (current.trim()) parts.push({ op, text: current.trim() })
    current = ''
    op = next
  }
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      current += c
      if (c === quote) quote = undefined
      else if (c === '\\' && quote === '"' && i + 1 < line.length) current += line[++i]
      continue
    }
    if (c === '\\' && i + 1 < line.length) {
      current += c + line[++i]
    } else if (c === "'" || c === '"') {
      quote = c
      current += c
    } else if (c === ';' || c === '\n') {
      push(';')
    } else if ((c === '&' || c === '|') && line[i + 1] === c) {
      push(c === '&' ? '&&' : '||')
      i++
    } else {
      current += c
    }
  }
  push(';')
  return parts
}

/** Word splitting with single/double quotes, backslash escapes and `$VAR` / `${VAR}` / `$?` expansion. */
function tokenize(text: string, lookup: (name: string) => string): string[] {
  const words: string[] = []
  let current = ''
  let inWord = false
  let quote: "'" | '"' | undefined
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote === "'") {
      if (c === "'") quote = undefined
      else current += c
      continue
    }
    if (c === '$') {
      const variable = readVariable(text, i, lookup)
      if (variable) {
        current += variable.value
        if (variable.value || quote) inWord = true
        i = variable.end - 1
        continue
      }
    }
    if (quote === '"') {
      if (c === '"') quote = undefined
      else if (c === '\\' && i + 1 < text.length && '"\\$`'.includes(text[i + 1])) current += text[++i]
      else current += c
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      inWord = true
    } else if (c === '\\' && i + 1 < text.length) {
      current += text[++i]
      inWord = true
    } else if (c === ' ' || c === '\t') {
      if (inWord) words.push(current)
      current = ''
      inWord = false
    } else {
      current += c
      inWord = true
    }
  }
  if (inWord) words.push(current)
  return words
}

function readVariable(
  text: string,
  start: number,
  lookup: (name: string) => string
): { value: string; end: number } | undefined {
  const next = text[start + 1]
  if (next === '{') {
    const close = text.indexOf('}', start + 2)
    return close === -1 ? undefined : { value: lookup(text.slice(start + 2, close)), end: close + 1 }
  }
  if (next === '?') return { value: lookup('?'), end: start + 2 }
  const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(start + 1))?.[0]
  return name ? { value: lookup(name), end: start + 1 + name.length } : undefined
}

function lookupVariable(name: string, ctx: CommandContext): string {
  if (name === '?') return String(ctx.lastCode)
  if (Object.hasOwn(ctx.env, name)) return ctx.env[name]
  switch (name) {
    case 'HOME':
    case 'PWD':
      return ctx.home
    case 'USER':
    case 'LOGNAME':
      return ctx.username
    case 'SHELL':
      return '/bin/bash'
    case 'PATH':
      return DEFAULT_PATH
    case 'HOSTNAME':
      return HOSTNAME
    case 'TERM':
      return ctx.pty?.term ?? ''
    default:
      return ''
  }
}

interface Redirect {
  fd: 1 | 2
  /** '/dev/null', '&1', '&2' or a file path */
  target: string
  append: boolean
}

function extractRedirects(words: string[]): { argv: string[]; redirects: Redirect[] } {
  const argv: string[] = []
  const redirects: Redirect[] = []
  for (let i = 0; i < words.length; i++) {
    const match = /^([12]?|&)(>>?)(.*)$/.exec(words[i])
    if (!match || (!match[3] && i + 1 >= words.length)) {
      argv.push(words[i])
      continue
    }
    const target = match[3] || words[++i]
    const append = match[2] === '>>'
    if (match[1] === '&') redirects.push({ fd: 1, target, append }, { fd: 2, target: '&1', append })
    else redirects.push({ fd: match[1] === '2' ? 2 : 1, target, append })
  }
  return { argv, redirects }
}

function openRedirects(
  io: CommandIO,
  redirects: Redirect[],
  ctx: CommandContext
): { io: CommandIO; flush: () => Promise<string | undefined> } | { error: string } {
  let out = io.out
  let err = io.err
  const files: { target: string; real: string; append: boolean; chunks: Buffer[] }[] = []
  for (const redirect of redirects) {
    let sink: Sink
    if (redirect.target === '/dev/null') {
      sink = async () => {}
    } else if (redirect.target === '&1') {
      sink = out
    } else if (redirect.target === '&2') {
      sink = err
    } else {
      let real: string
      try {
        real = ctx.toRealPath(redirect.target)
      } catch (e) {
        return { error: `${redirect.target}: ${describeFsError(e)}\n` }
      }
      const file = { target: redirect.target, real, append: redirect.append, chunks: [] as Buffer[] }
      files.push(file)
      sink = async (data) => {
        file.chunks.push(Buffer.from(data))
      }
    }
    if (redirect.fd === 1) out = sink
    else err = sink
  }
  const flush = async (): Promise<string | undefined> => {
    for (const file of files) {
      try {
        const data = Buffer.concat(file.chunks)
        if (file.append) await fsp.appendFile(file.real, data)
        else await fsp.writeFile(file.real, data)
      } catch (e) {
        return `${file.target}: ${describeFsError(e)}\n`
      }
    }
    return undefined
  }
  return { io: { out, err }, flush }
}

async function runCommandLine(line: string, io: CommandIO, ctx: CommandContext): Promise<CommandResult> {
  for (const { op, text } of splitCommandList(line)) {
    if ((op === '&&' && ctx.lastCode !== 0) || (op === '||' && ctx.lastCode === 0)) continue
    const result = await runSimpleCommand(text, io, ctx)
    ctx.lastCode = result.code
    if (result.exit) return result
    if (ctx.isAborted()) break
  }
  return { code: ctx.lastCode }
}

async function runSimpleCommand(text: string, io: CommandIO, ctx: CommandContext): Promise<CommandResult> {
  const { argv, redirects } = extractRedirects(tokenize(text, (name) => lookupVariable(name, ctx)))
  const assignments: Record<string, string> = {}
  while (argv.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0])) {
    const word = argv.shift() as string
    const eq = word.indexOf('=')
    assignments[word.slice(0, eq)] = word.slice(eq + 1)
  }
  if (argv.length === 0) {
    Object.assign(ctx.env, assignments)
    return OK
  }
  const redirected = openRedirects(io, redirects, ctx)
  if ('error' in redirected) {
    await io.err(redirected.error)
    return { code: 1 }
  }
  const commandCtx =
    Object.keys(assignments).length > 0 ? { ...ctx, env: { ...ctx.env, ...assignments } } : ctx
  const result = await runArgv(argv, redirected.io, commandCtx)
  const flushError = await redirected.flush()
  if (flushError) {
    await io.err(flushError)
    return { code: 1, exit: result.exit }
  }
  return result
}

async function runArgv(argv: string[], io: CommandIO, ctx: CommandContext): Promise<CommandResult> {
  const [command, ...args] = argv
  if (command === undefined) return OK
  const name = /^(\/usr)?\/s?bin\/[^/]+$/.test(command)
    ? command.slice(command.lastIndexOf('/') + 1)
    : command
  const builtin = Object.hasOwn(BUILTINS, name) ? BUILTINS[name] : undefined
  if (!builtin) {
    await io.err(`${command}: command not found\n`)
    return { code: 127 }
  }
  return builtin(args, io, ctx)
}

/** Feeds the exec channel's stdin to `onChunk` (with backpressure) until EOF or abort. */
async function forEachStdinChunk(
  ctx: CommandContext,
  onChunk: (chunk: Buffer) => Promise<void>
): Promise<void> {
  const stdin = ctx.stdin
  if (!stdin || stdin.readableEnded || ctx.isAborted()) return
  await new Promise<void>((resolve) => {
    let pending = Promise.resolve()
    let finished = false
    const finish = (): void => {
      if (finished) return
      finished = true
      stdin.off('data', onData)
      stdin.off('end', finish)
      void pending.then(() => resolve())
    }
    const onData = (chunk: Buffer): void => {
      stdin.pause()
      pending = pending
        .then(() => onChunk(chunk))
        .then(() => {
          if (!finished) stdin.resume()
        })
    }
    stdin.on('data', onData)
    stdin.once('end', finish)
    void ctx.aborted.then(finish)
  })
}

function abortableDelay(ms: number, aborted: Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    void aborted.then(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

function formatEnv(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}\n`)
    .join('')
}

// ---------------------------------------------------------------------------------------------
// SFTP (v3) backed by the real filesystem under rootDir
// ---------------------------------------------------------------------------------------------

class SftpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const permissionDenied = (): SftpError => new SftpError(STATUS_CODE.PERMISSION_DENIED, 'Permission denied')

type OpenHandle =
  | { kind: 'file'; fh: FileHandle; real: string }
  | { kind: 'dir'; real: string; virtual: string; entries: FileEntry[] | undefined; offset: number }

function serveSftp(sftp: SFTPWrapper, username: string, srv: ServerEnv): void {
  const { rootDir } = srv
  const home = homeOf(username)
  ensureHomeDir(rootDir, username)

  const handles = new Map<number, OpenHandle>()
  let nextHandleId = 1
  let closed = false
  // Requests are processed strictly in order, like OpenSSH's sftp-server (no WRITE/CLOSE races).
  let queue: Promise<void> = Promise.resolve()

  const run = (reqId: number, task: () => Promise<void>): void => {
    queue = queue.then(task).catch((err: unknown) => {
      if (closed) return
      const { code, message } = errorToStatus(err)
      sftp.status(reqId, code, message)
    })
  }
  const ok = (reqId: number): void => sftp.status(reqId, STATUS_CODE.OK)
  const resolvePath = (p: string): { virtual: string; real: string } => {
    const virtual = normalizeVirtualPath(p, home)
    if (virtual === null) throw permissionDenied()
    return { virtual, real: toRealPath(rootDir, virtual) }
  }
  const addHandle = (handle: OpenHandle): Buffer => {
    const id = nextHandleId++
    handles.set(id, handle)
    const buf = Buffer.alloc(4)
    buf.writeUInt32BE(id, 0)
    return buf
  }
  // Handle buffers may be views into protocol buffers, so decode them synchronously.
  const handleId = (buf: Buffer): number => (buf.length === 4 ? buf.readUInt32BE(0) : 0)
  const getHandle = (id: number): OpenHandle => {
    const handle = handles.get(id)
    if (!handle) throw new SftpError(STATUS_CODE.FAILURE, 'Invalid handle')
    return handle
  }
  const getFile = (id: number): Extract<OpenHandle, { kind: 'file' }> => {
    const handle = getHandle(id)
    if (handle.kind !== 'file') throw new SftpError(STATUS_CODE.FAILURE, 'Not a file handle')
    return handle
  }

  sftp.on('OPEN', (reqId, filename, flags, attrs) =>
    run(reqId, async () => {
      const { real } = resolvePath(filename)
      // On Windows a mode without the write bit would create a read-only file that can't be deleted later.
      const mode = !IS_WINDOWS && typeof attrs.mode === 'number' ? attrs.mode & 0o7777 : 0o666
      const fh = await fsp.open(real, toFsOpenFlags(flags), mode)
      if (closed) {
        await fh.close()
        return
      }
      sftp.handle(reqId, addHandle({ kind: 'file', fh, real }))
    })
  )

  sftp.on('READ', (reqId, handle, offset, length) => {
    const id = handleId(handle)
    run(reqId, async () => {
      const file = getFile(id)
      const size = Math.min(length, MAX_READ_LENGTH)
      const buffer = Buffer.allocUnsafe(size)
      const { bytesRead } = size > 0 ? await file.fh.read(buffer, 0, size, offset) : { bytesRead: 0 }
      if (bytesRead === 0) sftp.status(reqId, STATUS_CODE.EOF)
      else sftp.data(reqId, buffer.subarray(0, bytesRead))
    })
  })

  sftp.on('WRITE', (reqId, handle, offset, data) => {
    const id = handleId(handle)
    const chunk = Buffer.from(data) // copy: the payload may alias a reused protocol buffer
    run(reqId, async () => {
      const file = getFile(id)
      let written = 0
      while (written < chunk.length) {
        const { bytesWritten } = await file.fh.write(chunk, written, chunk.length - written, offset + written)
        if (bytesWritten <= 0) throw new SftpError(STATUS_CODE.FAILURE, 'Short write')
        written += bytesWritten
      }
      ok(reqId)
    })
  })

  sftp.on('CLOSE', (reqId, handle) => {
    const id = handleId(handle)
    run(reqId, async () => {
      const entry = getHandle(id)
      handles.delete(id)
      if (entry.kind === 'file') await entry.fh.close()
      ok(reqId)
    })
  })

  sftp.on('FSTAT', (reqId, handle) => {
    const id = handleId(handle)
    run(reqId, async () => {
      const entry = getHandle(id)
      const stats = entry.kind === 'file' ? await entry.fh.stat() : await fsp.stat(entry.real)
      sftp.attrs(reqId, statsToAttrs(stats))
    })
  })

  sftp.on('STAT', (reqId, p) =>
    run(reqId, async () => {
      sftp.attrs(reqId, statsToAttrs(await fsp.stat(resolvePath(p).real)))
    })
  )

  sftp.on('LSTAT', (reqId, p) =>
    run(reqId, async () => {
      sftp.attrs(reqId, statsToAttrs(await fsp.lstat(resolvePath(p).real)))
    })
  )

  sftp.on('SETSTAT', (reqId, p, attrs) =>
    run(reqId, async () => {
      await applyAttrs(resolvePath(p).real, undefined, attrs)
      ok(reqId)
    })
  )

  sftp.on('FSETSTAT', (reqId, handle, attrs) => {
    const id = handleId(handle)
    run(reqId, async () => {
      const entry = getHandle(id)
      await applyAttrs(entry.real, entry.kind === 'file' ? entry.fh : undefined, attrs)
      ok(reqId)
    })
  })

  sftp.on('OPENDIR', (reqId, p) =>
    run(reqId, async () => {
      const { real, virtual } = resolvePath(p)
      if (!(await fsp.stat(real)).isDirectory()) throw new SftpError(STATUS_CODE.FAILURE, 'Not a directory')
      sftp.handle(reqId, addHandle({ kind: 'dir', real, virtual, entries: undefined, offset: 0 }))
    })
  )

  sftp.on('READDIR', (reqId, handle) => {
    const id = handleId(handle)
    run(reqId, async () => {
      const entry = getHandle(id)
      if (entry.kind !== 'dir') throw new SftpError(STATUS_CODE.FAILURE, 'Not a directory handle')
      entry.entries ??= await listDirectory(entry.real, entry.virtual === '/', username)
      if (entry.offset >= entry.entries.length) {
        sftp.status(reqId, STATUS_CODE.EOF)
        return
      }
      const batch = entry.entries.slice(entry.offset, entry.offset + READDIR_BATCH)
      entry.offset += batch.length
      sftp.name(reqId, batch)
    })
  })

  sftp.on('REMOVE', (reqId, p) =>
    run(reqId, async () => {
      const { real } = resolvePath(p)
      if ((await fsp.lstat(real)).isDirectory()) throw new SftpError(STATUS_CODE.FAILURE, 'Is a directory')
      await fsp.unlink(real)
      ok(reqId)
    })
  )

  sftp.on('RMDIR', (reqId, p) =>
    run(reqId, async () => {
      const { real, virtual } = resolvePath(p)
      if (virtual === '/') throw permissionDenied()
      await fsp.rmdir(real)
      ok(reqId)
    })
  )

  sftp.on('MKDIR', (reqId, p, attrs) =>
    run(reqId, async () => {
      const { real } = resolvePath(p)
      const mode = !IS_WINDOWS && typeof attrs.mode === 'number' ? attrs.mode & 0o7777 : 0o777
      await fsp.mkdir(real, { mode })
      ok(reqId)
    })
  )

  sftp.on('RENAME', (reqId, oldPath, newPath) =>
    run(reqId, async () => {
      const from = resolvePath(oldPath)
      const to = resolvePath(newPath)
      if (from.virtual === '/' || to.virtual === '/') throw permissionDenied()
      // SFTP v3: it is an error if newpath already exists.
      if (await pathExists(to.real)) throw new SftpError(STATUS_CODE.FAILURE, 'File already exists')
      await fsp.rename(from.real, to.real)
      ok(reqId)
    })
  )

  sftp.on('REALPATH', (reqId, p) =>
    run(reqId, async () => {
      const { virtual } = resolvePath(p)
      sftp.name(reqId, [{ filename: virtual, longname: virtual, attrs: NO_ATTRS }])
    })
  )

  sftp.on('READLINK', (reqId, p) =>
    run(reqId, async () => {
      const target = toVirtualLinkTarget(rootDir, await fsp.readlink(resolvePath(p).real))
      sftp.name(reqId, [{ filename: target, longname: target, attrs: NO_ATTRS }])
    })
  )

  // ssh2 emits (linkPath, targetPath) here (its typings name them the other way round).
  sftp.on('SYMLINK', (reqId, linkPath, targetPath) =>
    run(reqId, async () => {
      const link = resolvePath(linkPath)
      let target: string
      if (targetPath.startsWith('/')) {
        target = resolvePath(targetPath).real
      } else {
        // Relative targets stay relative but must not point outside the root.
        if (normalizeVirtualPath(`${path.posix.dirname(link.virtual)}/${targetPath}`, home) === null) {
          throw permissionDenied()
        }
        target = targetPath.split('/').join(path.sep)
      }
      try {
        await fsp.symlink(target, link.real)
      } catch (err) {
        // e.g. EPERM on Windows without the symlink privilege / developer mode
        throw new SftpError(STATUS_CODE.FAILURE, `Symlink failed (${errnoCode(err) ?? 'error'})`)
      }
      ok(reqId)
    })
  )

  sftp.on('EXTENDED', (reqId) =>
    run(reqId, async () => {
      sftp.status(reqId, STATUS_CODE.OP_UNSUPPORTED)
    })
  )

  sftp.on('error', (err: Error) => debugLog?.(`sftp error: ${err.message}`))

  const cleanup = (): void => {
    if (closed) return
    closed = true
    const done = queue.then(async () => {
      for (const entry of handles.values()) {
        if (entry.kind === 'file') await entry.fh.close().catch(noop)
      }
      handles.clear()
    })
    srv.pendingCleanups.add(done)
    const forget = (): void => {
      srv.pendingCleanups.delete(done)
    }
    done.then(forget, forget)
  }
  sftp.on('end', cleanup)
  sftp.on('close', cleanup)
}

function toFsOpenFlags(pflags: number): string | number {
  const mapped = utils.sftp.flagsToString(pflags)
  if (mapped) return mapped
  // Combinations ssh2 has no string for (e.g. WRITE|CREAT without TRUNC).
  const read = (pflags & OPEN_MODE.READ) !== 0
  const write = (pflags & OPEN_MODE.WRITE) !== 0
  let flags = read && write ? fsConstants.O_RDWR : write ? fsConstants.O_WRONLY : fsConstants.O_RDONLY
  if (pflags & OPEN_MODE.APPEND) flags |= fsConstants.O_APPEND
  if (pflags & OPEN_MODE.CREAT) flags |= fsConstants.O_CREAT
  if (pflags & OPEN_MODE.TRUNC) flags |= fsConstants.O_TRUNC
  if (pflags & OPEN_MODE.EXCL) flags |= fsConstants.O_EXCL
  return flags
}

async function applyAttrs(
  real: string,
  fh: FileHandle | undefined,
  attrs: Partial<Attributes>
): Promise<void> {
  if (typeof attrs.size === 'number') {
    if (fh) await fh.truncate(attrs.size)
    else await fsp.truncate(real, attrs.size)
  }
  // Windows only knows a read-only flag, which would also block deletes: chmod is a no-op there.
  if (typeof attrs.mode === 'number' && !IS_WINDOWS) await fsp.chmod(real, attrs.mode & 0o7777)
  if (typeof attrs.atime === 'number' && typeof attrs.mtime === 'number') {
    await fsp.utimes(real, attrs.atime, attrs.mtime)
  }
  // uid/gid changes are ignored.
}

async function listDirectory(real: string, isRoot: boolean, owner: string): Promise<FileEntry[]> {
  const names = (await fsp.readdir(real)).sort()
  const targets: [string, string][] = [
    ['.', real],
    ['..', isRoot ? real : path.dirname(real)], // never stat outside the jail
    ...names.map((name): [string, string] => [name, path.join(real, name)])
  ]
  const entries = await Promise.all(
    targets.map(async ([name, target]): Promise<FileEntry | undefined> => {
      try {
        const stats = await fsp.lstat(target)
        return { filename: name, longname: formatLongname(name, stats, owner), attrs: statsToAttrs(stats) }
      } catch {
        return undefined // vanished or inaccessible
      }
    })
  )
  return entries.filter((entry): entry is FileEntry => entry !== undefined)
}

function statsToAttrs(stats: FsStats): Attributes {
  return {
    mode: stats.mode, // includes the S_IFMT type bits clients use to tell files/dirs/links apart
    uid: stats.uid,
    gid: stats.gid,
    size: stats.size,
    atime: Math.floor(stats.atimeMs / 1000),
    mtime: Math.floor(stats.mtimeMs / 1000)
  }
}

/** `ls -l` style line, formatted like OpenSSH's sftp-server. */
function formatLongname(name: string, stats: FsStats, owner: string): string {
  const date = new Date(stats.mtimeMs)
  const recent = Math.abs(Date.now() - stats.mtimeMs) < 182 * 24 * 3600 * 1000
  const day = String(date.getDate()).padStart(2, ' ')
  const pad2 = (n: number): string => String(n).padStart(2, '0')
  const when = recent
    ? `${MONTHS[date.getMonth()]} ${day} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
    : `${MONTHS[date.getMonth()]} ${day}  ${date.getFullYear()}`
  return [
    modeString(stats.mode),
    String(stats.nlink).padStart(3),
    owner.padEnd(8),
    owner.padEnd(8),
    String(stats.size).padStart(8),
    when,
    name
  ].join(' ')
}

function modeString(mode: number): string {
  const format = mode & S_IFMT
  const type =
    format === S_IFDIR
      ? 'd'
      : format === S_IFLNK
        ? 'l'
        : format === S_IFCHR
          ? 'c'
          : format === S_IFBLK
            ? 'b'
            : format === S_IFIFO
              ? 'p'
              : format === S_IFSOCK
                ? 's'
                : '-'
  const bit = (mask: number, ch: string): string => (mode & mask ? ch : '-')
  const exec = (mask: number, special: number, set: string, setNoExec: string): string =>
    mode & special ? (mode & mask ? set : setNoExec) : mode & mask ? 'x' : '-'
  return (
    type +
    bit(0o400, 'r') +
    bit(0o200, 'w') +
    exec(0o100, 0o4000, 's', 'S') +
    bit(0o040, 'r') +
    bit(0o020, 'w') +
    exec(0o010, 0o2000, 's', 'S') +
    bit(0o004, 'r') +
    bit(0o002, 'w') +
    exec(0o001, 0o1000, 't', 'T')
  )
}

// ---------------------------------------------------------------------------------------------
// Virtual path handling (jail)
// ---------------------------------------------------------------------------------------------

/**
 * Normalizes a client path to an absolute virtual POSIX path (relative paths resolve against `home`).
 * Returns null if the path climbs above `/` or contains a segment that is unsafe on this platform.
 */
function normalizeVirtualPath(input: string, home: string): string | null {
  let p = input.replace(/\\/g, '/') // backslashes are separators on Windows: never let them smuggle in `..`
  if (p === '~' || p.startsWith('~/')) p = home + p.slice(1)
  if (!p.startsWith('/')) p = `${home}/${p}`
  const parts: string[] = []
  for (const segment of p.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (parts.length === 0) return null
      parts.pop()
      continue
    }
    if (!isSafeSegment(segment)) return null
    parts.push(segment)
  }
  return `/${parts.join('/')}`
}

function isSafeSegment(segment: string): boolean {
  if (segment.includes('\0')) return false
  if (!IS_WINDOWS) return true
  // Win32 strips trailing dots/spaces (".. " would become "..") and gives ':' etc. special meaning.
  if (/[. ]$/.test(segment) || /[<>:"|?*]/.test(segment)) return false
  return Array.from(segment).every((ch) => ch.charCodeAt(0) >= 32)
}

function toRealPath(rootDir: string, virtualPath: string): string {
  const real = path.join(rootDir, ...virtualPath.split('/').filter(Boolean))
  const relative = path.relative(rootDir, real)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw permissionDenied()
  }
  return real
}

function toVirtualLinkTarget(rootDir: string, target: string): string {
  if (!path.isAbsolute(target)) return target.split(path.sep).join('/')
  const relative = path.relative(rootDir, target)
  if (relative === '') return '/'
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return target
  return `/${relative.split(path.sep).join('/')}`
}

async function pathExists(real: string): Promise<boolean> {
  try {
    await fsp.lstat(real)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------------------------
// Port forwarding
// ---------------------------------------------------------------------------------------------

/** direct-tcpip (client `forwardOut`): connect to the destination and pipe both ways. */
function openDirectTcpip(
  accept: () => ServerChannel,
  reject: () => void,
  info: TcpipRequestInfo,
  trackSocket: (socket: Socket) => void
): void {
  const socket = netConnect({ host: info.destIP, port: info.destPort })
  trackSocket(socket)
  let connected = false
  const timer = setTimeout(() => socket.destroy(new Error('connect timeout')), CONNECT_TIMEOUT_MS)
  socket.on('error', (err) => {
    debugLog?.(`direct-tcpip ${info.destIP}:${info.destPort}: ${err.message}`)
    if (!connected) reject()
    socket.destroy()
  })
  socket.once('close', () => clearTimeout(timer))
  socket.once('connect', () => {
    connected = true
    clearTimeout(timer)
    const channel = accept()
    if (!channel) {
      socket.destroy()
      return
    }
    bridge(socket, channel)
  })
}

/** tcpip-forward (client `forwardIn`): listen and open a forwarded-tcpip channel per incoming socket. */
async function startRemoteForward(
  conn: Connection,
  info: TcpipBindInfo,
  trackSocket: (socket: Socket) => void
): Promise<{ server: NetServer; port: number }> {
  const bindAddr = info.bindAddr
  // '' / '*' mean "all interfaces" in OpenSSH; a test server stays on loopback.
  const listenHost = !bindAddr || bindAddr === '*' || bindAddr === 'localhost' ? HOST : bindAddr
  let boundPort = info.bindPort
  const server = createNetServer((socket) => {
    trackSocket(socket)
    socket.on('error', noop)
    // ssh2 clients look the forwarding up by the exact (bindAddr, port) they requested.
    conn.forwardOut(
      bindAddr,
      boundPort,
      socket.remoteAddress ?? HOST,
      socket.remotePort ?? 0,
      (err, channel) => {
        if (err || socket.destroyed) {
          socket.destroy()
          channel?.close()
          return
        }
        bridge(socket, channel)
      }
    )
  })
  await listen(server, info.bindPort, listenHost)
  server.on('error', noop)
  boundPort = (server.address() as AddressInfo).port
  return { server, port: boundPort }
}

function bridge(socket: Socket, channel: ServerChannel): void {
  channel.on('error', noop)
  socket.pipe(channel)
  channel.pipe(socket)
  // Normal EOFs propagate through pipe(); only tear down on errors / channel close.
  socket.once('close', (hadError: boolean) => {
    if (hadError) channel.close()
  })
  channel.once('close', () => socket.destroy())
}

// ---------------------------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------------------------

function listen(server: NetServer, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => reject(err)
    server.once('error', onError)
    server.listen(port, host, () => {
      server.off('error', onError)
      resolve()
    })
  })
}

async function waitWithTimeout(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  await Promise.race([promise, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))])
  clearTimeout(timer)
}

function errnoCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null ? (err as NodeJS.ErrnoException).code : undefined
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function errorToStatus(err: unknown): { code: number; message: string } {
  if (err instanceof SftpError) return { code: err.status, message: err.message }
  const code = errnoCode(err)
  switch (code) {
    case 'ENOENT':
      return { code: STATUS_CODE.NO_SUCH_FILE, message: 'No such file' }
    case 'EACCES':
    case 'EPERM':
      return { code: STATUS_CODE.PERMISSION_DENIED, message: 'Permission denied' }
    default:
      return { code: STATUS_CODE.FAILURE, message: code ? `Failure (${code})` : 'Failure' }
  }
}

function describeFsError(err: unknown): string {
  if (err instanceof SftpError) return err.message
  switch (errnoCode(err)) {
    case 'ENOENT':
      return 'No such file or directory'
    case 'EISDIR':
      return 'Is a directory'
    case 'EACCES':
    case 'EPERM':
      return 'Permission denied'
    default:
      return errorMessage(err)
  }
}
