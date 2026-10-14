import { Braces, ClipboardPaste, Play, Plus, Search, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/controls'
import { Input } from '@/components/ui/input'
import { openEditor } from '@/stores/ui'
import { useItems } from '@/stores/vault'
import { typeInto } from './registry'

export function SnippetsPanel({ sessionId, onClose }: { sessionId?: string; onClose: () => void }): React.JSX.Element {
  const { t } = useTranslation('terminal')
  const snippets = useItems('snippet')
  const [q, setQ] = useState('')
  const list = useMemo(() => {
    const s = q.trim().toLowerCase()
    return [...snippets]
      .filter((x) => !s || x.data.label.toLowerCase().includes(s) || x.data.script.toLowerCase().includes(s) || x.data.tags.some((tg) => tg.toLowerCase().includes(s)))
      .sort((a, b) => a.data.label.localeCompare(b.data.label))
  }, [snippets, q])

  return (
    <div className="flex h-full w-[280px] shrink-0 flex-col border-l border-line bg-sidebar" data-testid="snippets-panel">
      <div className="flex h-10 items-center gap-2 border-b border-line px-3">
        <Braces className="size-4 text-muted" />
        <span className="flex-1 text-[13px] font-semibold">{t('snippets')}</span>
        <Button size="icon-xs" variant="ghost" onClick={() => openEditor('snippet')}>
          <Plus />
        </Button>
        <Button size="icon-xs" variant="ghost" onClick={onClose}>
          <X />
        </Button>
      </div>
      <div className="p-2">
        <Input icon={<Search />} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('snippetsSearch')} className="h-7" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {list.length === 0 && <div className="px-2 py-6 text-center text-xs text-subtle">{t('snippetsEmpty')}</div>}
        {list.map((s) => (
          <div
            key={s.id}
            className="group mb-1 cursor-default rounded-lg border border-transparent px-2.5 py-2 hover:border-line hover:bg-panel"
            onDoubleClick={() => sessionId && typeInto(sessionId, s.data.script, true)}
          >
            <div className="flex items-center gap-1">
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{s.data.label}</span>
              <Tip content={t('paste_')}>
                <button className="hidden rounded p-1 text-subtle hover:text-fg group-hover:block" onClick={() => sessionId && typeInto(sessionId, s.data.script, false)}>
                  <ClipboardPaste className="size-3.5" />
                </button>
              </Tip>
              <Tip content={t('runIt')}>
                <button className="rounded p-1 text-subtle hover:text-success" onClick={() => sessionId && typeInto(sessionId, s.data.script, true)}>
                  <Play className="size-3.5" />
                </button>
              </Tip>
            </div>
            <pre className="mt-1 line-clamp-2 whitespace-pre-wrap break-all font-mono text-[11px] text-muted">{s.data.script}</pre>
          </div>
        ))}
      </div>
    </div>
  )
}
