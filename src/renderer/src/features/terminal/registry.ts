import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import type { TerminalPrefs } from '@shared/schemas'
import { call, isMac, isWin, onSessionData, send } from '@/lib/api'
import { copyText } from '@/lib/utils'
import { getTerminalPrefs } from '@/stores/vault'
import { getTheme } from './themes'

export interface TermOverrides {
  theme?: string
  fontSize?: number
}

interface Entry {
  sessionId: string
  term: Terminal
  fit: FitAddon
  search: SearchAddon
  element: HTMLDivElement
  opened: boolean
  webgl?: WebglAddon
  overrides: TermOverrides
  zoom: number
  resizeTimer?: number
  /** Line typed so far (best effort, used for autocomplete history). */
  lineBuffer: string
}

const entries = new Map<string, Entry>()
/** Output that arrived before the renderer created the terminal. */
const early = new Map<string, string[]>()
let currentPrefs: TerminalPrefs | null = null
let resolvedDark = true

type InputRouter = (sessionId: string, data: string) => void
let inputRouter: InputRouter = (id, data) => send('session.write', id, data)
type LineListener = (sessionId: string, line: string) => void
const lineListeners = new Set<LineListener>()
const lineChangeListeners = new Set<LineListener>()
type KeyInterceptor = (e: KeyboardEvent) => boolean
const keyInterceptors = new Map<string, KeyInterceptor>()

export function setInputRouter(fn: InputRouter): void {
  inputRouter = fn
}

/** Notified with each command line the user submits (for autocomplete history). */
export function onCommandLine(fn: LineListener): () => void {
  lineListeners.add(fn)
  return () => lineListeners.delete(fn)
}

/** Notified whenever the tracked input line changes. */
export function onLineChange(fn: LineListener): () => void {
  lineChangeListeners.add(fn)
  return () => lineChangeListeners.delete(fn)
}

/** Lets a component swallow keys before xterm handles them (return false to swallow). */
export function setKeyInterceptor(sessionId: string, fn: KeyInterceptor | null): void {
  if (fn) keyInterceptors.set(sessionId, fn)
  else keyInterceptors.delete(sessionId)
}

/** Sends input to the session as if typed, keeping the tracked line in sync. */
export function sendInput(sessionId: string, data: string): void {
  const e = entries.get(sessionId)
  if (e) trackInput(e, data)
  inputRouter(sessionId, data)
}

onSessionData((id, data) => {
  const e = entries.get(id)
  if (!e) {
    const buf = early.get(id) ?? []
    buf.push(data)
    early.set(id, buf)
    send('session.ack', id, data.length)
    return
  }
  e.term.write(data, () => send('session.ack', id, data.length))
})

function prefs(): TerminalPrefs {
  return currentPrefs ?? getTerminalPrefs()
}

function optionsFor(o: TermOverrides, zoom: number) {
  const p = prefs()
  return {
    fontFamily: `"${p.fontFamily}", "JetBrains Mono", "Cascadia Mono", Menlo, Consolas, monospace`,
    fontSize: Math.max(6, (o.fontSize ?? p.fontSize) + zoom),
    lineHeight: p.lineHeight,
    cursorStyle: p.cursorStyle,
    cursorBlink: p.cursorBlink,
    scrollback: p.scrollback,
    theme: getTheme(o.theme ?? p.theme, resolvedDark).theme
  }
}

export function themeBackground(sessionId: string): string {
  const e = entries.get(sessionId)
  const p = prefs()
  return getTheme(e?.overrides.theme ?? p.theme, resolvedDark).theme.background ?? '#131520'
}

function trackInput(e: Entry, data: string): void {
  if (data.startsWith('\x1b') || data === '\t') {
    e.lineBuffer = ''
  } else {
    for (const ch of data) {
      if (ch === '\r') {
        const line = e.lineBuffer.trim()
        e.lineBuffer = ''
        if (line) for (const l of lineListeners) l(e.sessionId, line)
      } else if (ch === '\x7f' || ch === '\b') e.lineBuffer = e.lineBuffer.slice(0, -1)
      else if (ch === '\x03' || ch === '\x15' || ch === '\x04') e.lineBuffer = ''
      else if (ch >= ' ') e.lineBuffer += ch
    }
  }
  for (const l of lineChangeListeners) l(e.sessionId, e.lineBuffer)
}

