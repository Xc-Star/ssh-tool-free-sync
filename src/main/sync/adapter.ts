import type { SyncDbKind } from '@shared/types'
import type { KdfParams } from '../vault/crypto'

/** Remote schema version written by this app. Clients refuse to write to a newer schema. */
export const SCHEMA_VERSION = 1

/** The single vault description row stored in `<prefix>meta` under key `vault`. */
export interface VaultMeta {
  vaultId: string
  /** Incremented on every key rotation. */
  keyEpoch: number
  kdf: KdfParams
  /** base64 salt for the master-password KDF. */
  salt: string
  /** base64 vault key encrypted with the master-password derived key. */
  wrappedKey: string
  createdAt: number
  createdBy: string
}

/** Item as stored remotely. `payload` is opaque ciphertext (null for tombstones). */
export interface RemoteItem {
  id: string
  payload: Buffer | null
  hlc: string
  deleted: boolean
  deviceId: string
  seq: number
}

export type PushItem = Omit<RemoteItem, 'seq'>

export interface RemoteDevice {
  id: string
  /** Encrypted device description (opaque to the adapter). */
  info: Buffer | null
  lastSeen: number
}

export interface AdapterCapabilities {
  /** Supports push notifications (PostgreSQL LISTEN/NOTIFY). */
  realtime: boolean
  defaultPollSec: number
  defaultReconcileMin: number
}

export class SchemaTooNewError extends Error {
  constructor(readonly remoteVersion: number) {
    super(`The sync database uses schema v${remoteVersion}, which is newer than this app supports. Please update the app.`)
    this.name = 'SchemaTooNewError'
  }
}

export type SyncErrorCode = 'network' | 'auth' | 'config' | 'rate-limit' | 'schema' | 'unknown'

/**
 * Error thrown by adapters. `network` and `rate-limit` are treated as transient (offline / retry
 * with backoff); the others are surfaced to the user as configuration problems.
 */
export class SyncAdapterError extends Error {
  constructor(
    readonly code: SyncErrorCode,
    message: string,
    readonly cause?: unknown
  ) {
    super(message)
    this.name = 'SyncAdapterError'
  }

  get transient(): boolean {
    return this.code === 'network' || this.code === 'rate-limit'
  }
}

/**
 * Storage backend for sync. Implementations: PostgreSQL, MySQL/MariaDB, Cloudflare D1, WebDAV.
 *
 * Contract (verified by tests/integration/adapter-conformance.ts):
 *  - `push` writes an item only when its `hlc` is strictly greater than the stored one
 *    (string comparison); every written item gets a new seq.
 *  - seqs are unique and strictly increasing in commit order, so a reader paging with
 *    `pull(afterSeq)` never misses a committed item, even with concurrent writers.
 *  - `createVaultMeta` is race-safe: exactly one concurrent caller gets `true`.
 */
export interface SyncAdapter {
  readonly kind: SyncDbKind
  readonly capabilities: AdapterCapabilities
  /** Human readable target without secrets, e.g. "PostgreSQL · db.example.com/sshtool". */
  readonly label: string

  connect(): Promise<void>
  close(): Promise<void>

  /** Creates the tables when missing and records the schema version. */
  ensureSchema(): Promise<void>

  getVaultMeta(): Promise<VaultMeta | null>
  createVaultMeta(meta: VaultMeta): Promise<boolean>
  updateVaultMeta(meta: VaultMeta): Promise<void>

  push(items: PushItem[]): Promise<void>
  pull(afterSeq: number, limit: number): Promise<RemoteItem[]>
  getItems(ids: string[]): Promise<RemoteItem[]>
  head(): Promise<number>
  listIndex(): Promise<{ id: string; hlc: string }[]>

  upsertDevice(device: RemoteDevice): Promise<void>
  listDevices(): Promise<RemoteDevice[]>
  deleteDevice(id: string): Promise<void>

  /** Optional real-time change feed. Returns an unsubscribe function. */
  subscribe?(onChange: () => void, onError?: (err: Error) => void): Promise<() => Promise<void>>
}

/** Validates a table prefix (it is interpolated into SQL identifiers). */
export function assertTablePrefix(prefix: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,30}$/.test(prefix)) {
    throw new Error('Table prefix must start with a letter and contain only letters, digits and underscores (max 31).')
  }
  return prefix
}
