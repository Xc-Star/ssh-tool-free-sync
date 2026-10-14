import {
  CircleAlert,
  CircleCheck,
  Cloud,
  CloudCheck,
  CloudOff,
  KeyRound,
  KeySquare,
  Laptop,
  LaptopMinimal,
  Monitor,
  Pencil,
  PlugZap,
  RefreshCw,
  RotateCcwKey,
  ShieldAlert,
  Unplug,
  Zap
} from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { SyncDbConfig, SyncDevice, SyncState, SyncTestResult } from '@shared/types'
import { Button } from '@/components/ui/button'
import { confirm } from '@/components/ui/confirm'
import { Tip } from '@/components/ui/controls'
import { Dialog, DialogBody, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { Field, PasswordInput } from '@/components/ui/input'
import { Badge, Spinner } from '@/components/ui/misc'
import { call, errorMessage } from '@/lib/api'
import { cn, formatDate, relativeTime } from '@/lib/utils'
import { useApp } from '@/stores/app'
import {
  Callout,
  NumberField,
  SettingsCard,
  SettingsGroup,
  SettingsRow,
  useNow
} from '@/features/settings/ui'
import { DbLogo } from './DbLogo'
import { StrengthMeter } from './fields'
import { describeTarget, isWrongPasswordError, platformName, redactUrl } from './model'
import { WhatSyncs } from './SyncIntro'

const MIN_MASTER_PASSWORD = 8

const STATE_META: Record<
  SyncState,
  { icon: React.ComponentType<{ className?: string }>; tone: string; spin?: boolean }
> = {
  idle: { icon: CloudCheck, tone: 'bg-success/12 text-success' },
  syncing: { icon: RefreshCw, tone: 'bg-accent-soft text-accent', spin: true },
  offline: { icon: CloudOff, tone: 'bg-warning/12 text-warning' },
  error: { icon: CircleAlert, tone: 'bg-danger/12 text-danger' },
  'needs-password': { icon: KeyRound, tone: 'bg-warning/12 text-warning' },
  disabled: { icon: Cloud, tone: 'bg-panel-hover text-muted' }
}

export function SyncDashboard({ onEdit }: { onEdit: (config: SyncDbConfig) => void }): React.JSX.Element {
  const { t } = useTranslation('sync')
  const sync = useApp((s) => s.sync)
  const setSection = useApp((s) => s.setSection)
  const [config, setConfig] = useState<SyncDbConfig | null>(null)

  useEffect(() => {
    let alive = true
    call('sync.getConfig')
      .then((c) => alive && setConfig(c))
      .catch(() => alive && setConfig(null))
    return () => {
      alive = false
    }
  }, [sync.dbLabel])

  return (
    <div className="flex flex-col" data-testid="sync-dashboard">
      {sync.state === 'needs-password' && <UnlockBanner />}
      <StatusCard />
      <DevicesCard />
      {config && <ConnectionCard config={config} onEdit={() => onEdit(config)} />}
      <IntervalsCard />
      <SecurityCard />
      <SettingsGroup title={t('intro.whatSyncs')}>
        <WhatSyncs
          action={
            <Button
              size="xs"
              variant="ghost"
              className="-my-1 shrink-0"
              onClick={() => setSection('keychain')}
            >
              <KeySquare />
              {t('dashboard.openKeychain')}
            </Button>
          }
        />
      </SettingsGroup>
    </div>
  )
}

function UnlockBanner(): React.JSX.Element {
  const { t } = useTranslation('sync')
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (): Promise<void> => {
    if (!pw || busy) return
    setBusy(true)
    setError(null)
    try {
      await call('sync.unlock', pw)
      toast.success(t('dashboard.unlocked'))
    } catch (err) {
      const msg = errorMessage(err)
      setError(isWrongPasswordError(msg) ? t('vault.wrongPassword') : msg)
      setBusy(false)
    }
  }
  return (
    <div
      className="mb-6 rounded-xl border border-warning/40 bg-warning/10 p-5"
      data-testid="sync-unlock-banner"
    >
      <div className="flex items-start gap-4">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-warning/15 text-warning">
          <ShieldAlert className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold">{t('dashboard.unlockTitle')}</div>
          <p className="mt-1 text-xs leading-relaxed text-muted">{t('dashboard.unlockDesc')}</p>
          <form
            className="mt-3.5 flex items-start gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              void submit()
            }}
          >
            <div className="w-72">
              <PasswordInput
                autoFocus
                value={pw}
                placeholder={t('vault.masterPassword')}
                onChange={(e) => {
                  setPw(e.target.value)
                  setError(null)
                }}
                disabled={busy}
                data-testid="sync-unlock-password"
              />
              {error && <p className="mt-1.5 text-xs text-danger">{error}</p>}
            </div>
            <Button type="submit" variant="primary" disabled={busy || !pw} data-testid="sync-unlock">
              {busy ? <Spinner className="text-current" /> : <KeyRound />}
              {t('dashboard.unlock')}
            </Button>
          </form>
        </div>
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  sub,
  title,
  testId
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  title?: string
  testId?: string
}): React.JSX.Element {
  return (
    <div className="min-w-0 bg-panel px-5 py-3.5" title={title} data-testid={testId}>
      <div className="text-[11px] font-medium uppercase tracking-wider text-subtle">{label}</div>
      <div className="mt-1 flex items-center gap-1.5 truncate text-[13px] font-medium text-fg">{value}</div>
      {sub && <div className="mt-0.5 truncate text-[11px] text-muted">{sub}</div>}
    </div>
  )
}

