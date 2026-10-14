import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SyncDbConfig } from '@shared/types'
import { useApp } from '@/stores/app'
import { SettingsHeader } from '@/features/settings/ui'
import { SyncDashboard } from './SyncDashboard'
import { SyncIntro } from './SyncIntro'
import { SyncWizard } from './SyncWizard'

/** Settings → Sync: intro + setup wizard when not configured, otherwise the status dashboard. */
export function SyncSection(): React.JSX.Element {
  const { t } = useTranslation('sync')
  const configured = useApp((s) => s.sync.configured)
  // The live status flips to "configured" while create/join is still running; keep the wizard (and its success screen) mounted.
  const [pinned, setPinned] = useState(false)
  const [editing, setEditing] = useState<SyncDbConfig | null>(null)

  if (editing) {
    return (
      <div data-testid="sync-section">
        <SettingsHeader title={t('title')} description={t('subtitle')} />
        <SyncWizard
          initial={editing}
          onPin={setPinned}
          onFinish={() => setEditing(null)}
          onCancel={() => setEditing(null)}
        />
      </div>
    )
  }

  if (!configured || pinned) {
    return (
      <div data-testid="sync-section">
        <SyncIntro />
        <SyncWizard onPin={setPinned} onFinish={() => setPinned(false)} />
      </div>
    )
  }

  return (
    <div data-testid="sync-section">
      <SettingsHeader title={t('title')} description={t('subtitle')} />
      <SyncDashboard onEdit={setEditing} />
    </div>
  )
}
