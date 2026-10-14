import { Plus, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { vaultApi } from '@/lib/api'
import { cn, colorFor } from '@/lib/utils'
import { useItems } from '@/stores/vault'
import { inputClass } from '@/components/ui/input'

/** Chip input for tags (ids); unknown names create new tags. */
export function TagInput({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }): React.JSX.Element {
  const { t } = useTranslation('hosts')
  const tags = useItems('tag')
  const [text, setText] = useState('')
  const [focused, setFocused] = useState(false)
  const byId = useMemo(() => new Map(tags.map((tg) => [tg.id, tg])), [tags])
  const suggestions = useMemo(() => {
    const q = text.trim().toLowerCase()
    return tags.filter((tg) => !value.includes(tg.id) && (!q || tg.data.name.toLowerCase().includes(q))).slice(0, 8)
  }, [tags, text, value])
  const exact = tags.find((tg) => tg.data.name.toLowerCase() === text.trim().toLowerCase())

  const add = async (name: string): Promise<void> => {
    const n = name.trim()
    if (!n) return
    const existing = tags.find((tg) => tg.data.name.toLowerCase() === n.toLowerCase())
    const id = existing?.id ?? (await vaultApi.upsert('tag', { name: n })).id
    if (!value.includes(id)) onChange([...value, id])
    setText('')
  }

  return (
    <div className="relative">
      <div className={cn(inputClass, 'flex h-auto min-h-8 flex-wrap items-center gap-1 py-1')}>
        {value.map((id) => {
          const tg = byId.get(id)
          if (!tg) return null
          return (
            <span key={id} className="flex h-6 items-center gap-1 rounded-md bg-panel-hover pl-2 pr-1 text-xs">
              <span className="size-2 rounded-full" style={{ backgroundColor: tg.data.color ?? colorFor(tg.data.name) }} />
              {tg.data.name}
              <button type="button" className="rounded p-0.5 text-subtle hover:text-fg" onClick={() => onChange(value.filter((x) => x !== id))}>
                <X className="size-3" />
              </button>
            </span>
          )
        })}
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault()
              void add(text)
            } else if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1))
          }}
          placeholder={value.length ? '' : t('editor.tagsPlaceholder')}
          className="h-6 min-w-[80px] flex-1 bg-transparent text-[13px] outline-none placeholder:text-subtle"
        />
      </div>
      {focused && (suggestions.length > 0 || (text.trim() && !exact)) && (
        <div className="absolute inset-x-0 top-full z-10 mt-1 max-h-48 overflow-y-auto rounded-lg border border-line bg-elevated p-1 shadow-pop">
          {suggestions.map((tg) => (
            <button
              key={tg.id}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void add(tg.data.name)}
              className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] hover:bg-accent-soft"
            >
              <span className="size-2 rounded-full" style={{ backgroundColor: tg.data.color ?? colorFor(tg.data.name) }} />
              {tg.data.name}
            </button>
          ))}
          {text.trim() && !exact && (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void add(text)}
              className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-accent hover:bg-accent-soft"
            >
              <Plus className="size-3.5" />
              {t('editor.newTag', { name: text.trim() })}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
