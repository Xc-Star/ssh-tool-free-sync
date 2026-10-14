import { Check, Copy, FolderOpen, Heart, SquareTerminal } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/controls'
import { Badge } from '@/components/ui/misc'
import { call, errorMessage } from '@/lib/api'
import { copyText } from '@/lib/utils'
import { useApp } from '@/stores/app'
import { SettingsCard, SettingsGroup } from './ui'

const PLATFORMS = ['win32', 'darwin', 'linux']

function CopyButton({ value, testId }: { value: string; testId?: string }): React.JSX.Element {
  const { t } = useTranslation('settings')
  const [copied, setCopied] = useState(false)
  return (
    <Tip content={copied ? t('about.copied') : t('about.copy')}>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={t('about.copy')}
        data-testid={testId}
        onClick={() =>
          void copyText(value).then(
            () => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            },
            (err) => toast.error(errorMessage(err))
          )
        }
      >
        {copied ? <Check className="text-success" /> : <Copy />}
      </Button>
    </Tip>
  )
}

function InfoRow({
  label,
  children,
  mono
}: {
  label: string
  children: React.ReactNode
  mono?: boolean
}): React.JSX.Element {
  return (
    <div className="flex min-h-11 items-center gap-4 px-4 py-2">
      <div className="w-36 shrink-0 text-[13px] text-muted">{label}</div>
      <div
        className={
          mono
            ? 'flex min-w-0 flex-1 items-center gap-1.5 font-mono text-xs'
            : 'flex min-w-0 flex-1 items-center gap-1.5 text-[13px]'
        }
      >
        {children}
      </div>
    </div>
  )
}

export function AboutSection(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const info = useApp((s) => s.info)
  const platform = info
    ? PLATFORMS.includes(info.platform)
      ? t(`about.platforms.${info.platform}`)
      : info.platform
    : ''

  return (
    <div data-testid="settings-about">
      <div className="relative mb-8 overflow-hidden rounded-2xl border border-line bg-panel px-7 py-7">
        <div className="pointer-events-none absolute inset-0 bg-linear-to-br from-accent-soft via-transparent to-transparent" />
        <div className="relative flex items-center gap-5">
          <div className="flex size-16 shrink-0 items-center justify-center rounded-2xl bg-accent text-white shadow-pop">
            <SquareTerminal className="size-8" strokeWidth={1.75} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2.5">
              <h1 className="text-[22px] font-semibold tracking-tight">{info?.name ?? t('about.appName')}</h1>
              {info && <Badge tone="accent">{t('about.version', { version: info.version })}</Badge>}
            </div>
            <p className="mt-1.5 max-w-[520px] text-[13px] leading-relaxed text-muted">
              {t('about.tagline')}
            </p>
          </div>
        </div>
      </div>

      {info && (
        <SettingsGroup title={t('about.details')}>
          <SettingsCard>
            <InfoRow label={t('about.appVersion')}>
              <span className="selectable">{info.version}</span>
            </InfoRow>
            <InfoRow label={t('about.electron')}>
              <span className="selectable">{info.electron}</span>
            </InfoRow>
            <InfoRow label={t('about.node')}>
              <span className="selectable">{info.node}</span>
            </InfoRow>
            <InfoRow label={t('about.platform')}>
              <span className="selectable">
                {platform} · {info.arch}
              </span>
            </InfoRow>
            <InfoRow label={t('about.deviceName')}>
              <span className="selectable truncate">{info.deviceName}</span>
            </InfoRow>
            <InfoRow label={t('about.deviceId')} mono>
              <span className="selectable truncate" data-testid="about-device-id">
                {info.deviceId}
              </span>
              <CopyButton value={info.deviceId} />
            </InfoRow>
            <InfoRow label={t('about.dataDir')} mono>
              <span className="selectable min-w-0 flex-1 truncate" title={info.userData}>
                {info.userData}
              </span>
              <Button
                size="sm"
                variant="secondary"
                className="font-sans"
                onClick={() =>
                  void call('app.showItemInFolder', info.userData).catch((err) =>
                    toast.error(errorMessage(err))
                  )
                }
                data-testid="about-show-data-dir"
              >
                <FolderOpen />
                {t('about.showInFolder')}
              </Button>
            </InfoRow>
          </SettingsCard>
        </SettingsGroup>
      )}

      <SettingsGroup title={t('about.openSource')}>
        <SettingsCard>
          <div className="flex items-start gap-3 px-4 py-4">
            <Heart className="mt-0.5 size-4 shrink-0 text-danger" />
            <div className="flex flex-col gap-2 text-xs leading-relaxed text-muted">
              <p>{t('about.openSourceText')}</p>
              <p className="text-subtle">{t('about.trademarks')}</p>
            </div>
          </div>
        </SettingsCard>
      </SettingsGroup>
    </div>
  )
}
