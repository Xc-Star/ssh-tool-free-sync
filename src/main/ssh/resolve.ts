import type { ConnectionSettings, EnvVar, HostData, Item, ProxyConfig } from '@shared/schemas'
import type { QuickHost } from '@shared/types'
import type { VaultService } from '../vault/vault-service'

/** Fully resolved connection parameters for one SSH hop. */
export interface Endpoint {
  hostId?: string
  label: string
  address: string
  port: number
  username: string
  password?: string
  key?: { id: string; label: string; privateKey: string; passphrase?: string; certificate?: string }
  useAgent: boolean
  agentForwarding: boolean
  keepAliveSec: number
  proxy?: ProxyConfig
  envVars: EnvVar[]
  startupScript?: string
  charset: string
  jumpHostIds: string[]
  terminalTheme?: string
  fontSize?: number
  telnetPort?: number
}

type Layer = Partial<ConnectionSettings>

function isSet(v: unknown): boolean {
  if (v === undefined || v === null) return false
  if (typeof v === 'string') return v.length > 0
  if (Array.isArray(v)) return v.length > 0
  return true
}

/**
 * Builds the inheritance layers for a host, most specific first:
 * host → host identity → parent group → parent group identity → grand-parent group …
 */
export function hostLayers(vault: VaultService, host: HostData): Layer[] {
  const layers: Layer[] = []
  const pushWithIdentity = (layer: Layer): void => {
    layers.push(layer)
    if (layer.identityId) {
      const ident = vault.get(layer.identityId, 'identity')
      if (ident) layers.push({ username: ident.data.username, password: ident.data.password, keyId: ident.data.keyId })
    }
  }
  pushWithIdentity(host)
  const seen = new Set<string>()
  let gid = host.groupId
  while (gid && !seen.has(gid) && seen.size < 32) {
    seen.add(gid)
    const g = vault.get(gid, 'group')
    if (!g) break
    pushWithIdentity(g.data)
    gid = g.data.parentId
  }
  return layers
}

export function pick<K extends keyof Layer>(layers: Layer[], key: K): Layer[K] | undefined {
  for (const l of layers) if (isSet(l[key])) return l[key]
  return undefined
}

export function resolveHost(
  vault: VaultService,
  host: Pick<Item<'host'>, 'data'> & { id?: string },
  defaults: { keepAliveSec: number }
): Endpoint {
  const d = host.data
  const layers = hostLayers(vault, d)
  const keyId = pick(layers, 'keyId')
  const keyItem = keyId ? vault.get(keyId, 'key') : undefined
  const snippetId = pick(layers, 'startupSnippetId')
  const snippet = snippetId ? vault.get(snippetId, 'snippet') : undefined
  return {
    hostId: host.id,
    label: d.label || d.address,
    address: d.address,
    port: pick(layers, 'port') ?? 22,
    username: pick(layers, 'username') ?? '',
    password: pick(layers, 'password'),
    key: keyItem
      ? {
          id: keyItem.id,
          label: keyItem.data.label,
          privateKey: keyItem.data.privateKey,
          passphrase: keyItem.data.passphrase,
          certificate: keyItem.data.certificate
        }
      : undefined,
    useAgent: pick(layers, 'useAgent') ?? false,
    agentForwarding: pick(layers, 'agentForwarding') ?? false,
    keepAliveSec: pick(layers, 'keepAliveInterval') ?? defaults.keepAliveSec,
    proxy: pick(layers, 'proxy'),
    envVars: pick(layers, 'envVars') ?? [],
    startupScript: snippet?.data.script,
    charset: (pick(layers, 'charset') ?? 'utf-8').toLowerCase(),
    jumpHostIds: pick(layers, 'jumpHostIds') ?? [],
    terminalTheme: pick(layers, 'terminalTheme'),
    fontSize: pick(layers, 'fontSize'),
    telnetPort: d.telnetPort
  }
}

export function resolveHostById(vault: VaultService, hostId: string, defaults: { keepAliveSec: number }): Endpoint {
  const host = vault.get(hostId, 'host')
  if (!host) throw new Error('Host not found')
  return resolveHost(vault, host, defaults)
}

export function resolveQuickHost(q: QuickHost, defaults: { keepAliveSec: number }): Endpoint {
  return {
    label: q.label || (q.username ? `${q.username}@${q.address}` : q.address),
    address: q.address,
    port: q.port ?? 22,
    username: q.username ?? '',
    password: q.password,
    useAgent: true,
    agentForwarding: false,
    keepAliveSec: defaults.keepAliveSec,
    envVars: [],
    charset: 'utf-8',
    jumpHostIds: []
  }
}
