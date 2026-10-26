import type { AiChatRequest, AiConfigInput, AiConfigSummary, AiTestResult } from './ai'
import type { Item, ItemKind, KindInput, SerialProfileData } from './schemas'
import type {
  AppInfo,
  FileEntry,
  ForwardState,
  FsInfo,
  HistoryEntry,
  ImportResult,
  KeyInfo,
  LocalSettings,
  LockStatus,
  OpenLocalParams,
  OpenSerialParams,
  OpenSshParams,
  OpenTelnetParams,
  PromptRequest,
  SerialPortInfo,
  SessionInfo,
  ShellInfo,
  SshConfigEntry,
  SyncDbConfig,
  SyncDevice,
  SyncIntervals,
  SyncStatus,
  SyncTestResult,
  TextFileContent,
  ToastLevel,
  TransferInfo,
  UpdateCheckResult
} from './types'

export interface UpsertOptions {
  id?: string
  localOnly?: boolean
}

export interface DialogFilter {
  name: string
  extensions: string[]
}

/**
 * Request/response API exposed by the main process. Every method is invoked through a single
 * `rpc` IPC channel; return values are delivered as promises in the renderer.
 */
export interface Api {
  // app
  'app.info': () => AppInfo
  'app.openExternal': (url: string) => void
  'app.showItemInFolder': (path: string) => void
  'app.openFileDialog': (opts: { title?: string; filters?: DialogFilter[]; directory?: boolean; multi?: boolean; defaultPath?: string }) => string[]
  'app.saveFileDialog': (opts: { title?: string; defaultPath?: string; filters?: DialogFilter[] }) => string | null
  'app.readTextFile': (path: string, maxBytes?: number) => string
  'app.setTitleBarTheme': (theme: 'dark' | 'light') => void

  // lock / keystore
  'lock.status': () => LockStatus
  'lock.unlock': (password: string) => boolean
  'lock.lock': () => void
  'lock.enablePassword': (password: string) => void
  'lock.disablePassword': (password: string) => void
  'lock.changePassword': (oldPassword: string, newPassword: string) => void
  /** Retries reading the vault key from the OS keychain (see LockStatus.keystoreError). */
  'lock.retryKeystore': () => LockStatus
  /** Deletes the local vault and starts over with an empty one (synced data can be re-joined). */
  'lock.resetLocal': () => LockStatus

  // vault
  'vault.list': (kind?: ItemKind) => Item[]
  'vault.get': (id: string) => Item | null
  'vault.reveal': (id: string) => Item | null
  'vault.upsert': <K extends ItemKind>(kind: K, data: KindInput[K], opts?: UpsertOptions) => Item<K>
  'vault.patch': (id: string, patch: Record<string, unknown>) => Item
  'vault.remove': (ids: string[]) => void
  'vault.duplicate': (id: string) => Item
  'vault.setLocalOnly': (id: string, localOnly: boolean) => Item

  // keys
  'keys.generate': (opts: { label: string; type: 'ed25519' | 'rsa' | 'ecdsa'; bits?: number; passphrase?: string; comment?: string }) => Item<'key'>
  'keys.inspect': (privateKey: string, passphrase?: string) => KeyInfo
  'keys.import': (opts: { label: string; privateKey: string; passphrase?: string; certificate?: string }) => Item<'key'>
  'keys.importFile': (path: string, label?: string, passphrase?: string) => Item<'key'>
  'keys.exportToHost': (keyId: string, hostId: string) => { added: boolean; message: string }
  'keys.savePrivateKey': (keyId: string, path: string) => void

  // sessions
  'session.openSsh': (params: OpenSshParams) => SessionInfo
  'session.openLocal': (params: OpenLocalParams) => SessionInfo
  'session.openTelnet': (params: OpenTelnetParams) => SessionInfo
  'session.openSerial': (params: OpenSerialParams) => SessionInfo
  'session.close': (id: string) => void
  'session.reconnect': (id: string) => SessionInfo
  'session.list': () => SessionInfo[]
  'session.shells': () => ShellInfo[]
  'session.serialPorts': () => SerialPortInfo[]
  'session.exec': (hostId: string, command: string) => { code: number | null; stdout: string; stderr: string }

  // prompts
  'prompt.respond': (id: string, response: unknown) => void

  // filesystems (local + sftp)
  'fs.openLocal': () => FsInfo
  'fs.openSftp': (hostId: string, sessionId?: string) => FsInfo
  'fs.close': (fsId: string) => void
  'fs.list': (fsId: string, path: string) => FileEntry[]
  'fs.stat': (fsId: string, path: string) => FileEntry
  'fs.realpath': (fsId: string, path: string) => string
  'fs.mkdir': (fsId: string, path: string) => void
  'fs.newFile': (fsId: string, path: string) => void
  'fs.rename': (fsId: string, from: string, to: string) => void
  'fs.remove': (fsId: string, paths: string[]) => void
  'fs.chmod': (fsId: string, path: string, mode: number, recursive?: boolean) => void
  'fs.readText': (fsId: string, path: string) => TextFileContent
  'fs.writeText': (fsId: string, path: string, content: string) => void
  'fs.editExternal': (fsId: string, path: string) => void
  'fs.openLocalPath': (path: string) => void

