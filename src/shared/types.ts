import type { SerialProfileData } from './schemas'

// ---------------------------------------------------------------- app / lock

export interface AppInfo {
  name: string
  version: string
  platform: string
  arch: string
  electron: string
  node: string
  deviceId: string
  deviceName: string
  userData: string
  homeDir: string
}

export interface LockStatus {
  /** Vault key not available in memory → UI must show the lock screen. */
  locked: boolean
  /** App lock password is configured. */
  passwordEnabled: boolean
  /** OS keychain backend used by safeStorage. */
  backend: string
  /** True when the OS keychain protection is weak (e.g. Linux "basic_text"). */
  weak: boolean
  autoLockMinutes: number
  /** The OS keychain could not return the vault key: the lock screen offers retry / reset instead of a password. */
  keystoreError?: string
}

// ---------------------------------------------------------------- settings

export type Language = 'zh-CN' | 'en'
export type ThemeMode = 'dark' | 'light' | 'system'
export type ConflictPolicy = 'ask' | 'overwrite' | 'skip' | 'rename'

export interface LocalSettings {
  language: Language
  theme: ThemeMode
  hostsView: 'grid' | 'list'
  hostsSort: 'name' | 'recent' | 'address'
  sidebarCollapsed: boolean
  autoLockMinutes: number
  localShell?: string
  confirmOnClose: boolean
  autoCheckUpdates: boolean
  sftp: {
    concurrency: number
    showHidden: boolean
    conflictPolicy: ConflictPolicy
    defaultLocalPath?: string
  }
}

export const DEFAULT_SETTINGS: LocalSettings = {
  language: 'zh-CN',
  theme: 'dark',
  hostsView: 'grid',
  hostsSort: 'name',
  sidebarCollapsed: false,
  autoLockMinutes: 0,
  confirmOnClose: true,
  autoCheckUpdates: true,
  sftp: { concurrency: 3, showHidden: false, conflictPolicy: 'ask' }
}

// ---------------------------------------------------------------- updates

/** Result of checking GitHub Releases for a newer version. `unavailable` = GitHub could not be reached (offline, rate-limited), so no verdict exists. */
export type UpdateCheckResult =
  | { status: 'up-to-date'; currentVersion: string }
  | { status: 'unavailable'; currentVersion: string }
  | { status: 'available'; version: string; url: string; currentVersion: string }

// ---------------------------------------------------------------- sessions

export type SessionKind = 'ssh' | 'local' | 'telnet' | 'serial'
export type SessionStatus = 'connecting' | 'connected' | 'disconnected' | 'error'

/** Ad-hoc connection target (quick connect) that is not stored in the vault. */
export interface QuickHost {
  address: string
  port?: number
  username?: string
  password?: string
  label?: string
}

export interface OpenSshParams {
  hostId?: string
  inline?: QuickHost
  cols: number
  rows: number
  /** Command typed into the shell after it is ready (snippet run on hosts). */
  initialCommand?: string
}

export interface OpenLocalParams {
  cols: number
  rows: number
  shellId?: string
  cwd?: string
}

export interface OpenTelnetParams {
  hostId?: string
  inline?: { address: string; port?: number; label?: string }
  cols: number
  rows: number
}

export interface OpenSerialParams {
  profileId?: string
  inline?: SerialProfileData
  cols: number
  rows: number
}

export interface SessionInfo {
  id: string
  kind: SessionKind
  title: string
  hostId?: string
  status: SessionStatus
  error?: string
  startedAt: number
  /** OS hint detected for the remote host (ssh only). */
  osHint?: string
}

export interface ShellInfo {
  id: string
  label: string
  path: string
  args: string[]
}

export interface SerialPortInfo {
  path: string
  manufacturer?: string
  serialNumber?: string
  vendorId?: string
  productId?: string
}

// ---------------------------------------------------------------- prompts

export type PromptRequest =
  | {
      id: string
      type: 'hostkey'
      sessionId?: string
      hostLabel: string
      host: string
      port: number
      keyType: string
      fingerprint: string
      changed: boolean
      oldFingerprint?: string
    }
  | {
      id: string
      type: 'password'
      sessionId?: string
      hostLabel: string
      username: string
      message?: string
      allowSave: boolean
    }
  | {
      id: string
      type: 'passphrase'
      sessionId?: string
      keyLabel: string
      message?: string
      allowSave: boolean
    }
  | {
      id: string
      type: 'username'
      sessionId?: string
      hostLabel: string
    }
  | {
      id: string
      type: 'keyboard-interactive'
      sessionId?: string
      hostLabel: string
      name: string
      instructions: string
      prompts: { prompt: string; echo: boolean }[]
    }
  | {
      id: string
      type: 'conflict'
      fileName: string
      dstPath: string
      srcSize: number
      dstSize: number
      srcMtime: number
      dstMtime: number
    }

export type PromptType = PromptRequest['type']

