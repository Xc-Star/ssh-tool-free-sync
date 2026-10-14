import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseQuickConnect, posixJoin, posixDirname, parentPath, splitPath, modeToPermissions } from '../../src/shared/util'
import { parseSshConfig, applySshConfig } from '../../src/main/importers/ssh-config'
import { exportBackup, exportHostsCsv, importBackup, importHostsCsv, importKnownHosts, parseCsv } from '../../src/main/importers/data-io'
import { parseOsHint } from '../../src/main/ssh/os-detect'
import { TelnetProtocol, TelnetSession } from '../../src/main/sessions/telnet-session'
import { LocalSession, detectShells } from '../../src/main/sessions/local-session'
import { scriptToKeystrokes } from '../../src/main/sessions/ssh-session'
import { MemoryEmitter } from '../../src/main/services/emitter'
import { HistoryService } from '../../src/main/services/history'
import { generateKey, inspectKey, parsePrivateKey, KeyParseError } from '../../src/main/ssh/keys'
import { TEST_KDF } from '../../src/main/vault/crypto'
import { makeDevice } from '../helpers/device'

describe('quick connect parser', () => {
  it.each([
    ['root@10.0.0.1', { address: '10.0.0.1', username: 'root', port: undefined }],
    ['ssh -p 2222 deploy@web.example.com', { address: 'web.example.com', username: 'deploy', port: 2222 }],
    ['ssh deploy@web.example.com -p2200', { address: 'web.example.com', username: 'deploy', port: 2200 }],
    ['admin@host.lan:2022', { address: 'host.lan', username: 'admin', port: 2022 }],
    ['user@[::1]:22', { address: '::1', username: 'user', port: 22 }],
    ['example.com', { address: 'example.com', username: undefined, port: undefined }],
    ['ssh -l bob box', { address: 'box', username: 'bob', port: undefined }]
  ])('parses %s', (input, expected) => {
    expect(parseQuickConnect(input)).toEqual(expected)
  })
  it.each(['', 'ssh', 'a b', 'user@', 'host:99999', '-x host'])('rejects %s', (input) => {
    expect(parseQuickConnect(input)).toBeNull()
  })
})

describe('path helpers', () => {
  it('handles posix and windows paths', () => {
    expect(posixJoin('/home/a', '../b', 'c')).toBe('/home/b/c')
    expect(posixDirname('/a/b')).toBe('/a')
    expect(posixDirname('/a')).toBe('/')
    expect(parentPath('C:\\Users\\me', 'win32')).toBe('C:\\Users')
    expect(parentPath('C:\\Users', 'win32')).toBe('C:\\')
    expect(parentPath('C:\\', 'win32')).toBe('')
    expect(splitPath('/var/log', 'posix').map((c) => c.path)).toEqual(['/', '/var', '/var/log'])
    expect(splitPath('D:\\work\\x', 'win32').map((c) => c.path)).toEqual(['D:\\', 'D:\\work', 'D:\\work\\x'])
    expect(modeToPermissions(0o755, 'dir')).toBe('drwxr-xr-x')
    expect(modeToPermissions(0o640, 'file')).toBe('-rw-r-----')
  })
})

describe('ssh config import', () => {
  const text = `
Host *
  ServerAliveInterval 30
  User defaultuser

Host bastion
  HostName bastion.example.com
  User ops

Host web web-alias
  HostName 10.0.0.5
  Port 2222
  ProxyJump bastion
  LocalForward 8080 localhost:80
  DynamicForward 1080

Host *.internal
  User internal
`
  it('parses concrete hosts with wildcard defaults', () => {
    const entries = parseSshConfig(text)
    expect(entries.map((e) => e.alias)).toEqual(['bastion', 'web', 'web-alias'])
    const web = entries.find((e) => e.alias === 'web')!
    expect(web).toMatchObject({ hostName: '10.0.0.5', port: 2222, user: 'defaultuser', proxyJump: 'bastion' })
    expect(web.forwards).toEqual([
      { type: 'local', bindAddress: '127.0.0.1', bindPort: 8080, destHost: 'localhost', destPort: 80 },
      { type: 'dynamic', bindAddress: '127.0.0.1', bindPort: 1080 }
    ])
  })

  it('imports hosts, jump chains and forwards', () => {
    const d = makeDevice()
    const entries = parseSshConfig(text, d.vault).filter((e) => e.alias !== 'web-alias')
    const res = applySshConfig(entries, d.vault, 'Imported')
    expect(res).toMatchObject({ hosts: 2, groups: 1, forwards: 2 })
    const web = d.vault.list('host').find((h) => h.data.label === 'web')!
    const bastion = d.vault.list('host').find((h) => h.data.label === 'bastion')!
    expect(web.data.jumpHostIds).toEqual([bastion.id])
    expect(d.vault.list('portForward')).toHaveLength(2)
    // re-parsing marks existing entries
    expect(parseSshConfig(text, d.vault).find((e) => e.alias === 'web')?.exists).toBe(true)
  })
})

