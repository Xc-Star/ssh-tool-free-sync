import {
  Bot,
  CloudSync,
  DatabaseBackup,
  FolderSync,
  Info,
  Keyboard,
  ShieldCheck,
  SlidersHorizontal,
  SquareTerminal
} from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { useApp } from '@/stores/app'
import { SyncSection } from '@/features/sync/SyncSection'
import { AboutSection } from './AboutSection'
import { AiSection } from './AiSection'
import { DataSection } from './DataSection'
import { GeneralSection } from './GeneralSection'
import { SecuritySection } from './SecuritySection'
import { SftpSection } from './SftpSection'
import { ShortcutsSection } from './ShortcutsSection'
import { TerminalSection } from './TerminalSection'
import { SettingsHeader } from './ui'

export const SETTINGS_SECTIONS = [
  'general',
  'terminal',
  'shortcuts',
  'sftp',
  'ai',
  'sync',
  'security',
  'data',
  'about'
] as const
export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]

const NAV: {
  group: 'app' | 'vault' | null
  items: { id: SettingsSectionId; icon: React.ComponentType<{ className?: string }> }[]
}[] = [
  {
    group: 'app',
    items: [
      { id: 'general', icon: SlidersHorizontal },
      { id: 'terminal', icon: SquareTerminal },
      { id: 'shortcuts', icon: Keyboard },
      { id: 'sftp', icon: FolderSync },
      { id: 'ai', icon: Bot }
    ]
  },
  {
    group: 'vault',
    items: [
      { id: 'sync', icon: CloudSync },
      { id: 'security', icon: ShieldCheck },
      { id: 'data', icon: DatabaseBackup }
    ]
  },
  { group: null, items: [{ id: 'about', icon: Info }] }
]

function isSection(s: string): s is SettingsSectionId {
  return (SETTINGS_SECTIONS as readonly string[]).includes(s)
}

export function SettingsPage(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const raw = useApp((s) => s.settingsSection)
  const setSection = useApp((s) => s.setSection)
  const section: SettingsSectionId = isSection(raw) ? raw : 'general'
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [section])

  return (
    <div className="flex h-full min-h-0" data-testid="settings-page">
      <aside className="flex w-[212px] shrink-0 flex-col border-r border-line">
        <div className="flex h-16 shrink-0 items-center px-5">
          <h1 className="text-[17px] font-semibold">{t('title')}</h1>
        </div>
        <nav className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2.5 pb-4" aria-label={t('title')}>
          {NAV.map((g, gi) => (
            <div key={gi} className={cn('flex flex-col gap-0.5', gi > 0 && 'mt-3')}>
              {g.group && (
                <div className="px-3 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wider text-subtle">
                  {t(`groups.${g.group}`)}
                </div>
              )}
              {!g.group && <div className="mx-3 mb-2 h-px bg-line" />}
              {g.items.map(({ id, icon: Icon }) => {
                const active = section === id
                return (
                  <button
                    key={id}
                    onClick={() => setSection('settings', id)}
                    data-testid={`settings-nav-${id}`}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex h-9 w-full items-center gap-3 rounded-lg px-3 text-left text-[13px] font-medium transition-colors',
                      active ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-panel-hover hover:text-fg'
                    )}
                  >
                    <Icon className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{t(`nav.${id}`)}</span>
                    {id === 'sync' && <SyncDot />}
                    {id === 'security' && <SecurityDot />}
                  </button>
                )
              })}
            </div>
          ))}
        </nav>
      </aside>
      <div
        ref={scrollRef}
        className="min-w-0 flex-1 overflow-y-auto"
        data-testid={`settings-section-${section}`}
      >
        <div className="@container mx-auto w-full max-w-[784px] px-8 pb-20 pt-8">
          <SectionContent id={section} />
        </div>
      </div>
    </div>
  )
}

function SectionContent({ id }: { id: SettingsSectionId }): React.JSX.Element {
  const { t } = useTranslation('settings')
  if (id === 'sync') return <SyncSection />
  if (id === 'about') return <AboutSection />
  const body =
    id === 'general' ? (
      <GeneralSection />
    ) : id === 'terminal' ? (
      <TerminalSection />
    ) : id === 'shortcuts' ? (
      <ShortcutsSection />
    ) : id === 'sftp' ? (
      <SftpSection />
    ) : id === 'ai' ? (
      <AiSection />
    ) : id === 'security' ? (
      <SecuritySection />
    ) : (
      <DataSection />
    )
  return (
    <>
      <SettingsHeader title={t(`nav.${id}`)} description={t(`sectionDesc.${id}`)} />
      {body}
    </>
  )
}

function SyncDot(): React.JSX.Element | null {
  const sync = useApp((s) => s.sync)
  if (!sync.configured) return null
  const color =
    sync.state === 'idle'
      ? 'bg-success'
      : sync.state === 'syncing'
        ? 'bg-accent animate-soft-pulse'
        : sync.state === 'offline'
          ? 'bg-warning'
          : 'bg-danger'
  return <span className={cn('size-2 shrink-0 rounded-full', color)} data-testid="settings-sync-dot" />
}

function SecurityDot(): React.JSX.Element | null {
  const weak = useApp((s) => s.lock.weak && !s.lock.passwordEnabled)
  return weak ? <span className="size-2 shrink-0 rounded-full bg-warning" /> : null
}
