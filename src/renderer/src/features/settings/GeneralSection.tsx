import { LayoutGrid, List, Monitor, Moon, Sun } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { Language, LocalSettings, ShellInfo, ThemeMode } from '@shared/types'
import { Select, Switch } from '@/components/ui/controls'
import { Segmented } from '@/components/ui/misc'
import { call, errorMessage } from '@/lib/api'
import { useApp } from '@/stores/app'
import { SettingsCard, SettingsGroup, SettingsRow } from './ui'

export function useSaveSettings(): (patch: Partial<LocalSettings>) => void {
  const update = useApp((s) => s.updateSettings)
  return (patch) => void update(patch).catch((err) => toast.error(errorMessage(err)))
}

export function GeneralSection(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const { t: tc } = useTranslation()
  const settings = useApp((s) => s.settings)
  const save = useSaveSettings()
  const [shells, setShells] = useState<ShellInfo[] | null>(null)

  useEffect(() => {
    let alive = true
    call('session.shells')
      .then((list) => alive && setShells(list))
      .catch(() => alive && setShells([]))
    return () => {
      alive = false
    }
  }, [])

  const shell = shells?.find((s) => s.id === settings.localShell)

  return (
    <>
      <SettingsGroup title={t('general.appearance')}>
        <SettingsCard>
          <SettingsRow
            label={t('general.language')}
            description={t('general.languageDesc')}
            testId="settings-language"
          >
            <Segmented<Language>
              value={settings.language}
              onChange={(language) => save({ language })}
              options={[
                { value: 'zh-CN', label: t('languages.zh-CN') },
                { value: 'en', label: t('languages.en') }
              ]}
            />
          </SettingsRow>
          <SettingsRow
            label={t('general.theme')}
            description={t('general.themeDesc')}
            testId="settings-theme"
          >
            <Segmented<ThemeMode>
              value={settings.theme}
              onChange={(theme) => save({ theme })}
              options={[
                { value: 'dark', label: tc('theme.dark'), icon: <Moon /> },
                { value: 'light', label: tc('theme.light'), icon: <Sun /> },
                { value: 'system', label: tc('theme.system'), icon: <Monitor /> }
              ]}
            />
          </SettingsRow>
          <SettingsRow label={t('general.hostsView')} description={t('general.hostsViewDesc')}>
            <Segmented<LocalSettings['hostsView']>
              value={settings.hostsView}
              onChange={(hostsView) => save({ hostsView })}
              options={[
                { value: 'grid', label: t('general.grid'), icon: <LayoutGrid /> },
                { value: 'list', label: t('general.list'), icon: <List /> }
              ]}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsGroup>

      <SettingsGroup title={t('general.behavior')}>
        <SettingsCard>
          <SettingsRow label={t('general.confirmOnClose')} description={t('general.confirmOnCloseDesc')}>
            <Switch
              checked={settings.confirmOnClose}
              onCheckedChange={(confirmOnClose) => save({ confirmOnClose })}
              data-testid="settings-confirm-close"
            />
          </SettingsRow>
          <SettingsRow
            label={t('general.localShell')}
            description={
              <>
                {t('general.localShellDesc')}
                {shell && (
                  <span className="selectable mt-1 block truncate font-mono text-[11px] text-subtle">
                    {[shell.path, ...shell.args].join(' ')}
                  </span>
                )}
              </>
            }
          >
            <div className="w-60" data-testid="settings-local-shell">
              <Select
                value={settings.localShell}
                onChange={(localShell) => save({ localShell })}
                options={(shells ?? []).map((s) => ({ value: s.id, label: s.label }))}
                allowEmpty
                emptyLabel={t('general.systemDefault')}
                disabled={shells === null}
              />
            </div>
          </SettingsRow>
        </SettingsCard>
      </SettingsGroup>

      <p className="mt-4 px-1 text-xs text-subtle">{t('general.localOnly')}</p>
    </>
  )
}
