import { z } from 'zod'

/** All vault item kinds. Everything in the vault (and everything synced) is one of these. */
export const ITEM_KINDS = [
  'group',
  'tag',
  'host',
  'key',
  'identity',
  'snippet',
  'portForward',
  'knownHost',
  'serialProfile',
  'pref'
] as const
export type ItemKind = (typeof ITEM_KINDS)[number]

const idRef = z.string().min(1).max(64)
const port = z.number().int().min(1).max(65535)

export const proxySchema = z.object({
  type: z.enum(['socks5', 'socks4', 'http']),
  host: z.string().min(1).max(255),
  port,
  username: z.string().max(255).optional(),
  password: z.string().max(4096).optional()
})
export type ProxyConfig = z.infer<typeof proxySchema>

export const envVarSchema = z.object({
  name: z.string().min(1).max(255),
  value: z.string().max(4096)
})
export type EnvVar = z.infer<typeof envVarSchema>

/** Connection settings shared by hosts and groups (groups provide defaults inherited by their hosts). */
const connectionSettingsShape = {
  username: z.string().max(255).optional(),
  password: z.string().max(4096).optional(),
  keyId: idRef.optional(),
  identityId: idRef.optional(),
  port: port.optional(),
  useAgent: z.boolean().optional(),
  agentForwarding: z.boolean().optional(),
  jumpHostIds: z.array(idRef).max(16).optional(),
  proxy: proxySchema.optional(),
  keepAliveInterval: z.number().int().min(0).max(3600).optional(),
  envVars: z.array(envVarSchema).max(64).optional(),
  startupSnippetId: idRef.optional(),
  charset: z.string().max(32).optional(),
  terminalTheme: z.string().max(64).optional(),
  fontSize: z.number().int().min(6).max(64).optional()
}
export const connectionSettingsSchema = z.object(connectionSettingsShape)
export type ConnectionSettings = z.infer<typeof connectionSettingsSchema>

export const groupSchema = z.object({
  name: z.string().min(1).max(255),
  parentId: idRef.optional(),
  ...connectionSettingsShape
})
export type GroupData = z.infer<typeof groupSchema>

export const tagSchema = z.object({
  name: z.string().min(1).max(64),
  color: z.string().max(32).optional()
})
export type TagData = z.infer<typeof tagSchema>

export const hostSchema = z.object({
  label: z.string().max(255).default(''),
  address: z.string().min(1).max(255),
  groupId: idRef.optional(),
  tagIds: z.array(idRef).max(64).default([]),
  sshEnabled: z.boolean().default(true),
  telnetEnabled: z.boolean().default(false),
  telnetPort: port.optional(),
  osHint: z.string().max(32).optional(),
  notes: z.string().max(10000).optional(),
  ...connectionSettingsShape
})
export type HostData = z.infer<typeof hostSchema>

export const keySchema = z.object({
  label: z.string().min(1).max(255),
  keyType: z.string().max(64).default(''),
  privateKey: z.string().max(65536),
  publicKey: z.string().max(65536).default(''),
  passphrase: z.string().max(4096).optional(),
  fingerprint: z.string().max(255).default(''),
  certificate: z.string().max(65536).optional()
})
export type KeyData = z.infer<typeof keySchema>

export const identitySchema = z.object({
  label: z.string().min(1).max(255),
  username: z.string().max(255).default(''),
  password: z.string().max(4096).optional(),
  keyId: idRef.optional()
})
export type IdentityData = z.infer<typeof identitySchema>

export const snippetSchema = z.object({
  label: z.string().min(1).max(255),
  script: z.string().max(100_000),
  tags: z.array(z.string().max(64)).max(32).default([])
})
export type SnippetData = z.infer<typeof snippetSchema>

export const portForwardSchema = z.object({
  label: z.string().max(255).default(''),
  type: z.enum(['local', 'remote', 'dynamic']),
  hostId: idRef,
  bindAddress: z.string().max(255).default('127.0.0.1'),
  bindPort: port,
  destHost: z.string().max(255).optional(),
  destPort: port.optional(),
  autoStart: z.boolean().default(false)
})
export type PortForwardData = z.infer<typeof portForwardSchema>

