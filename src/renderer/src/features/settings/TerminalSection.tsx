import { Check, ChevronDown, CloudCheck, CloudOff, Moon, Sun } from 'lucide-react'
import { type CSSProperties, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { TerminalPrefs } from '@shared/schemas'
import { Badge, Segmented } from '@/components/ui/misc'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  Switch
} from '@/components/ui/controls'
import { Input } from '@/components/ui/input'
import { errorMessage } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useApp } from '@/stores/app'
import { saveTerminalPrefs, useTerminalPrefs } from '@/stores/vault'
import { getTheme, TERMINAL_THEMES, type TerminalTheme } from '@/features/terminal/themes'
import { Callout, NumberField, SettingsCard, SettingsGroup, SettingsRow } from './ui'

export const FONT_SUGGESTIONS = [
  'JetBrains Mono',
  'Cascadia Mono',
  'Consolas',
  'Menlo',
  'SF Mono',
  'Fira Code',
  'Source Code Pro',
  'Ubuntu Mono'
]

const fontCache = new Map<string, boolean>()

/** Detects locally available fonts by comparing text widths against generic fallbacks. */
function fontAvailable(name: string): boolean {
  const cached = fontCache.get(name)
  if (cached !== undefined) return cached
  let ok = true
  try {
    const ctx = document.createElement('canvas').getContext('2d')
    if (ctx) {
      const sample = 'mmmmmmmmmmlli10OO@#WwQq{}'
      ok = ['monospace', 'serif', 'sans-serif'].some((base) => {
        ctx.font = `48px ${base}`
        const fallback = ctx.measureText(sample).width
        ctx.font = `48px "${name}", ${base}`
        return ctx.measureText(sample).width !== fallback
      })
    }
  } catch {
    ok = true
  }
  fontCache.set(name, ok)
  return ok
}

function fontStack(family: string): string {
  return `"${family.replace(/"/g, '')}", "JetBrains Mono", "Cascadia Mono", Menlo, Consolas, monospace`
}

