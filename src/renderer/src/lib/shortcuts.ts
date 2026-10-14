import { isMac } from './api'

export type ShortcutAction =
  | 'commandPalette'
  | 'newTab'
  | 'closeTab'
  | 'nextTab'
  | 'prevTab'
  | 'localTerminal'
  | 'newHost'
  | 'openSftp'
  | 'splitRight'
  | 'splitDown'
  | 'closePane'
  | 'broadcast'
  | 'find'
  | 'copy'
  | 'paste'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset'
  | 'settings'
  | 'lock'
  | 'goToTab1'
  | 'goToTab2'
  | 'goToTab3'
  | 'goToTab4'
  | 'goToTab5'
  | 'goToTab6'
  | 'goToTab7'
  | 'goToTab8'
  | 'goToTab9'

const MAC: Record<ShortcutAction, string> = {
  commandPalette: 'Meta+K',
  newTab: 'Meta+T',
  closeTab: 'Meta+W',
  nextTab: 'Ctrl+Tab',
  prevTab: 'Ctrl+Shift+Tab',
  localTerminal: 'Meta+Shift+T',
  newHost: 'Meta+N',
  openSftp: 'Meta+Shift+O',
  splitRight: 'Meta+D',
  splitDown: 'Meta+Shift+D',
  closePane: 'Meta+Shift+W',
  broadcast: 'Meta+Shift+B',
  find: 'Meta+F',
  copy: 'Meta+C',
  paste: 'Meta+V',
  zoomIn: 'Meta+Equal',
  zoomOut: 'Meta+Minus',
  zoomReset: 'Meta+0',
  settings: 'Meta+Comma',
  lock: 'Meta+Shift+L',
  goToTab1: 'Meta+1',
  goToTab2: 'Meta+2',
  goToTab3: 'Meta+3',
  goToTab4: 'Meta+4',
  goToTab5: 'Meta+5',
  goToTab6: 'Meta+6',
  goToTab7: 'Meta+7',
  goToTab8: 'Meta+8',
  goToTab9: 'Meta+9'
}

/** Windows / Linux: Ctrl+Shift based so plain Ctrl keys keep working in the shell. */
const OTHER: Record<ShortcutAction, string> = {
  commandPalette: 'Ctrl+Shift+K',
  newTab: 'Ctrl+Shift+T',
  closeTab: 'Ctrl+Shift+W',
  nextTab: 'Ctrl+Tab',
  prevTab: 'Ctrl+Shift+Tab',
  localTerminal: 'Ctrl+Shift+Backquote',
  newHost: 'Ctrl+Shift+N',
  openSftp: 'Ctrl+Shift+O',
  splitRight: 'Ctrl+Shift+D',
  splitDown: 'Ctrl+Shift+E',
  closePane: 'Ctrl+Shift+X',
  broadcast: 'Ctrl+Shift+B',
  find: 'Ctrl+Shift+F',
  copy: 'Ctrl+Shift+C',
  paste: 'Ctrl+Shift+V',
  zoomIn: 'Ctrl+Equal',
  zoomOut: 'Ctrl+Minus',
  zoomReset: 'Ctrl+0',
  settings: 'Ctrl+Comma',
  lock: 'Ctrl+Shift+L',
  goToTab1: 'Alt+1',
  goToTab2: 'Alt+2',
  goToTab3: 'Alt+3',
  goToTab4: 'Alt+4',
  goToTab5: 'Alt+5',
  goToTab6: 'Alt+6',
  goToTab7: 'Alt+7',
  goToTab8: 'Alt+8',
  goToTab9: 'Alt+9'
}

export const SHORTCUT_ACTIONS = Object.keys(MAC) as ShortcutAction[]
const PLATFORM_KEY = isMac ? 'mac' : 'other'

export function defaultShortcut(action: ShortcutAction): string {
  return (isMac ? MAC : OTHER)[action]
}

/** Overrides are stored per platform family (synced pref item) so mac and PC layouts do not clash. */
export function resolveShortcuts(overrides: Record<string, string>): Record<ShortcutAction, string> {
  const out = {} as Record<ShortcutAction, string>
  for (const a of SHORTCUT_ACTIONS) out[a] = overrides[`${PLATFORM_KEY}:${a}`] ?? defaultShortcut(a)
  return out
}

export function overrideKey(action: ShortcutAction): string {
  return `${PLATFORM_KEY}:${action}`
}

const CODE_NAMES: Record<string, string> = {
  Backquote: 'Backquote',
  Minus: 'Minus',
  Equal: 'Equal',
  Comma: 'Comma',
  Period: 'Period',
  Slash: 'Slash',
  Backslash: 'Backslash',
  BracketLeft: 'BracketLeft',
  BracketRight: 'BracketRight',
  Semicolon: 'Semicolon',
  Quote: 'Quote',
  Tab: 'Tab',
  Enter: 'Enter',
  Space: 'Space',
  Escape: 'Escape',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  NumpadAdd: 'Equal',
  NumpadSubtract: 'Minus'
}

function keyName(e: KeyboardEvent): string | null {
  const c = e.code
  if (/^Key[A-Z]$/.test(c)) return c.slice(3)
  if (/^Digit\d$/.test(c)) return c.slice(5)
  if (/^Numpad\d$/.test(c)) return c.slice(6)
  if (/^F\d{1,2}$/.test(c)) return c
  return CODE_NAMES[c] ?? null
}

/** Normalized combo for a keyboard event, e.g. "Ctrl+Shift+T". Null for bare modifier presses. */
export function comboFromEvent(e: KeyboardEvent): string | null {
  const key = keyName(e)
  if (!key) return null
  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  if (e.metaKey) parts.push('Meta')
  parts.push(key)
  return parts.join('+')
}

const SYMBOLS: Record<string, string> = isMac
  ? { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘', Equal: '=', Minus: '-', Comma: ',', Backquote: '`', Tab: '⇥', Enter: '↩' }
  : { Meta: 'Win', Equal: '=', Minus: '-', Comma: ',', Backquote: '`' }

export function formatCombo(combo: string): string {
  const parts = combo.split('+').map((p) => SYMBOLS[p] ?? p)
  return isMac ? parts.join('') : parts.join('+')
}
