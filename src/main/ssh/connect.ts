import type { Duplex } from 'node:stream'
import { type AnyAuthMethod, type AuthenticationType, Client, type ClientChannel, type ParsedKey } from 'ssh2'
import type { PromptService } from '../services/prompts'
import type { VaultService } from '../vault/vault-service'
import { systemAgentPath, VaultKeyAgent } from './agent'
import { HostKeyRejectedError, type KnownHostsService } from './known-hosts'
import { KeyParseError, parsePrivateKey } from './keys'
import { openProxySocket } from './proxy'
import { type Endpoint, resolveHostById } from './resolve'

export type LogFn = (line: string, level?: 'info' | 'warn' | 'error') => void

export interface ConnectDeps {
  vault: VaultService
  prompts: PromptService
  knownHosts: KnownHostsService
  defaultKeepAliveSec: number
}

export interface ConnectOptions {
  log?: LogFn
  sessionId?: string
  /** Aborts the connection attempt (e.g. tab closed while connecting). */
  signal?: AbortSignal
  readyTimeoutMs?: number
}

/** An authenticated SSH connection, possibly reached through jump hosts. */
export class SshConnection {
  private closed = false
  private closeListeners: (() => void)[] = []

  constructor(
    readonly client: Client,
    readonly chain: Client[],
    readonly endpoint: Endpoint
  ) {
    client.on('close', () => this.handleClose())
    client.on('error', () => {})
  }

  get isClosed(): boolean {
    return this.closed
  }

  onClose(cb: () => void): void {
    if (this.closed) cb()
    else this.closeListeners.push(cb)
  }

  private handleClose(): void {
    if (this.closed) return
    this.closed = true
    for (const c of this.chain) if (c !== this.client) c.end()
    for (const l of this.closeListeners.splice(0)) l()
  }

  close(): void {
    this.client.end()
    for (const c of this.chain) c.end()
    this.handleClose()
  }

  exec(
    command: string,
    opts: { maxBytes?: number; timeoutMs?: number; stdin?: string; signal?: AbortSignal } = {}
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const max = opts.maxBytes ?? 1024 * 1024
    return new Promise((resolve, reject) => {
      this.client.exec(command, (err, stream) => {
        if (err) return reject(err)
        let stdout = ''
        let stderr = ''
        let code: number | null = null
        const stop = (reason: Error): void => {
          clearTimeout(timer)
          opts.signal?.removeEventListener('abort', onAbort)
          // Closing the channel alone can leave the remote process running.
          stream.signal('INT')
          stream.close()
          reject(reason)
        }
        const onAbort = (): void => stop(new Error('Command aborted'))
        const timer = setTimeout(() => stop(new Error('Command timed out')), opts.timeoutMs ?? 20_000)
        if (opts.signal?.aborted) return onAbort()
        opts.signal?.addEventListener('abort', onAbort, { once: true })
        stream.on('data', (d: Buffer) => {
          if (stdout.length < max) stdout += d.toString('utf8')
        })
        stream.stderr.on('data', (d: Buffer) => {
          if (stderr.length < max) stderr += d.toString('utf8')
        })
        stream.on('exit', (c: number | null) => {
          code = c
        })
        stream.on('close', () => {
          clearTimeout(timer)
          opts.signal?.removeEventListener('abort', onAbort)
          resolve({ code, stdout, stderr })
        })
        if (opts.stdin !== undefined) stream.end(opts.stdin)
      })
    })
  }

  shell(opts: { cols: number; rows: number; term?: string; env?: Record<string, string> }): Promise<ClientChannel> {
    return new Promise((resolve, reject) => {
      this.client.shell(
        { cols: opts.cols, rows: opts.rows, term: opts.term ?? 'xterm-256color', width: opts.cols * 8, height: opts.rows * 16 },
        { env: opts.env },
        (err, stream) => (err ? reject(err) : resolve(stream))
      )
    })
  }
}

function forwardOut(client: Client, host: string, port: number): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    client.forwardOut('127.0.0.1', 0, host, port, (err, stream) => (err ? reject(err) : resolve(stream)))
  })
}

