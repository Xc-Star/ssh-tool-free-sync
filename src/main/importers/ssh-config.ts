import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import SSHConfig from 'ssh-config'
import type { ImportResult, SshConfigEntry } from '@shared/types'
import { inspectKey } from '../ssh/keys'
import type { VaultService } from '../vault/vault-service'

export function defaultSshConfigPath(): string {
  return path.join(os.homedir(), '.ssh', 'config')
}

function expandHome(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2))
  return p
}

function hostAliases(value: unknown): string[] {
  if (typeof value === 'string') return value.split(/\s+/).filter(Boolean)
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? v : (v as { val: string }).val)).filter(Boolean)
  return []
}

function asArray(v: unknown): string[] {
  if (v === undefined || v === null) return []
  return Array.isArray(v) ? v.map(String) : [String(v)]
}

function parseForwardSpec(spec: string): { bindAddress: string; bindPort: number; destHost?: string; destPort?: number } | null {
  const parts = spec.trim().split(/\s+/)
  const parseBind = (s: string): { addr: string; port: number } | null => {
    const m = /^(?:\[?([^\]]*?)\]?:)?(\d+)$/.exec(s)
    if (!m) return null
    return { addr: m[1] || '127.0.0.1', port: Number(m[2]) }
  }
  const bind = parseBind(parts[0])
  if (!bind) return null
  if (parts.length < 2) return { bindAddress: bind.addr, bindPort: bind.port }
  const dm = /^\[?([^\]]+?)\]?:(\d+)$/.exec(parts[1])
  if (!dm) return null
  return { bindAddress: bind.addr, bindPort: bind.port, destHost: dm[1], destPort: Number(dm[2]) }
}

/** Parses an OpenSSH client config into importable entries (wildcard sections only provide defaults). */
export function parseSshConfig(text: string, vault?: VaultService): SshConfigEntry[] {
  const config = SSHConfig.parse(text)
  const entries: SshConfigEntry[] = []
  const existing = vault?.list('host') ?? []
  for (const section of config as unknown as { param: string; value: unknown }[]) {
    if (String(section.param).toLowerCase() !== 'host') continue
    for (const alias of hostAliases(section.value)) {
      if (/[*?!]/.test(alias)) continue
      const c = config.compute(alias) as Record<string, unknown>
      const hostName = String(c.HostName ?? alias)
      const port = c.Port ? Number(c.Port) : undefined
      const user = c.User ? String(c.User) : undefined
      const forwards: SshConfigEntry['forwards'] = []
      for (const lf of asArray(c.LocalForward)) {
        const f = parseForwardSpec(lf)
        if (f?.destHost) forwards.push({ type: 'local', ...f })
      }
      for (const rf of asArray(c.RemoteForward)) {
        const f = parseForwardSpec(rf)
        if (f?.destHost) forwards.push({ type: 'remote', ...f })
      }
      for (const df of asArray(c.DynamicForward)) {
        const f = parseForwardSpec(df)
        if (f) forwards.push({ type: 'dynamic', bindAddress: f.bindAddress, bindPort: f.bindPort })
      }
      entries.push({
        alias,
        hostName,
        port,
        user,
        identityFiles: asArray(c.IdentityFile).map(expandHome),
        proxyJump: c.ProxyJump ? String(c.ProxyJump) : undefined,
        forwards,
        exists: existing.some(
          (h) => h.data.address === hostName && (h.data.port ?? 22) === (port ?? 22) && (h.data.username ?? '') === (user ?? '')
        )
      })
    }
  }
  return entries
}

export function readSshConfig(file: string | undefined, vault: VaultService): SshConfigEntry[] {
  const p = file || defaultSshConfigPath()
  if (!fs.existsSync(p)) return []
  return parseSshConfig(fs.readFileSync(p, 'utf8'), vault)
}

/** Imports the selected ssh config entries (keys from IdentityFile, ProxyJump chains, forwards). */
export function applySshConfig(entries: SshConfigEntry[], vault: VaultService, groupName?: string): ImportResult {
  const result: ImportResult = { hosts: 0, groups: 0, keys: 0, forwards: 0, knownHosts: 0, other: 0, skipped: 0, errors: [] }
  let groupId: string | undefined
  if (groupName?.trim()) {
    const g = vault.list('group').find((x) => x.data.name === groupName.trim() && !x.data.parentId)
    groupId = g?.id ?? vault.upsert('group', { name: groupName.trim() }).id
    if (!g) result.groups++
  }
  const keyByFingerprint = new Map(vault.list('key').map((k) => [k.data.fingerprint, k.id]))
  const keyByPath = new Map<string, string | undefined>()
  const importKey = (file: string): string | undefined => {
    if (keyByPath.has(file)) return keyByPath.get(file)
    let id: string | undefined
    try {
      const pem = fs.readFileSync(file, 'utf8')
      let info
      try {
        info = inspectKey(pem)
      } catch {
        info = undefined
      }
      if (info && keyByFingerprint.has(info.fingerprint)) {
        id = keyByFingerprint.get(info.fingerprint)
      } else {
        const item = vault.upsert('key', {
          label: path.basename(file),
          privateKey: pem,
          keyType: info?.keyType ?? '',
          publicKey: info?.publicKey ?? '',
          fingerprint: info?.fingerprint ?? ''
        })
        id = item.id
        if (info) keyByFingerprint.set(info.fingerprint, id)
        result.keys++
      }
    } catch (err) {
      result.errors.push(`${file}: ${(err as Error).message}`)
    }
    keyByPath.set(file, id)
    return id
  }

  const aliasToId = new Map<string, string>()
  for (const h of vault.list('host')) aliasToId.set(h.data.label, h.id)
  const created: { entry: SshConfigEntry; id: string }[] = []
  for (const e of entries) {
    const keyFile = e.identityFiles.find((f) => fs.existsSync(f))
    const keyId = keyFile ? importKey(keyFile) : undefined
    const host = vault.upsert('host', {
      label: e.alias,
      address: e.hostName,
      port: e.port,
      username: e.user,
      keyId,
      groupId,
      useAgent: !keyId ? true : undefined
    })
    aliasToId.set(e.alias, host.id)
    created.push({ entry: e, id: host.id })
    result.hosts++
  }
  for (const { entry, id } of created) {
    if (entry.proxyJump && entry.proxyJump !== 'none') {
      const jumpIds: string[] = []
      for (const j of entry.proxyJump.split(',')) {
        const name = j.trim().replace(/^.*@/, '').replace(/:\d+$/, '')
        let jid = aliasToId.get(name)
        if (!jid) {
          const m = /^(?:([^@]+)@)?([^:]+)(?::(\d+))?$/.exec(j.trim())
          if (m) {
            jid = vault.upsert('host', { label: m[2], address: m[2], username: m[1], port: m[3] ? Number(m[3]) : undefined, groupId }).id
            aliasToId.set(m[2], jid)
            result.hosts++
          }
        }
        if (jid) jumpIds.push(jid)
      }
      if (jumpIds.length) vault.patch(id, { jumpHostIds: jumpIds })
    }
    for (const f of entry.forwards) {
      vault.upsert('portForward', {
        label: `${entry.alias} ${f.type} ${f.bindPort}`,
        type: f.type,
        hostId: id,
        bindAddress: f.bindAddress,
        bindPort: f.bindPort,
        destHost: f.destHost,
        destPort: f.destPort
      })
      result.forwards++
    }
  }
  return result
}