function StatusCard(): React.JSX.Element {
  const { t, i18n } = useTranslation('sync')
  const sync = useApp((s) => s.sync)
  const [running, setRunning] = useState(false)
  useNow(15_000)
  const meta = STATE_META[sync.state]
  const Icon = meta.icon
  const syncing = running || sync.state === 'syncing'
  const showError = !!sync.lastError && (sync.state === 'error' || sync.state === 'offline')

  const syncNow = async (): Promise<void> => {
    setRunning(true)
    try {
      const s = await call('sync.now')
      if (s.state === 'error' || s.state === 'offline')
        toast.error(t('dashboard.syncFailed'), { description: s.lastError })
      else if (s.state === 'needs-password') toast.warning(t('dashboard.states.needs-password'))
      else toast.success(t('dashboard.synced'))
    } catch (err) {
      toast.error(t('dashboard.syncFailed'), { description: errorMessage(err) })
    } finally {
      setRunning(false)
    }
  }

  const disconnect = async (): Promise<void> => {
    const ok = await confirm({
      title: t('dashboard.disconnectTitle'),
      message: t('dashboard.disconnectMessage'),
      confirmLabel: t('dashboard.disconnect'),
      danger: true
    })
    if (!ok) return
    try {
      await call('sync.disconnect')
      toast.success(t('dashboard.disconnected'))
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  return (
    <div
      className="overflow-hidden rounded-xl border border-line bg-panel"
      data-testid="sync-status-card"
      data-state={sync.state}
    >
      <div className="flex flex-wrap items-center gap-4 p-5">
        <div className={cn('flex size-12 shrink-0 items-center justify-center rounded-2xl', meta.tone)}>
          <Icon className={cn('size-6', meta.spin && 'animate-spin')} />
        </div>
        <div className="min-w-[200px] flex-1">
          <div className="text-[16px] font-semibold" data-testid="sync-state-label">
            {t(`dashboard.states.${sync.state}`)}
          </div>
          <div className="mt-0.5 text-xs leading-relaxed text-muted">
            {t(`dashboard.stateDesc.${sync.state}`)}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="secondary"
            onClick={() => void syncNow()}
            disabled={syncing || sync.state === 'needs-password'}
            data-testid="sync-now"
          >
            <RefreshCw className={cn(syncing && 'animate-spin')} />
            {t('dashboard.syncNow')}
          </Button>
          <Button variant="danger-ghost" onClick={() => void disconnect()} data-testid="sync-disconnect">
            <Unplug />
            {t('dashboard.disconnect')}
          </Button>
        </div>
      </div>
      <div className="flex items-center gap-2 border-t border-line px-5 py-2.5 text-xs text-muted">
        {sync.dbKind && <DbLogo kind={sync.dbKind} size="xs" />}
        <span className="selectable truncate font-mono" data-testid="sync-db-label">
          {sync.dbLabel}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-px border-t border-line bg-line @xl:grid-cols-4">
        <Stat
          label={t('dashboard.lastSync')}
          value={sync.lastSyncAt ? relativeTime(sync.lastSyncAt, i18n.language) : t('dashboard.never')}
          title={sync.lastSyncAt ? formatDate(sync.lastSyncAt, i18n.language) : undefined}
          testId="sync-last-sync"
        />
        <Stat
          label={t('dashboard.pending')}
          value={
            <span className={cn('tabular-nums', sync.pendingChanges > 0 && 'text-warning')}>
              {sync.pendingChanges}
            </span>
          }
          sub={t('dashboard.pendingSub')}
          testId="sync-pending"
        />
        <Stat
          label={t('dashboard.updates')}
          value={
            sync.realtime ? (
              <>
                <Zap className="size-3.5 shrink-0 text-accent" />
                {t('dashboard.realtime')}
              </>
            ) : (
              <>
                <RefreshCw className="size-3.5 shrink-0 text-muted" />
                {t('dashboard.polling')}
              </>
            )
          }
          sub={
            sync.realtime
              ? t('dashboard.realtimeSub')
              : t('dashboard.pollingSub', { count: sync.pollIntervalSec })
          }
          testId="sync-mode"
        />
        <Stat
          label={t('dashboard.reconcile')}
          value={t('dashboard.reconcileEvery', { count: sync.reconcileIntervalMin })}
          sub={t('dashboard.reconcileSub')}
        />
      </div>
      {showError && (
        <div
          className="flex items-start gap-2.5 border-t border-line bg-danger/5 px-5 py-3 text-xs"
          data-testid="sync-last-error"
        >
          <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-danger" />
          <div className="min-w-0 flex-1">
            <div className="selectable break-words font-mono text-fg">{sync.lastError}</div>
            <div className="mt-1 text-muted">
              {t(`dashboard.errorHint.${sync.state === 'offline' ? 'offline' : 'error'}`)}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function deviceIcon(platform: string): React.ComponentType<{ className?: string }> {
  const os = platformName(platform).os
  return os === 'darwin' ? Laptop : os === 'linux' ? LaptopMinimal : Monitor
}

function DevicesCard(): React.JSX.Element {
  const { t, i18n } = useTranslation('sync')
  const info = useApp((s) => s.info)
  const [devices, setDevices] = useState<SyncDevice[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  useNow(30_000)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const list = await call('sync.devices')
      setDevices([...list].sort((a, b) => Number(b.current) - Number(a.current) || b.lastSeen - a.lastSeen))
      setError(null)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Reload once the master password was entered: device names written with the new key become readable.
  const needsPassword = useApp((s) => s.sync.state === 'needs-password')
  const wasLocked = useRef(needsPassword)
  useEffect(() => {
    if (wasLocked.current && !needsPassword) void load()
    wasLocked.current = needsPassword
  }, [load, needsPassword])

  const platformLabel = (p: string): string => {
    const { os, arch } = platformName(p)
    const name = ['win32', 'darwin', 'linux'].includes(os)
      ? t(`platforms.${os}`)
      : os || t('dashboard.unknownPlatform')
    return arch ? `${name} · ${arch}` : name
  }

  // Device info that could not be decrypted (written with an older vault key) comes back without platform/version.
  // For this device the local app info is shown instead until its next heartbeat re-uploads it.
  const displayDevice = (d: SyncDevice): SyncDevice & { unknown: boolean } => {
    const unknown = !d.platform && !d.appVersion
    if (unknown && d.current && info)
      return {
        ...d,
        name: info.deviceName,
        platform: `${info.platform}-${info.arch}`,
        appVersion: info.version,
        unknown: false
      }
    return { ...d, unknown }
  }

  return (
    <SettingsGroup
      title={t('dashboard.devices')}
      description={t('dashboard.devicesDesc')}
      testId="sync-devices"
      action={
        <Tip content={t('dashboard.refresh')}>
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={() => void load()}
            disabled={loading}
            aria-label={t('dashboard.refresh')}
            data-testid="sync-devices-refresh"
          >
            <RefreshCw className={cn(loading && 'animate-spin')} />
          </Button>
        </Tip>
      }
    >
      <SettingsCard>
        {devices === null && !error ? (
          <div className="flex h-16 items-center justify-center gap-2 text-xs text-muted">
            <Spinner />
          </div>
        ) : error && !devices?.length ? (
          <div className="flex items-center gap-2 px-4 py-4 text-xs text-danger">
            <CircleAlert className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1">
              {t('dashboard.devicesError')} — <span className="selectable break-words">{error}</span>
            </span>
          </div>
        ) : !devices?.length ? (
          <div className="px-4 py-5 text-center text-xs text-muted">{t('dashboard.noDevices')}</div>
        ) : (
          devices.map((raw) => {
            const d = displayDevice(raw)
            const Icon = deviceIcon(d.platform)
            return (
              <div
                key={d.id}
                className="flex items-center gap-3 px-4 py-3"
                data-testid="sync-device"
                data-current={d.current}
              >
                <div
                  className={cn(
                    'flex size-9 shrink-0 items-center justify-center rounded-lg',
                    d.current ? 'bg-accent-soft text-accent' : 'bg-panel-hover text-muted'
                  )}
                >
                  <Icon className="size-[18px]" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-medium">
                      {d.unknown ? t('dashboard.unknownDevice') : d.name}
                    </span>
                    {d.current && <Badge tone="accent">{t('dashboard.thisDevice')}</Badge>}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-muted">
                    {d.unknown ? (
                      t('dashboard.unknownDeviceHint')
                    ) : (
                      <>
                        {platformLabel(d.platform)}
                        {d.appVersion && ` · v${d.appVersion}`}
                      </>
                    )}
                  </div>
                </div>
                <div
                  className="shrink-0 text-right text-xs text-muted"
                  title={formatDate(d.lastSeen, i18n.language)}
                >
                  {t('dashboard.lastSeen', { time: relativeTime(d.lastSeen, i18n.language) })}
                </div>
              </div>
            )
          })
        )}
      </SettingsCard>
    </SettingsGroup>
  )
}

function ConnectionCard({ config, onEdit }: { config: SyncDbConfig; onEdit: () => void }): React.JSX.Element {
  const { t } = useTranslation('sync')
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<SyncTestResult | null>(null)

  const test = async (): Promise<void> => {
    setTesting(true)
    setResult(null)
    try {
      setResult(await call('sync.test', config))
    } catch (err) {
      setResult({ ok: false, hasVault: false, error: errorMessage(err) })
    } finally {
      setTesting(false)
    }
  }

  const rows: { label: string; value: ReactNode; mono?: boolean }[] = []
  if (config.kind === 'd1') {
    rows.push({ label: t('dashboard.accountId'), value: config.accountId, mono: true })
    rows.push({ label: t('dashboard.databaseId'), value: config.databaseId, mono: true })
    rows.push({ label: t('dashboard.apiToken'), value: config.apiToken ? '••••••••••••' : '—', mono: true })
    if (config.baseUrl) rows.push({ label: t('dashboard.endpoint'), value: config.baseUrl, mono: true })
  } else {
    if (config.url?.trim()) rows.push({ label: t('dashboard.url'), value: redactUrl(config.url), mono: true })
    else {
      rows.push({
        label: t('dashboard.server'),
        value: describeTarget({ ...config, database: undefined }),
        mono: true
      })
      rows.push({ label: t('dashboard.databaseName'), value: config.database || '—', mono: true })
      rows.push({ label: t('dashboard.user'), value: config.user || '—', mono: true })
    }
    rows.push({
      label: t('dashboard.ssl'),
      value: (
        <>
          {t(`form.sslModes.${config.ssl}`)}
          {config.ca && <Badge>{t('dashboard.customCa')}</Badge>}
          {config.ssl === 'disable' && <Badge tone="warning">{t('dashboard.unencrypted')}</Badge>}
        </>
      )
    })
  }
  rows.push({ label: t('dashboard.prefix'), value: config.tablePrefix, mono: true })

  return (
    <SettingsGroup
      title={t('dashboard.connection')}
      testId="sync-connection"
      action={
        <>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void test()}
            disabled={testing}
            data-testid="sync-connection-test"
          >
            {testing ? <Spinner className="size-3.5" /> : <PlugZap />}
            {t('dashboard.test')}
          </Button>
          <Button size="sm" variant="secondary" onClick={onEdit} data-testid="sync-connection-edit">
            <Pencil />
            {t('dashboard.editConnection')}
          </Button>
        </>
      }
    >
      <SettingsCard>
        <div className="flex items-center gap-3 px-4 py-3">
          <DbLogo kind={config.kind} size="sm" />
          <span className="text-[13px] font-medium">{t(`db.${config.kind}`)}</span>
        </div>
        <div className="grid grid-cols-[150px_1fr] gap-x-4 gap-y-2 px-4 py-3.5 text-[13px]">
          {rows.map((r) => (
            <div key={r.label} className="contents">
              <div className="text-muted">{r.label}</div>
              <div className={cn('flex min-w-0 items-center gap-2', r.mono && 'font-mono text-xs')}>
                <span className="selectable truncate">{r.value}</span>
              </div>
            </div>
          ))}
        </div>
        {result && (
          <div
            className={cn(
              'flex items-start gap-2 px-4 py-3 text-xs',
              result.ok ? 'text-success' : 'text-danger'
            )}
            data-testid="sync-connection-result"
          >
            {result.ok ? (
              <CircleCheck className="mt-px size-3.5 shrink-0" />
            ) : (
              <CircleAlert className="mt-px size-3.5 shrink-0" />
            )}
            <span className="selectable min-w-0 break-words">
              {result.ok ? t('test.ok', { ms: result.latencyMs ?? 0 }) : result.error || t('test.failed')}
            </span>
          </div>
        )}
      </SettingsCard>
    </SettingsGroup>
  )
}

function IntervalsCard(): React.JSX.Element {
  const { t } = useTranslation('sync')
  const { t: tc } = useTranslation()
  const pollIntervalSec = useApp((s) => s.sync.pollIntervalSec)
  const reconcileIntervalMin = useApp((s) => s.sync.reconcileIntervalMin)
  const realtime = useApp((s) => s.sync.realtime)
  const [poll, setPoll] = useState(pollIntervalSec)
  const [rec, setRec] = useState(reconcileIntervalMin)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setPoll(pollIntervalSec)
    setRec(reconcileIntervalMin)
  }, [pollIntervalSec, reconcileIntervalMin])

  const dirty = poll !== pollIntervalSec || rec !== reconcileIntervalMin
  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      await call('sync.setIntervals', { pollIntervalSec: poll, reconcileIntervalMin: rec })
      toast.success(t('dashboard.intervalsSaved'))
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsGroup title={t('dashboard.intervals')} testId="sync-intervals">
      <SettingsCard>
        <SettingsRow
          label={t('dashboard.poll')}
          description={realtime ? t('dashboard.pollDescRealtime') : t('dashboard.pollDesc')}
        >
          <NumberField
            value={poll}
            min={5}
            max={3600}
            step={5}
            onChange={setPoll}
            suffix={t('dashboard.secondsShort')}
            className="w-36"
            testId="sync-poll-interval"
          />
        </SettingsRow>
        <SettingsRow label={t('dashboard.reconcileLabel')} description={t('dashboard.reconcileDesc')}>
          <NumberField
            value={rec}
            min={1}
            max={1440}
            onChange={setRec}
            suffix={t('dashboard.minutesShort')}
            className="w-36"
            testId="sync-reconcile-interval"
          />
        </SettingsRow>
        {dirty && (
          <div className="flex items-center justify-end gap-2 px-4 py-2.5">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setPoll(pollIntervalSec)
                setRec(reconcileIntervalMin)
              }}
              disabled={busy}
            >
              {tc('reset')}
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => void save()}
              disabled={busy}
              data-testid="sync-intervals-save"
            >
              {busy && <Spinner className="size-3.5 text-current" />}
              {tc('save')}
            </Button>
          </div>
        )}
      </SettingsCard>
    </SettingsGroup>
  )
}

