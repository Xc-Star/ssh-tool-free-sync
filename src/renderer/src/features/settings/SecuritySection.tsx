import { KeyRound, Lock, LockKeyhole, LockOpen, ShieldAlert } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/controls'
import { Dialog, DialogBody, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { Field, PasswordInput } from '@/components/ui/input'
import { Badge, Spinner } from '@/components/ui/misc'
import { call, errorMessage } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useApp } from '@/stores/app'
import { useSaveSettings } from './GeneralSection'
import { Callout, SettingsCard, SettingsGroup, SettingsRow } from './ui'

const AUTO_LOCK_MINUTES = [0, 1, 5, 10, 15, 30, 60, 120, 240]
const MIN_LOCK_PASSWORD = 4
const KNOWN_BACKENDS = [
  'dpapi',
  'keychain',
  'gnome_libsecret',
  'kwallet',
  'kwallet5',
  'kwallet6',
  'basic_text',
  'unknown'
]

type DialogMode = 'enable' | 'change' | 'disable'

export function SecuritySection(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const lock = useApp((s) => s.lock)
  const autoLockMinutes = useApp((s) => s.settings.autoLockMinutes)
  const save = useSaveSettings()
  const [dialog, setDialog] = useState<DialogMode | null>(null)
  const on = lock.passwordEnabled

  const minutes = AUTO_LOCK_MINUTES.includes(autoLockMinutes)
    ? AUTO_LOCK_MINUTES
    : [...AUTO_LOCK_MINUTES, autoLockMinutes].sort((a, b) => a - b)
  const backendLabel = lock.backend
    ? KNOWN_BACKENDS.includes(lock.backend)
      ? t(`security.backends.${lock.backend}`)
      : lock.backend
    : t('security.backends.unknown')

  const lockNow = (): void => {
    call('lock.lock').catch((err) => toast.error(errorMessage(err)))
  }

  return (
    <>
      {lock.weak && (
        <Callout
          tone="warning"
          icon={<ShieldAlert />}
          title={t('security.weakTitle')}
          className="mb-6"
          testId="security-weak-warning"
          action={
            !on && (
              <Button size="sm" variant="primary" onClick={() => setDialog('enable')}>
                {t('security.setPassword')}
              </Button>
            )
          }
        >
          {t('security.weakDesc', { backend: backendLabel })}
        </Callout>
      )}

      <SettingsGroup title={t('security.appLock')}>
        <SettingsCard>
          <div className="flex items-center gap-4 p-4" data-testid="lock-status" data-enabled={on}>
            <div
              className={cn(
                'flex size-11 shrink-0 items-center justify-center rounded-xl',
                on ? 'bg-success/12 text-success' : 'bg-panel-hover text-muted'
              )}
            >
              {on ? <LockKeyhole className="size-5" /> : <LockOpen className="size-5" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-semibold">{on ? t('security.on') : t('security.off')}</div>
              <div className="mt-0.5 text-xs leading-relaxed text-muted">
                {on ? t('security.onDesc') : t('security.offDesc')}
              </div>
            </div>
            {on ? (
              <Button variant="secondary" onClick={lockNow} data-testid="lock-now">
                <Lock />
                {t('security.lockNow')}
              </Button>
            ) : (
              <Button variant="primary" onClick={() => setDialog('enable')} data-testid="lock-enable">
                <LockKeyhole />
                {t('security.setPassword')}
              </Button>
            )}
          </div>
          {on && (
            <SettingsRow label={t('security.changePassword')} description={t('security.changePasswordDesc')}>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setDialog('change')}
                data-testid="lock-change"
              >
                {t('security.change')}
              </Button>
            </SettingsRow>
          )}
          {on && (
            <SettingsRow label={t('security.disable')} description={t('security.disableDesc')}>
              <Button
                size="sm"
                variant="danger-ghost"
                onClick={() => setDialog('disable')}
                data-testid="lock-disable"
              >
                {t('security.turnOff')}
              </Button>
            </SettingsRow>
          )}
          <SettingsRow
            label={t('security.autoLock')}
            description={on ? t('security.autoLockDesc') : t('security.autoLockNeedsPassword')}
            disabled={!on}
          >
            <div className="w-44" data-testid="lock-auto">
              <Select
                value={String(autoLockMinutes)}
                onChange={(v) => v !== undefined && save({ autoLockMinutes: Number(v) })}
                options={minutes.map((m) => ({
                  value: String(m),
                  label: m === 0 ? t('security.never') : t('security.after', { count: m })
                }))}
                disabled={!on}
              />
            </div>
          </SettingsRow>
        </SettingsCard>
      </SettingsGroup>

      <SettingsGroup title={t('security.keyStorage')}>
        <SettingsCard>
          <SettingsRow
            label={t('security.backend')}
            description={t('security.backendDesc')}
            icon={<KeyRound />}
          >
            <span className="text-[13px] text-fg" data-testid="lock-backend">
              {on ? t('security.protectedByPassword') : backendLabel}
            </span>
            <Badge tone={lock.weak ? 'warning' : 'success'}>
              {lock.weak ? t('security.weak') : t('security.strong')}
            </Badge>
          </SettingsRow>
        </SettingsCard>
      </SettingsGroup>

      {dialog && <LockPasswordDialog mode={dialog} onClose={() => setDialog(null)} />}
    </>
  )
}