  // transfers
  'transfer.enqueue': (req: { srcFsId: string; srcPaths: string[]; dstFsId: string; dstDir: string }) => string
  'transfer.list': () => TransferInfo[]
  'transfer.cancel': (id: string) => void
  'transfer.retry': (id: string) => void
  'transfer.clear': () => void

  // port forwarding
  'forward.start': (ruleId: string) => void
  'forward.stop': (ruleId: string) => void
  'forward.states': () => ForwardState[]

  // history / known hosts
  'history.list': (limit?: number) => HistoryEntry[]
  'history.clear': () => void
  'knownHosts.importFile': (path?: string) => ImportResult

  // settings
  'settings.get': () => LocalSettings
  'settings.set': (patch: Partial<LocalSettings>) => LocalSettings

  // sync
  'sync.status': () => SyncStatus
  'sync.getConfig': () => SyncDbConfig | null
  'sync.test': (config: SyncDbConfig) => SyncTestResult
  'sync.create': (config: SyncDbConfig, masterPassword: string) => SyncStatus
  'sync.join': (config: SyncDbConfig, masterPassword: string) => SyncStatus
  'sync.unlock': (masterPassword: string) => SyncStatus
  'sync.now': () => SyncStatus
  'sync.disconnect': () => void
  'sync.changePassword': (oldPassword: string, newPassword: string) => void
  'sync.rotateKey': (masterPassword: string) => void
  'sync.devices': () => SyncDevice[]
  'sync.setIntervals': (intervals: SyncIntervals) => SyncStatus

  // import / export
  'import.sshConfigPreview': (path?: string) => SshConfigEntry[]
  'import.sshConfigApply': (entries: SshConfigEntry[], groupName?: string) => ImportResult
  'import.csv': (path: string) => ImportResult
  'backup.export': (path: string, password: string) => number
  'backup.import': (path: string, password: string) => ImportResult
  'export.hostsCsv': (path: string) => number

  // serial helpers
  'serial.defaultProfile': () => SerialProfileData

  // updates
  /** Checks GitHub Releases for a newer version now (ignores the autoCheckUpdates setting). */
  'update.check': () => UpdateCheckResult

  // ai
  'ai.getConfigs': () => AiConfigSummary[]
  'ai.saveConfig': (config: AiConfigInput) => AiConfigSummary
  'ai.removeConfig': (id: string) => void
  'ai.testConfig': (config: AiConfigInput) => AiTestResult
  'ai.listModels': (config: AiConfigInput) => string[]
  /** Starts an agent run; results arrive as `ai.*` events. */
  'ai.chat': (req: AiChatRequest) => void
  'ai.resolveConfirm': (confirmId: string, approve: boolean, autoRest?: boolean) => void
  'ai.abort': (conversationId: string) => void
}

export type ApiMethod = keyof Api

/** Events pushed from main to renderer. */
export interface Events {
  'vault.changed': { kinds: ItemKind[] }
  'lock.changed': LockStatus
  'session.status': SessionInfo
  'session.log': { id: string; line: string; level: 'info' | 'warn' | 'error' }
  'prompt.request': PromptRequest
  'prompt.cancel': { id: string }
  'transfer.update': TransferInfo[]
  'forward.states': ForwardState[]
  'sync.status': SyncStatus
  'settings.changed': LocalSettings
  'history.changed': Record<string, never>
  'toast': { level: ToastLevel; message: string; detail?: string }
  'fs.changed': { fsId: string; dir: string }
  'update.available': { version: string; url: string }
  'ai.delta': { conversationId: string; text: string }
  'ai.toolCall': { conversationId: string; callId: string; name: string; args: Record<string, unknown> }
  'ai.confirm': { confirmId: string; conversationId: string; callId: string; name: string; args: Record<string, unknown> }
  'ai.toolResult': { conversationId: string; callId: string; name: string; ok: boolean; result: string }
  'ai.done': { conversationId: string; reason: 'stop' | 'maxTurns' | 'aborted' | 'error'; error?: string }
}

export type EventName = keyof Events

/** Fire-and-forget channels from renderer → main (hot paths). */
export interface SendChannels {
  'session.write': [id: string, data: string]
  'session.resize': [id: string, cols: number, rows: number]
  'session.ack': [id: string, bytes: number]
}

/** Result envelope used by the rpc channel so errors keep their message/code across IPC. */
export type RpcResult = { ok: true; value: unknown } | { ok: false; error: { message: string; code?: string } }

/** Bridge exposed on `window.sshtool` by the preload script. */
export interface PreloadBridge {
  platform: string
  invoke(method: string, ...args: unknown[]): Promise<RpcResult>
  send<C extends keyof SendChannels>(channel: C, ...args: SendChannels[C]): void
  on(event: string, listener: (payload: unknown) => void): () => void
  onSessionData(listener: (id: string, data: string) => void): () => void
  getPathForFile(file: File): string
}
