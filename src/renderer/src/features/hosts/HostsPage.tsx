import {
  ChevronDown,
  ChevronRight,
  CloudUpload,
  Copy,
  Files,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  LayoutGrid,
  List,
  Monitor,
  Pencil,
  Plug,
  Plus,
  Server,
  SlidersHorizontal,
  Terminal,
  Trash2,
  Upload,
  Usb,
  X,
  Zap
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { HistoryEntry } from '@shared/types'
import { parseQuickConnect } from '@shared/util'
import { HostAvatar } from '@/components/HostAvatar'
import { Card, CardGrid, Page, PageBody, PageHeader } from '@/components/Page'
import { Button } from '@/components/ui/button'
import { confirm } from '@/components/ui/confirm'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tip
} from '@/components/ui/controls'
import { EmptyState, Kbd, SectionTitle } from '@/components/ui/misc'
import { call, on, vaultApi } from '@/lib/api'
import { formatCombo, resolveShortcuts } from '@/lib/shortcuts'
import { cn, colorFor, copyText, relativeTime } from '@/lib/utils'
import { useApp } from '@/stores/app'
import { openHost, openTab } from '@/stores/tabs'
import { openEditor, openInSftp, useUi } from '@/stores/ui'
import { useItems, useShortcutOverrides } from '@/stores/vault'
import {
  descendantGroupIds,
  type GroupItem,
  groupLabel,
  groupPath,
  hostCountInGroup,
  type HostItem,
  hostSubtitle,
  hostTitle,
  matchesSearch
} from './utils'

const DND_HOSTS = 'application/x-sshtool-hosts'
const DND_GROUP = 'application/x-sshtool-group'

function useLastConnected(): Map<string, number> {
  const [map, setMap] = useState(new Map<string, number>())
  useEffect(() => {
    const load = (): void => {
      void call('history.list', 1000).then((list: HistoryEntry[]) => {
        const m = new Map<string, number>()
        for (const e of list) if (e.hostId && !m.has(e.hostId)) m.set(e.hostId, e.startedAt)
        setMap(m)
      })
    }
    load()
    return on('history.changed', load)
  }, [])
  return map
}

function connect(h: HostItem): void {
  void openHost(h.id, h.data.sshEnabled === false && h.data.telnetEnabled ? 'telnet' : 'ssh')
}

async function moveHosts(ids: string[], groupId: string | undefined): Promise<void> {
  for (const id of ids) await vaultApi.patch(id, { groupId })
}

/**
 * Quick access to a shell on this machine. The tooltip shows the effective (possibly customised)
 * shortcut so the button doubles as a hint for the `localTerminal` hotkey.
 */
function OpenLocalTerminalButton(): React.JSX.Element {
  const { t } = useTranslation('hosts')
  const overrides = useShortcutOverrides()
  const combo = useMemo(() => resolveShortcuts(overrides).localTerminal, [overrides])
  return (
    <Tip
      content={
        <span className="flex items-center gap-1.5">
          {t('openLocalTerminal')}
          <Kbd>{formatCombo(combo)}</Kbd>
        </span>
      }
    >
      <Button variant="secondary" onClick={() => void openTab({ kind: 'local' })} data-testid="open-local-terminal">
        <Terminal />
        {t('openLocalTerminal')}
      </Button>
    </Tip>
  )
}

