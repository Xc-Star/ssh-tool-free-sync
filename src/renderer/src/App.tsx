import { Toaster, toast } from 'sonner'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { CommandPalette } from './components/CommandPalette'
import { LockScreen } from './components/LockScreen'
import { PromptHost } from './components/PromptHost'
import { Sidebar } from './components/Sidebar'
import { TabBar } from './components/TabBar'
import { DialogHost } from './components/ui/confirm'
import { TooltipProvider } from './components/ui/controls'
import { Editors } from './features/editors'
import { HostsPage } from './features/hosts/HostsPage'
import { KeychainPage } from './features/keychain/KeychainPage'
import { KnownHostsPage } from './features/known-hosts/KnownHostsPage'
import { LogsPage } from './features/logs/LogsPage'
import { PortForwardingPage } from './features/port-forwarding/PortForwardingPage'
import { SettingsPage } from './features/settings/SettingsPage'
import { SftpPage } from './features/sftp/SftpPage'
import { RunSnippetDialog } from './features/snippets/RunSnippetDialog'
import { SnippetsPage } from './features/snippets/SnippetsPage'
import { SerialDialog } from './features/terminal/SerialDialog'
import { TerminalPrefsSync, TerminalView } from './features/terminal/TerminalView'
import { call, on } from './lib/api'
import { useGlobalShortcuts } from './lib/use-shortcuts'
import { cn } from './lib/utils'
import { useApp } from './stores/app'
import { useTabs } from './stores/tabs'
import { useUi } from './stores/ui'

function GlobalRunSnippet(): React.JSX.Element | null {
  const id = useUi((s) => s.runSnippetId)
  return <RunSnippetDialog snippetId={id} onClose={() => useUi.setState({ runSnippetId: null })} />
}

function SectionPage(): React.JSX.Element {
  const section = useApp((s) => s.section)
  switch (section) {
    case 'keychain':
      return <KeychainPage />
    case 'portForwarding':
      return <PortForwardingPage />
    case 'snippets':
      return <SnippetsPage />
    case 'knownHosts':
      return <KnownHostsPage />
    case 'logs':
      return <LogsPage />
    case 'settings':
      return <SettingsPage />
    default:
      return <HostsPage />
  }
}

export function App(): React.JSX.Element {
  const { t } = useTranslation('common')
  const locked = useApp((s) => s.lock.locked)
  const theme = useApp((s) => s.resolvedTheme)
  const activeTabId = useTabs((s) => s.activeTabId)
  const tabs = useTabs((s) => s.tabs)
  useGlobalShortcuts()

  useEffect(
    () =>
      on('toast', ({ level, message, detail }) => {
        const fn = level === 'error' ? toast.error : level === 'success' ? toast.success : level === 'warning' ? toast.warning : toast.info
        fn(message, { description: detail })
      }),
    []
  )

  useEffect(
    () =>
      on('update.available', ({ version, url }) => {
        toast.info(t('update.toastTitle', { version }), {
          description: t('update.toastDesc'),
          action: {
            label: t('update.goDownload'),
            onClick: () => void call('app.openExternal', url).catch(() => {})
          }
        })
      }),
    [t]
  )

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col">
        <TabBar />
        <div className="relative min-h-0 flex-1">
          {locked ? (
            <LockScreen />
          ) : (
            <>
              <div className={cn('absolute inset-0 flex', activeTabId !== 'vault' && 'hidden')}>
                <Sidebar />
                <main className="relative min-w-0 flex-1 overflow-hidden">
                  <SectionPage />
                </main>
              </div>
              <div className={cn('absolute inset-0', activeTabId !== 'sftp' && 'hidden')}>
                <SftpPage />
              </div>
              {tabs.map((tab) => (tab.kind === 'terminal' ? <TerminalView key={tab.id} tab={tab} visible={tab.id === activeTabId} /> : null))}
            </>
          )}
        </div>
      </div>
      {!locked && (
        <>
          <Editors />
          <CommandPalette />
          <SerialDialog />
          <GlobalRunSnippet />
          <TerminalPrefsSync />
        </>
      )}
      <PromptHost />
      <DialogHost />
      <Toaster theme={theme} position="bottom-right" richColors closeButton toastOptions={{ className: 'text-[13px]' }} />
    </TooltipProvider>
  )
}
