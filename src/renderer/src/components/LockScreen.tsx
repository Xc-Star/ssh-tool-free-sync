import { Lock, ShieldAlert } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { call, errorMessage } from '@/lib/api'
import { useApp } from '@/stores/app'
import { Button } from './ui/button'
import { confirm } from './ui/confirm'
import { PasswordInput } from './ui/input'

export function LockScreen(): React.JSX.Element {
  const keystoreError = useApp((s) => s.lock.keystoreError)
  return keystoreError ? <KeystoreError error={keystoreError} /> : <PasswordLock />
}

/** Deletes the local vault after confirmation (keychain unusable or app lock password forgotten). */
function useResetLocal(): () => Promise<void> {
  const { t } = useTranslation()
  return async () => {
    const ok = await confirm({ title: t('lock.resetTitle'), message: t('lock.resetMessage'), confirmLabel: t('lock.resetConfirm'), danger: true })
    if (!ok) return
    try {
      useApp.setState({ lock: await call('lock.resetLocal') })
      toast.success(t('lock.resetDone'))
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }
}

function PasswordLock(): React.JSX.Element {
  const { t } = useTranslation()
  const reset = useResetLocal()
  const [pw, setPw] = useState('')
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)
  const submit = async (): Promise<void> => {
    setBusy(true)
    try {
      const ok = await call('lock.unlock', pw)
      if (!ok) {
        setError(true)
        setPw('')
      }
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 bg-app" data-testid="lock-screen">
      <div className="flex size-16 items-center justify-center rounded-2xl bg-accent-soft text-accent">
        <Lock className="size-8" />
      </div>
      <div className="text-center">
        <div className="text-lg font-semibold">{t('lock.title')}</div>
        <div className="mt-1 text-xs text-muted">{t('lock.subtitle')}</div>
      </div>
      <form
        className="flex w-72 flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <PasswordInput
          autoFocus
          value={pw}
          placeholder={t('lock.password')}
          onChange={(e) => {
            setPw(e.target.value)
            setError(false)
          }}
        />
        {error && <div className="text-center text-xs text-danger">{t('lock.wrong')}</div>}
        <Button variant="primary" type="submit" disabled={busy || !pw}>
          {t('lock.unlock')}
        </Button>
      </form>
      <button type="button" className="text-xs text-subtle hover:text-fg hover:underline" onClick={() => void reset()} data-testid="lock-forgot">
        {t('lock.forgot')}
      </button>
    </div>
  )
}

function KeystoreError({ error }: { error: string }): React.JSX.Element {
  const { t } = useTranslation()
  const reset = useResetLocal()
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }
  const retry = async (): Promise<void> => {
    try {
      const lock = await call('lock.retryKeystore')
      useApp.setState({ lock })
      if (lock.keystoreError) toast.error(t('lock.stillUnavailable'), { description: lock.keystoreError })
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 bg-app px-6" data-testid="keystore-error">
      <div className="flex size-16 items-center justify-center rounded-2xl bg-danger/10 text-danger">
        <ShieldAlert className="size-8" />
      </div>
      <div className="max-w-md text-center">
        <div className="text-lg font-semibold">{t('lock.keystoreTitle')}</div>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">{t('lock.keystoreDesc')}</p>
        <p className="selectable mt-3 break-words rounded-md border border-line bg-panel px-3 py-2 text-left font-mono text-xs text-subtle">{error}</p>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="danger-ghost" onClick={() => void run(reset)} disabled={busy} data-testid="keystore-reset">
          {t('lock.reset')}
        </Button>
        <Button variant="primary" onClick={() => void run(retry)} disabled={busy} data-testid="keystore-retry">
          {t('lock.retry')}
        </Button>
      </div>
    </div>
  )
}