export function createTerminal(sessionId: string, overrides: TermOverrides = {}): Entry {
  const existing = entries.get(sessionId)
  if (existing) return existing
  const term = new Terminal({
    ...optionsFor(overrides, 0),
    allowProposedApi: true,
    macOptionIsMeta: isMac,
    rightClickSelectsWord: false,
    drawBoldTextInBrightColors: true,
    minimumContrastRatio: 1,
    smoothScrollDuration: 0,
    windowsPty: isWin ? { backend: 'conpty' } : undefined
  })
  const fit = new FitAddon()
  const search = new SearchAddon()
  term.loadAddon(fit)
  term.loadAddon(search)
  term.loadAddon(new WebLinksAddon((_e, uri) => void call('app.openExternal', uri).catch(() => {})))
  const unicode = new Unicode11Addon()
  term.loadAddon(unicode)
  term.unicode.activeVersion = '11'
  const element = document.createElement('div')
  element.className = 'terminal-host'
  const entry: Entry = { sessionId, term, fit, search, element, opened: false, overrides, zoom: 0, lineBuffer: '' }
  entries.set(sessionId, entry)
  term.onData((d) => {
    trackInput(entry, d)
    inputRouter(sessionId, d)
  })
  term.onBinary((d) => inputRouter(sessionId, d))
  term.attachCustomKeyEventHandler((ev) => {
    const f = keyInterceptors.get(sessionId)
    return f ? f(ev) : true
  })
  term.onResize(({ cols, rows }) => send('session.resize', sessionId, cols, rows))
  term.onSelectionChange(() => {
    if (prefs().copyOnSelect && term.hasSelection()) void copyText(term.getSelection()).catch(() => {})
  })
  term.onBell(() => {
    if (prefs().bell) new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=').play().catch(() => {})
  })
  const pending = early.get(sessionId)
  if (pending) {
    early.delete(sessionId)
    term.write(pending.join(''))
  }
  return entry
}

export function getTerminal(sessionId: string): Entry | undefined {
  return entries.get(sessionId)
}

export function disposeTerminal(sessionId: string): void {
  const e = entries.get(sessionId)
  early.delete(sessionId)
  if (!e) return
  entries.delete(sessionId)
  keyInterceptors.delete(sessionId)
  try {
    e.webgl?.dispose()
  } catch {
    // ignore
  }
  e.term.dispose()
  e.element.remove()
}

function loadWebgl(e: Entry): void {
  try {
    const webgl = new WebglAddon()
    webgl.onContextLoss(() => {
      webgl.dispose()
      e.webgl = undefined
    })
    e.term.loadAddon(webgl)
    e.webgl = webgl
  } catch {
    e.webgl = undefined
  }
}

/** Moves the (persistent) terminal element into a pane container. */
export function attachTerminal(sessionId: string, container: HTMLElement): void {
  const e = entries.get(sessionId)
  if (!e) return
  if (e.element.parentElement !== container) container.appendChild(e.element)
  if (!e.opened) {
    e.term.open(e.element)
    e.opened = true
    loadWebgl(e)
  }
  fitTerminal(sessionId)
}

export function detachTerminal(sessionId: string, container: HTMLElement): void {
  const e = entries.get(sessionId)
  if (e && e.element.parentElement === container) container.removeChild(e.element)
}

export function fitTerminal(sessionId: string): void {
  const e = entries.get(sessionId)
  if (!e || !e.opened || !e.element.isConnected) return
  if (e.element.clientWidth < 20 || e.element.clientHeight < 20) return
  try {
    e.fit.fit()
  } catch {
    // element not measurable yet
  }
}

export function scheduleFit(sessionId: string): void {
  const e = entries.get(sessionId)
  if (!e) return
  if (e.resizeTimer) window.clearTimeout(e.resizeTimer)
  e.resizeTimer = window.setTimeout(() => fitTerminal(sessionId), 30)
}

/**
 * True when the user is working somewhere else (dialog, command palette, menu, form field), so an
 * automatic focus (session connected, tab shown) must not steal the keyboard from it.
 */
