import { FolderOpen, House, RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { ConflictPolicy, LocalSettings } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Select, Switch, Tip } from '@/components/ui/controls'
import { call, errorMessage } from '@/lib/api'
import { useApp } from '@/stores/app'
import { useSaveSettings } from './GeneralSection'
import { NumberField, SettingsCard, SettingsGroup, SettingsRow } from './ui'

const POLICIES: ConflictPolicy[] = ['ask', 'overwrite', 'skip', 'rename']

export function SftpSection(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const { t: tc } = useTranslation()
  const sftp = useApp((s) => s.settings.sftp)
  const save = useSaveSettings()
  const patch = (p: Partial<LocalSettings['sftp']>): void => save({ sftp: { ...sftp, ...p } })

  const chooseFolder = async (): Promise<void> => {
    try {
      const [dir] = await call('app.openFileDialog', {
        title: t('sftp.chooseTitle'),
        directory: true,
        defaultPath: sftp.defaultLocalPath
      })
      if (dir) patch({ defaultLocalPath: dir })
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  return (
    <>
      <SettingsGroup title={t('sftp.transfers')}>
        <SettingsCard>
          <SettingsRow label={t('sftp.concurrency')} description={t('sftp.concurrencyDesc')}>
            <NumberField
              value={sftp.concurrency}
              min={1}
              max={8}
              onChange={(concurrency) => patch({ concurrency })}
              className="w-28"
              testId="sftp-concurrency"
            />
          </SettingsRow>
          <SettingsRow label={t('sftp.conflictPolicy')} description={t('sftp.conflictPolicyDesc')}>
            <div className="w-48" data-testid="sftp-conflict-policy">
              <Select
                value={sftp.conflictPolicy}
                onChange={(v) => v && patch({ conflictPolicy: v as ConflictPolicy })}
                options={POLICIES.map((p) => ({ value: p, label: t(`sftp.policies.${p}`) }))}
              />
            </div>
          </SettingsRow>
        </SettingsCard>
      </SettingsGroup>

      <SettingsGroup title={t('sftp.browser')}>
        <SettingsCard>
          <SettingsRow label={t('sftp.showHidden')} description={t('sftp.showHiddenDesc')}>
            <Switch
              checked={sftp.showHidden}
              onCheckedChange={(showHidden) => patch({ showHidden })}
              data-testid="sftp-show-hidden"
            />
          </SettingsRow>
          <SettingsRow
            label={t('sftp.defaultLocalPath')}
            description={t('sftp.defaultLocalPathDesc')}
            align="start"
          >
            <div className="flex w-[320px] items-center gap-2">
              <div
                className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-line bg-input px-2.5 text-[13px]"
                title={sftp.defaultLocalPath}
                data-testid="sftp-default-path"
              >
                {sftp.defaultLocalPath ? (
                  <FolderOpen className="size-3.5 shrink-0 text-subtle" />
                ) : (
                  <House className="size-3.5 shrink-0 text-subtle" />
                )}
                <span
                  className={
                    sftp.defaultLocalPath ? 'selectable truncate font-mono text-xs' : 'truncate text-muted'
                  }
                >
                  {sftp.defaultLocalPath ?? t('sftp.homeFolder')}
                </span>
              </div>
              <Button
                size="md"
                variant="secondary"
                onClick={() => void chooseFolder()}
                data-testid="sftp-choose-path"
              >
                {t('sftp.choose')}
              </Button>
              {sftp.defaultLocalPath && (
                <Tip content={tc('reset')}>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => patch({ defaultLocalPath: undefined })}
                    aria-label={tc('reset')}
                  >
                    <RotateCcw />
                  </Button>
                </Tip>
              )}
            </div>
          </SettingsRow>
        </SettingsCard>
      </SettingsGroup>
    </>
  )
}