export const knownHostSchema = z.object({
  host: z.string().min(1).max(255),
  port,
  keyType: z.string().max(64),
  fingerprint: z.string().max(128),
  publicKey: z.string().max(16384)
})
export type KnownHostData = z.infer<typeof knownHostSchema>

export const serialProfileSchema = z.object({
  label: z.string().min(1).max(255),
  path: z.string().min(1).max(255),
  baudRate: z.number().int().positive().default(115200),
  dataBits: z.union([z.literal(5), z.literal(6), z.literal(7), z.literal(8)]).default(8),
  stopBits: z.union([z.literal(1), z.literal(1.5), z.literal(2)]).default(1),
  parity: z.enum(['none', 'even', 'odd', 'mark', 'space']).default('none'),
  flowControl: z.enum(['none', 'hardware', 'software']).default('none'),
  localEcho: z.boolean().default(false),
  lineEnding: z.enum(['cr', 'lf', 'crlf']).default('cr')
})
export type SerialProfileData = z.infer<typeof serialProfileSchema>

export const terminalPrefsSchema = z.object({
  theme: z.string().max(64).default('sshtool-dark'),
  fontFamily: z.string().max(255).default('JetBrains Mono'),
  fontSize: z.number().int().min(6).max(64).default(14),
  lineHeight: z.number().min(1).max(2).default(1.2),
  cursorStyle: z.enum(['block', 'underline', 'bar']).default('block'),
  cursorBlink: z.boolean().default(true),
  scrollback: z.number().int().min(100).max(200_000).default(10_000),
  copyOnSelect: z.boolean().default(false),
  rightClickPaste: z.boolean().default(true),
  bell: z.boolean().default(false),
  keepAliveInterval: z.number().int().min(0).max(3600).default(30),
  autocomplete: z.boolean().default(true)
})
export type TerminalPrefs = z.infer<typeof terminalPrefsSchema>

export const prefSchema = z.object({
  terminal: terminalPrefsSchema.optional(),
  shortcuts: z.record(z.string(), z.string()).optional()
})
export type PrefData = z.infer<typeof prefSchema>

/** Fixed id of the (single) synced preferences item. */
export const PREF_ITEM_ID = 'pref-main'

export const KIND_SCHEMAS = {
  group: groupSchema,
  tag: tagSchema,
  host: hostSchema,
  key: keySchema,
  identity: identitySchema,
  snippet: snippetSchema,
  portForward: portForwardSchema,
  knownHost: knownHostSchema,
  serialProfile: serialProfileSchema,
  pref: prefSchema
} as const

export interface KindData {
  group: GroupData
  tag: TagData
  host: HostData
  key: KeyData
  identity: IdentityData
  snippet: SnippetData
  portForward: PortForwardData
  knownHost: KnownHostData
  serialProfile: SerialProfileData
  pref: PrefData
}

/** Input type accepted by upsert (zod defaults may be omitted). */
export type KindInput = { [K in ItemKind]: z.input<(typeof KIND_SCHEMAS)[K]> }

/** A decrypted vault item. `Item` (no type arg) is a discriminated union over `kind`. */
export type Item<K extends ItemKind = ItemKind> = {
  [P in K]: {
    id: string
    kind: P
    data: KindData[P]
    createdAt: number
    updatedAt: number
    localOnly: boolean
  }
}[K]

/** Kinds that are device specific and therefore local-only by default. */
export const DEFAULT_LOCAL_ONLY_KINDS: readonly ItemKind[] = ['serialProfile']

/**
 * Secret fields per kind. They are masked before crossing into the renderer and only
 * revealed on explicit request.
 */
export const SECRET_PATHS: Partial<Record<ItemKind, string[]>> = {
  host: ['password', 'proxy.password'],
  group: ['password', 'proxy.password'],
  key: ['privateKey', 'passphrase'],
  identity: ['password']
}

/** Placeholder the renderer receives instead of a secret value. Sending it back means "unchanged". */
export const SECRET_MASK = '\u0000__sshtool_masked__\u0000'

export function isMasked(v: unknown): boolean {
  return v === SECRET_MASK
}
