import { Plus, X } from 'lucide-react'
import { type ReactNode, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { confirm } from '@/components/ui/confirm'
import { Sheet, SheetSection } from '@/components/ui/dialog'
import { Field, Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/misc'
import { errorMessage, isMac, vaultApi } from '@/lib/api'
import { cn } from '@/lib/utils'
import { getItem, useItems } from '@/stores/vault'
import { CodeEditor } from './CodeEditor'

const MAX_TAGS = 32
const MAX_TAG_LENGTH = 64

interface FormState {
  label: string
  script: string
  tags: string[]
}

function initialForm(id: string | undefined, defaults: Record<string, unknown> | undefined): FormState {
  const src: Record<string, unknown> = (id ? getItem('snippet', id)?.data : undefined) ?? defaults ?? {}
  return {
    label: typeof src.label === 'string' ? src.label : '',
    script: typeof src.script === 'string' ? src.script : '',
    tags: Array.isArray(src.tags) ? src.tags.filter((x): x is string => typeof x === 'string') : []
  }
}

function Required({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <>
      {children}
      <span className="ml-0.5 text-danger">*</span>
    </>
  )
}

export function SnippetEditor({
  id,
  defaults,
  onClose
}: {
  id?: string
  defaults?: Record<string, unknown>
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation('snippets')
  const { t: tc } = useTranslation()
  const snippets = useItems('snippet')
  const [initial] = useState(() => initialForm(id, defaults))
  const [existingLabel] = useState(() => (id ? getItem('snippet', id)?.data.label : undefined))
  const isEdit = existingLabel !== undefined
  const [form, setForm] = useState(initial)
  const [submitted, setSubmitted] = useState(false)
  const [saving, setSaving] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)

  const set = <K extends keyof FormState>(key: K, value: FormState[K]): void =>
    setForm((f) => ({ ...f, [key]: value }))
  const dirty = JSON.stringify(form) !== JSON.stringify(initial)
  const errors = {
    label: form.label.trim() ? undefined : t('errors.label'),
    script: form.script.trim() ? undefined : t('errors.script')
  }
  const shown = submitted ? errors : { label: undefined, script: undefined }
  const knownTags = useMemo(
    () => [...new Set(snippets.flatMap((s) => s.data.tags))].sort((a, b) => a.localeCompare(b)),
    [snippets]
  )

  const requestClose = async (): Promise<void> => {
    if (dirty && !saving) {
      const ok = await confirm({
        title: tc('unsavedTitle'),
        message: tc('unsaved'),
        confirmLabel: tc('discard'),
        danger: true
      })
      if (!ok) return
    }
    onClose()
  }

  const save = async (): Promise<void> => {
    if (saving) return
    setSubmitted(true)
    if (errors.label || errors.script) return
    setSaving(true)
    try {
      await vaultApi.upsert(
        'snippet',
        { label: form.label.trim(), script: form.script, tags: form.tags },
        id ? { id } : undefined
      )
      toast.success(tc('savedToast'))
      onClose()
    } catch (err) {
      toast.error(tc('errorTitle'), { description: errorMessage(err) })
      setSaving(false)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.defaultPrevented || e.nativeEvent.isComposing) return
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault()
      void save()
      return
    }
    const target = e.target as HTMLElement
    if (e.key === 'Enter' && target.tagName === 'INPUT' && bodyRef.current?.contains(target)) {
      e.preventDefault()
      void save()
    }
  }

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) void requestClose()
      }}
      title={isEdit ? t('editTitle') : t('newTitle')}
      subtitle={existingLabel}
      width="w-[560px]"
      footer={
        <>
          <span className="text-xs text-subtle">{t('saveShortcut', { key: isMac ? '⌘S' : 'Ctrl+S' })}</span>
          <div className="flex-1" />
          <Button variant="ghost" onClick={() => void requestClose()}>
            {tc('cancel')}
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={saving} data-testid="snippet-save">
            {saving && <Spinner className="size-3.5 text-white" />}
            {tc('save')}
          </Button>
        </>
      }
    >
      <div ref={bodyRef} onKeyDown={onKeyDown} data-testid="snippet-editor">
        <SheetSection>
          <Field label={<Required>{t('label')}</Required>} error={shown.label} htmlFor="snippet-label">
            <Input
              id="snippet-label"
              value={form.label}
              onChange={(e) => set('label', e.target.value)}
              placeholder={t('labelPlaceholder')}
              maxLength={255}
              autoFocus={!isEdit}
              aria-invalid={!!shown.label || undefined}
              className={cn(shown.label && 'border-danger focus:border-danger focus:ring-danger/20')}
              data-testid="snippet-label"
            />
          </Field>
          <Field label={<Required>{t('script')}</Required>} error={shown.script} hint={t('scriptHint')}>
            <CodeEditor
              value={form.script}
              onChange={(v) => set('script', v)}
              language="shell"
              minHeight={220}
              maxHeight={420}
              autoFocus={isEdit}
              placeholder={t('scriptPlaceholder')}
              invalid={!!shown.script}
              ariaLabel={t('script')}
            />
          </Field>
          <Field label={t('tags')} hint={t('tagsHint')}>
            <TagInput value={form.tags} onChange={(tags) => set('tags', tags)} suggestions={knownTags} />
          </Field>
        </SheetSection>
      </div>
    </Sheet>
  )
}

