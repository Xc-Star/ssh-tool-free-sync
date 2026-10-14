import {
  Braces,
  Copy,
  CopyPlus,
  Ellipsis,
  Hash,
  Pencil,
  Play,
  Plus,
  SearchX,
  SquareTerminal,
  Trash2
} from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { Item } from '@shared/schemas'
import { CardGrid, Page, PageBody, PageHeader } from '@/components/Page'
import { Button } from '@/components/ui/button'
import { confirm } from '@/components/ui/confirm'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tip
} from '@/components/ui/controls'
import { Badge, EmptyState } from '@/components/ui/misc'
import { call, errorMessage, vaultApi } from '@/lib/api'
import { cn, copyText } from '@/lib/utils'
import { openEditor } from '@/stores/ui'
import { useItems } from '@/stores/vault'
import { RunSnippetDialog } from './RunSnippetDialog'

export function SnippetsPage(): React.JSX.Element {
  const { t } = useTranslation('snippets')
  const snippets = useItems('snippet')
  const [search, setSearch] = useState('')
  const [tagFilter, setTagFilter] = useState<string[]>([])
  const [runId, setRunId] = useState<string | null>(null)

  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const s of snippets) for (const tag of s.data.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [snippets])
  const activeTags = useMemo(
    () => tagFilter.filter((tag) => tagCounts.some(([name]) => name === tag)),
    [tagFilter, tagCounts]
  )

  const list = useMemo(() => {
    const q = search.trim().toLowerCase()
    return snippets
      .filter((s) => activeTags.every((tag) => s.data.tags.includes(tag)))
      .filter(
        (s) =>
          !q ||
          s.data.label.toLowerCase().includes(q) ||
          s.data.script.toLowerCase().includes(q) ||
          s.data.tags.some((tag) => tag.toLowerCase().includes(q))
      )
      .sort((a, b) => a.data.label.localeCompare(b.data.label))
  }, [snippets, search, activeTags])

  const toggleTag = (tag: string): void =>
    setTagFilter((cur) => (cur.includes(tag) ? cur.filter((x) => x !== tag) : [...cur, tag]))
  const clearFilters = (): void => {
    setSearch('')
    setTagFilter([])
  }

  return (
    <Page>
      <PageHeader
        search={search}
        onSearch={setSearch}
        searchPlaceholder={t('searchPlaceholder')}
        actions={
          <Button variant="primary" onClick={() => openEditor('snippet')} data-testid="new-snippet">
            <Plus />
            {t('newSnippet')}
          </Button>
        }
      />
      <PageBody>
        {snippets.length === 0 ? (
          <EmptyState
            icon={<Braces />}
            title={t('emptyTitle')}
            description={t('emptyDescription')}
            className="py-24"
            action={
              <Button variant="primary" className="mt-2" onClick={() => openEditor('snippet')}>
                <Plus />
                {t('newSnippet')}
              </Button>
            }
          />
        ) : (
          <>
            {tagCounts.length > 0 && (
              <div className="mb-4 flex flex-wrap items-center gap-1.5" data-testid="snippet-tag-filter">
                <FilterChip
                  active={activeTags.length === 0}
                  onClick={() => setTagFilter([])}
                  count={snippets.length}
                >
                  {t('allTags')}
                </FilterChip>
                {tagCounts.map(([tag, count]) => (
                  <FilterChip
                    key={tag}
                    active={activeTags.includes(tag)}
                    onClick={() => toggleTag(tag)}
                    count={count}
                  >
                    <Hash className="size-3 opacity-70" />
                    {tag}
                  </FilterChip>
                ))}
              </div>
            )}
            {list.length === 0 ? (
              <EmptyState
                icon={<SearchX />}
                title={t('noMatch')}
                action={
                  <Button variant="secondary" size="sm" onClick={clearFilters}>
                    {t('clearFilters')}
                  </Button>
                }
              />
            ) : (
              <CardGrid className="grid-cols-[repeat(auto-fill,minmax(300px,1fr))]">
                {list.map((s) => (
                  <SnippetCard
                    key={s.id}
                    snippet={s}
                    onRun={() => setRunId(s.id)}
                    onTagClick={toggleTag}
                    activeTags={activeTags}
                  />
                ))}
              </CardGrid>
            )}
          </>
        )}
      </PageBody>
      <RunSnippetDialog snippetId={runId} onClose={() => setRunId(null)} />
    </Page>
  )
}

function FilterChip({
  active,
  onClick,
  count,
  children
}: {
  active: boolean
  onClick: () => void
  count: number
  children: ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex h-7 items-center gap-1 rounded-full border px-3 text-xs font-medium transition-colors',
        active
          ? 'border-accent bg-accent-soft text-accent'
          : 'border-line bg-panel text-muted hover:border-line-strong hover:text-fg'
      )}
    >
      {children}
      <span className={cn('ml-0.5 text-[10.5px] tabular-nums', active ? 'text-accent' : 'text-subtle')}>
        {count}
      </span>
    </button>
  )
}

