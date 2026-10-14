import { ArrowDown, ArrowUp, CaseSensitive, Regex, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { clearSearch, findInTerminal, focusTerminal } from './registry'

export function SearchBar({ sessionId, onClose }: { sessionId: string; onClose: () => void }): React.JSX.Element {
  const { t } = useTranslation('terminal')
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [regex, setRegex] = useState(false)
  const [miss, setMiss] = useState(false)
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  useEffect(() => {
    if (!query) {
      clearSearch(sessionId)
      setMiss(false)
      return
    }
    setMiss(!findInTerminal(sessionId, query, 'next', { caseSensitive, regex }))
  }, [query, caseSensitive, regex, sessionId])

  const close = (): void => {
    clearSearch(sessionId)
    onClose()
    focusTerminal(sessionId)
  }

  const go = (dir: 'next' | 'prev'): void => setMiss(!findInTerminal(sessionId, query, dir, { caseSensitive, regex }))

  const toggle = (on: boolean): string => cn('rounded p-1 [&_svg]:size-3.5', on ? 'bg-accent-soft text-accent' : 'text-subtle hover:text-fg')

  return (
    <div className="absolute right-4 top-2 z-20 flex items-center gap-1 rounded-lg border border-line bg-elevated p-1 shadow-pop animate-fade-in">
      <input
        ref={ref}
        value={query}
        placeholder={t('findPlaceholder')}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') go(e.shiftKey ? 'prev' : 'next')
          if (e.key === 'Escape') close()
        }}
        className={cn('h-7 w-56 rounded-md bg-input px-2 text-[13px] outline-none', miss && query && 'text-danger')}
      />
      <button className={toggle(caseSensitive)} title={t('caseSensitive')} onClick={() => setCaseSensitive((v) => !v)}>
        <CaseSensitive />
      </button>
      <button className={toggle(regex)} title={t('regex')} onClick={() => setRegex((v) => !v)}>
        <Regex />
      </button>
      <button className={toggle(false)} onClick={() => go('prev')}>
        <ArrowUp />
      </button>
      <button className={toggle(false)} onClick={() => go('next')}>
        <ArrowDown />
      </button>
      <button className={toggle(false)} onClick={close}>
        <X />
      </button>
    </div>
  )
}