describe('csv / known_hosts / backup', () => {
  it('parses RFC 4180 csv', () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"']
    ])
  })

  it('imports and exports hosts as csv', () => {
    const d = makeDevice()
    const res = importHostsCsv('label,address,port,username,password,group,tags\nweb,10.0.0.1,2222,root,pw,Prod/Web,a;b\n,10.0.0.2,,,,,\n', d.vault)
    expect(res).toMatchObject({ hosts: 2, groups: 2 })
    const web = d.vault.list('host').find((h) => h.data.label === 'web')!
    expect(web.data).toMatchObject({ port: 2222, username: 'root', password: 'pw' })
    expect(web.data.tagIds).toHaveLength(2)
    const csv = exportHostsCsv(d.vault)
    expect(csv).toContain('web,10.0.0.1,2222,root,Prod/Web,a;b')
    expect(csv).not.toContain('pw')
  })

  it('imports known_hosts lines', () => {
    const d = makeDevice()
    const key = inspectKey(generateKey({ type: 'ed25519' }).privateKey)
    const blob = key.publicKey.split(' ')[1]
    const res = importKnownHosts(`github.com,140.82.112.3 ssh-ed25519 ${blob}\n[myhost]:2222 ssh-ed25519 ${blob}\n|1|hashed= ssh-ed25519 ${blob}\n# comment\n`, d.vault)
    expect(res.knownHosts).toBe(3)
    expect(res.skipped).toBe(1)
    expect(d.vault.list('knownHost').find((k) => k.data.host === 'myhost')?.data.port).toBe(2222)
  })

  it('round-trips an encrypted backup', async () => {
    const a = makeDevice()
    a.vault.upsert('host', { address: 'h1', password: 'secret' })
    a.vault.upsert('snippet', { label: 's', script: 'ls' })
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sshtool-bk-')), 'b.json')
    expect(await exportBackup(a.vault, file, 'backup-pass', TEST_KDF)).toBe(2)
    expect(fs.readFileSync(file, 'utf8')).not.toContain('secret')
    const b = makeDevice()
    await expect(importBackup(b.vault, file, 'wrong-pass')).rejects.toThrow(/Wrong backup password/)
    const res = await importBackup(b.vault, file, 'backup-pass')
    expect(res.hosts).toBe(1)
    expect(b.vault.list('host')[0].data.password).toBe('secret')
  })
})

describe('keys', () => {
  it('generates, parses and reports encrypted keys', () => {
    for (const type of ['ed25519', 'ecdsa', 'rsa'] as const) {
      const k = generateKey({ type, bits: type === 'rsa' ? 2048 : undefined })
      const info = inspectKey(k.privateKey)
      expect(info.publicKey.split(' ')[1]).toBe(k.publicKey.split(' ')[1])
      expect(info.fingerprint).toMatch(/^SHA256:/)
    }
    const enc = generateKey({ type: 'ed25519', passphrase: 'pw' })
    expect(() => parsePrivateKey(enc.privateKey)).toThrow(KeyParseError)
    expect(inspectKey(enc.privateKey, 'pw').encrypted).toBe(true)
    expect(() => parsePrivateKey(enc.privateKey, 'nope')).toThrow(KeyParseError)
  })

  it('never produces a malformed Ed25519 key (ssh2 drops a leading zero byte in 1 of 256 keys)', () => {
    for (let i = 0; i < 1500; i++) {
      const k = generateKey({ type: 'ed25519' })
      expect(Buffer.from(k.publicKey.split(' ')[1], 'base64')).toHaveLength(51)
      expect(() => parsePrivateKey(k.privateKey)).not.toThrow()
    }
  })
})

