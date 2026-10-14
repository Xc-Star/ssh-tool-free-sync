import fs from 'node:fs'
import { AgentProtocol, BaseAgent, type ParsedKey } from 'ssh2'

const WINDOWS_OPENSSH_PIPE = '\\\\.\\pipe\\openssh-ssh-agent'

/** Locates the system SSH agent (OpenSSH agent / Pageant on Windows, SSH_AUTH_SOCK elsewhere). */
export function systemAgentPath(): string | undefined {
  if (process.env.SSH_AUTH_SOCK) return process.env.SSH_AUTH_SOCK
  if (process.platform === 'win32') {
    try {
      if (fs.existsSync(WINDOWS_OPENSSH_PIPE)) return WINDOWS_OPENSSH_PIPE
    } catch {
      // ignore
    }
    return 'pageant'
  }
  return undefined
}

/**
 * In-memory agent exposing vault keys. Used for agent forwarding when the system agent is not
 * used, so keys stored in the app can be used from the remote host.
 */
export class VaultKeyAgent extends BaseAgent<ParsedKey> {
  constructor(private readonly keys: ParsedKey[]) {
    super()
  }

  getIdentities(cb: (err: Error | undefined, keys?: ParsedKey[]) => void): void {
    cb(undefined, this.keys)
  }

  sign(pubKey: ParsedKey, data: Buffer, options: any, cb?: (err: Error | undefined, signature?: Buffer) => void): void {
    const done = typeof options === 'function' ? options : cb
    const opts = typeof options === 'function' ? {} : options ?? {}
    const key = this.keys.find((k) => k.equals(pubKey))
    if (!key) {
      done?.(new Error('key not found'))
      return
    }
    try {
      done?.(undefined, key.sign(data, opts.hash))
    } catch (err) {
      done?.(err as Error)
    }
  }

  getStream(cb: (err: Error | undefined, stream?: any) => void): void {
    const proto = new AgentProtocol(false)
    proto.on('identities', (req: any) => proto.getIdentitiesReply(req, this.keys))
    proto.on('sign', (req: any, pubKey: ParsedKey, data: Buffer, opts: any) => {
      const key = this.keys.find((k) => k.equals(pubKey))
      if (!key) return proto.failureReply(req)
      try {
        proto.signReply(req, key.sign(data, opts?.hash))
      } catch {
        proto.failureReply(req)
      }
    })
    cb(undefined, proto)
  }
}
