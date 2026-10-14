import type net from 'node:net'
import type { Duplex } from 'node:stream'

export type SocksConnect = (host: string, port: number) => Promise<Duplex>

const REP_SUCCEEDED = 0x00
const REP_GENERAL_FAILURE = 0x01
const REP_CONNECTION_REFUSED = 0x05
const REP_COMMAND_NOT_SUPPORTED = 0x07
const REP_ADDRESS_NOT_SUPPORTED = 0x08

/**
 * Serves one SOCKS4/4a/5 client connection (CONNECT only, no authentication) and tunnels it
 * through `connect`.
 */
export function handleSocksConnection(sock: net.Socket, connect: SocksConnect, onTunnel?: (s: Duplex) => void): void {
  let buf = Buffer.alloc(0)
  let stage: 'greeting' | 'request' | 'done' = 'greeting'
  let version = 0

  const fail = (reply: Buffer): void => {
    stage = 'done'
    sock.end(reply)
  }

  const tunnel = (host: string, port: number, reply: (ok: boolean, code?: number) => Buffer): void => {
    stage = 'done'
    sock.pause()
    sock.off('data', onData)
    connect(host, port).then(
      (remote) => {
        sock.write(reply(true))
        const rest = buf
        buf = Buffer.alloc(0)
        if (rest.length) remote.write(rest)
        sock.pipe(remote).pipe(sock)
        const destroyBoth = (): void => {
          sock.destroy()
          remote.destroy()
        }
        sock.on('error', destroyBoth)
        remote.on('error', destroyBoth)
        sock.on('close', () => remote.destroy())
        remote.on('close', () => sock.destroy())
        sock.resume()
        onTunnel?.(remote)
      },
      () => {
        sock.end(reply(false, REP_CONNECTION_REFUSED))
      }
    )
  }

  const onData = (chunk: Buffer): void => {
    buf = Buffer.concat([buf, chunk])
    if (buf.length > 4096) return fail(Buffer.alloc(0))
    if (stage === 'greeting') {
      if (buf.length < 1) return
      version = buf[0]
      if (version === 4) {
        // SOCKS4 / 4a: VER CMD PORT(2) IP(4) USERID\0 [HOST\0]
        if (buf.length < 9) return
        const userEnd = buf.indexOf(0, 8)
        if (userEnd < 0) return
        const cmd = buf[1]
        const port = buf.readUInt16BE(2)
        const ip = buf.subarray(4, 8)
        let host = `${ip[0]}.${ip[1]}.${ip[2]}.${ip[3]}`
        let consumed = userEnd + 1
        if (ip[0] === 0 && ip[1] === 0 && ip[2] === 0 && ip[3] !== 0) {
          const hostEnd = buf.indexOf(0, consumed)
          if (hostEnd < 0) return
          host = buf.subarray(consumed, hostEnd).toString('utf8')
          consumed = hostEnd + 1
        }
        buf = buf.subarray(consumed)
        const reply4 = (ok: boolean): Buffer => Buffer.from([0x00, ok ? 0x5a : 0x5b, 0, 0, 0, 0, 0, 0])
        if (cmd !== 1) return fail(reply4(false))
        return tunnel(host, port, reply4)
      }
      if (version !== 5) return fail(Buffer.alloc(0))
      if (buf.length < 2) return
      const n = buf[1]
      if (buf.length < 2 + n) return
      const methods = buf.subarray(2, 2 + n)
      buf = buf.subarray(2 + n)
      if (!methods.includes(0x00)) return fail(Buffer.from([0x05, 0xff]))
      sock.write(Buffer.from([0x05, 0x00]))
      stage = 'request'
    }
    if (stage === 'request') {
      if (buf.length < 4) return
      const [ver, cmd, , atyp] = buf
      const reply5 = (ok: boolean, code = REP_GENERAL_FAILURE): Buffer =>
        Buffer.from([0x05, ok ? REP_SUCCEEDED : code, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
      if (ver !== 5) return fail(reply5(false))
      let host: string
      let offset: number
      if (atyp === 0x01) {
        if (buf.length < 10) return
        host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`
        offset = 8
      } else if (atyp === 0x03) {
        if (buf.length < 5) return
        const len = buf[4]
        if (buf.length < 5 + len + 2) return
        host = buf.subarray(5, 5 + len).toString('utf8')
        offset = 5 + len
      } else if (atyp === 0x04) {
        if (buf.length < 22) return
        const parts: string[] = []
        for (let i = 0; i < 16; i += 2) parts.push(buf.readUInt16BE(4 + i).toString(16))
        host = parts.join(':')
        offset = 20
      } else {
        return fail(reply5(false, REP_ADDRESS_NOT_SUPPORTED))
      }
      const port = buf.readUInt16BE(offset)
      buf = buf.subarray(offset + 2)
      if (cmd !== 0x01) return fail(reply5(false, REP_COMMAND_NOT_SUPPORTED))
      tunnel(host, port, reply5)
    }
  }

  sock.on('data', onData)
  sock.on('error', () => sock.destroy())
}