function SecurityCard(): React.JSX.Element {
  const { t } = useTranslation('sync')
  const [dialog, setDialog] = useState<'change' | 'rotate' | null>(null)
  const needsPassword = useApp((s) => s.sync.state === 'needs-password')
  return (
    <SettingsGroup title={t('dashboard.security')} testId="sync-security">
      <SettingsCard>
        <SettingsRow
          icon={<KeyRound />}
          label={t('dashboard.changePassword')}
          description={t('dashboard.changePasswordDesc')}
        >
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setDialog('change')}
            disabled={needsPassword}
            data-testid="sync-change-password"
          >
            {t('dashboard.changeBtn')}
          </Button>
        </SettingsRow>
        <SettingsRow
          icon={<RotateCcwKey />}
          label={t('dashboard.rotateKey')}
          description={t('dashboard.rotateKeyDesc')}
        >
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setDialog('rotate')}
            disabled={needsPassword}
            data-testid="sync-rotate-key"
          >
            {t('dashboard.rotateBtn')}
          </Button>
        </SettingsRow>
      </SettingsCard>
      {dialog === 'change' && <ChangeMasterPasswordDialog onClose={() => setDialog(null)} />}
      {dialog === 'rotate' && <RotateKeyDialog onClose={() => setDialog(null)} />}
    </SettingsGroup>
  )
}

function ChangeMasterPasswordDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { t } = useTranslation('sync')
  const { t: tc } = useTranslation()
  const [current, setCurrent] = useState('')
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<{ current?: string; pw?: string; pw2?: string; general?: string }>({})

  const submit = async (): Promise<void> => {
    const e: typeof errors = {}
    if (!current) e.current = tc('required')
    if (pw.length < MIN_MASTER_PASSWORD) e.pw = t('vault.minLength')
    else if (pw2 !== pw) e.pw2 = t('vault.mismatch')
    setErrors(e)
    if (Object.keys(e).length) return
    setBusy(true)
    try {
      await call('sync.changePassword', current, pw)
      toast.success(t('dashboard.passwordChanged'))
      onClose()
    } catch (err) {
      const msg = errorMessage(err)
      setErrors(isWrongPasswordError(msg) ? { current: t('vault.wrongPassword') } : { general: msg })
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent
        title={t('dashboard.changeTitle')}
        description={t('dashboard.changePasswordDesc')}
        width="max-w-[440px]"
        data-testid="sync-change-password-dialog"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <DialogBody className="flex flex-col gap-3.5 pb-1">
            <Field label={t('dashboard.currentPassword')} error={errors.current}>
              <PasswordInput
                autoFocus
                value={current}
                disabled={busy}
                onChange={(e) => {
                  setCurrent(e.target.value)
                  setErrors((x) => ({ ...x, current: undefined }))
                }}
                data-testid="sync-current-password"
              />
            </Field>
            <Field label={t('dashboard.newPassword')} error={errors.pw}>
              <PasswordInput
                value={pw}
                disabled={busy}
                onChange={(e) => {
                  setPw(e.target.value)
                  setErrors((x) => ({ ...x, pw: undefined }))
                }}
                data-testid="sync-new-password"
              />
            </Field>
            <StrengthMeter password={pw} />
            <Field label={t('dashboard.confirmNew')} error={errors.pw2}>
              <PasswordInput
                value={pw2}
                disabled={busy}
                onChange={(e) => {
                  setPw2(e.target.value)
                  setErrors((x) => ({ ...x, pw2: undefined }))
                }}
                data-testid="sync-new-password-confirm"
              />
            </Field>
            {errors.general && <Callout tone="danger">{errors.general}</Callout>}
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              {tc('cancel')}
            </Button>
            <Button type="submit" variant="primary" disabled={busy} data-testid="sync-change-password-submit">
              {busy && <Spinner className="text-current" />}
              {t('dashboard.changePassword')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function RotateKeyDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { t } = useTranslation('sync')
  const { t: tc } = useTranslation()
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    if (!pw) {
      setError(tc('required'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      await call('sync.rotateKey', pw)
      toast.success(t('dashboard.rotated'))
      onClose()
    } catch (err) {
      const msg = errorMessage(err)
      setError(isWrongPasswordError(msg) ? t('vault.wrongPassword') : msg)
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent
        title={t('dashboard.rotateTitle')}
        width="max-w-[460px]"
        data-testid="sync-rotate-dialog"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <DialogBody className="flex flex-col gap-4 pb-1">
            <ul className="flex flex-col gap-2.5 text-[13px] leading-relaxed text-muted">
              {(['rotate1', 'rotate2', 'rotate3'] as const).map((k, i) => (
                <li key={k} className="flex gap-2.5">
                  <span className="mt-[3px] flex size-4 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[10px] font-semibold text-accent">
                    {i + 1}
                  </span>
                  <span>{t(`dashboard.${k}`)}</span>
                </li>
              ))}
            </ul>
            <Field label={t('vault.masterPassword')} error={error ?? undefined}>
              <PasswordInput
                autoFocus
                value={pw}
                disabled={busy}
                onChange={(e) => {
                  setPw(e.target.value)
                  setError(null)
                }}
                data-testid="sync-rotate-password"
              />
            </Field>
            {busy && (
              <div className="flex items-center gap-2 text-xs text-muted">
                <Spinner className="size-3.5" />
                {t('dashboard.rotating')}
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              {tc('cancel')}
            </Button>
            <Button type="submit" variant="primary" disabled={busy} data-testid="sync-rotate-submit">
              {busy ? <Spinner className="text-current" /> : <RotateCcwKey />}
              {t('dashboard.rotateConfirm')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