export function TerminalSection(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const stored = useTerminalPrefs()
  const dark = useApp((s) => s.resolvedTheme === 'dark')
  const syncConfigured = useApp((s) => s.sync.configured)
  const setSection = useApp((s) => s.setSection)
  // Optimistic values until the vault round trip (vault.changed → store) catches up.
  const [overlay, setOverlay] = useState<Partial<TerminalPrefs>>({})
  const prefs: TerminalPrefs = { ...stored, ...overlay }

  useEffect(() => {
    setOverlay((o) => {
      const keys = Object.keys(o) as (keyof TerminalPrefs)[]
      const pending = keys.filter((k) => stored[k] !== o[k])
      if (pending.length === keys.length) return o
      return Object.fromEntries(pending.map((k) => [k, o[k]])) as Partial<TerminalPrefs>
    })
  }, [stored])

  const update = (patch: Partial<TerminalPrefs>): void => {
    setOverlay((o) => ({ ...o, ...patch }))
    saveTerminalPrefs({ ...prefs, ...patch }).catch((err) => {
      toast.error(errorMessage(err))
      setOverlay(
        (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !(k in patch))) as Partial<TerminalPrefs>
      )
    })
  }

  const theme = getTheme(prefs.theme, dark)

  return (
    <>
      <Callout
        tone={syncConfigured ? 'info' : 'warning'}
        icon={syncConfigured ? <CloudCheck /> : <CloudOff />}
        className="mb-6"
        action={
          !syncConfigured && (
            <Button size="sm" variant="secondary" onClick={() => setSection('settings', 'sync')}>
              {t('terminal.setupSync')}
            </Button>
          )
        }
        testId="terminal-sync-hint"
      >
        {syncConfigured ? t('terminal.synced') : t('terminal.notSynced')}
      </Callout>

      <div className="sticky top-0 z-10 -mx-2 bg-app px-2 pb-4 pt-1">
        <TerminalPreview prefs={prefs} theme={theme} />
      </div>

      <SettingsGroup
        title={t('terminal.colorTheme')}
        action={<span className="text-xs text-subtle">{theme.name}</span>}
        className="mt-3"
      >
        <div
          className="grid grid-cols-[repeat(auto-fill,minmax(128px,1fr))] gap-2.5"
          role="radiogroup"
          aria-label={t('terminal.colorTheme')}
        >
          {TERMINAL_THEMES.map((th) => (
            <ThemeCard
              key={th.id}
              theme={th}
              selected={th.id === theme.id}
              onSelect={() => update({ theme: th.id })}
            />
          ))}
        </div>
      </SettingsGroup>

      <SettingsGroup title={t('terminal.text')}>
        <SettingsCard>
          <SettingsRow label={t('terminal.fontFamily')} description={t('terminal.fontFamilyDesc')}>
            <FontFamilyField value={prefs.fontFamily} onCommit={(fontFamily) => update({ fontFamily })} />
          </SettingsRow>
          <SettingsRow label={t('terminal.fontSize')} description={t('terminal.fontSizeDesc')}>
            <NumberField
              value={prefs.fontSize}
              min={6}
              max={64}
              onChange={(fontSize) => update({ fontSize })}
              suffix="px"
              className="w-32"
              testId="terminal-font-size"
            />
          </SettingsRow>
          <SettingsRow label={t('terminal.lineHeight')} description={t('terminal.lineHeightDesc')}>
            <NumberField
              value={prefs.lineHeight}
              min={1}
              max={2}
              step={0.1}
              onChange={(lineHeight) => update({ lineHeight })}
              className="w-32"
              testId="terminal-line-height"
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsGroup>

      <SettingsGroup title={t('terminal.cursor')}>
        <SettingsCard>
          <SettingsRow label={t('terminal.cursorStyle')} description={t('terminal.cursorStyleDesc')}>
            <Segmented<TerminalPrefs['cursorStyle']>
              value={prefs.cursorStyle}
              onChange={(cursorStyle) => update({ cursorStyle })}
              options={(['block', 'underline', 'bar'] as const).map((s) => ({
                value: s,
                label: t(`terminal.cursorStyles.${s}`),
                icon: <CursorGlyph style={s} />
              }))}
            />
          </SettingsRow>
          <SettingsRow label={t('terminal.cursorBlink')} description={t('terminal.cursorBlinkDesc')}>
            <Switch checked={prefs.cursorBlink} onCheckedChange={(cursorBlink) => update({ cursorBlink })} />
          </SettingsRow>
        </SettingsCard>
      </SettingsGroup>

      <SettingsGroup title={t('terminal.behavior')}>
        <SettingsCard>
          <SettingsRow label={t('terminal.scrollback')} description={t('terminal.scrollbackDesc')}>
            <NumberField
              value={prefs.scrollback}
              min={100}
              max={200_000}
              step={1000}
              onChange={(scrollback) => update({ scrollback })}
              className="w-40"
              testId="terminal-scrollback"
            />
          </SettingsRow>
          <SettingsRow label={t('terminal.copyOnSelect')} description={t('terminal.copyOnSelectDesc')}>
            <Switch
              checked={prefs.copyOnSelect}
              onCheckedChange={(copyOnSelect) => update({ copyOnSelect })}
            />
          </SettingsRow>
          <SettingsRow label={t('terminal.rightClickPaste')} description={t('terminal.rightClickPasteDesc')}>
            <Switch
              checked={prefs.rightClickPaste}
              onCheckedChange={(rightClickPaste) => update({ rightClickPaste })}
            />
          </SettingsRow>
          <SettingsRow label={t('terminal.bell')} description={t('terminal.bellDesc')}>
            <Switch checked={prefs.bell} onCheckedChange={(bell) => update({ bell })} />
          </SettingsRow>
          <SettingsRow label={t('terminal.autocomplete')} description={t('terminal.autocompleteDesc')}>
            <Switch
              checked={prefs.autocomplete}
              onCheckedChange={(autocomplete) => update({ autocomplete })}
              data-testid="terminal-autocomplete"
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsGroup>

      <SettingsGroup title={t('terminal.connection')}>
        <SettingsCard>
          <SettingsRow label={t('terminal.keepAlive')} description={t('terminal.keepAliveDesc')}>
            {prefs.keepAliveInterval === 0 && <Badge>{t('terminal.off')}</Badge>}
            <NumberField
              value={prefs.keepAliveInterval}
              min={0}
              max={3600}
              step={5}
              suffix={t('terminal.seconds')}
              onChange={(keepAliveInterval) => update({ keepAliveInterval })}
              className="w-32"
              testId="terminal-keepalive"
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsGroup>
    </>
  )
}

