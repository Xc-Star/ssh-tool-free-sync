import type { ConnectionSettings, Item } from '@shared/schemas'
import { getItem, getItems } from '@/stores/vault'

export type HostItem = Item<'host'>
export type GroupItem = Item<'group'>

/** Groups from the given one up to the root (nearest first). */
export function groupChain(groupId: string | undefined): GroupItem[] {
  const out: GroupItem[] = []
  const seen = new Set<string>()
  let id = groupId
  while (id && !seen.has(id) && out.length < 32) {
    seen.add(id)
    const g = getItem('group', id)
    if (!g) break
    out.push(g)
    id = g.data.parentId
  }
  return out
}

/** Breadcrumb path from the root down to the given group. */
export function groupPath(groupId: string | undefined): GroupItem[] {
  return groupChain(groupId).reverse()
}

export function groupLabel(groupId: string | undefined): string {
  return groupPath(groupId)
    .map((g) => g.data.name)
    .join(' / ')
}

/** Every group id below `groupId` (inclusive). */
export function descendantGroupIds(groupId: string, groups: GroupItem[]): Set<string> {
  const out = new Set([groupId])
  let added = true
  while (added) {
    added = false
    for (const g of groups) {
      if (g.data.parentId && out.has(g.data.parentId) && !out.has(g.id)) {
        out.add(g.id)
        added = true
      }
    }
  }
  return out
}

export function hostCountInGroup(groupId: string, groups: GroupItem[], hosts: HostItem[]): number {
  const ids = descendantGroupIds(groupId, groups)
  return hosts.filter((h) => h.data.groupId && ids.has(h.data.groupId)).length
}

const INHERITABLE: (keyof ConnectionSettings)[] = [
  'username',
  'password',
  'keyId',
  'identityId',
  'port',
  'useAgent',
  'agentForwarding',
  'jumpHostIds',
  'proxy',
  'keepAliveInterval',
  'envVars',
  'startupSnippetId',
  'charset',
  'terminalTheme',
  'fontSize'
]

function isSet(v: unknown): boolean {
  if (v === undefined || v === null) return false
  if (typeof v === 'string') return v.length > 0
  if (Array.isArray(v)) return v.length > 0
  return true
}

/** Settings a host in `groupId` would inherit (from the group chain and their identities). */
export function inheritedSettings(groupId: string | undefined): Partial<ConnectionSettings> & { source?: Record<string, string> } {
  const out: Partial<ConnectionSettings> = {}
  const source: Record<string, string> = {}
  for (const g of groupChain(groupId)) {
    const layers: Partial<ConnectionSettings>[] = [g.data]
    if (g.data.identityId) {
      const ident = getItem('identity', g.data.identityId)
      if (ident) layers.push({ username: ident.data.username, password: ident.data.password, keyId: ident.data.keyId })
    }
    for (const layer of layers) {
      for (const k of INHERITABLE) {
        if (!isSet(out[k]) && isSet(layer[k])) {
          ;(out as Record<string, unknown>)[k] = layer[k]
          source[k] = g.data.name
        }
      }
    }
  }
  return { ...out, source }
}

/** Effective username shown on host cards. */
export function effectiveUsername(h: HostItem): string | undefined {
  if (h.data.username) return h.data.username
  if (h.data.identityId) {
    const ident = getItem('identity', h.data.identityId)
    if (ident?.data.username) return ident.data.username
  }
  return inheritedSettings(h.data.groupId).username
}

export function hostTitle(h: HostItem): string {
  return h.data.label || h.data.address
}

/** Termius-style subtitle: "ssh, root" / "ssh, telnet". */
export function hostSubtitle(h: HostItem): string {
  const protos: string[] = []
  if (h.data.sshEnabled !== false) protos.push('ssh')
  if (h.data.telnetEnabled) protos.push('telnet')
  const user = effectiveUsername(h)
  return [protos.join(', '), user].filter(Boolean).join(', ')
}

export function matchesSearch(h: HostItem, q: string, tagNames: Map<string, string>): boolean {
  if (!q) return true
  const s = q.toLowerCase()
  const fields = [h.data.label, h.data.address, h.data.username, groupLabel(h.data.groupId), h.data.notes, ...h.data.tagIds.map((t) => tagNames.get(t))]
  return fields.some((f) => f?.toLowerCase().includes(s))
}

export function allTags(): Map<string, string> {
  return new Map(getItems('tag').map((t) => [t.id, t.data.name]))
}