function lineCount(script: string): number {
  const trimmed = script.replace(/\s+$/, '')
  return trimmed ? trimmed.split('\n').length : 0
}

function SnippetCard({
  snippet,
  onRun,
  onTagClick,
  activeTags
}: {
  snippet: Item<'snippet'>
  onRun: () => void
  onTagClick: (tag: string) => void
  activeTags: string[]
}): React.JSX.Element {
  const { t } = useTranslation('snippets')
  const { t: tc } = useTranslation()
  const { label, script, tags } = snippet.data

  const edit = (): void => openEditor('snippet', snippet.id)
  const copy = async (): Promise<void> => {
    try {
      await copyText(script)
      toast.success(t('scriptCopied'))
    } catch (err) {
      toast.error(tc('errorTitle'), { description: errorMessage(err) })
    }
  }
  const duplicate = async (): Promise<void> => {
    try {
      const dup = await call('vault.duplicate', snippet.id)
      toast.success(t('duplicated'), {
        action: { label: tc('edit'), onClick: () => openEditor('snippet', dup.id) }
      })
    } catch (err) {
      toast.error(tc('errorTitle'), { description: errorMessage(err) })
    }
  }
  const remove = async (): Promise<void> => {
    const ok = await confirm({
      title: tc('deleteConfirmTitle'),
      message: tc('deleteConfirm', { name: label }),
      confirmLabel: tc('delete'),
      danger: true
    })
    if (!ok) return
    try {
      await vaultApi.remove([snippet.id])
      toast.success(tc('deletedToast'))
    } catch (err) {
      toast.error(tc('errorTitle'), { description: errorMessage(err) })
    }
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-testid="snippet-card"
          onDoubleClick={edit}
          className="group relative flex min-w-0 cursor-default flex-col gap-2.5 rounded-xl border border-transparent bg-panel p-3.5 transition-colors hover:border-line hover:bg-panel-hover"
        >
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
              <SquareTerminal className="size-[18px]" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13.5px] font-semibold">{label}</div>
              <div className="text-xs text-muted">{t('lines', { count: lineCount(script) })}</div>
            </div>
            <div
              className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 has-[[aria-expanded=true]]:opacity-100"
              onDoubleClick={(e) => e.stopPropagation()}
            >
              <IconAction tip={t('run')} onClick={onRun} testId="run-snippet" className="hover:text-success">
                <Play />
              </IconAction>
              <IconAction tip={t('copyScript')} onClick={() => void copy()}>
                <Copy />
              </IconAction>
              <IconAction tip={tc('edit')} onClick={edit}>
                <Pencil />
              </IconAction>
              <DropdownMenu>
                <Tip content={tc('more')}>
                  <DropdownMenuTrigger asChild>
                    <Button size="icon-sm" variant="ghost" aria-label={tc('more')}>
                      <Ellipsis />
                    </Button>
                  </DropdownMenuTrigger>
                </Tip>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => void duplicate()}>
                    <CopyPlus />
                    {tc('duplicate')}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem danger onSelect={() => void remove()}>
                    <Trash2 />
                    {tc('delete')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
          <div className="min-h-[calc(3*1.6em+18px)] flex-1 rounded-lg border border-line bg-input px-2.5 py-2 text-[11.5px] leading-[1.6]">
            <pre className="line-clamp-3 whitespace-pre-wrap break-all font-mono text-muted">{script}</pre>
          </div>
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {tags.map((tag) => (
                <Badge
                  key={tag}
                  tone={activeTags.includes(tag) ? 'accent' : 'neutral'}
                  className="max-w-full cursor-default hover:text-fg"
                  onClick={(e) => {
                    e.stopPropagation()
                    onTagClick(tag)
                  }}
                  onDoubleClick={(e) => e.stopPropagation()}
                >
                  <span className="truncate">{tag}</span>
                </Badge>
              ))}
            </div>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onRun}>
          <Play />
          {t('run')}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void copy()}>
          <Copy />
          {t('copyScript')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={edit}>
          <Pencil />
          {tc('edit')}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void duplicate()}>
          <CopyPlus />
          {tc('duplicate')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem danger onSelect={() => void remove()}>
          <Trash2 />
          {tc('delete')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

function IconAction({
  tip,
  onClick,
  testId,
  className,
  children
}: {
  tip: string
  onClick: () => void
  testId?: string
  className?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <Tip content={tip}>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={tip}
        onClick={onClick}
        data-testid={testId}
        className={className}
      >
        {children}
      </Button>
    </Tip>
  )
}
