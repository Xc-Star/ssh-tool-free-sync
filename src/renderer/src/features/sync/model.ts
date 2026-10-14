import { SECRET_MASK } from '@shared/schemas'
import type { D1DbConfig, SqlDbConfig, SslMode, SyncDbConfig, SyncDbKind } from '@shared/types'

export const DEFAULT_PREFIX = 'sshtool_'
export const DEFAULT_PORT: Record<SqlDbConfig['kind'], number> = { postgres: 5432, mysql: 3306 }
/** Same rule as the main process (`assertTablePrefix`): the prefix is interpolated into SQL identifiers. */
export const PREFIX_RE = /^[A-Za-z][A-Za-z0-9_]{0,30}$/
export const SSL_MODES: SslMode[] = ['disable', 'require', 'verify-ca', 'verify-full']
export const URL_SCHEMES: Record<SqlDbConfig['kind'], string[]> = {
  postgres: ['postgres://', 'postgresql://'],
  mysql: ['mysql://', 'mariadb://']
}
export const DB_KINDS: SyncDbKind[] = ['postgres', 'mysql', 'd1']

export interface SqlForm {
  useUrl: boolean
  url: string
  host: string
  port: string
  database: string
  user: string
  /** Typed password, or SECRET_MASK while the stored one is kept. */
  password: string
  ssl: SslMode
  ca: string
  tablePrefix: string
}

export interface D1Form {
  accountId: string
  databaseId: string
  /** Typed token, or SECRET_MASK while the stored one is kept. */
  apiToken: string
  tablePrefix: string
  baseUrl: string
}

export type FormField =
  | 'url'
  | 'host'
  | 'port'
  | 'database'
  | 'user'
  | 'tablePrefix'
  | 'accountId'
  | 'databaseId'
  | 'apiToken'
  | 'baseUrl'

/** Field → i18n key below `form.errors`. */
export type FieldErrors = Partial<
  Record<FormField, 'required' | 'invalidPort' | 'invalidUrl' | 'prefixInvalid' | 'invalidBaseUrl'>
>

export function emptySqlForm(kind: SqlDbConfig['kind'] = 'postgres'): SqlForm {
  return {
    useUrl: false,
    url: '',
    host: '',
    port: String(DEFAULT_PORT[kind]),
    database: '',
    user: '',
    password: '',
    ssl: 'require',
    ca: '',
    tablePrefix: DEFAULT_PREFIX
  }
}

export function emptyD1Form(): D1Form {
  return { accountId: '', databaseId: '', apiToken: '', tablePrefix: DEFAULT_PREFIX, baseUrl: '' }
}

export function sqlFormFrom(cfg: SqlDbConfig): SqlForm {
  return {
    useUrl: !!cfg.url?.trim(),
    url: cfg.url ?? '',
    host: cfg.host ?? '',
    port: cfg.port ? String(cfg.port) : String(DEFAULT_PORT[cfg.kind]),
    database: cfg.database ?? '',
    user: cfg.user ?? '',
    password: cfg.password ?? '',
    ssl: cfg.ssl ?? 'require',
    ca: cfg.ca ?? '',
    tablePrefix: cfg.tablePrefix || DEFAULT_PREFIX
  }
}

export function d1FormFrom(cfg: D1DbConfig): D1Form {
  return {
    accountId: cfg.accountId ?? '',
    databaseId: cfg.databaseId ?? '',
    apiToken: cfg.apiToken ?? '',
    tablePrefix: cfg.tablePrefix || DEFAULT_PREFIX,
    baseUrl: cfg.baseUrl ?? ''
  }
}

export function needsCa(ssl: SslMode): boolean {
  return ssl === 'verify-ca' || ssl === 'verify-full'
}

/** Builds the config sent to the main process. Masked secrets are passed through unchanged (main restores them). */
export function buildConfig(kind: SyncDbKind, sql: SqlForm, d1: D1Form): SyncDbConfig {
  if (kind === 'd1') {
    const baseUrl = d1.baseUrl.trim()
    return {
      kind: 'd1',
      accountId: d1.accountId.trim(),
      databaseId: d1.databaseId.trim(),
      apiToken: d1.apiToken === SECRET_MASK ? d1.apiToken : d1.apiToken.trim(),
      tablePrefix: d1.tablePrefix.trim() || DEFAULT_PREFIX,
      ...(baseUrl ? { baseUrl } : {})
    }
  }
  const ca = needsCa(sql.ssl) && sql.ca.trim() ? sql.ca.trim() : undefined
  const base: SqlDbConfig = {
    kind,
    ssl: sql.ssl,
    tablePrefix: sql.tablePrefix.trim() || DEFAULT_PREFIX,
    ...(ca ? { ca } : {})
  }
  if (sql.useUrl) return { ...base, url: sql.url.trim() }
  const port = Number(sql.port.trim())
  return {
    ...base,
    host: sql.host.trim(),
    port: sql.port.trim() && Number.isInteger(port) ? port : undefined,
    database: sql.database.trim(),
    user: sql.user.trim(),
    password: sql.password || undefined
  }
}