function LockPasswordDialog({ mode, onClose }: { mode: DialogMode; onClose: () => void }): React.JSX.Element {
  const { t } = useTranslation('settings')
  const { t: tc } = useTranslation()
  const [current, setCurrent] = useState('')
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<{ current?: string; pw?: string; pw2?: string; general?: string }>({})

  const title =
    mode === 'enable'
      ? t('security.enableTitle')
      : mode === 'change'
        ? t('security.changeTitle')
        : t('security.disableTitle')
  const description =
    mode === 'enable'
      ? t('security.enableDesc')
      : mode === 'disable'
        ? t('security.disableDialogDesc')
        : undefined

  const submit = async (): Promise<void> => {
    const e: typeof errors = {}
    if (mode !== 'enable' && !current) e.current = tc('required')
    if (mode !== 'disable') {
      if (pw.length < MIN_LOCK_PASSWORD) e.pw = t('security.minLength', { count: MIN_LOCK_PASSWORD })
      else if (pw2 !== pw) e.pw2 = t('security.mismatch')
    }
    setErrors(e)
    if (Object.keys(e).length) return
    setBusy(true)
    try {
      if (mode === 'enable') await call('lock.enablePassword', pw)
      else if (mode === 'change') await call('lock.changePassword', current, pw)
      else await call('lock.disablePassword', current)
      toast.success(
        mode === 'enable'
          ? t('security.enabled')
          : mode === 'change'
            ? t('security.changed')
            : t('security.disabled')
      )
      onClose()
    } catch (err) {
      const msg = errorMessage(err)
      if (/wrong password/i.test(msg)) setErrors({ current: t('security.wrongPassword') })
      else setErrors({ general: msg })
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent
        title={title}
        description={description}
        width="max-w-[420px]"
        data-testid={`lock-dialog-${mode}`}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <DialogBody className="flex flex-col gap-3.5 pb-1">
            {mode !== 'enable' && (
              <Field label={t('security.currentPassword')} error={errors.current}>
                <PasswordInput
                  autoFocus
                  value={current}
                  disabled={busy}
                  onChange={(e) => {
                    setCurrent(e.target.value)
                    setErrors((x) => ({ ...x, current: undefined }))
                  }}
                  data-testid="lock-current-password"
                />
              </Field>
            )}
            {mode !== 'disable' && (
              <>
                <Field
                  label={mode === 'change' ? t('security.newPassword') : t('security.password')}
                  error={errors.pw}
                  hint={t('security.minLength', { count: MIN_LOCK_PASSWORD })}
                >
                  <PasswordInput
                    autoFocus={mode === 'enable'}
                    value={pw}
                    disabled={busy}
                    onChange={(e) => {
                      setPw(e.target.value)
                      setErrors((x) => ({ ...x, pw: undefined }))
                    }}
                    data-testid="lock-password"
                  />
                </Field>
                <Field
                  label={mode === 'change' ? t('security.confirmNewPassword') : t('security.confirmPassword')}
                  error={errors.pw2}
                >
                  <PasswordInput
                    value={pw2}
                    disabled={busy}
                    onChange={(e) => {
                      setPw2(e.target.value)
                      setErrors((x) => ({ ...x, pw2: undefined }))
                    }}
                    data-testid="lock-password-confirm"
                  />
                </Field>
              </>
            )}
            {errors.general && <Callout tone="danger">{errors.general}</Callout>}
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              {tc('cancel')}
            </Button>
            <Button
              variant={mode === 'disable' ? 'danger' : 'primary'}
              type="submit"
              disabled={busy}
              data-testid="lock-submit"
            >
              {busy && <Spinner className="text-current" />}
              {mode === 'enable'
                ? t('security.enable')
                : mode === 'change'
                  ? tc('save')
                  : t('security.turnOffConfirm')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
