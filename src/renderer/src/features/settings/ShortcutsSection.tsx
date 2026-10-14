import { Keyboard, RotateCcw, TriangleAlert, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { confirm } from '@/components/ui/confirm'
import { Tip } from '@/components/ui/controls'
import { Badge, Kbd } from '@/components/ui/misc'
import { errorMessage, isMac } from '@/lib/api'
import {
  comboFromEvent,
  defaultShortcut,
  formatCombo,
  overrideKey,
  resolveShortcuts,
  SHORTCUT_ACTIONS,
  type ShortcutAction
} from '@/lib/shortcuts'
import { cn } from '@/lib/utils'
import { saveShortcutOverrides, useShortcutOverrides } from '@/stores/vault'
import { Callout, SettingsCard, SettingsGroup } from './ui'

type GroupId = 'general' | 'tabs' | 'panes' | 'terminal' | 'other'

const GROUPS: { id: GroupId; actions: ShortcutAction[] }[] = [
  { id: 'general', actions: ['commandPalette', 'newHost', 'localTerminal', 'openSftp', 'settings', 'lock'] },
  {
    id: 'tabs',
    actions: [
      'newTab',
      'closeTab',
      'nextTab',
      'prevTab',
      'goToTab1',
      'goToTab2',
      'goToTab3',
      'goToTab4',
      'goToTab5',
      'goToTab6',
      'goToTab7',
      'goToTab8',
      'goToTab9'
    ]
  },
  { id: 'panes', actions: ['splitRight', 'splitDown', 'closePane', 'broadcast'] },
  { id: 'terminal', actions: ['find', 'copy', 'paste', 'zoomIn', 'zoomOut', 'zoomReset'] }
]

function groupsWithRest(): { id: GroupId; actions: ShortcutAction[] }[] {
  const listed = new Set(GROUPS.flatMap((g) => g.actions))
  const rest = SHORTCUT_ACTIONS.filter((a) => !listed.has(a))
  return rest.length ? [...GROUPS, { id: 'other', actions: rest }] : GROUPS
}

const MODIFIERS = new Set(['Ctrl', 'Alt', 'Meta'])

export function ComboKeys({ combo, className }: { combo: string; className?: string }): React.JSX.Element {
  return (
    <span className={cn('flex items-center gap-1', className)}>
      {combo.split('+').map((part, i) => (
        <Kbd key={i}>{formatCombo(part)}</Kbd>
      ))}
    </span>
  )
}

export function ShortcutsSection(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const overrides = useShortcutOverrides()
  const overridesRef = useRef(overrides)
  useEffect(() => {
    overridesRef.current = overrides
  })
  const resolved = useMemo(() => resolveShortcuts(overrides), [overrides])
  const [recording, setRecording] = useState<ShortcutAction | null>(null)
  const [recordError, setRecordError] = useState<string | null>(null)

  const label = (a: ShortcutAction): string => {
    const m = /^goToTab(\d)$/.exec(a)
    return m ? t('shortcuts.actions.goToTab', { n: m[1] }) : t(`shortcuts.actions.${a}`, { defaultValue: a })
  }

  const conflicts = useMemo(() => {
    const byCombo = new Map<string, ShortcutAction[]>()
    for (const a of SHORTCUT_ACTIONS) byCombo.set(resolved[a], [...(byCombo.get(resolved[a]) ?? []), a])
    const out = new Map<ShortcutAction, ShortcutAction[]>()
    let combos = 0
    for (const list of byCombo.values()) {
      if (list.length < 2) continue
      combos++
      for (const a of list)
        out.set(
          a,
          list.filter((x) => x !== a)
        )
    }
    return { byAction: out, combos }
  }, [resolved])

  const customCount = SHORTCUT_ACTIONS.filter((a) => overrides[overrideKey(a)] !== undefined).length

  const save = async (
    next: Record<string, string>,
    message: string,
    action?: ShortcutAction
  ): Promise<void> => {
    try {
      await saveShortcutOverrides(next)
      if (action) {
        const map = resolveShortcuts(next)
        const clash = SHORTCUT_ACTIONS.find((a) => a !== action && map[a] === map[action])
        if (clash) {
          toast.warning(
            t('shortcuts.conflictToast', { combo: formatCombo(map[action]), action: label(clash) })
          )
          return
        }
      }
      toast.success(message)
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  const assign = (action: ShortcutAction, combo: string): void => {
    const next = { ...overridesRef.current }
    if (combo === defaultShortcut(action)) delete next[overrideKey(action)]
    else next[overrideKey(action)] = combo
    void save(next, t('shortcuts.saved'), action)
  }
  const assignRef = useRef(assign)
  useEffect(() => {
    assignRef.current = assign
  })

  const resetOne = (action: ShortcutAction): void => {
    const next = { ...overrides }
    delete next[overrideKey(action)]
    void save(next, t('shortcuts.reset'))
  }

  const resetAll = async (): Promise<void> => {
    const ok = await confirm({
      title: t('shortcuts.resetAllTitle'),
      message: t('shortcuts.resetAllMessage'),
      confirmLabel: t('shortcuts.resetAll'),
      danger: true
    })
    if (!ok) return
    const own = new Set(SHORTCUT_ACTIONS.map(overrideKey))
    void save(
      Object.fromEntries(Object.entries(overrides).filter(([k]) => !own.has(k))),
      t('shortcuts.resetAllDone')
    )
  }

  useEffect(() => {
    if (!recording) return
    const w = window as { __sshtoolRecordingShortcut?: boolean }
    w.__sshtoolRecordingShortcut = true
    const stop = (): void => setRecording(null)
    const onKeyDown = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) return stop()
      const combo = comboFromEvent(e)
      if (!combo) return
      const parts = combo.split('+')
      const key = parts[parts.length - 1]
      if (!parts.some((p) => MODIFIERS.has(p)) && !/^F\d{1,2}$/.test(key)) {
        setRecordError(t('shortcuts.needsModifier', { mods: isMac ? '⌃ ⌥ ⌘' : 'Ctrl / Alt' }))
        return
      }
      stop()
      assignRef.current(recording, combo)
    }
    const swallow = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
    }
    const onMouseDown = (e: MouseEvent): void => {
      if (!(e.target as HTMLElement | null)?.closest?.('[data-recording="true"]')) stop()
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', swallow, true)
    window.addEventListener('mousedown', onMouseDown, true)
    window.addEventListener('blur', stop)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', swallow, true)
      window.removeEventListener('mousedown', onMouseDown, true)
      window.removeEventListener('blur', stop)
      w.__sshtoolRecordingShortcut = false
    }
  }, [recording, t])

  const startRecording = (a: ShortcutAction): void => {
    setRecordError(null)
    setRecording((cur) => (cur === a ? null : a))
  }

  return (
    <>
      <div className="mb-6 flex items-start gap-4">
        <p className="min-w-0 flex-1 text-xs leading-relaxed text-muted">{t('shortcuts.intro')}</p>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void resetAll()}
          disabled={customCount === 0}
          data-testid="shortcuts-reset-all"
        >
          <RotateCcw />
          {t('shortcuts.resetAll')}
        </Button>
      </div>

      {conflicts.combos > 0 && (
        <Callout tone="warning" className="mb-6" testId="shortcuts-conflicts">
          {t('shortcuts.conflictsBanner', { count: conflicts.combos })}
        </Callout>
      )}

      {groupsWithRest().map((g) => (
        <SettingsGroup key={g.id} title={t(`shortcuts.groups.${g.id}`)}>
          <SettingsCard>
            {g.actions.map((a) => {
              const isRecording = recording === a
              const custom = overrides[overrideKey(a)] !== undefined
              const clash = conflicts.byAction.get(a) ?? []
              return (
                <div
                  key={a}
                  data-recording={isRecording}
                  data-testid={`shortcut-row-${a}`}
                  className={cn(
                    'flex min-h-[52px] items-center gap-3 px-4 py-2 transition-colors',
                    isRecording && 'bg-accent-soft'
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[13px] font-medium">{label(a)}</span>
                      {custom && !isRecording && <Badge tone="accent">{t('shortcuts.custom')}</Badge>}
                    </div>
                    {isRecording && recordError ? (
                      <div className="mt-0.5 text-xs text-danger">{recordError}</div>
                    ) : (
                      clash.length > 0 && (
                        <div className="mt-0.5 flex items-center gap-1 text-xs text-warning">
                          <TriangleAlert className="size-3 shrink-0" />
                          <span className="truncate">
                            {t('shortcuts.conflict', { actions: clash.map(label).join(', ') })}
                          </span>
                        </div>
                      )
                    )}
                  </div>
                  {isRecording ? (
                    <span className="flex items-center gap-2 text-xs" data-testid="shortcut-recording">
                      <span className="font-medium text-accent animate-soft-pulse">
                        {t('shortcuts.recording')}
                      </span>
                      <span className="text-subtle">{t('shortcuts.escToCancel')}</span>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => startRecording(a)}
                      className={cn(
                        'rounded-md p-1 transition-colors hover:bg-panel-hover',
                        clash.length > 0 && 'ring-1 ring-warning/50'
                      )}
                      data-testid={`shortcut-combo-${a}`}
                    >
                      <ComboKeys combo={resolved[a]} />
                    </button>
                  )}
                  <Button
                    size="sm"
                    variant={isRecording ? 'ghost' : 'secondary'}
                    onClick={() => startRecording(a)}
                    data-testid={`shortcut-record-${a}`}
                    className="w-[84px]"
                  >
                    {isRecording ? <X /> : <Keyboard />}
                    {isRecording ? t('shortcuts.cancel') : t('shortcuts.record')}
                  </Button>
                  <Tip content={custom ? t('shortcuts.resetOne') : undefined}>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      onClick={() => resetOne(a)}
                      className={cn(!custom && 'invisible')}
                      aria-label={t('shortcuts.resetOne')}
                      data-testid={`shortcut-reset-${a}`}
                    >
                      <RotateCcw />
                    </Button>
                  </Tip>
                </div>
              )
            })}
          </SettingsCard>
        </SettingsGroup>
      ))}
    </>
  )
}
