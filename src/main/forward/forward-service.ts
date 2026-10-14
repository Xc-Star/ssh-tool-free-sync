import net from 'node:net'
import type { Duplex } from 'node:stream'
import type { Client, ClientChannel, TcpConnectionDetails } from 'ssh2'
import type { Item } from '@shared/schemas'
import type { ForwardState } from '@shared/types'
import type { Emitter } from '../services/emitter'
import type { Lease, ConnectionPool } from '../ssh/pool'
import type { VaultService } from '../vault/vault-service'
import { handleSocksConnection } from './socks'

type TcpHandler = (info: TcpConnectionDetails, accept: () => ClientChannel, reject: () => void) => void

/** One dispatcher per ssh2 client so several remote-forward rules can share a connection. */
const remoteHandlers = new WeakMap<Client, Map<number, TcpHandler>>()

function registerRemoteHandler(client: Client, port: number, handler: TcpHandler): () => void {
  let map = remoteHandlers.get(client)
  if (!map) {
    const m = new Map<number, TcpHandler>()
    map = m
    remoteHandlers.set(client, m)
    client.on('tcp connection', (info, accept, reject) => {
      const h = m.get(info.destPort)
      if (h) h(info, accept, reject)
      else reject()
    })
  }
  map.set(port, handler)
  return () => map!.delete(port)
}

interface Active {
  state: ForwardState
  lease?: Lease
  server?: net.Server
  sockets: Set<Duplex>
  cleanup: (() => void)[]
}

function pipeBoth(a: Duplex, b: Duplex, track: Set<Duplex>): void {
  track.add(a)
  track.add(b)
  a.pipe(b).pipe(a)
  const destroy = (): void => {
    a.destroy()
    b.destroy()
    track.delete(a)
    track.delete(b)
  }
  a.on('error', destroy)
  b.on('error', destroy)
  a.on('close', destroy)
  b.on('close', destroy)
}

/** Runs port-forwarding rules (local, remote and dynamic/SOCKS) over pooled SSH connections. */
export class ForwardService {
  private active = new Map<string, Active>()

  constructor(
    private readonly vault: VaultService,
    private readonly pool: ConnectionPool,
    private readonly emitter: Emitter
  ) {}

  states(): ForwardState[] {
    return [...this.active.values()].map((a) => ({ ...a.state, connections: a.sockets.size / 2 }))
  }

  private publish(): void {
    this.emitter.emit('forward.states', this.states())
  }

  private setState(a: Active, status: ForwardState['status'], error?: string): void {
    a.state.status = status
    a.state.error = error
    this.publish()
  }

  async start(ruleId: string): Promise<void> {
    const rule = this.vault.get(ruleId, 'portForward')
    if (!rule) throw new Error('Rule not found')
    const cur = this.active.get(ruleId)
    if (cur && (cur.state.status === 'running' || cur.state.status === 'starting')) return
    const a: Active = { state: { ruleId, status: 'starting', connections: 0 }, sockets: new Set(), cleanup: [] }
    this.active.set(ruleId, a)
    this.publish()
    try {
      a.lease = await this.pool.acquire(rule.data.hostId)
      a.lease.conn.onClose(() => {
        if (this.active.get(ruleId) === a && a.state.status !== 'stopped') {
          this.teardown(a)
          this.setState(a, 'error', 'SSH connection closed')
        }
      })
      if (rule.data.type === 'remote') await this.startRemote(a, rule)
      else await this.startLocal(a, rule)
      if (this.active.get(ruleId) !== a) return this.teardown(a)
      this.setState(a, 'running')
    } catch (err) {
      this.teardown(a)
      this.setState(a, 'error', (err as Error).message)
      throw err
    }
  }

  private forwardOut(a: Active, host: string, port: number, srcHost = '127.0.0.1', srcPort = 0): Promise<ClientChannel> {
    return new Promise((resolve, reject) => {
      const client = a.lease?.conn.client
      if (!client) return reject(new Error('not connected'))
      client.forwardOut(srcHost, srcPort, host, port, (err, ch) => (err ? reject(err) : resolve(ch)))
    })
  }

  private startLocal(a: Active, rule: Item<'portForward'>): Promise<void> {
    const { bindAddress, bindPort, destHost, destPort, type } = rule.data
    if (type === 'local' && (!destHost || !destPort)) throw new Error('Destination host and port are required')
    const server = net.createServer((sock) => {
      sock.on('error', () => sock.destroy())
      if (type === 'dynamic') {
        handleSocksConnection(sock, (h, p) => this.forwardOut(a, h, p, sock.remoteAddress, sock.remotePort), (remote) => {
          a.sockets.add(sock)
          a.sockets.add(remote)
          remote.on('close', () => {
            a.sockets.delete(sock)
            a.sockets.delete(remote)
            this.publish()
          })
          this.publish()
        })
        return
      }
      this.forwardOut(a, destHost!, destPort!, sock.remoteAddress ?? '127.0.0.1', sock.remotePort ?? 0).then(
        (ch) => {
          pipeBoth(sock, ch, a.sockets)
          ch.on('close', () => this.publish())
          this.publish()
        },
        () => sock.destroy()
      )
    })
    a.server = server
    return new Promise((resolve, reject) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        reject(err.code === 'EADDRINUSE' ? new Error(`Port ${bindAddress}:${bindPort} is already in use`) : err)
      })
      server.listen(bindPort, bindAddress || '127.0.0.1', () => {
        server.on('error', (err) => this.setState(a, 'error', err.message))
        resolve()
      })
    })
  }

  private startRemote(a: Active, rule: Item<'portForward'>): Promise<void> {
    const { bindAddress, bindPort, destHost, destPort } = rule.data
    if (!destHost || !destPort) throw new Error('Destination host and port are required')
    const client = a.lease!.conn.client
    return new Promise((resolve, reject) => {
      client.forwardIn(bindAddress || '127.0.0.1', bindPort, (err, port) => {
        if (err) return reject(new Error(`Remote server refused to listen on ${bindAddress}:${bindPort}: ${err.message}`))
        const boundPort = port || bindPort
        const unregister = registerRemoteHandler(client, boundPort, (_info, accept) => {
          const ch = accept()
          const sock = net.connect(destPort, destHost)
          sock.on('error', () => ch.close())
          pipeBoth(ch, sock, a.sockets)
          sock.on('close', () => this.publish())
          this.publish()
        })
        a.cleanup.push(() => {
          unregister()
          client.unforwardIn(bindAddress || '127.0.0.1', boundPort, () => {})
        })
        resolve()
      })
    })
  }

  private teardown(a: Active): void {
    for (const c of a.cleanup.splice(0)) {
      try {
        c()
      } catch {
        // ignore
      }
    }
    a.server?.close()
    a.server = undefined
    for (const s of a.sockets) s.destroy()
    a.sockets.clear()
    a.lease?.release()
    a.lease = undefined
  }

  stop(ruleId: string): void {
    const a = this.active.get(ruleId)
    if (!a) return
    a.state.status = 'stopped'
    this.teardown(a)
    this.active.delete(ruleId)
    this.publish()
  }

  stopAll(): void {
    for (const id of [...this.active.keys()]) this.stop(id)
  }

  /** Starts rules flagged autoStart (after the vault is unlocked). */
  async autoStart(): Promise<void> {
    for (const rule of this.vault.list('portForward')) {
      if (rule.data.autoStart) await this.start(rule.id).catch(() => {})
    }
  }

  /** Stops rules whose definition was deleted. */
  pruneDeleted(): void {
    for (const id of [...this.active.keys()]) if (!this.vault.get(id, 'portForward')) this.stop(id)
  }
}