export function HostsPage(): React.JSX.Element {
  const { t, i18n } = useTranslation('hosts')
  const { t: tc } = useTranslation()
  const hosts = useItems('host')
  const groups = useItems('group')
  const tags = useItems('tag')
  const settings = useApp((s) => s.settings)
  const updateSettings = useApp((s) => s.updateSettings)
  const syncConfigured = useApp((s) => s.sync.configured)
  const setSection = useApp((s) => s.setSection)
  const groupId = useUi((s) => s.hostsGroupId)
  const search = useUi((s) => s.hostsSearch)
  const tagFilter = useUi((s) => s.hostsTagFilter)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [anchor, setAnchor] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const lastConnected = useLastConnected()

  const tagNames = useMemo(() => new Map(tags.map((tg) => [tg.id, tg.data.name])), [tags])
  const setSearch = (v: string): void => useUi.setState({ hostsSearch: v })
  const setGroup = (id: string | undefined): void => {
    useUi.setState({ hostsGroupId: id })
    setSelected(new Set())
  }

  // The open group vanished (e.g. deleted on another device) → back to the root.
  useEffect(() => {
    if (groupId && !groups.some((g) => g.id === groupId)) useUi.setState({ hostsGroupId: undefined })
  }, [groupId, groups])

  const searching = search.trim().length > 0 || tagFilter.length > 0
  const visibleGroups = useMemo(() => {
    if (searching) {
      const s = search.trim().toLowerCase()
      return s ? groups.filter((g) => g.data.name.toLowerCase().includes(s)) : []
    }
    return groups.filter((g) => (g.data.parentId ?? undefined) === groupId)
  }, [groups, groupId, searching, search])

  const visibleHosts = useMemo(() => {
    let list = searching ? hosts.filter((h) => matchesSearch(h, search.trim(), tagNames)) : hosts.filter((h) => (h.data.groupId ?? undefined) === groupId)
    if (tagFilter.length) list = list.filter((h) => tagFilter.every((tg) => h.data.tagIds.includes(tg)))
    const by = settings.hostsSort
    return [...list].sort((a, b) => {
      if (by === 'recent') return (lastConnected.get(b.id) ?? 0) - (lastConnected.get(a.id) ?? 0) || hostTitle(a).localeCompare(hostTitle(b))
      if (by === 'address') return a.data.address.localeCompare(b.data.address, undefined, { numeric: true })
      return hostTitle(a).localeCompare(hostTitle(b), undefined, { numeric: true, sensitivity: 'base' })
    })
  }, [hosts, groupId, searching, search, tagFilter, tagNames, settings.hostsSort, lastConnected])

  const sortedGroups = useMemo(() => [...visibleGroups].sort((a, b) => a.data.name.localeCompare(b.data.name)), [visibleGroups])

  const quick = useMemo(() => {
    const q = search.trim()
    if (!q || !/[@.:]/.test(q)) return null
    return parseQuickConnect(q)
  }, [search])

  const quickConnect = (): void => {
    if (!quick) return
    void openTab({ kind: 'ssh', inline: { address: quick.address, port: quick.port, username: quick.username } })
    setSearch('')
  }

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') setSearch('')
    if (e.key !== 'Enter') return
    if (visibleHosts.length === 1 && !quick) return connect(visibleHosts[0])
    if (quick) {
      const exact = hosts.find((h) => h.data.address === quick.address && (!quick.username || h.data.username === quick.username))
      if (exact && !quick.port) return connect(exact)
      quickConnect()
    }
  }

  const clickHost = (e: React.MouseEvent, h: HostItem): void => {
    if (e.ctrlKey || e.metaKey) {
      setSelected((s) => {
        const n = new Set(s)
        if (n.has(h.id)) n.delete(h.id)
        else n.add(h.id)
        return n
      })
      setAnchor(h.id)
      return
    }
    if (e.shiftKey && anchor) {
      const ids = visibleHosts.map((x) => x.id)
      const a = ids.indexOf(anchor)
      const b = ids.indexOf(h.id)
      if (a >= 0 && b >= 0) {
        const [from, to] = a < b ? [a, b] : [b, a]
        setSelected(new Set(ids.slice(from, to + 1)))
        return
      }
    }
    if (selected.size) {
      setSelected(new Set())
      return
    }
    connect(h)
  }

  const deleteHosts = async (ids: string[]): Promise<void> => {
    const first = hosts.find((h) => h.id === ids[0])
    const ok = await confirm({
      title: tc('deleteConfirmTitle'),
      message: ids.length === 1 && first ? tc('deleteConfirm', { name: hostTitle(first) }) : t('deleteHostsConfirm', { count: ids.length }),
      confirmLabel: tc('delete'),
      danger: true
    })
    if (!ok) return
    await vaultApi.remove(ids)
    setSelected(new Set())
    toast.success(tc('deletedToast'))
  }

  const deleteGroup = async (g: GroupItem): Promise<void> => {
    if (!(await confirm({ title: tc('deleteConfirmTitle'), message: t('deleteGroupConfirm', { name: g.data.name }), confirmLabel: tc('delete'), danger: true }))) return
    await vaultApi.remove([g.id])
  }

  const dragIdsFor = (h: HostItem): string[] => (selected.has(h.id) ? [...selected] : [h.id])

  const dropProps = (target: string | undefined, key: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes(DND_HOSTS) || e.dataTransfer.types.includes(DND_GROUP)) {
        e.preventDefault()
        setDropTarget(key)
      }
    },
    onDragLeave: () => setDropTarget((d) => (d === key ? null : d)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      setDropTarget(null)
      const hostIds = e.dataTransfer.getData(DND_HOSTS)
      if (hostIds) {
        void moveHosts(JSON.parse(hostIds) as string[], target)
        setSelected(new Set())
        return
      }
      const gid = e.dataTransfer.getData(DND_GROUP)
      if (gid && gid !== target && !(target && descendantGroupIds(gid, groups).has(target))) void vaultApi.patch(gid, { parentId: target })
    }
  })

  const crumbs = groupPath(groupId)
  const isEmptyVault = hosts.length === 0 && groups.length === 0
  const newHostDefaults = groupId ? { groupId } : undefined

  return (
    <Page>
      <PageHeader
        search={search}
        onSearch={setSearch}
        onSearchKeyDown={onSearchKey}
        searchPlaceholder={t('searchPlaceholder')}
        searchTestId="hosts-search"
        actions={
          <>
            {quick && (
              <Button variant="secondary" onClick={quickConnect} data-testid="quick-connect">
                <Zap />
                {t('connectTo', { target: `${quick.username ? `${quick.username}@` : ''}${quick.address}${quick.port ? `:${quick.port}` : ''}` })}
              </Button>
            )}
            <div className="flex rounded-lg border border-line p-0.5">
              <Tip content={t('viewGrid')}>
                <button
                  className={cn('rounded-md p-1.5', settings.hostsView === 'grid' ? 'bg-panel-hover text-fg' : 'text-subtle hover:text-fg')}
                  onClick={() => void updateSettings({ hostsView: 'grid' })}
                >
                  <LayoutGrid className="size-4" />
                </button>
              </Tip>
              <Tip content={t('viewList')}>
                <button
                  className={cn('rounded-md p-1.5', settings.hostsView === 'list' ? 'bg-panel-hover text-fg' : 'text-subtle hover:text-fg')}
                  onClick={() => void updateSettings({ hostsView: 'list' })}
                >
                  <List className="size-4" />
                </button>
              </Tip>
            </div>
            <DropdownMenu>
              <Tip content={t('sortBy')}>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon">
                    <SlidersHorizontal />
                  </Button>
                </DropdownMenuTrigger>
              </Tip>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>{t('sortBy')}</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={settings.hostsSort} onValueChange={(v) => void updateSettings({ hostsSort: v as typeof settings.hostsSort })}>
                  <DropdownMenuRadioItem value="name">{t('sortName')}</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="address">{t('sortAddress')}</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="recent">{t('sortRecent')}</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <OpenLocalTerminalButton />
            <div className="flex">
              <Button variant="primary" className="rounded-r-none" onClick={() => openEditor('host', undefined, newHostDefaults)} data-testid="new-host">
                <Plus />
                {t('newHost')}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="primary" className="rounded-l-none border-l border-white/20 px-1.5" aria-label="more" data-testid="new-host-menu">
                    <ChevronDown />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => openEditor('host', undefined, newHostDefaults)}>
                    <Server />
                    {t('newHost')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => openEditor('group', undefined, groupId ? { parentId: groupId } : undefined)} data-testid="new-group">
                    <FolderPlus />
                    {t('newGroup')}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => setSection('settings', 'data')}>
                    <Upload />
                    {t('importSshConfig')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setSection('settings', 'data')}>
                    <Files />
                    {t('importCsv')}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => useUi.setState({ serialDialogOpen: true })}>
                    <Usb />
                    {t('serial')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </>
        }
      />
      <PageBody>
        {isEmptyVault ? (
          <EmptyState
            icon={<Server />}
            title={t('emptyTitle')}
            description={t('emptyDesc')}
            action={
              <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
                <Button variant="primary" onClick={() => openEditor('host')}>
                  <Plus />
                  {t('newHost')}
                </Button>
                <Button variant="secondary" onClick={() => setSection('settings', 'data')}>
                  <Upload />
                  {t('importSshConfig')}
                </Button>
                {!syncConfigured && (
                  <Button variant="secondary" onClick={() => setSection('settings', 'sync')}>
                    <CloudUpload />
                    {t('setupSync')}
                  </Button>
                )}
              </div>
            }
          />
        ) : (
          <>
            {(crumbs.length > 0 || searching) && (
              <div className="mb-4 flex items-center gap-1 text-[13px]">
                <button
                  className={cn('rounded-md px-2 py-1 text-muted hover:bg-panel-hover hover:text-fg', dropTarget === 'root' && 'bg-accent-soft text-accent')}
                  onClick={() => {
                    setGroup(undefined)
                    setSearch('')
                    useUi.setState({ hostsTagFilter: [] })
                  }}
                  {...dropProps(undefined, 'root')}
                >
                  {t('allHosts')}
                </button>
                {!searching &&
                  crumbs.map((g, i) => (
                    <span key={g.id} className="flex items-center gap-1">
                      <ChevronRight className="size-3.5 text-subtle" />
                      <button
                        className={cn(
                          'rounded-md px-2 py-1 hover:bg-panel-hover',
                          i === crumbs.length - 1 ? 'font-semibold text-fg' : 'text-muted hover:text-fg',
                          dropTarget === `crumb-${g.id}` && 'bg-accent-soft text-accent'
                        )}
                        onClick={() => setGroup(g.id)}
                        {...dropProps(g.id, `crumb-${g.id}`)}
                      >
                        {g.data.name}
                      </button>
                    </span>
                  ))}
                {!searching && groupId && (
                  <Tip content={t('editGroup')}>
                    <Button size="icon-sm" variant="ghost" onClick={() => openEditor('group', groupId)}>
                      <Pencil />
                    </Button>
                  </Tip>
                )}
              </div>
            )}

            {tags.length > 0 && (
              <div className="mb-4 flex flex-wrap items-center gap-1.5">
                {tags.map((tg) => {
                  const active = tagFilter.includes(tg.id)
                  return (
                    <button
                      key={tg.id}
                      onClick={() => useUi.setState({ hostsTagFilter: active ? tagFilter.filter((x) => x !== tg.id) : [...tagFilter, tg.id] })}
                      className={cn(
                        'flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors',
                        active ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:text-fg'
                      )}
                    >
                      <span className="size-1.5 rounded-full" style={{ backgroundColor: tg.data.color ?? colorFor(tg.data.name) }} />
                      {tg.data.name}
                    </button>
                  )
                })}
                {tagFilter.length > 0 && (
                  <button className="text-xs text-subtle hover:text-fg" onClick={() => useUi.setState({ hostsTagFilter: [] })}>
                    {t('clearFilters')}
                  </button>
                )}
              </div>
            )}

            {selected.size > 0 && (
              <div className="sticky top-0 z-10 mb-4 flex items-center gap-2 rounded-xl border border-accent/40 bg-elevated px-3 py-2 shadow-pop">
                <span className="text-[13px] font-medium">{t('selected', { count: selected.size })}</span>
                <div className="flex-1" />
                <Button size="sm" variant="secondary" onClick={() => [...selected].forEach((id) => void openHost(id))}>
                  <Plug />
                  {t('connectAll')}
                </Button>
                <MoveMenu groups={groups} onMove={(gid) => void moveHosts([...selected], gid).then(() => setSelected(new Set()))} label={t('moveTo')} rootLabel={t('moveToRoot')} />
                <Button size="sm" variant="danger-ghost" onClick={() => void deleteHosts([...selected])}>
                  <Trash2 />
                  {tc('delete')}
                </Button>
                <Button size="icon-sm" variant="ghost" onClick={() => setSelected(new Set())}>
                  <X />
                </Button>
              </div>
            )}

            {sortedGroups.length > 0 && (
              <>
                <SectionTitle>{t('groups')}</SectionTitle>
                <CardGrid className="mb-6">
                  {sortedGroups.map((g) => (
                    <ContextMenu key={g.id}>
                      <ContextMenuTrigger asChild>
                        <div draggable onDragStart={(e) => e.dataTransfer.setData(DND_GROUP, g.id)} {...dropProps(g.id, `group-${g.id}`)} data-testid="group-card">
                          <Card
                            onClick={() => {
                              setGroup(g.id)
                              setSearch('')
                            }}
                            className={cn(dropTarget === `group-${g.id}` && 'border-accent bg-accent-soft')}
                            icon={
                              <div
                                className="flex size-9 shrink-0 items-center justify-center rounded-lg"
                                style={{ backgroundColor: `${colorFor(g.data.name)}22`, color: colorFor(g.data.name) }}
                              >
                                <Folder className="size-[18px]" />
                              </div>
                            }
                            title={g.data.name}
                            subtitle={
                              searching && g.data.parentId
                                ? groupLabel(g.data.parentId)
                                : t('hostsCount', { count: hostCountInGroup(g.id, groups, hosts) })
                            }
                            right={
                              <button
                                className="hidden rounded-md p-1.5 text-subtle hover:bg-panel hover:text-fg group-hover:block"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  openEditor('group', g.id)
                                }}
                              >
                                <Pencil className="size-3.5" />
                              </button>
                            }
                          />
                        </div>
                      </ContextMenuTrigger>
                      <ContextMenuContent>
                        <ContextMenuItem onSelect={() => setGroup(g.id)}>
                          <FolderOpen />
                          {t('openGroup')}
                        </ContextMenuItem>
                        <ContextMenuItem onSelect={() => openEditor('group', g.id)}>
                          <Pencil />
                          {tc('edit')}
                        </ContextMenuItem>
                        <ContextMenuItem onSelect={() => openEditor('host', undefined, { groupId: g.id })}>
                          <Plus />
                          {t('newHost')}
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem danger onSelect={() => void deleteGroup(g)}>
                          <Trash2 />
                          {tc('delete')}
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                  ))}
                </CardGrid>
              </>
            )}

            {(visibleHosts.length > 0 || !searching) && <SectionTitle>{t('hosts')}</SectionTitle>}
            {visibleHosts.length === 0 && !searching && crumbs.length > 0 && (
              <EmptyState icon={<FolderOpen />} title={t('emptyGroup')} description={t('emptyGroupDesc')} className="py-10" />
            )}
            {visibleHosts.length === 0 && searching && <EmptyState icon={<Server />} title={t('noMatch')} className="py-10" />}
            {settings.hostsView === 'grid' ? (
              <CardGrid>
                {visibleHosts.map((h) => (
                  <HostContextMenu key={h.id} host={h} groups={groups} selectedIds={selected.has(h.id) ? [...selected] : [h.id]} onDelete={deleteHosts}>
                    <div draggable onDragStart={(e) => e.dataTransfer.setData(DND_HOSTS, JSON.stringify(dragIdsFor(h)))}>
                      <Card
                        testId="host-card"
                        data-host-id={h.id}
                        onClick={(e) => clickHost(e, h)}
                        selected={selected.has(h.id)}
                        icon={<HostAvatar osHint={h.data.osHint} label={hostTitle(h)} kind={h.data.sshEnabled === false && h.data.telnetEnabled ? 'telnet' : 'ssh'} />}
                        title={hostTitle(h)}
                        subtitle={hostSubtitle(h)}
                        right={
                          <Tip content={tc('edit')}>
                            <button
                              className="hidden rounded-md p-1.5 text-subtle hover:bg-panel hover:text-fg group-hover:block"
                              onClick={(e) => {
                                e.stopPropagation()
                                openEditor('host', h.id)
                              }}
                              data-testid="host-edit"
                            >
                              <Pencil className="size-3.5" />
                            </button>
                          </Tip>
                        }
                      >
                        {h.data.tagIds.length > 0 && (
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {h.data.tagIds.slice(0, 3).map((id) => (
                              <span key={id} className="flex items-center gap-1 rounded bg-panel-hover px-1.5 text-[10.5px] text-muted">
                                <span className="size-1.5 rounded-full" style={{ backgroundColor: colorFor(tagNames.get(id) ?? '') }} />
                                {tagNames.get(id)}
                              </span>
                            ))}
                          </div>
                        )}
                      </Card>
                    </div>
                  </HostContextMenu>
                ))}
              </CardGrid>
            ) : (
              visibleHosts.length > 0 && (
                <div className="overflow-hidden rounded-xl border border-line">
                  {visibleHosts.map((h, i) => (
                    <HostContextMenu key={h.id} host={h} groups={groups} selectedIds={selected.has(h.id) ? [...selected] : [h.id]} onDelete={deleteHosts}>
                      <div
                        draggable
                        onDragStart={(e) => e.dataTransfer.setData(DND_HOSTS, JSON.stringify(dragIdsFor(h)))}
                        onClick={(e) => clickHost(e, h)}
                        data-testid="host-card"
                        className={cn(
                          'group flex h-12 cursor-default items-center gap-3 bg-panel px-3 hover:bg-panel-hover',
                          i > 0 && 'border-t border-line',
                          selected.has(h.id) && 'bg-accent-soft'
                        )}
                      >
                        <HostAvatar size="sm" osHint={h.data.osHint} label={hostTitle(h)} className="size-7 [&_svg]:size-4" />
                        <div className="w-[28%] min-w-0">
                          <div className="truncate text-[13px] font-semibold">{hostTitle(h)}</div>
                          <div className="truncate text-xs text-muted">{hostSubtitle(h)}</div>
                        </div>
                        <div className="w-[22%] truncate font-mono text-xs text-muted">
                          {h.data.address}
                          {h.data.port ? `:${h.data.port}` : ''}
                        </div>
                        <div className="w-[18%] truncate text-xs text-muted">{groupLabel(h.data.groupId)}</div>
                        <div className="flex min-w-0 flex-1 gap-1 overflow-hidden">
                          {h.data.tagIds.slice(0, 3).map((id) => (
                            <span key={id} className="shrink-0 rounded bg-panel-hover px-1.5 text-[10.5px] text-muted">
                              {tagNames.get(id)}
                            </span>
                          ))}
                        </div>
                        <div className="w-28 text-right text-xs text-subtle">
                          {lastConnected.get(h.id) ? relativeTime(lastConnected.get(h.id), i18n.language) : ''}
                        </div>
                        <button
                          className="invisible rounded-md p-1.5 text-subtle hover:bg-panel hover:text-fg group-hover:visible"
                          onClick={(e) => {
                            e.stopPropagation()
                            openEditor('host', h.id)
                          }}
                        >
                          <Pencil className="size-3.5" />
                        </button>
                      </div>
                    </HostContextMenu>
                  ))}
                </div>
              )
            )}
          </>
        )}
      </PageBody>
    </Page>
  )
}

