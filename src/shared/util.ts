import type { QuickHost } from './types'

/** RFC 9562 UUIDv7 (time ordered). Works in both Node and the browser. */
export function uuidv7(): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  const ts = Date.now()
  bytes[0] = Math.floor(ts / 2 ** 40) & 0xff
  bytes[1] = Math.floor(ts / 2 ** 32) & 0xff
  bytes[2] = Math.floor(ts / 2 ** 24) & 0xff
  bytes[3] = Math.floor(ts / 2 ** 16) & 0xff
  bytes[4] = Math.floor(ts / 2 ** 8) & 0xff
  bytes[5] = ts & 0xff
  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function formatBytes(n: number, digits = 1): string {
  if (!Number.isFinite(n) || n < 0) return '-'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB', 'PB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 ? 0 : digits)} ${units[i]}`
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m ${sec}s`
  return `${sec}s`
}

// ---------------------------------------------------------------- posix paths (remote)

export function posixJoin(...parts: string[]): string {
  const joined = parts.filter((p) => p !== '').join('/')
  return posixNormalize(joined)
}

export function posixNormalize(p: string): string {
  if (!p) return '.'
  const abs = p.startsWith('/')
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop()
      else if (!abs) out.push('..')
      continue
    }
    out.push(seg)
  }
  const s = out.join('/')
  return abs ? `/${s}` : s || '.'
}

export function posixDirname(p: string): string {
  const n = posixNormalize(p)
  if (n === '/') return '/'
  const i = n.lastIndexOf('/')
  if (i < 0) return '.'
  if (i === 0) return '/'
  return n.slice(0, i)
}

export function posixBasename(p: string): string {
  const n = posixNormalize(p)
  if (n === '/') return '/'
  return n.slice(n.lastIndexOf('/') + 1)
}

/** Parent directory for either flavor; returns '' for the Windows virtual "drives" root. */
export function parentPath(p: string, flavor: 'posix' | 'win32'): string {
  if (flavor === 'posix') return posixDirname(p)
  const s = p.replace(/\//g, '\\').replace(/\\+$/, '')
  if (/^[a-zA-Z]:$/.test(s)) return ''
  const i = s.lastIndexOf('\\')
  if (i < 0) return ''
  const parent = s.slice(0, i)
  return /^[a-zA-Z]:$/.test(parent) ? `${parent}\\` : parent
}

export function joinPath(dir: string, name: string, flavor: 'posix' | 'win32'): string {
  if (flavor === 'posix') return posixJoin(dir, name)
  if (!dir) return name.endsWith('\\') ? name : `${name}\\`
  return dir.endsWith('\\') ? `${dir}${name}` : `${dir}\\${name}`
}

export function splitPath(p: string, flavor: 'posix' | 'win32'): { label: string; path: string }[] {
  if (flavor === 'posix') {
    const parts = posixNormalize(p).split('/').filter(Boolean)
    const crumbs = [{ label: '/', path: '/' }]
    let acc = ''
    for (const part of parts) {
      acc += `/${part}`
      crumbs.push({ label: part, path: acc })
    }
    return crumbs
  }
  const s = p.replace(/\//g, '\\')
  const parts = s.split('\\').filter(Boolean)
  const crumbs: { label: string; path: string }[] = []
  let acc = ''
  for (const part of parts) {
    acc = acc ? `${acc}${acc.endsWith('\\') ? '' : '\\'}${part}` : `${part}\\`
    crumbs.push({ label: part, path: acc })
  }
  return crumbs
}

// ---------------------------------------------------------------- quick connect

/**
 * Parses quick-connect input such as `user@host`, `user@host:2222`, `ssh -p 2222 user@host`,
 * `ssh user@[::1] -p 22` or `host`. Returns null when the input is not a valid target.
 */
export function parseQuickConnect(input: string): QuickHost | null {
  const tokens = input.trim().split(/\s+/).filter(Boolean)
  if (!tokens.length) return null
  if (tokens[0] === 'ssh') tokens.shift()
  let port: number | undefined
  let user: string | undefined
  let target: string | undefined
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === '-p') {
      port = Number(tokens[++i])
      continue
    }
    if (/^-p\d+$/.test(t)) {
      port = Number(t.slice(2))
      continue
    }
    if (t === '-l') {
      user = tokens[++i]
      continue
    }
    if (t.startsWith('-')) return null
    if (target) return null
    target = t
  }
  if (!target) return null
  const at = target.lastIndexOf('@')
  if (at >= 0) {
    user = target.slice(0, at) || user
    target = target.slice(at + 1)
  }
  let host = target
  const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(target)
  if (bracket) {
    host = bracket[1]
    if (bracket[2]) port = Number(bracket[2])
  } else if ((target.match(/:/g) || []).length === 1) {
    const [h, p] = target.split(':')
    host = h
    if (p) port = Number(p)
  }
  if (!host || !/^[\w.\-:%]+$/.test(host)) return null
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) return null
  if (user !== undefined && !/^[^\s@]+$/.test(user)) return null
  return { address: host, port, username: user }
}

/** Converts a unix mode to an `ls -l` style permission string. */
export function modeToPermissions(mode: number, type: 'file' | 'dir' | 'symlink' | 'other'): string {
  const t = type === 'dir' ? 'd' : type === 'symlink' ? 'l' : '-'
  const bits = ['r', 'w', 'x']
  let s = ''
  for (let i = 8; i >= 0; i--) s += mode & (1 << i) ? bits[(8 - i) % 3] : '-'
  return t + s
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}
