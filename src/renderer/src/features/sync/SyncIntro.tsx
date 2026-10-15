import {
  ArrowLeftRight,
  BadgeCheck,
  Braces,
  Database,
  FolderTree,
  IdCard,
  Info,
  KeyRound,
  Laptop,
  Lock,
  LockKeyhole,
  Monitor,
  LaptopMinimal,
  Server,
  ShieldCheck,
  SquareTerminal,
  Tags
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/misc'
import { cn } from '@/lib/utils'
import { BRANDS, BrandIcon } from './DbLogo'

const SYNCED: { key: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: 'hosts', icon: Server },
  { key: 'groups', icon: FolderTree },
  { key: 'tags', icon: Tags },
  { key: 'keys', icon: KeyRound },
  { key: 'identities', icon: IdCard },
  { key: 'snippets', icon: Braces },
  { key: 'portForwards', icon: ArrowLeftRight },
  { key: 'knownHosts', icon: ShieldCheck },
  { key: 'terminalPrefs', icon: SquareTerminal }
]

/** Chips listing every synced item kind, plus the device-only note. */
export function WhatSyncs({
  action,
  className
}: {
  action?: ReactNode
  className?: string
}): React.JSX.Element {
  const { t } = useTranslation('sync')
  return (
    <div
      className={cn('rounded-xl border border-line bg-panel p-4', className)}
      data-testid="sync-what-syncs"
    >
      <div className="flex flex-wrap gap-1.5">
        {SYNCED.map(({ key, icon: Icon }) => (
          <span
            key={key}
            className="inline-flex h-7 items-center gap-1.5 rounded-full border border-line bg-app px-2.5 text-xs text-fg"
          >
            <Icon className="size-3.5 text-muted" />
            {t(`kinds.${key}`)}
          </span>
        ))}
      </div>
      <div className="mt-3.5 flex items-start gap-2.5 border-t border-line pt-3.5 text-xs leading-relaxed text-muted">
        <Info className="mt-0.5 size-3.5 shrink-0 text-accent" />
        <span className="flex-1">{t('intro.deviceOnly')}</span>
        {action}
      </div>
    </div>
  )
}

function Connector(): React.JSX.Element {
  return (
    <div className="relative flex w-8 items-center justify-center self-center @xl:w-14">
      <div className="absolute inset-x-0 top-1/2 border-t-2 border-dashed border-line-strong" />
      <span className="relative flex size-6 items-center justify-center rounded-full border border-line bg-elevated text-subtle shadow-sm">
        <ArrowLeftRight className="size-3" />
      </span>
    </div>
  )
}

function Caption({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="mt-2.5 text-center text-[11px] font-medium leading-tight text-subtle">{children}</div>
  )
}

/** Devices ⇄ end-to-end encryption ⇄ your database. Compacts itself in narrow layouts. */
function SyncIllustration(): React.JSX.Element {
  const { t } = useTranslation('sync')
  return (
    <div className="flex items-start justify-center" aria-hidden>
      <div className="flex flex-col items-center">
        <div className="flex h-[76px] items-center">
          <div className="flex items-center gap-1 rounded-2xl border border-line bg-elevated p-1.5 shadow-sm">
            {[Laptop, Monitor, LaptopMinimal].map((Icon, i) => (
              <div
                key={i}
                className={cn(
                  'size-10 items-center justify-center rounded-xl bg-panel-hover text-muted',
                  i === 2 ? 'hidden @xl:flex' : 'flex'
                )}
              >
                <Icon className="size-5" />
              </div>
            ))}
          </div>
        </div>
        <Caption>{t('intro.diagram.devices')}</Caption>
      </div>
      <div className="flex h-[76px] items-center">
        <Connector />
      </div>
      <div className="flex w-24 flex-col items-center @xl:w-[112px]">
        <div className="flex h-[76px] items-center">
          <div className="flex size-16 items-center justify-center rounded-2xl bg-accent text-white shadow-pop ring-8 ring-accent/10">
            <LockKeyhole className="size-7" />
          </div>
        </div>
        <Caption>{t('intro.diagram.encrypt')}</Caption>
      </div>
      <div className="flex h-[76px] items-center">
        <Connector />
      </div>
      <div className="flex flex-col items-center">
        <div className="flex h-[76px] items-center">
          <div className="relative flex h-[54px] items-center gap-2 rounded-2xl border border-line bg-elevated px-3 shadow-sm @xl:pr-3.5">
            <Database className="size-6 text-muted" />
            <span className="hidden h-6 w-px bg-line @xl:block" />
            <span className="hidden items-center gap-1.5 @xl:flex">
              {[BRANDS.postgres, BRANDS.mysql, BRANDS.d1, BRANDS.webdav].map((b) => (
                <BrandIcon key={b.title} icon={b} className="size-[18px] text-muted" />
              ))}
            </span>
            <span className="absolute -bottom-1.5 -right-1.5 flex size-6 items-center justify-center rounded-full border-2 border-panel bg-success text-white">
              <Lock className="size-3" />
            </span>
          </div>
        </div>
        <Caption>{t('intro.diagram.database')}</Caption>
      </div>
    </div>
  )
}

export function SyncIntro(): React.JSX.Element {
  const { t } = useTranslation('sync')
  const features: { key: 'e2e' | 'own' | 'free'; icon: React.ComponentType<{ className?: string }> }[] = [
    { key: 'e2e', icon: ShieldCheck },
    { key: 'own', icon: Database },
    { key: 'free', icon: BadgeCheck }
  ]
  return (
    <div className="mb-8 flex flex-col gap-4" data-testid="sync-intro">
      <div className="relative overflow-hidden rounded-2xl border border-line bg-panel">
        <div className="pointer-events-none absolute inset-0 bg-linear-to-b from-accent-soft to-transparent to-70%" />
        <div className="relative flex flex-col items-center px-8 pb-7 pt-8 text-center">
          <SyncIllustration />
          <Badge tone="success" className="mt-6">
            {t('intro.badge')}
          </Badge>
          <h1 className="mt-3 max-w-[560px] text-[21px] font-semibold leading-snug tracking-tight">
            {t('intro.title')}
          </h1>
          <p className="mt-2.5 max-w-[580px] text-[13px] leading-relaxed text-muted">{t('intro.text')}</p>
        </div>
        <div className="relative grid grid-cols-1 divide-y divide-line border-t border-line @xl:grid-cols-3 @xl:divide-x @xl:divide-y-0">
          {features.map(({ key, icon: Icon }) => (
            <div key={key} className="flex flex-col gap-1.5 px-5 py-4">
              <div className="flex items-center gap-2 text-[13px] font-semibold">
                <Icon className="size-4 shrink-0 text-accent" />
                {t(`intro.features.${key}`)}
              </div>
              <p className="text-xs leading-relaxed text-muted">{t(`intro.features.${key}Desc`)}</p>
            </div>
          ))}
        </div>
      </div>
      <div>
        <h2 className="mb-2.5 px-1 text-[11px] font-semibold uppercase tracking-wider text-subtle">
          {t('intro.whatSyncs')}
        </h2>
        <WhatSyncs />
      </div>
    </div>
  )
}