function friendlyError(err: unknown, ep: Endpoint): Error {
  const e = err as NodeJS.ErrnoException & { level?: string }
  const msg = e?.message ?? String(err)
  const where = `${ep.address}:${ep.port}`
  if (e?.code === 'ECONNREFUSED') return new Error(`Connection refused by ${where}`)
  if (e?.code === 'ENOTFOUND' || e?.code === 'EAI_AGAIN') return new Error(`Cannot resolve host "${ep.address}"`)
  if (e?.code === 'ETIMEDOUT' || /Timed out while waiting for handshake/i.test(msg)) return new Error(`Connection to ${where} timed out`)
  if (e?.code === 'EHOSTUNREACH' || e?.code === 'ENETUNREACH') return new Error(`Host ${where} is unreachable`)
  if (e?.code === 'ECONNRESET') return new Error(`Connection to ${where} was reset`)
  if (/All configured authentication methods failed/i.test(msg)) return new Error('Authentication failed')
  return e instanceof Error ? e : new Error(msg)
}

/** Connects (through jump hosts / proxy when configured) and authenticates. */
export async function connectEndpoint(target: Endpoint, deps: ConnectDeps, opts: ConnectOptions = {}): Promise<SshConnection> {
  const log: LogFn = opts.log ?? (() => {})
  const hops: Endpoint[] = []
  const seen = new Set<string>()
  for (const id of target.jumpHostIds) {
    if (seen.has(id) || id === target.hostId) continue
    seen.add(id)
    hops.push(resolveHostById(deps.vault, id, { keepAliveSec: deps.defaultKeepAliveSec }))
  }
  hops.push(target)

  const chain: Client[] = []
  try {
    let prev: Client | undefined
    for (let i = 0; i < hops.length; i++) {
      const hop = hops[i]
      if (opts.signal?.aborted) throw new Error('Connection cancelled')
      let sock: Duplex | undefined
      if (prev) {
        log(`Opening tunnel to ${hop.address}:${hop.port} via ${hops[i - 1].label}…`)
        sock = await forwardOut(prev, hop.address, hop.port)
      } else if (hop.proxy) {
        log(`Connecting to ${hop.proxy.type.toUpperCase()} proxy ${hop.proxy.host}:${hop.proxy.port}…`)
        sock = await openProxySocket(hop.proxy, hop.address, hop.port)
      }
      log(`Connecting to ${hop.label} (${hop.address}:${hop.port})…`)
      const client = await connectHop(hop, sock, deps, opts, log)
      chain.push(client)
      prev = client
    }
    const conn = new SshConnection(chain[chain.length - 1], chain, target)
    return conn
  } catch (err) {
    for (const c of chain) c.end()
    throw err
  }
}

