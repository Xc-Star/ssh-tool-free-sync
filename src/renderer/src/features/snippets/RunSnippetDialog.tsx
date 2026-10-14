import { ChevronDown, Play, Search, SquareTerminal } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { Item } from '@shared/schemas'
import { HostAvatar } from '@/components/HostAvatar'
import { Button } from '@/components/ui/button'
import {
  Checkbox,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '@/components/ui/controls'
import { Dialog, DialogBody, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { errorMessage } from '@/lib/api'
import { cn } from '@/lib/utils'
import { typeInto } from '@/features/terminal/registry'
import {
  activatePane,
  activateTab,
  activeSessionId,
  leaves,
  openTab,
  type SessionState,
  useTabs
} from '@/stores/tabs'
import { useItem, useItems } from '@/stores/vault'
import { CodeEditor } from './CodeEditor'

function hostName(h: Item<'host'>): string {
  return h.data.label || h.data.address
}

function hostTarget(h: Item<'host'>): string {
  return `${h.data.username ? `${h.data.username}@` : ''}${h.data.address}${h.data.port && h.data.port !== 22 ? `:${h.data.port}` : ''}`
}

/** Runs a snippet on one or more hosts (one new terminal tab each) or in an open terminal session. */
export function RunSnippetDialog({
  snippetId,
  onClose
}: {
  snippetId: string | null | undefined
  onClose: () => void
}): React.JSX.Element | null {
  const snippet = useItem('snippet', snippetId ?? undefined)
  if (!snippet) return null
  return <RunSnippetDialogContent key={snippet.id} snippet={snippet} onClose={onClose} />
}

function RunSnippetDialogContent({
  snippet,
  onClose
}: {
  snippet: Item<'snippet'>
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation('snippets')
  const { t: tc } = useTranslation()
  const hosts = useItems('host')
  const groups = useItems('group')
  const tabs = useTabs((s) => s.tabs)
  const sessions = useTabs((s) => s.sessions)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [currentSessionId] = useState(() => activeSessionId())
  const script = snippet.data.script

  const groupName = useMemo(() => new Map(groups.map((g) => [g.id, g.data.name])), [groups])
  const sshHosts = useMemo(
    () =>
      hosts.filter((h) => h.data.sshEnabled !== false).sort((a, b) => hostName(a).localeCompare(hostName(b))),
    [hosts]
  )
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return sshHosts
    return sshHosts.filter((h) =>
      [h.data.label, h.data.address, h.data.username, groupName.get(h.data.groupId ?? '')].some(
        (s) => s && s.toLowerCase().includes(q)
      )
    )
  }, [sshHosts, query, groupName])
  const selectedCount = sshHosts.filter((h) => selected.has(h.id)).length
  const allChecked = filtered.length > 0 && filtered.every((h) => selected.has(h.id))
  const someChecked = filtered.some((h) => selected.has(h.id))

  /** Connected sessions in open terminal tabs (when the dialog is not opened from a terminal). */
  const openSessions = useMemo(
    () =>
      tabs.flatMap((tab) =>
        tab.kind === 'terminal'
          ? leaves(tab.root)
              .map((leaf) => ({ tabId: tab.id, paneId: leaf.id, session: sessions[leaf.sessionId] }))
              .filter(
                (x): x is { tabId: string; paneId: string; session: SessionState } =>
                  x.session?.status === 'connected'
              )
          : []
      ),
    [tabs, sessions]
  )

  const toggle = (id: string): void =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const toggleAll = (): void =>
    setSelected((prev) => {
      const next = new Set(prev)
      for (const h of filtered) {
        if (allChecked) next.delete(h.id)
        else next.add(h.id)
      }
      return next
    })

  const runOnHosts = async (): Promise<void> => {
    const targets = sshHosts.filter((h) => selected.has(h.id))
    if (!targets.length) return
    onClose()
    for (const h of targets) {
      try {
        await openTab({ kind: 'ssh', hostId: h.id, initialCommand: script })
      } catch (err) {
        toast.error(t('openFailed', { name: hostName(h) }), { description: errorMessage(err) })
      }
    }
  }

  const runInSession = (sessionId: string, tabId?: string, paneId?: string): void => {
    onClose()
    if (tabId) {
      activateTab(tabId)
      if (paneId) activatePane(tabId, paneId)
    }
    typeInto(sessionId, script, true)
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t('runTitle', { name: snippet.data.label })}
        description={t('runDescription')}
        width="max-w-xl"
        data-testid="run-snippet-dialog"
      >
        <DialogBody className="flex flex-col gap-3 pb-1">
          <CodeEditor
            value={script}
            readOnly
            language="shell"
            minHeight={0}
            maxHeight={132}
            ariaLabel={t('script')}
          />

          <div className="mt-1 flex items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-subtle">
              {t('hosts')}
            </span>
            {selectedCount > 0 && (
              <span className="text-xs text-accent">{t('selectedCount', { count: selectedCount })}</span>
            )}
            <div className="flex-1" />
            {filtered.length > 0 && (
              <label className="flex cursor-default items-center gap-2 text-xs text-muted hover:text-fg">
                <Checkbox
                  checked={allChecked ? true : someChecked ? 'indeterminate' : false}
                  onCheckedChange={toggleAll}
                  data-testid="run-snippet-select-all"
                />
                {tc('selectAll')}
              </label>
            )}
          </div>
          <Input
            icon={<Search />}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('hostsSearch')}
            autoFocus
            data-testid="run-snippet-search"
          />
          <div className="h-[248px] overflow-y-auto rounded-lg border border-line bg-panel p-1">
            {filtered.length === 0 ? (
              <div className="flex h-full items-center justify-center px-6 text-center text-xs text-subtle">
                {sshHosts.length ? t('noHostsMatch') : t('noHosts')}
              </div>
            ) : (
              filtered.map((h) => {
                const checked = selected.has(h.id)
                const group = groupName.get(h.data.groupId ?? '')
                return (
                  <label
                    key={h.id}
                    className={cn(
                      'flex h-11 cursor-default items-center gap-3 rounded-md px-2.5 transition-colors',
                      checked ? 'bg-accent-soft' : 'hover:bg-panel-hover'
                    )}
                    data-testid="run-snippet-host"
                  >
                    <Checkbox checked={checked} onCheckedChange={() => toggle(h.id)} />
                    <HostAvatar
                      size="sm"
                      osHint={h.data.osHint}
                      label={hostName(h)}
                      className="size-7 [&_svg]:size-4"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium leading-tight">
                        {hostName(h)}
                      </span>
                      <span className="block truncate text-[11.5px] leading-tight text-muted">
                        {hostTarget(h)}
                      </span>
                    </span>
                    {group && (
                      <span className="max-w-[140px] shrink-0 truncate text-[11px] text-subtle">{group}</span>
                    )}
                  </label>
                )
              })
            )}
          </div>
        </DialogBody>
        <DialogFooter className="justify-between">
          <div className="flex min-w-0 items-center">
            {currentSessionId ? (
              <Button
                variant="secondary"
                onClick={() => runInSession(currentSessionId)}
                data-testid="run-snippet-current"
              >
                <SquareTerminal />
                {t('runInCurrent')}
              </Button>
            ) : openSessions.length > 0 ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="secondary" data-testid="run-snippet-session">
                    <SquareTerminal />
                    {t('runInSession')}
                    <ChevronDown />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
                  <DropdownMenuLabel>{t('runInSession')}</DropdownMenuLabel>
                  {openSessions.map(({ tabId, paneId, session }) => (
                    <DropdownMenuItem
                      key={session.id}
                      onSelect={() => runInSession(session.id, tabId, paneId)}
                    >
                      <HostAvatar
                        size="sm"
                        kind={
                          session.kind === 'local'
                            ? 'local'
                            : session.kind === 'serial'
                              ? 'serial'
                              : session.kind === 'telnet'
                                ? 'telnet'
                                : 'ssh'
                        }
                        osHint={session.osHint}
                        label={session.title}
                        className="size-5 rounded [&_svg]:!size-3 [&_svg]:!text-white"
                      />
                      <span className="truncate">{session.title}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onClose}>
              {tc('cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={selectedCount === 0}
              onClick={() => void runOnHosts()}
              data-testid="run-snippet-submit"
            >
              <Play />
              {selectedCount > 0 ? t('runOn', { count: selectedCount }) : tc('run')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
