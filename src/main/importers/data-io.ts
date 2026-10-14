import fs from 'node:fs'
import { randomBytes } from 'node:crypto'
import { ITEM_KINDS, type Item, type ItemKind } from '@shared/schemas'
import type { ImportResult } from '@shared/types'
import { decryptJson, DecryptError, deriveKey, DEFAULT_KDF, encryptJson, type KdfParams } from '../vault/crypto'
import type { VaultService } from '../vault/vault-service'
import { parsePublicKeyLine, fingerprintOf } from '../ssh/keys'

// ------------------------------------------------------------------ CSV

/** RFC 4180 CSV parser (quotes, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  const src = text.replace(/^\uFEFF/, '')
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
      } else field += c
    } else if (c === '"') inQuotes = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += c
  }
  if (field || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''))
}

function csvField(v: unknown): string {
  const s = v === undefined || v === null ? '' : String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function ensureGroupPath(vault: VaultService, pathStr: string, result: ImportResult): string | undefined {
  let parentId: string | undefined
  for (const name of pathStr.split('/').map((s) => s.trim()).filter(Boolean)) {
    const found = vault.list('group').find((g) => g.data.name === name && (g.data.parentId ?? undefined) === parentId)
    if (found) parentId = found.id
    else {
      parentId = vault.upsert('group', { name, parentId }).id
      result.groups++
    }
  }
  return parentId
}

/** Imports hosts from CSV with a header row: label,address,port,username,password,group,tags. */
export function importHostsCsv(text: string, vault: VaultService): ImportResult {
  const result: ImportResult = { hosts: 0, groups: 0, keys: 0, forwards: 0, knownHosts: 0, other: 0, skipped: 0, errors: [] }
  const rows = parseCsv(text)
  if (!rows.length) return result
  const header = rows[0].map((h) => h.trim().toLowerCase())
  const col = (names: string[]): number => header.findIndex((h) => names.includes(h))
  const idx = {
    label: col(['label', 'name', 'alias']),
    address: col(['address', 'hostname', 'host', 'ip']),
    port: col(['port']),
    username: col(['username', 'user', 'login']),
    password: col(['password']),
    group: col(['group', 'folder']),
    tags: col(['tags', 'tag'])
  }
  if (idx.address < 0) {
    result.errors.push('CSV must contain an "address" (or "hostname") column')
    return result
  }
  const tagByName = new Map(vault.list('tag').map((t) => [t.data.name.toLowerCase(), t.id]))
  for (const r of rows.slice(1)) {
    const get = (i: number): string => (i >= 0 ? (r[i] ?? '').trim() : '')
    const address = get(idx.address)
    if (!address) {
      result.skipped++
      continue
    }
    const port = Number(get(idx.port))
    const tagIds: string[] = []
    for (const name of get(idx.tags).split(/[;|]/).map((s) => s.trim()).filter(Boolean)) {
      let id = tagByName.get(name.toLowerCase())
      if (!id) {
        id = vault.upsert('tag', { name }).id
        tagByName.set(name.toLowerCase(), id)
        result.other++
      }
      tagIds.push(id)
    }
    try {
      vault.upsert('host', {
        label: get(idx.label) || address,
        address,
        port: Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined,
        username: get(idx.username) || undefined,
        password: get(idx.password) || undefined,
        groupId: get(idx.group) ? ensureGroupPath(vault, get(idx.group), result) : undefined,
        tagIds
      })
      result.hosts++
    } catch (err) {
      result.errors.push(`${address}: ${(err as Error).message}`)
    }
  }
  return result
}

/** Exports hosts as CSV (no secrets). */
export function exportHostsCsv(vault: VaultService): string {
  const groups = new Map(vault.list('group').map((g) => [g.id, g]))
  const tags = new Map(vault.list('tag').map((t) => [t.id, t.data.name]))
  const groupPath = (id?: string): string => {
    const names: string[] = []
    const seen = new Set<string>()
    while (id && groups.has(id) && !seen.has(id)) {
      seen.add(id)
      const g = groups.get(id)!
      names.unshift(g.data.name)
      id = g.data.parentId
    }
    return names.join('/')
  }
  const lines = ['label,address,port,username,group,tags']
  for (const h of vault.list('host')) {
    const d = h.data
    lines.push(
      [d.label, d.address, d.port ?? '', d.username ?? '', groupPath(d.groupId), d.tagIds.map((t) => tags.get(t) ?? '').filter(Boolean).join(';')]
        .map(csvField)
        .join(',')
    )
  }
  return `${lines.join('\r\n')}\r\n`
}

