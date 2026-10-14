import { CornerDownLeft, History, Braces } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { useTabs } from '@/stores/tabs'
import { getItems } from '@/stores/vault'
import { currentLine, onCommandLine, onLineChange, sendInput, setKeyInterceptor } from './registry'

const MAX_HISTORY = 500
const historyKey = (hostKey: string): string => `sshtool.history.${hostKey}`

function hostKeyForSession(sessionId: string): string {
  const s = useTabs.getState().sessions[sessionId]
  if (!s) return 'unknown'
  if ((s.spec.kind === 'ssh' || s.spec.kind === 'telnet') && s.spec.hostId) return s.spec.hostId
  if (s.spec.kind === 'ssh' && s.spec.inline) return `inline:${s.spec.inline.address}`
  return s.spec.kind
}

function loadHistory(hostKey: string): string[] {
  try {
    return JSON.parse(localStorage.getItem(historyKey(hostKey)) ?? '[]') as string[]
  } catch {
    return []
  }
}

// Record every submitted command line (device-local; command history is never synced).
onCommandLine((sessionId, line) => {
  if (line.length < 2 || line.length > 500) return
  const key = hostKeyForSession(sessionId)
  const list = loadHistory(key).filter((c) => c !== line)
  list.unshift(line)
  localStorage.setItem(historyKey(key), JSON.stringify(list.slice(0, MAX_HISTORY)))
})

interface Suggestion {
  text: string
  source: 'history' | 'snippet'
}

function suggestionsFor(line: string, hostKey: string): Suggestion[] {
  if (line.trim().length < 2) return []
  const out: Suggestion[] = []
  const seen = new Set<string>()
  for (const c of loadHistory(hostKey)) {
    if (c.startsWith(line) && c !== line && !seen.has(c)) {
      seen.add(c)
      out.push({ text: c, source: 'history' })
      if (out.length >= 4) break
    }
  }
  for (const s of getItems('snippet')) {
    const first = s.data.script.split('\n')[0]
    if (!s.data.script.includes('\n') && first.startsWith(line) && first !== line && !seen.has(first)) {
      seen.add(first)
      out.push({ text: first, source: 'snippet' })
      if (out.length >= 6) break
    }
  }
  return out
}

/** Inline command suggestions (Termius style autocomplete). Tab accepts, Esc dismisses. */
export function Autocomplete({ sessionId, hostId }: { sessionId: string; hostId?: string }): React.JSX.Element | null {
  const { t } = useTranslation('terminal')
  const [line, setLine] = useState(() => currentLine(sessionId))
  const [index, setIndex] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const hostKey = useMemo(() => hostId ?? hostKeyForSession(sessionId), [hostId, sessionId])

  useEffect(
    () =>
      onLineChange((id, l) => {
        if (id !== sessionId) return
        setLine(l)
        setIndex(0)
        setDismissed(false)
      }),
    [sessionId]
  )

  const items = useMemo(() => (dismissed ? [] : suggestionsFor(line, hostKey)), [line, hostKey, dismissed])

  useEffect(() => {
    if (!items.length) {
      setKeyInterceptor(sessionId, null)
      return
    }
    setKeyInterceptor(sessionId, (e) => {
      if (e.type !== 'keydown') return true
      if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const pick = items[Math.min(index, items.length - 1)]
        e.preventDefault()
        sendInput(sessionId, pick.text.slice(line.length))
        return false
      }
      if (e.key === 'Escape') {
        setDismissed(true)
        return true
      }
      if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault()
        setIndex((i) => (e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length))
        return false
      }
      return true
    })
    return () => setKeyInterceptor(sessionId, null)
  }, [items, index, line, sessionId])

  if (!items.length) return null
  return (
    <div className="pointer-events-none absolute bottom-3 left-3 z-10 max-w-[70%] rounded-lg border border-line bg-elevated/95 p-1 shadow-pop backdrop-blur animate-fade-in" data-testid="autocomplete">
      {items.map((s, i) => (
        <div key={s.text} className={cn('flex items-center gap-2 rounded-md px-2 py-1 font-mono text-xs', i === index ? 'bg-accent-soft text-fg' : 'text-muted')}>
          {s.source === 'history' ? <History className="size-3 shrink-0 text-subtle" /> : <Braces className="size-3 shrink-0 text-subtle" />}
          <span className="truncate">
            <span className="text-subtle">{line}</span>
            <span>{s.text.slice(line.length)}</span>
          </span>
          {i === index && <CornerDownLeft className="ml-auto size-3 shrink-0 text-subtle" />}
        </div>
      ))}
      <div className="px-2 pb-0.5 pt-1 text-[10px] text-subtle">{t('autocompleteHint')} · Alt+↑↓ · Esc</div>
    </div>
  )
}