function focusBusyElsewhere(): boolean {
  const el = document.activeElement as HTMLElement | null
  if (!el || el === document.body || el.closest('.xterm')) return false
  // A field on a page that is now hidden (e.g. the vault search box after a quick connect) doesn't count.
  if (el.getClientRects().length === 0) return false
  if (el.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [cmdk-root]')) return true
  return el.matches('input, textarea, select, [contenteditable="true"]')
}

/** `auto`: focus requested by the app rather than a user action; skipped while the user is busy elsewhere. */
export function focusTerminal(sessionId: string, opts: { auto?: boolean } = {}): void {
  if (opts.auto && focusBusyElsewhere()) return
  entries.get(sessionId)?.term.focus()
}

export function applyTerminalPrefs(p: TerminalPrefs, dark: boolean): void {
  currentPrefs = p
  resolvedDark = dark
  for (const e of entries.values()) {
    Object.assign(e.term.options, optionsFor(e.overrides, e.zoom))
    scheduleFit(e.sessionId)
  }
}

export function setOverrides(sessionId: string, overrides: TermOverrides): void {
  const e = entries.get(sessionId)
  if (!e) return
  e.overrides = overrides
  Object.assign(e.term.options, optionsFor(overrides, e.zoom))
  scheduleFit(sessionId)
}

export function zoom(sessionId: string, delta: number | 'reset'): void {
  const e = entries.get(sessionId)
  if (!e) return
  e.zoom = delta === 'reset' ? 0 : Math.max(-8, Math.min(24, e.zoom + delta))
  e.term.options.fontSize = optionsFor(e.overrides, e.zoom).fontSize
  scheduleFit(sessionId)
}

export async function copySelection(sessionId: string): Promise<boolean> {
  const e = entries.get(sessionId)
  if (!e?.term.hasSelection()) return false
  await copyText(e.term.getSelection())
  return true
}

export async function pasteInto(sessionId: string): Promise<void> {
  const e = entries.get(sessionId)
  if (!e) return
  const text = await navigator.clipboard.readText()
  if (text) e.term.paste(text)
}

/** Writes text as if typed (snippets). `run` appends Enter. */
export function typeInto(sessionId: string, text: string, run: boolean): void {
  const e = entries.get(sessionId)
  if (!e) return
  const normalized = text.replace(/\r\n/g, '\n').replace(/\n+$/, '')
  if (run) {
    const data = `${normalized.replace(/\n/g, '\r')}\r`
    inputRouter(sessionId, data)
  } else {
    e.term.paste(normalized)
  }
  e.term.focus()
}

export function currentLine(sessionId: string): string {
  return entries.get(sessionId)?.lineBuffer ?? ''
}

export function clearTerminal(sessionId: string): void {
  entries.get(sessionId)?.term.clear()
}

export function selectAllTerminal(sessionId: string): void {
  entries.get(sessionId)?.term.selectAll()
}

export function findInTerminal(sessionId: string, query: string, direction: 'next' | 'prev', opts: { caseSensitive?: boolean; regex?: boolean } = {}): boolean {
  const e = entries.get(sessionId)
  if (!e || !query) return false
  const searchOpts = {
    caseSensitive: opts.caseSensitive,
    regex: opts.regex,
    decorations: { matchOverviewRuler: '#f0a53a', activeMatchColorOverviewRuler: '#5b7fff', matchBackground: '#f0a53a55', activeMatchBackground: '#5b7fff88' }
  }
  return direction === 'next' ? e.search.findNext(query, searchOpts) : e.search.findPrevious(query, searchOpts)
}

export function clearSearch(sessionId: string): void {
  entries.get(sessionId)?.search.clearDecorations()
}

/** Plain-text dump of the scrollback (save output). */
export function bufferText(sessionId: string): string {
  const e = entries.get(sessionId)
  if (!e) return ''
  const buf = e.term.buffer.active
  const lines: string[] = []
  for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '')
  return lines.join('\n').replace(/\n+$/, '\n')
}

// Read-only hook for end-to-end tests (the terminal renders to a canvas, so its text is not in the DOM).
;(window as unknown as { __sshtoolTerminalText?: (id: string) => string }).__sshtoolTerminalText = bufferText
