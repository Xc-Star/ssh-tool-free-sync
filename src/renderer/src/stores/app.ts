import { create } from 'zustand'
import type { AppInfo, ForwardState, LocalSettings, LockStatus, SyncStatus } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import i18n from '@/i18n'
import { call, on } from '@/lib/api'

export type Section = 'hosts' | 'keychain' | 'portForwarding' | 'snippets' | 'knownHosts' | 'logs' | 'settings'

interface AppState {
  ready: boolean
  info: AppInfo | null
  settings: LocalSettings
  lock: LockStatus
  sync: SyncStatus
  forwards: Record<string, ForwardState>
  section: Section
  settingsSection: string
  resolvedTheme: 'dark' | 'light'
  commandOpen: boolean
  setSection: (s: Section, settingsSection?: string) => void
  setCommandOpen: (open: boolean) => void
  updateSettings: (patch: Partial<LocalSettings>) => Promise<void>
}

const media = window.matchMedia('(prefers-color-scheme: dark)')

function resolveTheme(mode: LocalSettings['theme']): 'dark' | 'light' {
  if (mode === 'system') return media.matches ? 'dark' : 'light'
  return mode
}

function applyTheme(theme: 'dark' | 'light'): void {
  document.documentElement.classList.toggle('dark', theme === 'dark')
  document.documentElement.style.colorScheme = theme
  void call('app.setTitleBarTheme', theme).catch(() => {})
}

export const useApp = create<AppState>((set) => ({
  ready: false,
  info: null,
  settings: DEFAULT_SETTINGS,
  lock: { locked: false, passwordEnabled: false, backend: '', weak: false, autoLockMinutes: 0 },
  sync: { configured: false, state: 'disabled', pendingChanges: 0, realtime: false, pollIntervalSec: 60, reconcileIntervalMin: 15 },
  forwards: {},
  section: 'hosts',
  settingsSection: 'general',
  resolvedTheme: 'dark',
  commandOpen: false,
  setSection: (section, settingsSection) => set({ section, ...(settingsSection ? { settingsSection } : {}) }),
  setCommandOpen: (commandOpen) => set({ commandOpen }),
  updateSettings: async (patch) => {
    const settings = await call('settings.set', patch)
    applySettings(settings)
    set({ settings })
  }
}))

function applySettings(settings: LocalSettings): void {
  const theme = resolveTheme(settings.theme)
  applyTheme(theme)
  useApp.setState({ resolvedTheme: theme })
  if (i18n.language !== settings.language) void i18n.changeLanguage(settings.language)
  document.documentElement.lang = settings.language
}

export async function initApp(): Promise<void> {
  const [info, settings, lock, sync, forwards] = await Promise.all([
    call('app.info'),
    call('settings.get'),
    call('lock.status'),
    call('sync.status'),
    call('forward.states')
  ])
  applySettings(settings)
  useApp.setState({
    info,
    settings,
    lock,
    sync,
    forwards: Object.fromEntries(forwards.map((f) => [f.ruleId, f])),
    ready: true
  })
  on('settings.changed', (s) => {
    applySettings(s)
    useApp.setState({ settings: s })
  })
  on('lock.changed', (lock) => useApp.setState({ lock }))
  on('sync.status', (sync) => useApp.setState({ sync }))
  on('forward.states', (list) => useApp.setState({ forwards: Object.fromEntries(list.map((f) => [f.ruleId, f])) }))
  media.addEventListener('change', () => {
    const s = useApp.getState().settings
    if (s.theme === 'system') applySettings(s)
  })
}