function CursorGlyph({ style }: { style: TerminalPrefs['cursorStyle'] }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block h-3 w-[7px]',
        style === 'block' && 'bg-current',
        style === 'underline' && 'border-b-2 border-current',
        style === 'bar' && 'border-l-2 border-current'
      )}
    />
  )
}

function ThemeCard({
  theme,
  selected,
  onSelect
}: {
  theme: TerminalTheme
  selected: boolean
  onSelect: () => void
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  const th = theme.theme
  const ansi = [th.black, th.red, th.green, th.yellow, th.blue, th.magenta, th.cyan, th.white]
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      data-testid={`terminal-theme-${theme.id}`}
      className={cn(
        'group flex flex-col overflow-hidden rounded-lg border text-left transition-[border-color,box-shadow]',
        selected ? 'border-accent ring-2 ring-accent/30' : 'border-line hover:border-line-strong'
      )}
    >
      <div
        className="flex h-[58px] flex-col justify-between px-2.5 pb-2 pt-2.5 font-mono text-[10.5px] leading-none"
        style={{ background: th.background, color: th.foreground }}
      >
        <div className="truncate">
          <span style={{ color: th.green }}>~</span> <span style={{ color: th.blue }}>$</span> ls -la
          <span
            className="ml-0.5 inline-block h-[9px] w-[5px] align-[-1px]"
            style={{ background: th.cursor }}
          />
        </div>
        <div className="flex h-2 overflow-hidden rounded-[2px]">
          {ansi.map((c, i) => (
            <span key={i} className="flex-1" style={{ background: c }} />
          ))}
        </div>
      </div>
      <div
        className={cn(
          'flex h-8 items-center gap-1.5 border-t px-2.5',
          selected ? 'border-accent/40 bg-accent-soft' : 'border-line bg-panel'
        )}
      >
        <span className={cn('min-w-0 flex-1 truncate text-xs font-medium', selected && 'text-accent')}>
          {theme.name}
        </span>
        {selected ? (
          <Check className="size-3.5 shrink-0 text-accent" strokeWidth={3} />
        ) : (
          <span
            title={theme.dark ? t('terminal.darkTheme') : t('terminal.lightTheme')}
            className="shrink-0 text-subtle"
          >
            {theme.dark ? <Moon className="size-3" /> : <Sun className="size-3" />}
          </span>
        )}
      </div>
    </button>
  )
}

