import { useEffect } from 'react'
import { call } from './api'
import { comboFromEvent, resolveShortcuts, type ShortcutAction } from './shortcuts'
import { useTerminalUi } from '@/features/terminal/TerminalView'
import { copySelection, pasteInto, zoom } from '@/features/terminal/registry'
import { useApp } from '@/stores/app'
import { activateTab, activeSessionId, activeTerminalTab, closePane, closeTab, cycleTab, openTab, splitPane, toggleBroadcast, useTabs } from '@/stores/tabs'
import { openEditor, openInSftp } from '@/stores/ui'
import { useShortcutOverrides } from '@/stores/vault'

function inTextField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  if (el.classList?.contains('xterm-helper-textarea')) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable || !!el.closest?.('.cm-editor')
}

function inTerminal(target: EventTarget | null): boolean {
  return !!(target as HTMLElement | null)?.classList?.contains('xterm-helper-textarea')
}

export function runShortcut(action: ShortcutAction, e?: KeyboardEvent): boolean {
  const tab = activeTerminalTab()
  const sid = activeSessionId()
  switch (action) {
    case 'commandPalette':
    case 'newTab':
      useApp.getState().setCommandOpen(true)
      return true
    case 'closeTab':
      if (tab) closeTab(tab.id)
      return !!tab
    case 'nextTab':
      cycleTab(1)
      return true
    case 'prevTab':
      cycleTab(-1)
      return true
    case 'localTerminal':
      void openTab({ kind: 'local' })
      return true
    case 'newHost':
      activateTab('vault')
      useApp.getState().setSection('hosts')
      openEditor('host')
      return true
    case 'openSftp': {
      const s = sid ? useTabs.getState().sessions[sid] : undefined
      if (s?.spec.kind === 'ssh' && s.spec.hostId) openInSftp(s.spec.hostId, sid)
      else activateTab('sftp')
      return true
    }
    case 'splitRight':
    case 'splitDown':
      if (!tab) return false
      void splitPane(tab.id, tab.activePaneId, action === 'splitRight' ? 'horizontal' : 'vertical')
      return true
    case 'closePane':
      if (!tab) return false
      closePane(tab.id, tab.activePaneId)
      return true
    case 'broadcast':
      if (!tab) return false
      toggleBroadcast(tab.id)
      return true
    case 'find':
      if (!tab) return false
      useTerminalUi.setState({ searchTabId: tab.id })
      return true
    case 'copy':
      if (!sid || !inTerminal(e?.target ?? null)) return false
      void copySelection(sid)
      return true
    case 'paste':
      if (!sid || !inTerminal(e?.target ?? null)) return false
      void pasteInto(sid)
      return true
    case 'zoomIn':
    case 'zoomOut':
    case 'zoomReset':
      if (!sid) return false
      zoom(sid, action === 'zoomIn' ? 1 : action === 'zoomOut' ? -1 : 'reset')
      return true
    case 'settings':
      activateTab('vault')
      useApp.getState().setSection('settings')
      return true
    case 'lock':
      if (!useApp.getState().lock.passwordEnabled) return false
      void call('lock.lock')
      return true
    default: {
      const m = /^goToTab(\d)$/.exec(action)
      if (m) {
        const tabs = useTabs.getState().tabs
        const target = tabs[Number(m[1]) - 1]
        if (target) activateTab(target.id)
        return !!target
      }
      return false
    }
  }
}

/** Global keyboard shortcuts (capture phase so they win over xterm). */
export function useGlobalShortcuts(): void {
  const overrides = useShortcutOverrides()
  useEffect(() => {
    const map = resolveShortcuts(overrides)
    const byCombo = new Map<string, ShortcutAction>()
    for (const [action, combo] of Object.entries(map)) byCombo.set(combo, action as ShortcutAction)
    const handler = (e: KeyboardEvent): void => {
      if ((window as { __sshtoolRecordingShortcut?: boolean }).__sshtoolRecordingShortcut) return
      const combo = comboFromEvent(e)
      if (!combo) return
      const action = byCombo.get(combo)
      if (!action) return
      // Let text fields keep their native copy/paste/select behavior.
      if ((action === 'copy' || action === 'paste') && inTextField(e.target)) return
      if (inTextField(e.target) && !combo.includes('+')) return
      if (document.querySelector('[role="dialog"]') && action !== 'commandPalette') return
      if (runShortcut(action, e)) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [overrides])
}
