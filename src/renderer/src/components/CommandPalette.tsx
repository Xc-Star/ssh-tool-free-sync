import { Command } from 'cmdk'
import { Bot, Braces, FolderOpen, FolderPlus, Lock, Moon, Plus, RefreshCcw, Server, Settings, Sun, Terminal, Usb, Zap } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { parseQuickConnect } from '@shared/util'
import { call } from '@/lib/api'
import { HostAvatar } from './HostAvatar'
import { typeInto } from '@/features/terminal/registry'
import { useTerminalUi } from '@/features/terminal/TerminalView'
import { useApp } from '@/stores/app'
import { activateTab, activeSessionId, findTabBySession, openHost, openTab } from '@/stores/tabs'
import { openEditor, useUi } from '@/stores/ui'
import { useItems } from '@/stores/vault'

export function CommandPalette(): React.JSX.Element | null {
  const { t } = useTranslation('palette')
  const open = useApp((s) => s.commandOpen)
  const setOpen = useApp((s) => s.setCommandOpen)
  const hosts = useItems('host')
  const groups = useItems('group')
  const tags = useItems('tag')
  const snippets = useItems('snippet')
  const lock = useApp((s) => s.lock)
  const theme = useApp((s) => s.resolvedTheme)
  const updateSettings = useApp((s) => s.updateSettings)
  const syncConfigured = useApp((s) => s.sync.configured)
  const [query, setQuery] = useState('')

  const quick = useMemo(() => {
    const q = parseQuickConnect(query)
    if (!q || !/[@:.\s]/.test(query.trim())) return null
    return q
  }, [query])

  const groupName = useMemo(() => new Map(groups.map((g) => [g.id, g.data.name])), [groups])
  const tagName = useMemo(() => new Map(tags.map((g) => [g.id, g.data.name])), [tags])

  if (!open) return null
  const close = (): void => {
    setOpen(false)
    setQuery('')
  }
  const run = (fn: () => void): void => {
    close()
    fn()
  }
  const sid = activeSessionId()

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-overlay pt-[12vh]" onMouseDown={close}>
      <Command
        className="w-[600px] max-w-[92vw] overflow-hidden rounded-xl border border-line bg-elevated shadow-pop animate-fade-in"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close()
        }}
        loop
        data-testid="command-palette"
      >
        <div className="flex items-center gap-2 border-b border-line px-4">
          <Zap className="size-4 shrink-0 text-accent" />
          <Command.Input
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder={t('placeholder')}
            className="h-12 flex-1 bg-transparent text-[14px] text-fg outline-none placeholder:text-subtle"
          />
        </div>
        <Command.List className="max-h-[420px] overflow-y-auto p-2 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-subtle">
          <Command.Empty className="px-3 py-8 text-center text-xs text-subtle">{t('empty')}</Command.Empty>
          {quick && (
            <Command.Group heading={t('quickConnect')} forceMount>
              <Item
                value={`quick ${query}`}
                onSelect={() => run(() => void openTab({ kind: 'ssh', inline: { address: quick.address, port: quick.port, username: quick.username } }))}
                icon={<Zap />}
                label={t('connectTo', { target: `${quick.username ? `${quick.username}@` : ''}${quick.address}${quick.port ? `:${quick.port}` : ''}` })}
                hint="SSH"
              />
            </Command.Group>
          )}
          {hosts.length > 0 && (
            <Command.Group heading={t('hosts')}>
              {hosts.map((h) => (
                <Command.Item
                  key={h.id}
                  value={`host ${h.data.label} ${h.data.address} ${h.data.username ?? ''} ${groupName.get(h.data.groupId ?? '') ?? ''} ${h.data.tagIds.map((x) => tagName.get(x)).join(' ')} ${h.id}`}
                  onSelect={() => run(() => void openHost(h.id, h.data.sshEnabled === false && h.data.telnetEnabled ? 'telnet' : 'ssh'))}
                  className="flex h-11 cursor-default items-center gap-3 rounded-lg px-2 text-[13px] data-[selected=true]:bg-accent-soft"
                >
                  <HostAvatar size="sm" osHint={h.data.osHint} label={h.data.label || h.data.address} className="size-7 [&_svg]:size-4" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{h.data.label || h.data.address}</div>
                    <div className="truncate text-xs text-muted">
                      {h.data.username ? `${h.data.username}@` : ''}
                      {h.data.address}
                      {groupName.get(h.data.groupId ?? '') ? ` · ${groupName.get(h.data.groupId ?? '')}` : ''}
                    </div>
                  </div>
                </Command.Item>
              ))}
            </Command.Group>
          )}
          {snippets.length > 0 && (
            <Command.Group heading={t('snippets')}>
              {snippets.map((s) => (
                <Item
                  key={s.id}
                  value={`snippet ${s.data.label} ${s.data.script.slice(0, 200)} ${s.id}`}
                  onSelect={() => run(() => (sid ? typeInto(sid, s.data.script, true) : useUi.setState({ runSnippetId: s.id })))}
                  icon={<Braces />}
                  label={s.data.label}
                  hint={sid ? t('runInTerminal') : t('runOnHosts')}
                />
              ))}
            </Command.Group>
          )}
          <Command.Group heading={t('actions')}>
            <Item value="action new host" icon={<Plus />} label={t('newHost')} onSelect={() => run(() => (activateTab('vault'), useApp.getState().setSection('hosts'), openEditor('host')))} />
            <Item value="action new group" icon={<FolderPlus />} label={t('newGroup')} onSelect={() => run(() => (activateTab('vault'), useApp.getState().setSection('hosts'), openEditor('group')))} />
            <Item value="action local terminal" icon={<Terminal />} label={t('localTerminal')} onSelect={() => run(() => void openTab({ kind: 'local' }))} />
            <Item value="action serial" icon={<Usb />} label={t('serial')} onSelect={() => run(() => useUi.setState({ serialDialogOpen: true }))} />
            <Item value="action sftp" icon={<FolderOpen />} label={t('openSftp')} onSelect={() => run(() => activateTab('sftp'))} />
            {sid && (
              <Item
                value="action ai assistant"
                icon={<Bot />}
                label={t('aiAssistant')}
                onSelect={() =>
                  run(() => {
                    const tab = findTabBySession(sid)
                    if (tab) activateTab(tab.id)
                    useTerminalUi.setState({ aiOpen: true })
                  })
                }
              />
            )}
            <Item value="action snippets" icon={<Braces />} label={t('manageSnippets')} onSelect={() => run(() => (activateTab('vault'), useApp.getState().setSection('snippets')))} />
            {syncConfigured && <Item value="action sync now" icon={<RefreshCcw />} label={t('syncNow')} onSelect={() => run(() => void call('sync.now').catch(() => {}))} />}
            <Item
              value="action toggle theme"
              icon={theme === 'dark' ? <Sun /> : <Moon />}
              label={t('toggleTheme')}
              onSelect={() => run(() => void updateSettings({ theme: theme === 'dark' ? 'light' : 'dark' }))}
            />
            <Item value="action settings" icon={<Settings />} label={t('settings')} onSelect={() => run(() => (activateTab('vault'), useApp.getState().setSection('settings')))} />
            {lock.passwordEnabled && <Item value="action lock" icon={<Lock />} label={t('lock')} onSelect={() => run(() => void call('lock.lock'))} />}
          </Command.Group>
          {hosts.length === 0 && !quick && (
            <div className="flex items-center gap-2 px-3 py-3 text-xs text-subtle">
              <Server className="size-3.5" />
              {t('hint')}
            </div>
          )}
        </Command.List>
      </Command>
    </div>
  )
}

function Item({ value, onSelect, icon, label, hint }: { value: string; onSelect: () => void; icon: React.ReactNode; label: React.ReactNode; hint?: string }): React.JSX.Element {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      className="flex h-9 cursor-default items-center gap-3 rounded-lg px-2 text-[13px] data-[selected=true]:bg-accent-soft [&_svg]:size-4 [&_svg]:text-muted"
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && <span className="text-xs text-subtle">{hint}</span>}
    </Command.Item>
  )
}