function FontFamilyField({
  value,
  onCommit
}: {
  value: string
  onCommit: (v: string) => void
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  const [text, setText] = useState(value)
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    if (!focused) setText(value)
  }, [value, focused])
  const commit = (raw: string): void => {
    const v = raw.trim().replace(/^["']|["']$/g, '')
    if (!v) setText(value)
    else if (v !== value) onCommit(v)
  }
  return (
    <div className="flex w-64 items-stretch">
      <Input
        value={text}
        maxLength={255}
        onFocus={() => setFocused(true)}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => {
          setFocused(false)
          commit(e.target.value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            setText(value)
            setTimeout(() => (e.target as HTMLInputElement).blur())
          }
        }}
        className="rounded-r-none"
        style={{ fontFamily: fontStack(text || value) }}
        data-testid="terminal-font-family"
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex w-8 shrink-0 items-center justify-center rounded-r-md border border-l-0 border-line bg-input text-subtle hover:text-fg data-[state=open]:text-fg"
            aria-label={t('terminal.fontSuggestions')}
            data-testid="terminal-font-suggestions"
          >
            <ChevronDown className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel>{t('terminal.fontSuggestions')}</DropdownMenuLabel>
          {FONT_SUGGESTIONS.map((f) => {
            const installed = fontAvailable(f)
            return (
              <DropdownMenuItem
                key={f}
                onSelect={() => {
                  setText(f)
                  if (f !== value) onCommit(f)
                }}
              >
                <span
                  className={cn('min-w-0 flex-1 truncate', !installed && 'text-muted')}
                  style={{ fontFamily: installed ? fontStack(f) : undefined }}
                >
                  {f}
                </span>
                {f === value ? (
                  <Check className="!text-accent" />
                ) : (
                  !installed && (
                    <span className="shrink-0 text-[11px] text-subtle">{t('terminal.notInstalled')}</span>
                  )
                )}
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

const BLINK_CSS = '@keyframes sshtool-settings-blink { 50% { opacity: 0 } }'

/** Static preview rendered with the selected theme colors and font settings. */
function TerminalPreview({
  prefs,
  theme
}: {
  prefs: TerminalPrefs
  theme: TerminalTheme
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  const th = theme.theme
  const fg = th.foreground
  const span = (color: string | undefined, text: string, bold = false): React.JSX.Element => (
    <span style={{ color, fontWeight: bold ? 700 : undefined }}>{text}</span>
  )
  const prompt = (
    <>
      {span(th.green, 'user@sshtool', true)}
      {span(fg, ':')}
      {span(th.blue, '~', true)}
      {span(fg, '$ ')}
    </>
  )
  const palette = [
    th.black,
    th.red,
    th.green,
    th.yellow,
    th.blue,
    th.magenta,
    th.cyan,
    th.white,
    th.brightBlack,
    th.brightRed,
    th.brightGreen,
    th.brightYellow,
    th.brightBlue,
    th.brightMagenta,
    th.brightCyan,
    th.brightWhite
  ]
  const cursorColor = th.cursor ?? fg
  const cursorStyle: CSSProperties = {
    display: 'inline-block',
    width: '1ch',
    height: '1.2em',
    verticalAlign: 'text-bottom',
    boxSizing: 'border-box',
    animation: prefs.cursorBlink ? 'sshtool-settings-blink 1.06s step-end infinite' : undefined,
    ...(prefs.cursorStyle === 'block'
      ? { background: cursorColor }
      : prefs.cursorStyle === 'underline'
        ? { borderBottom: `2px solid ${cursorColor}` }
        : { borderLeft: `2px solid ${cursorColor}` })
  }
  return (
    <div
      className="overflow-hidden rounded-xl border border-line shadow-sm"
      data-testid="terminal-preview"
      aria-label={t('terminal.preview')}
    >
      <style>{BLINK_CSS}</style>
      <div
        className="flex h-7 items-center gap-1.5 px-3"
        style={{
          background: th.background,
          boxShadow: `inset 0 -1px 0 ${th.selectionBackground ?? 'transparent'}`
        }}
      >
        <span className="size-2.5 rounded-full" style={{ background: th.red }} />
        <span className="size-2.5 rounded-full" style={{ background: th.yellow }} />
        <span className="size-2.5 rounded-full" style={{ background: th.green }} />
        <span className="ml-2 font-mono text-[11px]" style={{ color: th.brightBlack }}>
          user@sshtool: ~
        </span>
        <span className="ml-auto text-[11px] font-medium" style={{ color: th.brightBlack }}>
          {t('terminal.preview')} · {theme.name}
        </span>
      </div>
      <div
        className="overflow-hidden whitespace-pre px-3.5 pb-3 pt-2"
        style={{
          background: th.background,
          color: fg,
          fontFamily: fontStack(prefs.fontFamily),
          fontSize: prefs.fontSize,
          lineHeight: prefs.lineHeight
        }}
      >
        <div>
          {prompt}
          {span(fg, 'ls -l')}
        </div>
        <div>
          {'drwxr-xr-x 2 user staff 4096 '}
          {span(th.blue, 'backups', true)}
        </div>
        <div>
          {'-rwxr-xr-x 1 user staff  812 '}
          {span(th.green, 'deploy.sh', true)}
        </div>
        <div>
          {'lrwxrwxrwx 1 user staff   15 '}
          {span(th.cyan, 'current', true)}
          {' -> releases/42'}
        </div>
        <div>
          {'-rw-r--r-- 1 user staff 1.2M '}
          {span(th.red, 'site.tar.gz', true)}
        </div>
        <div className="flex items-center gap-[0.35ch] py-[0.2em]">
          {palette.map((c, i) => (
            <span
              key={i}
              style={{
                display: 'inline-block',
                width: '1.6ch',
                height: '0.85em',
                background: c,
                borderRadius: 2
              }}
            />
          ))}
        </div>
        <div>
          {prompt}
          <span style={cursorStyle} />
        </div>
      </div>
    </div>
  )
}