/** Chip input: Enter or comma adds a tag, Backspace on an empty input removes the last one. */
function TagInput({
  value,
  onChange,
  suggestions
}: {
  value: string[]
  onChange: (tags: string[]) => void
  suggestions: string[]
}): React.JSX.Element {
  const { t } = useTranslation('snippets')
  const [text, setText] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const add = (raw: string): void => {
    const next = [...value]
    for (const part of raw.split(',')) {
      const tag = part.trim().slice(0, MAX_TAG_LENGTH)
      if (!tag || next.some((x) => x.toLowerCase() === tag.toLowerCase())) continue
      if (next.length >= MAX_TAGS) {
        toast.error(t('errors.tooManyTags', { max: MAX_TAGS }))
        break
      }
      next.push(tag)
    }
    if (next.length !== value.length) onChange(next)
    setText('')
  }
  const remove = (tag: string): void => onChange(value.filter((x) => x !== tag))

  const q = text.trim().toLowerCase()
  const available = suggestions
    .filter(
      (s) => !value.some((v) => v.toLowerCase() === s.toLowerCase()) && (!q || s.toLowerCase().includes(q))
    )
    .slice(0, 12)

  return (
    <div className="flex flex-col gap-2">
      <div
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) {
            e.preventDefault()
            inputRef.current?.focus()
          }
        }}
        className="flex min-h-8 flex-wrap items-center gap-1 rounded-md border border-line bg-input px-1 py-[3px] transition-colors focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20"
      >
        {value.map((tag) => (
          <span
            key={tag}
            className="inline-flex h-6 max-w-full items-center gap-0.5 rounded bg-accent-soft pl-2 pr-0.5 text-xs font-medium text-accent"
            data-testid="snippet-tag"
          >
            <span className="truncate">{tag}</span>
            <button
              type="button"
              aria-label={t('removeTag', { tag })}
              onClick={() => remove(tag)}
              className="flex size-5 shrink-0 items-center justify-center rounded text-accent/70 hover:bg-accent/15 hover:text-accent"
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          value={text}
          spellCheck={false}
          onChange={(e) => {
            const v = e.target.value
            if (v.includes(',')) add(v)
            else setText(v)
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return
            if (e.key === 'Enter' && text.trim()) {
              e.preventDefault()
              add(text)
            } else if (e.key === 'Backspace' && !text && value.length) {
              e.preventDefault()
              remove(value[value.length - 1])
            }
          }}
          onBlur={() => {
            if (text.trim()) add(text)
          }}
          placeholder={value.length ? '' : t('tagsPlaceholder')}
          className="h-6 min-w-[120px] flex-1 bg-transparent px-1.5 text-[13px] text-fg outline-none placeholder:text-subtle"
          data-testid="snippet-tag-input"
        />
      </div>
      {available.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="mr-0.5 text-[11px] text-subtle">{t('suggestions')}</span>
          {available.map((s) => (
            <button
              key={s}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => add(s)}
              className="inline-flex h-6 items-center gap-1 rounded border border-dashed border-line-strong px-1.5 text-xs text-muted transition-colors hover:border-accent hover:text-accent"
            >
              <Plus className="size-3" />
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
