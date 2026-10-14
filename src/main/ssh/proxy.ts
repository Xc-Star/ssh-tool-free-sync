import net from 'node:net'
import { SocksClient } from 'socks'
import type { ProxyConfig } from '@shared/schemas'

/** Opens a TCP tunnel to destHost:destPort through a SOCKS4/5 or HTTP CONNECT proxy. */
export async function openProxySocket(
  proxy: ProxyConfig,
  destHost: string,
  destPort: number,
  timeoutMs = 20_000
): Promise<net.Socket> {
  if (proxy.type === 'socks5' || proxy.type === 'socks4') {
    const { socket } = await SocksClient.createConnection({
      proxy: {
        host: proxy.host,
        port: proxy.port,
        type: proxy.type === 'socks5' ? 5 : 4,
        userId: proxy.username || undefined,
        password: proxy.password || undefined
      },
      command: 'connect',
      destination: { host: destHost, port: destPort },
      timeout: timeoutMs
    })
    return socket
  }
  return httpConnect(proxy, destHost, destPort, timeoutMs)
}

function httpConnect(proxy: ProxyConfig, destHost: string, destPort: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxy.port, proxy.host)
    const timer = setTimeout(() => fail(new Error('HTTP proxy connection timed out')), timeoutMs)
    let buf = Buffer.alloc(0)
    const fail = (err: Error): void => {
      clearTimeout(timer)
      socket.destroy()
      reject(err)
    }
    socket.once('error', fail)
    socket.once('connect', () => {
      const target = destHost.includes(':') ? `[${destHost}]:${destPort}` : `${destHost}:${destPort}`
      let req = `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n`
      if (proxy.username) {
        const cred = Buffer.from(`${proxy.username}:${proxy.password ?? ''}`).toString('base64')
        req += `Proxy-Authorization: Basic ${cred}\r\n`
      }
      socket.write(`${req}\r\n`)
    })
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk])
      const end = buf.indexOf('\r\n\r\n')
      if (end < 0) {
        if (buf.length > 16384) fail(new Error('Invalid HTTP proxy response'))
        return
      }
      socket.off('data', onData)
      const head = buf.subarray(0, end).toString('latin1')
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(head)
      if (!status || status[1] !== '200') {
        fail(new Error(`HTTP proxy refused the tunnel: ${head.split('\r\n')[0]}`))
        return
      }
      clearTimeout(timer)
      socket.off('error', fail)
      const rest = buf.subarray(end + 4)
      if (rest.length) socket.unshift(rest)
      resolve(socket)
    }
    socket.on('data', onData)
  })
}
