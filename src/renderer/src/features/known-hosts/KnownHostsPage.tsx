import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Copy,
  FileInput,
  FileKey,
  Import,
  ShieldCheck,
  Trash2,
  X
} from 'lucide-react'
import { type ReactNode, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { Item } from '@shared/schemas'
import type { ImportResult } from '@shared/types'
import { Page, PageBody, PageHeader } from '@/components/Page'
import { Button } from '@/components/ui/button'
import { confirm } from '@/components/ui/confirm'
import {
  Checkbox,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Tip
} from '@/components/ui/controls'
import { Badge, EmptyState, Spinner } from '@/components/ui/misc'
import { call, errorMessage, isWin, vaultApi } from '@/lib/api'
import { cn, copyText, formatDate, relativeTime } from '@/lib/utils'
import { useApp } from '@/stores/app'
import { useItems } from '@/stores/vault'

type SortKey = 'host' | 'updated'

/** `host` for the default port, `[host]:port` otherwise (known_hosts notation). */
function hostLabel(k: Item<'knownHost'>): string {
  return k.data.port === 22 ? k.data.host : `[${k.data.host}]:${k.data.port}`
}

export function KnownHostsPage(): React.JSX.Element {
  const { t, i18n } = useTranslation('knownHosts')
  const { t: tc } = useTranslation()
  const items = useItems('knownHost')
  const hosts = useItems('host')
  const homeDir = useApp((s) => s.info?.homeDir)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'host', dir: 1 })
  const [importing, setImporting] = useState(false)
  const anchorRef = useRef<string | null>(null)

  /** Vault host labels by `address|port` so a key can show which saved host it belongs to. */
  const hostNames = useMemo(() => {
    const m = new Map<string, string>()
    for (const h of hosts) {
      const key = `${h.data.address.toLowerCase()}|${h.data.port ?? 22}`
      if (!m.has(key)) m.set(key, h.data.label || h.data.address)
    }
    return m
  }, [hosts])
  const usedBy = (k: Item<'knownHost'>): string | undefined =>
    hostNames.get(`${k.data.host.toLowerCase()}|${k.data.port}`)

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    const list = items.filter(
      (k) =>
        !q ||
        [
          k.data.host,
          String(k.data.port),
          k.data.keyType,
          k.data.fingerprint,
          hostNames.get(`${k.data.host.toLowerCase()}|${k.data.port}`)
        ].some((s) => s && s.toLowerCase().includes(q))
    )
    return list.sort((a, b) =>
      sort.key === 'host'
        ? sort.dir *
          (a.data.host.localeCompare(b.data.host) ||
            a.data.port - b.data.port ||
            a.data.keyType.localeCompare(b.data.keyType))
        : sort.dir * (a.updatedAt - b.updatedAt)
    )
  }, [items, search, sort, hostNames])

  const selectedRows = rows.filter((r) => selected.has(r.id))
  const allChecked = rows.length > 0 && selectedRows.length === rows.length
  const someChecked = selectedRows.length > 0

  const toggleSort = (key: SortKey): void =>
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === 'updated' ? -1 : 1 }
    )
  const toggleAll = (): void => setSelected(allChecked ? new Set() : new Set(rows.map((r) => r.id)))
  const clickRow = (id: string, e: React.MouseEvent): void => {
    if (e.shiftKey && anchorRef.current) {
      const a = rows.findIndex((r) => r.id === anchorRef.current)
      const b = rows.findIndex((r) => r.id === id)
      if (a >= 0 && b >= 0) {
        const [from, to] = a < b ? [a, b] : [b, a]
        setSelected((prev) => new Set([...prev, ...rows.slice(from, to + 1).map((r) => r.id)]))
        return
      }
    }
    anchorRef.current = id
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const showImportResult = (res: ImportResult): void => {
    const skipped = res.skipped ? t('importSkipped', { count: res.skipped }) : undefined
    if (res.knownHosts > 0) toast.success(t('imported', { count: res.knownHosts }), { description: skipped })
    else toast.info(t('importNothing'), { description: skipped })
    if (res.errors.length) toast.error(t('importFailed'), { description: res.errors.slice(0, 3).join('\n') })
  }
  const runImport = async (path?: string): Promise<void> => {
    setImporting(true)
    try {
      showImportResult(await call('knownHosts.importFile', path))
    } catch (err) {
      toast.error(t('importFailed'), { description: errorMessage(err) })
    } finally {
      setImporting(false)
    }
  }
  const importFromFile = async (): Promise<void> => {
    const defaultPath = homeDir ? `${homeDir}${isWin ? '\\.ssh' : '/.ssh'}` : undefined
    const paths = await call('app.openFileDialog', { title: t('importDialogTitle'), defaultPath }).catch(
      () => [] as string[]
    )
    if (paths[0]) await runImport(paths[0])
  }

  const copyFingerprint = async (k: Item<'knownHost'>): Promise<void> => {
    await copyText(k.data.fingerprint)
    toast.success(t('fingerprintCopied'))
  }
  const copyPublicKey = async (k: Item<'knownHost'>): Promise<void> => {
    await copyText(`${k.data.keyType} ${k.data.publicKey}`)
    toast.success(t('publicKeyCopied'))
  }
  const removeItems = async (list: Item<'knownHost'>[]): Promise<void> => {
    if (!list.length) return
    const message =
      list.length === 1
        ? t('deleteMessage', { host: hostLabel(list[0]), keyType: list[0].data.keyType })
        : t('deleteManyMessage', { count: list.length })
    const ok = await confirm({ title: t('deleteTitle'), message, confirmLabel: tc('delete'), danger: true })
    if (!ok) return
    try {
      await vaultApi.remove(list.map((k) => k.id))
      setSelected((prev) => {
        const next = new Set(prev)
        for (const k of list) next.delete(k.id)
        return next
      })
      toast.success(t('removed', { count: list.length }))
    } catch (err) {
      toast.error(tc('errorTitle'), { description: errorMessage(err) })
    }
  }

  const importButton = (
    <div className="flex items-center">
      <Button
        variant="secondary"
        className="rounded-r-none"
        onClick={() => void runImport()}
        disabled={importing}
        data-testid="known-hosts-import"
      >
        {importing ? <Spinner className="size-4" /> : <Import />}
        {t('importDefault')}
      </Button>
      <DropdownMenu>
        <Tip content={t('importMore')}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="secondary"
              size="icon"
              className="w-7 rounded-l-none border-l-0"
              disabled={importing}
              aria-label={t('importMore')}
            >
              <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
        </Tip>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => void importFromFile()}>
            <FileInput />
            {t('importFile')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )

  return (
    <Page>
      <PageHeader
        search={search}
        onSearch={setSearch}
        searchPlaceholder={t('searchPlaceholder')}
        actions={
          someChecked ? (
            <>
              <span className="text-xs text-muted">{t('selected', { count: selectedRows.length })}</span>
              <Button variant="ghost" onClick={() => setSelected(new Set())}>
                <X />
                {t('clearSelection')}
              </Button>
              <Button
                variant="danger"
                onClick={() => void removeItems(selectedRows)}
                data-testid="known-hosts-delete-selected"
              >
                <Trash2 />
                {t('deleteSelected', { count: selectedRows.length })}
              </Button>
            </>
          ) : (
            importButton
          )
        }
      />
      <PageBody>
        {items.length === 0 ? (
          <EmptyState
            icon={<ShieldCheck />}
            title={t('emptyTitle')}
            description={t('emptyDescription')}
            className="py-24"
            action={
              <Button
                variant="primary"
                className="mt-2"
                onClick={() => void runImport()}
                disabled={importing}
              >
                {importing ? <Spinner className="size-4 text-white" /> : <Import />}
                {t('importDefault')}
              </Button>
            }
          />
        ) : rows.length === 0 ? (
          <EmptyState icon={<ShieldCheck />} title={t('noMatch')} />
        ) : (
          <>
            <div className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-subtle">
              {t('count', { count: items.length })}
            </div>
            <div className="@container overflow-clip rounded-xl border border-line bg-panel">
              <table className="w-full table-fixed border-collapse text-[13px]">
                <thead>
                  <tr className="h-9 text-left text-[11px] font-semibold uppercase tracking-wider text-subtle">
                    <Th className="w-11 pl-4">
                      <Checkbox
                        checked={allChecked ? true : someChecked ? 'indeterminate' : false}
                        onCheckedChange={toggleAll}
                        aria-label={tc('selectAll')}
                        data-testid="known-hosts-select-all"
                      />
                    </Th>
                    <Th>
                      <SortButton
                        active={sort.key === 'host'}
                        dir={sort.dir}
                        onClick={() => toggleSort('host')}
                      >
                        {t('host')}
                      </SortButton>
                    </Th>
                    <Th className="w-[64px]">{t('port')}</Th>
                    <Th className="w-[148px]">{t('keyType')}</Th>
                    <Th>{t('fingerprint')}</Th>
                    <Th className="hidden w-[116px] @2xl:table-cell">
                      <SortButton
                        active={sort.key === 'updated'}
                        dir={sort.dir}
                        onClick={() => toggleSort('updated')}
                      >
                        {t('updated')}
                      </SortButton>
                    </Th>
                    <Th className="w-[48px] pr-3">
                      <span className="sr-only">{tc('actions')}</span>
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((k) => {
                    const checked = selected.has(k.id)
                    const owner = usedBy(k)
                    return (
                      <ContextMenu key={k.id}>
                        <ContextMenuTrigger asChild>
                          <tr
                            data-testid="known-host-row"
                            onClick={(e) => clickRow(k.id, e)}
                            className={cn(
                              'group h-12 cursor-default border-t border-line transition-colors first:border-t-0',
                              checked ? 'bg-accent-soft' : 'hover:bg-panel-hover'
                            )}
                          >
                            <td className="pl-4" onClick={(e) => e.stopPropagation()}>
                              <Checkbox
                                checked={checked}
                                onCheckedChange={() => {
                                  anchorRef.current = k.id
                                  setSelected((prev) => {
                                    const next = new Set(prev)
                                    if (next.has(k.id)) next.delete(k.id)
                                    else next.add(k.id)
                                    return next
                                  })
                                }}
                                aria-label={hostLabel(k)}
                              />
                            </td>
                            <td className="pr-3">
                              <div className="flex min-w-0 items-center gap-2.5">
                                <div className="hidden size-7 shrink-0 items-center justify-center rounded-md bg-success/12 text-success @3xl:flex">
                                  <ShieldCheck className="size-4" />
                                </div>
                                <div className="min-w-0">
                                  <div className="selectable truncate font-medium">{k.data.host}</div>
                                  {owner && (
                                    <div className="truncate text-[11px] text-muted">
                                      {t('usedBy', { name: owner })}
                                    </div>
                                  )}
                                </div>
                              </div>
                            </td>
                            <td className="pr-3 font-mono text-xs tabular-nums text-muted">{k.data.port}</td>
                            <td className="pr-3">
                              <Badge className="max-w-full font-mono">
                                <span className="truncate">{k.data.keyType}</span>
                              </Badge>
                            </td>
                            <td className="pr-3">
                              <div className="flex min-w-0 items-center gap-1">
                                <Tip
                                  content={<span className="break-all font-mono">{k.data.fingerprint}</span>}
                                >
                                  <span className="selectable min-w-0 truncate font-mono text-xs text-muted">
                                    {k.data.fingerprint}
                                  </span>
                                </Tip>
                                <Tip content={t('copyFingerprint')}>
                                  <button
                                    type="button"
                                    aria-label={t('copyFingerprint')}
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      void copyFingerprint(k)
                                    }}
                                    className="flex size-6 shrink-0 items-center justify-center rounded text-subtle opacity-0 transition-opacity hover:bg-panel hover:text-fg focus-visible:opacity-100 group-hover:opacity-100"
                                  >
                                    <Copy className="size-3.5" />
                                  </button>
                                </Tip>
                              </div>
                            </td>
                            <td className="hidden pr-3 @2xl:table-cell">
                              <Tip content={formatDate(k.updatedAt, i18n.language)}>
                                <span className="text-xs text-muted">
                                  {relativeTime(k.updatedAt, i18n.language)}
                                </span>
                              </Tip>
                            </td>
                            <td className="pr-3 text-right">
                              <Tip content={tc('delete')}>
                                <Button
                                  size="icon-sm"
                                  variant="danger-ghost"
                                  aria-label={tc('delete')}
                                  className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    void removeItems([k])
                                  }}
                                >
                                  <Trash2 />
                                </Button>
                              </Tip>
                            </td>
                          </tr>
                        </ContextMenuTrigger>
                        <ContextMenuContent>
                          <ContextMenuItem onSelect={() => void copyFingerprint(k)}>
                            <Copy />
                            {t('copyFingerprint')}
                          </ContextMenuItem>
                          <ContextMenuItem onSelect={() => void copyPublicKey(k)}>
                            <FileKey />
                            {t('copyPublicKey')}
                          </ContextMenuItem>
                          <ContextMenuSeparator />
                          <ContextMenuItem
                            danger
                            onSelect={() =>
                              void removeItems(checked && selectedRows.length > 1 ? selectedRows : [k])
                            }
                          >
                            <Trash2 />
                            {checked && selectedRows.length > 1
                              ? t('deleteSelected', { count: selectedRows.length })
                              : tc('delete')}
                          </ContextMenuItem>
                        </ContextMenuContent>
                      </ContextMenu>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </PageBody>
    </Page>
  )
}

function Th({ children, className }: { children: ReactNode; className?: string }): React.JSX.Element {
  // Sticks to the top edge of PageBody's scrollport (offset by its 1.25rem top padding).
  return (
    <th
      className={cn(
        'sticky -top-5 z-[1] bg-panel pr-3 font-semibold shadow-[inset_0_-1px_0_var(--c-line)]',
        className
      )}
    >
      {children}
    </th>
  )
}

function SortButton({
  active,
  dir,
  onClick,
  children
}: {
  active: boolean
  dir: 1 | -1
  onClick: () => void
  children: ReactNode
}): React.JSX.Element {
  const Icon = dir === 1 ? ArrowUp : ArrowDown
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 uppercase tracking-wider hover:text-fg',
        active && 'text-muted'
      )}
    >
      {children}
      <Icon className={cn('size-3', active ? 'opacity-100' : 'opacity-0')} />
    </button>
  )
}