describe('misc', () => {
  it('detects the OS from os-release', () => {
    expect(parseOsHint('ID=ubuntu\nID_LIKE=debian\n---\nLinux')).toBe('ubuntu')
    expect(parseOsHint('ID="rocky"\n')).toBe('rocky')
    expect(parseOsHint('ID=opensuse-leap')).toBe('opensuse')
    expect(parseOsHint('ID=weird\nID_LIKE="rhel fedora"')).toBe('rhel')
    expect(parseOsHint('---\nDarwin')).toBe('macos')
    expect(parseOsHint('')).toBe('unknown')
  })

  it('turns scripts into keystrokes', () => {
    expect(scriptToKeystrokes('a\nb\n')).toBe('a\rb\r')
    expect(scriptToKeystrokes('')).toBe('')
  })
})

describe('telnet', () => {
  it('negotiates options and passes data through', () => {
    const sent: Buffer[] = []
    const p = new TelnetProtocol((b) => sent.push(b), 100, 40)
    const IAC = 255
    const out = p.receive(Buffer.from([0x41, IAC, 253, 31, IAC, 251, 1, IAC, 250, 24, 1, IAC, 240, IAC, IAC, 0x42]))
    expect([...out]).toEqual([0x41, 255, 0x42])
    const all = Buffer.concat(sent)
    expect(all.includes(Buffer.from([IAC, 251, 31]))).toBe(true) // WILL NAWS
    expect(all.includes(Buffer.from([IAC, 250, 31, 0, 100, 0, 40, IAC, 240]))).toBe(true) // window size
    expect(all.includes(Buffer.from([IAC, 253, 1]))).toBe(true) // DO ECHO
    expect(all.includes(Buffer.from('XTERM-256COLOR'))).toBe(true) // TTYPE IS
    expect([...TelnetProtocol.encodeInput(Buffer.from([0x61, 255, 13]))]).toEqual([0x61, 255, 255, 13, 10])
  })

  it('connects to a telnet server', async () => {
    const server = net.createServer((s) => {
      s.write(Buffer.from([255, 251, 1]))
      s.write('login: ')
      s.on('data', (d) => {
        if (d.includes(Buffer.from('admin'))) s.write('\r\nwelcome admin\r\n')
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as net.AddressInfo).port
    const d = makeDevice()
    const emitter = new MemoryEmitter()
    const history = new HistoryService(d.db, d.keystore, emitter)
    const s = new TelnetSession('t1', { inline: { address: '127.0.0.1', port }, cols: 80, rows: 24 }, d.vault, history, emitter)
    await s.start()
    expect(s.info.status).toBe('connected')
    s.write('admin\r')
    const start = Date.now()
    while (!(emitter.data.get('t1') ?? '').includes('welcome admin') && Date.now() - start < 5000) await new Promise((r) => setTimeout(r, 20))
    expect(emitter.data.get('t1')).toContain('login: ')
    expect(emitter.data.get('t1')).toContain('welcome admin')
    s.dispose()
    server.close()
  })
})

describe('local terminal', () => {
  it('spawns the default shell with node-pty', async () => {
    expect(detectShells().length).toBeGreaterThan(0)
    const emitter = new MemoryEmitter()
    const s = new LocalSession('l1', { cols: 80, rows: 24 }, undefined, emitter)
    await s.start()
    expect(s.info.status).toBe('connected')
    s.write('echo sshtool-pty-ok\r')
    const start = Date.now()
    while (!(emitter.data.get('l1') ?? '').includes('sshtool-pty-ok\r\n') && Date.now() - start < 15000) await new Promise((r) => setTimeout(r, 50))
    expect(emitter.data.get('l1')).toContain('sshtool-pty-ok')
    s.dispose()
  }, 30_000)
})