function MoveMenu({ groups, onMove, label, rootLabel }: { groups: GroupItem[]; onMove: (gid: string | undefined) => void; label: string; rootLabel: string }): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="secondary">
          <FolderInput />
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
        <DropdownMenuItem onSelect={() => onMove(undefined)}>
          <Monitor />
          {rootLabel}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {[...groups]
          .sort((a, b) => groupLabel(a.id).localeCompare(groupLabel(b.id)))
          .map((g) => (
            <DropdownMenuItem key={g.id} onSelect={() => onMove(g.id)}>
              <Folder />
              {groupLabel(g.id)}
            </DropdownMenuItem>
          ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function HostContextMenu({
  host,
  groups,
  selectedIds,
  onDelete,
  children
}: {
  host: HostItem
  groups: GroupItem[]
  selectedIds: string[]
  onDelete: (ids: string[]) => Promise<void>
  children: React.ReactNode
}): React.JSX.Element {
  const { t } = useTranslation('hosts')
  const { t: tc } = useTranslation()
  const multi = selectedIds.length > 1
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        {!multi && (
          <>
            {host.data.sshEnabled !== false && (
              <ContextMenuItem onSelect={() => void openHost(host.id, 'ssh')}>
                <Plug />
                {t('connectSsh')}
              </ContextMenuItem>
            )}
            {host.data.telnetEnabled && (
              <ContextMenuItem onSelect={() => void openHost(host.id, 'telnet')}>
                <Monitor />
                {t('connectTelnet')}
              </ContextMenuItem>
            )}
            {host.data.sshEnabled !== false && (
              <ContextMenuItem onSelect={() => openInSftp(host.id)}>
                <FolderOpen />
                {t('openSftp')}
              </ContextMenuItem>
            )}
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => openEditor('host', host.id)}>
              <Pencil />
              {tc('edit')}
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => void call('vault.duplicate', host.id)}>
              <Copy />
              {tc('duplicate')}
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => void copyText(host.data.address).then(() => toast.success(tc('copied')))}>
              <Copy />
              {t('copyAddress')}
            </ContextMenuItem>
          </>
        )}
        {multi && (
          <ContextMenuItem onSelect={() => selectedIds.forEach((id) => void openHost(id))}>
            <Plug />
            {t('connectAll')}
          </ContextMenuItem>
        )}
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <FolderInput />
            {t('moveTo')}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem onSelect={() => void moveHosts(selectedIds, undefined)}>
              <Monitor />
              {t('moveToRoot')}
            </ContextMenuItem>
            {[...groups]
              .sort((a, b) => groupLabel(a.id).localeCompare(groupLabel(b.id)))
              .map((g) => (
                <ContextMenuItem key={g.id} onSelect={() => void moveHosts(selectedIds, g.id)}>
                  <Folder />
                  {groupLabel(g.id)}
                </ContextMenuItem>
              ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem danger onSelect={() => void onDelete(selectedIds)}>
          <Trash2 />
          {multi ? t('selected', { count: selectedIds.length }) : tc('delete')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