async function connectHop(
  ep: Endpoint,
  sock: Duplex | undefined,
  deps: ConnectDeps,
  opts: ConnectOptions,
  log: LogFn
): Promise<Client> {
  const { prompts, vault, knownHosts } = deps
  const sessionId = opts.sessionId

  let username = ep.username
  if (!username) {
    const r = await prompts.ask({ type: 'username', sessionId, hostLabel: ep.label })
    if (!r?.value) throw new Error('Connection cancelled')
    username = r.value.trim()
  }

  // Private key (may need a passphrase prompt)
  let parsedKey: ParsedKey | undefined
  let saveKeyPassphrase: string | undefined
  if (ep.key) {
    let passphrase = ep.key.passphrase
    for (let attempt = 0; attempt < 3 && !parsedKey; attempt++) {
      try {
        parsedKey = parsePrivateKey(ep.key.privateKey, passphrase)
      } catch (err) {
        if (!(err instanceof KeyParseError) || !err.needsPassphrase) {
          log(`Key "${ep.key.label}" could not be used: ${(err as Error).message}`, 'warn')
          break
        }
        const r = await prompts.ask({
          type: 'passphrase',
          sessionId,
          keyLabel: ep.key.label,
          message: attempt > 0 || passphrase ? 'Wrong passphrase, try again' : undefined,
          allowSave: true
        })
        if (!r) break
        passphrase = r.value
        if (r.save) saveKeyPassphrase = r.value
      }
    }
    if (parsedKey && saveKeyPassphrase !== undefined) {
      try {
        vault.patch(ep.key.id, { passphrase: saveKeyPassphrase })
      } catch {
        // key might be read-only / removed meanwhile
      }
    }
  }

  const agentPath = ep.useAgent ? systemAgentPath() : undefined
  let forwardAgent: string | VaultKeyAgent | undefined
  if (ep.agentForwarding) forwardAgent = agentPath ?? (parsedKey ? new VaultKeyAgent([parsedKey]) : undefined)

  const tried = new Set<string>()
  let password = ep.password
  let promptedPassword: string | undefined
  let savePassword = false
  let passwordPrompts = 0
  let kiPasswordUsed = false

  const askPassword = async (retry: boolean): Promise<string | null> => {
    passwordPrompts++
    const r = await prompts.ask({
      type: 'password',
      sessionId,
      hostLabel: ep.label,
      username,
      message: retry ? 'Authentication failed, try again' : undefined,
      allowSave: !!ep.hostId
    })
    if (!r) return null
    promptedPassword = r.value
    savePassword = r.save
    return r.value
  }

  const nextMethod = async (methodsLeft: AuthenticationType[] | null): Promise<AnyAuthMethod | false> => {
    const allowed = (t: AuthenticationType): boolean => !methodsLeft || methodsLeft.includes(t)
    if (!tried.has('none')) {
      tried.add('none')
      return { type: 'none', username }
    }
    if (parsedKey && !tried.has('publickey') && allowed('publickey')) {
      tried.add('publickey')
      log(`Authenticating with key "${ep.key!.label}"…`)
      return { type: 'publickey', username, key: parsedKey }
    }
    if (agentPath && !tried.has('agent') && allowed('publickey')) {
      tried.add('agent')
      log('Authenticating with SSH agent…')
      return { type: 'agent', username, agent: agentPath }
    }
    if (password && !tried.has('password') && allowed('password')) {
      tried.add('password')
      log('Authenticating with password…')
      return { type: 'password', username, password }
    }
    if (allowed('password') && passwordPrompts < 3) {
      const pw = await askPassword(passwordPrompts > 0 || tried.has('password'))
      if (pw === null) return false
      password = pw
      tried.add('password')
      log('Authenticating with password…')
      return { type: 'password', username, password: pw }
    }
    if (!tried.has('keyboard-interactive') && allowed('keyboard-interactive')) {
      tried.add('keyboard-interactive')
      log('Authenticating with keyboard-interactive…')
      return {
        type: 'keyboard-interactive',
        username,
        prompt: (name, instructions, _lang, list, finish) => {
          void (async () => {
            if (!list.length) return finish([])
            const single = list.length === 1 && !list[0].echo && /pass(word|code)?|口令|密码/i.test(list[0].prompt)
            if (single) {
              if (password && !kiPasswordUsed) {
                kiPasswordUsed = true
                return finish([password])
              }
              const pw = await askPassword(kiPasswordUsed)
              kiPasswordUsed = true
              if (pw !== null) password = pw
              return finish([pw ?? ''])
            }
            const r = await prompts.ask({
              type: 'keyboard-interactive',
              sessionId,
              hostLabel: ep.label,
              name,
              instructions,
              prompts: list.map((p) => ({ prompt: p.prompt, echo: !!p.echo }))
            })
            finish(r?.answers ?? list.map(() => ''))
          })()
        }
      }
    }
    return false
  }

  const client = new Client()
  knownHosts.lastRejection = null
  return new Promise<Client>((resolve, reject) => {
    let settled = false
    const onAbort = (): void => {
      if (settled) return
      settled = true
      client.end()
      reject(new Error('Connection cancelled'))
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    client.once('ready', () => {
      if (settled) return client.end()
      settled = true
      opts.signal?.removeEventListener('abort', onAbort)
      log(`Authenticated as ${username}`)
      if (savePassword && promptedPassword !== undefined && ep.hostId) {
        try {
          vault.patch(ep.hostId, { password: promptedPassword, ...(ep.username ? {} : { username }) })
        } catch {
          // host removed meanwhile
        }
      }
      resolve(client)
    })
    client.once('error', (err) => {
      if (settled) return
      settled = true
      opts.signal?.removeEventListener('abort', onAbort)
      if (knownHosts.lastRejection) reject(knownHosts.lastRejection)
      else reject(friendlyError(err, ep))
    })
    client.once('close', () => {
      if (settled) return
      settled = true
      reject(knownHosts.lastRejection ?? new Error(`Connection to ${ep.address}:${ep.port} closed`))
    })
    try {
      client.connect({
        host: ep.address,
        port: ep.port,
        sock: sock as any,
        username,
        readyTimeout: opts.readyTimeoutMs ?? 30_000,
        keepaliveInterval: ep.keepAliveSec > 0 ? ep.keepAliveSec * 1000 : 0,
        keepaliveCountMax: 3,
        agent: forwardAgent as any,
        agentForward: !!forwardAgent,
        hostVerifier: ((key: Buffer, verify: (ok: boolean) => void) => {
          knownHosts.verify(ep, key, sessionId).then(verify, () => verify(false))
        }) as any,
        authHandler: ((methodsLeft: AuthenticationType[] | null, _partial: boolean | null, next: (m: unknown) => void) => {
          nextMethod(methodsLeft).then(next, () => next(false))
        }) as any
      })
    } catch (err) {
      settled = true
      reject(friendlyError(err, ep))
    }
  })
}

export { HostKeyRejectedError }