export interface PromptResponses {
  hostkey: 'accept-save' | 'accept-once' | 'reject'
  password: { value: string; save: boolean }
  passphrase: { value: string; save: boolean }
  username: { value: string }
  'keyboard-interactive': { answers: string[] }
  conflict: { action: 'overwrite' | 'skip' | 'rename'; applyToAll: boolean }
}

// ---------------------------------------------------------------- filesystem / sftp

export type FileType = 'file' | 'dir' | 'symlink' | 'other'

export interface FileEntry {
  name: string
  path: string
  type: FileType
  /** For symlinks: type of the link target when resolvable. */
  targetType?: FileType
  size: number
  mtime: number
  mode: number
  permissions: string
  owner?: string
  group?: string
  hidden: boolean
}

export interface FsInfo {
  id: string
  kind: 'local' | 'sftp'
  hostId?: string
  label: string
  home: string
  /** Path flavor: posix for remote hosts and macOS/Linux, win32 for Windows local disk. */
  flavor: 'posix' | 'win32'
}

export type TransferStatus = 'queued' | 'running' | 'done' | 'error' | 'canceled' | 'skipped'

export interface TransferInfo {
  id: string
  batchId: string
  srcFsId: string
  dstFsId: string
  srcLabel: string
  dstLabel: string
  srcPath: string
  dstPath: string
  name: string
  isDir: boolean
  size: number
  transferred: number
  /** bytes/sec */
  speed: number
  status: TransferStatus
  error?: string
  startedAt?: number
  endedAt?: number
}

export interface TextFileContent {
  content: string
  size: number
  mtime: number
  /** True if the file looks binary (content not returned). */
  binary: boolean
  tooLarge: boolean
}

// ---------------------------------------------------------------- port forwarding

export interface ForwardState {
  ruleId: string
  status: 'stopped' | 'starting' | 'running' | 'error'
  error?: string
  connections: number
}

// ---------------------------------------------------------------- history

export interface HistoryEntry {
  id: number
  hostId?: string
  label: string
  address: string
  username?: string
  protocol: SessionKind
  startedAt: number
  endedAt?: number
  status: 'connected' | 'failed' | 'closed'
  error?: string
}

// ---------------------------------------------------------------- sync

export type SyncDbKind = 'postgres' | 'mysql' | 'd1' | 'webdav'
export type SslMode = 'disable' | 'require' | 'verify-ca' | 'verify-full'

export interface SqlDbConfig {
  kind: 'postgres' | 'mysql'
  /** Optional connection URL; when set it takes precedence over the discrete fields. */
  url?: string
  host?: string
  port?: number
  database?: string
  user?: string
  password?: string
  ssl: SslMode
  /** PEM CA certificate for verify-ca / verify-full. */
  ca?: string
  tablePrefix: string
}

export interface D1DbConfig {
  kind: 'd1'
  accountId: string
  databaseId: string
  apiToken: string
  tablePrefix: string
  /** Override of the Cloudflare API base URL (tests / proxies). */
  baseUrl?: string
}

/**
 * A WebDAV collection (Nextcloud, ownCloud, Synology, Apache/nginx mod_dav, Box, …). The vault is
 * stored as one JSON document inside that folder, guarded by ETag compare-and-swap.
 */
export interface WebdavDbConfig {
  kind: 'webdav'
  /** Absolute URL of the collection, e.g. https://cloud.example.com/remote.php/dav/files/user/sshtool/ */
  url: string
  username?: string
  password?: string
  /** File name prefix (same rule as the SQL table prefix). */
  tablePrefix: string
}

export type SyncDbConfig = SqlDbConfig | D1DbConfig | WebdavDbConfig

export type SyncState = 'disabled' | 'idle' | 'syncing' | 'offline' | 'error' | 'needs-password'

export interface SyncStatus {
  configured: boolean
  state: SyncState
  dbKind?: SyncDbKind
  dbLabel?: string
  lastSyncAt?: number
  lastError?: string
  pendingChanges: number
  realtime: boolean
  pollIntervalSec: number
  reconcileIntervalMin: number
}

export interface SyncDevice {
  id: string
  name: string
  platform: string
  appVersion: string
  lastSeen: number
  current: boolean
}

export interface SyncTestResult {
  ok: boolean
  error?: string
  hasVault: boolean
  latencyMs?: number
}

export interface SyncIntervals {
  pollIntervalSec: number
  reconcileIntervalMin: number
}

// ---------------------------------------------------------------- import / export

export interface SshConfigEntry {
  alias: string
  hostName: string
  port?: number
  user?: string
  identityFiles: string[]
  proxyJump?: string
  forwards: { type: 'local' | 'remote' | 'dynamic'; bindAddress: string; bindPort: number; destHost?: string; destPort?: number }[]
  /** A host with the same address/port/user already exists in the vault. */
  exists: boolean
}

export interface ImportResult {
  hosts: number
  groups: number
  keys: number
  forwards: number
  knownHosts: number
  other: number
  skipped: number
  errors: string[]
}

export interface KeyInfo {
  keyType: string
  publicKey: string
  fingerprint: string
  encrypted: boolean
  comment?: string
}

export type ToastLevel = 'info' | 'success' | 'warning' | 'error'