// ------------------------------------------------------------------ known_hosts

export function importKnownHosts(text: string, vault: VaultService): ImportResult {
  const result: ImportResult = { hosts: 0, groups: 0, keys: 0, forwards: 0, knownHosts: 0, other: 0, skipped: 0, errors: [] }
  const existing = new Set(vault.list('knownHost').map((k) => `${k.data.host}|${k.data.port}|${k.data.keyType}`))
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('@')) {
      result.skipped++
      continue
    }
    const sp = line.indexOf(' ')
    if (sp < 0) continue
    const hostsField = line.slice(0, sp)
    const key = parsePublicKeyLine(line.slice(sp + 1))
    if (!key) {
      result.skipped++
      continue
    }
    if (hostsField.startsWith('|')) {
      result.skipped++
      continue
    }
    for (const h of hostsField.split(',')) {
      const m = /^\[([^\]]+)\]:(\d+)$/.exec(h)
      const host = m ? m[1] : h
      const port = m ? Number(m[2]) : 22
      const sig = `${host}|${port}|${key.type}`
      if (existing.has(sig) || host.startsWith('!') || /[*?]/.test(host)) {
        result.skipped++
        continue
      }
      vault.upsert('knownHost', { host, port, keyType: key.type, fingerprint: fingerprintOf(key.blob), publicKey: key.blob.toString('base64') })
      existing.add(sig)
      result.knownHosts++
    }
  }
  return result
}

// ------------------------------------------------------------------ encrypted backup

interface BackupFile {
  format: 'sshtool-backup'
  version: 1
  createdAt: number
  kdf: KdfParams
  salt: string
  data: string
}

const BACKUP_AAD = 'sshtool:backup:v1'

export async function exportBackup(vault: VaultService, file: string, password: string, kdf: KdfParams = DEFAULT_KDF): Promise<number> {
  if (password.length < 8) throw new Error('The backup password must be at least 8 characters')
  const items = vault.list()
  const salt = randomBytes(16)
  const key = await deriveKey(password, salt, kdf)
  const payload: BackupFile = {
    format: 'sshtool-backup',
    version: 1,
    createdAt: Date.now(),
    kdf,
    salt: salt.toString('base64'),
    data: encryptJson(key, { items }, BACKUP_AAD).toString('base64')
  }
  await fs.promises.writeFile(file, JSON.stringify(payload, null, 2), { mode: 0o600 })
  return items.length
}

export async function importBackup(vault: VaultService, file: string, password: string): Promise<ImportResult> {
  const result: ImportResult = { hosts: 0, groups: 0, keys: 0, forwards: 0, knownHosts: 0, other: 0, skipped: 0, errors: [] }
  let parsed: BackupFile
  try {
    parsed = JSON.parse(await fs.promises.readFile(file, 'utf8')) as BackupFile
  } catch {
    throw new Error('Not a valid backup file')
  }
  if (parsed.format !== 'sshtool-backup' || parsed.version !== 1) throw new Error('Unsupported backup format')
  const key = await deriveKey(password, Buffer.from(parsed.salt, 'base64'), parsed.kdf)
  let content: { items: Item[] }
  try {
    content = decryptJson(key, Buffer.from(parsed.data, 'base64'), BACKUP_AAD)
  } catch (err) {
    if (err instanceof DecryptError) throw new Error('Wrong backup password', { cause: err })
    throw err
  }
  const counters: Partial<Record<ItemKind, keyof ImportResult>> = {
    host: 'hosts',
    group: 'groups',
    key: 'keys',
    portForward: 'forwards',
    knownHost: 'knownHosts'
  }
  // groups first so parent references resolve naturally
  const order = (k: ItemKind): number => (k === 'group' ? 0 : k === 'tag' ? 1 : k === 'key' || k === 'identity' ? 2 : 3)
  for (const it of [...content.items].sort((a, b) => order(a.kind) - order(b.kind))) {
    if (!(ITEM_KINDS as readonly string[]).includes(it.kind)) {
      result.skipped++
      continue
    }
    const local = vault.get(it.id)
    if (local && local.updatedAt >= it.updatedAt) {
      result.skipped++
      continue
    }
    try {
      vault.upsert(it.kind, it.data as never, { id: it.id, localOnly: it.localOnly })
      const c = counters[it.kind]
      if (c) (result[c] as number)++
      else result.other++
    } catch (err) {
      result.errors.push(`${it.kind} ${it.id}: ${(err as Error).message}`)
    }
  }
  return result
}