export function validateForm(kind: SyncDbKind, sql: SqlForm, d1: D1Form): FieldErrors {
  const e: FieldErrors = {}
  if (kind === 'd1') {
    if (!d1.accountId.trim()) e.accountId = 'required'
    if (!d1.databaseId.trim()) e.databaseId = 'required'
    if (!d1.apiToken.trim()) e.apiToken = 'required'
    if (!PREFIX_RE.test(d1.tablePrefix.trim() || DEFAULT_PREFIX)) e.tablePrefix = 'prefixInvalid'
    const base = d1.baseUrl.trim()
    if (base && !/^https?:\/\/[^/\s]+/i.test(base)) e.baseUrl = 'invalidBaseUrl'
    return e
  }
  if (sql.useUrl) {
    const url = sql.url.trim().toLowerCase()
    if (!url) e.url = 'required'
    else if (!URL_SCHEMES[kind].some((s) => url.startsWith(s))) e.url = 'invalidUrl'
  } else {
    if (!sql.host.trim()) e.host = 'required'
    const port = sql.port.trim()
    if (port && !(/^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535)) e.port = 'invalidPort'
    if (!sql.database.trim()) e.database = 'required'
    if (!sql.user.trim()) e.user = 'required'
  }
  if (!PREFIX_RE.test(sql.tablePrefix.trim() || DEFAULT_PREFIX)) e.tablePrefix = 'prefixInvalid'
  return e
}

/** Host name the SQL form points to (from the URL when URL mode is used). */
export function sqlHost(sql: SqlForm): string {
  if (!sql.useUrl) return sql.host.trim()
  try {
    return new URL(sql.url.trim()).hostname
  } catch {
    return ''
  }
}

/** Loopback, private ranges, link-local, single-label and local-only DNS names. */
export function isPrivateHost(host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
  if (!h) return true
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0.0.0.0') return true
  if (
    /^(127|10)\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    /^169\.254\./.test(h)
  )
    return true
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return true
  if (/^f[cd][0-9a-f]{2}:/.test(h) || h.startsWith('fe80:')) return true
  if (/\.(local|lan|internal|intranet|home\.arpa|corp)$/.test(h)) return true
  return !h.includes('.') && !h.includes(':')
}

export type ErrorHint = 'network' | 'auth' | 'tls' | 'noSsl' | 'database'

/** Maps common connection errors to a short, actionable hint. */
export function errorHint(message: string): ErrorHint | null {
  if (
    /does not support SSL|not support (ssl|secure)|SSL is not enabled|SSL off|HANDSHAKE_NO_SSL/i.test(message)
  )
    return 'noSsl'
  if (/certificate|self[- ]signed|\bSSL\b|\bTLS\b|ERR_TLS|ERR_SSL/i.test(message)) return 'tls'
  if (
    /denied access|authentication|password|access denied|\b401\b|\b403\b|unauthori[sz]ed|forbidden|ER_ACCESS_DENIED/i.test(
      message
    )
  )
    return 'auth'
  if (
    /database "?[^"]*"? does not exist|unknown database|could not be found|ER_BAD_DB_ERROR|\b404\b/i.test(
      message
    )
  )
    return 'database'
  if (
    /cannot reach|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|timeout|timed out|fetch failed|network/i.test(
      message
    )
  )
    return 'network'
  return null
}

export function isWrongPasswordError(message: string): boolean {
  return /wrong (master )?password/i.test(message)
}

/** Hides the password of a connection URL. */
export function redactUrl(url: string): string {
  return url.replace(/(\/\/[^:/@\s]+:)[^@\s]*@/, '$1••••••@')
}

/** Short human readable target, without secrets. */
export function describeTarget(cfg: SyncDbConfig): string {
  if (cfg.kind === 'd1') return cfg.databaseId ? `${cfg.databaseId.slice(0, 8)}…` : ''
  if (cfg.url?.trim()) {
    try {
      const u = new URL(cfg.url.trim())
      return `${u.hostname || 'localhost'}:${u.port || DEFAULT_PORT[cfg.kind]}${u.pathname && u.pathname !== '/' ? u.pathname : ''}`
    } catch {
      return redactUrl(cfg.url)
    }
  }
  const host = cfg.host?.trim() || 'localhost'
  return `${host.includes(':') ? `[${host}]` : host}:${cfg.port || DEFAULT_PORT[cfg.kind]}${cfg.database ? `/${cfg.database}` : ''}`
}

export type Strength = 'tooShort' | 'weak' | 'fair' | 'good' | 'strong'
export const STRENGTH_LEVELS: Strength[] = ['tooShort', 'weak', 'fair', 'good', 'strong']

/** Simple heuristic based on length and character classes, with penalties for obvious patterns. */
export function passwordStrength(pw: string): { level: Strength; score: number } {
  if (pw.length < 8) return { level: 'tooShort', score: 0 }
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length
  let score = pw.length >= 16 ? 3 : pw.length >= 12 ? 2 : 1
  if (classes >= 3) score++
  if (pw.length >= 24) score++
  const unique = new Set(pw).size
  if (
    unique <= 4 ||
    /^(.)\1+$/.test(pw) ||
    /(password|passwort|123456|qwerty|abcdef|letmein|sshtool)/i.test(pw)
  )
    score = 1
  else if (classes === 1 && pw.length < 16) score = Math.min(score, 1)
  score = Math.max(1, Math.min(4, score))
  return { level: STRENGTH_LEVELS[score], score }
}

export function platformName(platform: string): { os: string; arch: string } {
  const [os, ...rest] = platform.split('-')
  return { os, arch: rest.join('-') }
}
