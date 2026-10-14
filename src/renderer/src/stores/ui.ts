import { create } from 'zustand'
import { activateTab } from './tabs'

export type EditorKind = 'host' | 'group' | 'key' | 'identity' | 'snippet' | 'portForward'

export interface EditorRequest {
  kind: EditorKind
  id?: string
  /** Initial values for a new item. */
  defaults?: Record<string, unknown>
  /** Changes on every open so editors remount with fresh state. */
  nonce: number
}

interface UiState {
  editor: EditorRequest | null
  sftpRequest: { hostId: string; sessionId?: string; nonce: number } | null
  /** Current group folder in the hosts view (undefined = root). */
  hostsGroupId?: string
  hostsSearch: string
  hostsTagFilter: string[]
  runSnippetId: string | null
  serialDialogOpen: boolean
  importDialog: 'sshConfig' | null
}

export const useUi = create<UiState>(() => ({
  editor: null,
  sftpRequest: null,
  hostsSearch: '',
  hostsTagFilter: [],
  runSnippetId: null,
  serialDialogOpen: false,
  importDialog: null
}))

export function openEditor(kind: EditorKind, id?: string, defaults?: Record<string, unknown>): void {
  useUi.setState({ editor: { kind, id, defaults, nonce: Date.now() } })
}

export function closeEditor(): void {
  useUi.setState({ editor: null })
}

/** Switches to the SFTP tab and opens the given host in the right pane. */
export function openInSftp(hostId: string, sessionId?: string): void {
  useUi.setState({ sftpRequest: { hostId, sessionId, nonce: Date.now() } })
  activateTab('sftp')
}
