import { ChevronRight, Monitor } from 'lucide-react'
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FsInfo } from '@shared/types'
import { splitPath } from '@shared/util'
import { cn } from '@/lib/utils'
import { navigate, type PaneId } from './store'
import { resolveInputPath, samePath } from './utils'

/** Breadcrumbs of the current folder; clicking the empty area (or the last crumb) turns them into a path input. */
export function PathBar({ paneId, fs, path }: { paneId: PaneId; fs: FsInfo; path: string }): React.JSX.Element {
  const { t } = useTranslation('sftp')
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [invalid, setInvalid] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const crumbs = useMemo(() => {
    if (fs.flavor === 'posix') return splitPath(path || '/', 'posix')
    const computer = { label: t('computer'), path: '' }
    return path ? [computer, ...splitPath(path, 'win32')] : [computer]
  }, [fs.flavor, path, t])

  // Keep the deepest crumb visible when the path is longer than the bar.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [crumbs, editing])

  useEffect(() => {
    if (!editing) return
    const el = inputRef.current
    el?.focus()
    el?.select()
  }, [editing])

  const startEdit = (): void => {
    setValue(path)
    setInvalid(false)
    setEditing(true)
  }

  const submit = async (): Promise<void> => {
    const target = resolveInputPath(value, fs, path)
    if (target === null) {
      setInvalid(true)
      return
    }
    if (samePath(target, path, fs.flavor)) {
      setEditing(false)
      return
    }
    if (await navigate(paneId, target)) setEditing(false)
    else {
      setInvalid(true)
      inputRef.current?.select()
    }
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={value}
        spellCheck={false}
        data-testid="sftp-path-input"
        onChange={(e) => {
          setValue(e.target.value)
          setInvalid(false)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            void submit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            setEditing(false)
          }
        }}
        onBlur={() => setEditing(false)}
        placeholder={fs.flavor === 'win32' ? 'C:\\' : '/'}
        className={cn(
          'h-7 min-w-0 flex-1 rounded-md border bg-input px-2 font-mono text-xs text-fg outline-none placeholder:text-subtle focus:ring-2',
          invalid ? 'border-danger focus:ring-danger/20' : 'border-accent focus:ring-accent/20'
        )}
      />
    )
  }

  return (
    <div
      ref={scrollRef}
      onClick={(e) => {
        if (e.target === e.currentTarget) startEdit()
      }}
      title={t('editPath')}
      className="flex h-7 min-w-0 flex-1 cursor-text items-center overflow-x-auto rounded-md border border-transparent px-1 transition-colors [scrollbar-width:none] hover:border-line hover:bg-input/60 [&::-webkit-scrollbar]:hidden"
      data-testid={`sftp-breadcrumbs-${paneId}`}
    >
      {crumbs.map((c, i) => {
        const last = i === crumbs.length - 1
        return (
          <Fragment key={`${i}:${c.path}`}>
            {i > 0 && !(fs.flavor === 'posix' && i === 1) && <ChevronRight className="pointer-events-none size-3 shrink-0 text-subtle" />}
            <button
              type="button"
              onClick={() => (last ? startEdit() : void navigate(paneId, c.path))}
              className={cn(
                'flex h-6 shrink-0 cursor-default items-center gap-1.5 rounded px-1.5 text-[12.5px] transition-colors hover:bg-panel-hover',
                last ? 'font-medium text-fg' : 'text-muted hover:text-fg',
                fs.flavor === 'posix' && i === 0 && 'px-1 font-mono'
              )}
            >
              {fs.flavor === 'win32' && i === 0 && <Monitor className="size-3.5" />}
              <span className="max-w-[220px] truncate">{c.label}</span>
            </button>
          </Fragment>
        )
      })}
      <div className="h-full min-w-6 flex-1" onClick={startEdit} />
    </div>
  )
}
