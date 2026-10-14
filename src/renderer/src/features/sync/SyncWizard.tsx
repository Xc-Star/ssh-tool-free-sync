import {
  ArrowLeft,
  Check,
  CircleCheck,
  Cloud,
  CloudCheck,
  KeyRound,
  Laptop,
  LockKeyhole,
  PlugZap,
  RefreshCw,
  Sparkles,
  Zap
} from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SECRET_MASK } from '@shared/schemas'
import type { SyncDbConfig, SyncDbKind, SyncTestResult } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/controls'
import { Field, PasswordInput } from '@/components/ui/input'
import { Badge, ProgressBar, Spinner } from '@/components/ui/misc'
import { call, errorMessage } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Callout } from '@/features/settings/ui'
import { D1ConnectionForm, D1Help, SqlConnectionForm, SqlHelp } from './ConnectionForm'
import { DbLogo } from './DbLogo'
import { StrengthMeter } from './fields'
import {
  buildConfig,
  type D1Form,
  d1FormFrom,
  DB_KINDS,
  DEFAULT_PORT,
  describeTarget,
  emptyD1Form,
  emptySqlForm,
  errorHint,
  isWrongPasswordError,
  type SqlForm,
  sqlFormFrom,
  validateForm
} from './model'

type Step = 1 | 2 | 3
type StepState = 'done' | 'active' | 'upcoming'
type Outcome = 'created' | 'joined'

const MIN_MASTER_PASSWORD = 8

export function SyncWizard({
  initial,
  onPin,
  onFinish,
  onCancel
}: {
  /** Existing (masked) config when editing the connection of a configured device. */
  initial?: SyncDbConfig | null
  /** Keeps the wizard on screen while create/join runs, even though the live status already says "configured". */
  onPin: (pinned: boolean) => void
  onFinish: () => void
  onCancel?: () => void
}): React.JSX.Element {
  const { t } = useTranslation('sync')
  const { t: tc } = useTranslation()
  const editing = !!initial
  const [kind, setKind] = useState<SyncDbKind | null>(initial?.kind ?? null)
  const [step, setStep] = useState<Step>(initial ? 2 : 1)
  const [sql, setSql] = useState<SqlForm>(() =>
    initial && initial.kind !== 'd1' ? sqlFormFrom(initial) : emptySqlForm()
  )
  const [d1, setD1] = useState<D1Form>(() => (initial?.kind === 'd1' ? d1FormFrom(initial) : emptyD1Form()))
  const savedSecret =
    !!initial && (initial.kind === 'd1' ? initial.apiToken === SECRET_MASK : initial.password === SECRET_MASK)
  const [showErrors, setShowErrors] = useState(false)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<SyncTestResult | null>(null)
  const [tested, setTested] = useState<{ config: SyncDbConfig; result: SyncTestResult; run: number } | null>(
    null
  )
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const stepRefs = useRef<Partial<Record<Step, HTMLDivElement | null>>>({})
  const firstRender = useRef(true)

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    const el = stepRefs.current[step]
    if (!el) return
    const top = el.getBoundingClientRect().top
    if (top < 48 || top > window.innerHeight - 200) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [step])

  const errors = kind ? validateForm(kind, sql, d1) : {}
  const patchSql = (p: Partial<SqlForm>): void => {
    setSql((s) => ({ ...s, ...p }))
    setResult(null)
  }
  const patchD1 = (p: Partial<D1Form>): void => {
    setD1((s) => ({ ...s, ...p }))
    setResult(null)
  }

  const chooseKind = (k: SyncDbKind): void => {
    if (k !== kind) {
      if (k !== 'd1') {
        const other = k === 'postgres' ? 'mysql' : 'postgres'
        setSql((s) =>
          s.port === '' || s.port === String(DEFAULT_PORT[other])
            ? { ...s, port: String(DEFAULT_PORT[k]) }
            : s
        )
      }
      setResult(null)
      setShowErrors(false)
    }
    setKind(k)
    setStep(2)
  }

  const runTest = async (): Promise<void> => {
    if (!kind) return
    if (Object.keys(errors).length) {
      setShowErrors(true)
      return
    }
    const config = buildConfig(kind, sql, d1)
    setTesting(true)
    setResult(null)
    try {
      const r = await call('sync.test', config)
      setResult(r)
      if (r.ok) {
        setTested((prev) => ({ config, result: r, run: (prev?.run ?? 0) + 1 }))
        setStep(3)
      }
    } catch (err) {
      setResult({ ok: false, hasVault: false, error: errorMessage(err) })
    } finally {
      setTesting(false)
    }
  }

  const onBusy = (b: boolean): void => {
    setBusy(b)
    onPin(b)
  }

  if (outcome) {
    return (
      <SetupDone
        outcome={outcome}
        editing={editing}
        onFinish={() => {
          onPin(false)
          onFinish()
        }}
      />
    )
  }

  const stateOf = (s: Step): StepState => (s < step ? 'done' : s === step ? 'active' : 'upcoming')
  const locked = busy || testing

  return (
    <section className="scroll-mt-4 rounded-2xl border border-line bg-panel" data-testid="sync-wizard">
      <header className="flex items-center gap-3 border-b border-line px-6 py-4">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <Sparkles className="size-[18px]" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold">{editing ? t('wizard.editTitle') : t('wizard.title')}</h2>
          <p className="mt-0.5 text-xs text-muted">
            {editing ? t('wizard.editSubtitle') : t('wizard.subtitle')}
          </p>
        </div>
        {onCancel && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onCancel}
            disabled={busy}
            data-testid="sync-wizard-cancel"
          >
            {tc('cancel')}
          </Button>
        )}
      </header>

      <div className="px-6 pb-6 pt-5">
        <WizardStep
          index={1}
          refEl={(el) => {
            stepRefs.current[1] = el
          }}
          title={t('wizard.stepDb')}
          state={stateOf(1)}
          action={
            stateOf(1) === 'done' && (
              <Button
                size="xs"
                variant="ghost"
                onClick={() => setStep(1)}
                disabled={locked}
                data-testid="sync-change-db"
              >
                {t('wizard.change')}
              </Button>
            )
          }
          summary={
            kind && (
              <div className="flex items-center gap-2.5">
                <DbLogo kind={kind} size="sm" />
                <span className="text-[13px] font-medium">{t(`db.${kind}`)}</span>
              </div>
            )
          }
        >
          <DbChoice value={kind} onSelect={chooseKind} />
        </WizardStep>

        <WizardStep
          index={2}
          refEl={(el) => {
            stepRefs.current[2] = el
          }}
          title={t('wizard.stepConnect')}
          state={stateOf(2)}
          action={
            stateOf(2) === 'done' && (
              <Button
                size="xs"
                variant="ghost"
                onClick={() => setStep(2)}
                disabled={locked}
                data-testid="sync-edit-connection"
              >
                {t('wizard.edit')}
              </Button>
            )
          }
          summary={tested && <TestSummary config={tested.config} result={tested.result} />}
        >
          {kind === 'd1' && <D1Help defaultOpen={!d1.accountId && !editing} />}
          {kind === 'd1' ? (
            <D1ConnectionForm
              form={d1}
              onChange={patchD1}
              errors={showErrors ? errors : null}
              disabled={testing}
              savedSecret={savedSecret}
            />
          ) : kind ? (
            <SqlConnectionForm
              kind={kind}
              form={sql}
              onChange={patchSql}
              errors={showErrors ? errors : null}
              disabled={testing}
              savedSecret={savedSecret}
            />
          ) : null}
          {result && !result.ok && <TestFailure error={result.error ?? ''} />}
          {result?.ok && (
            <Callout tone="success" title={t('test.ok', { ms: result.latencyMs ?? 0 })} testId="sync-test-ok">
              {result.hasVault ? t('test.vaultFound') : t('test.noVault')}
            </Callout>
          )}
          <div className="flex items-center gap-2">
            {!editing && (
              <Button variant="ghost" onClick={() => setStep(1)} disabled={testing}>
                <ArrowLeft />
                {tc('back')}
              </Button>
            )}
            <div className="flex-1" />
            {result?.ok && tested && (
              <Button variant="secondary" onClick={() => setStep(3)}>
                {t('wizard.continue')}
              </Button>
            )}
            <Button
              variant="primary"
              onClick={() => void runTest()}
              disabled={testing}
              data-testid="sync-test"
            >
              {testing ? <Spinner className="text-current" /> : <PlugZap />}
              {testing ? t('test.testing') : t('test.button')}
            </Button>
          </div>
          {kind && kind !== 'd1' && <SqlHelp />}
        </WizardStep>

        <WizardStep
          index={3}
          last
          refEl={(el) => {
            stepRefs.current[3] = el
          }}
          title={
            tested
              ? tested.result.hasVault
                ? t('wizard.stepJoin')
                : t('wizard.stepCreate')
              : t('wizard.stepVault')
          }
          state={stateOf(3)}
        >
          {tested && (
            <VaultStep
              key={tested.run}
              config={tested.config}
              mode={tested.result.hasVault ? 'join' : 'create'}
              editing={editing}
              onBusy={onBusy}
              onDone={(o) => {
                setBusy(false)
                setOutcome(o)
              }}
              onRetest={() => {
                setResult(null)
                setStep(2)
              }}
            />
          )}
        </WizardStep>
      </div>
    </section>
  )
}

function WizardStep({
  index,
  title,
  state,
  summary,
  action,
  children,
  last,
  refEl
}: {
  index: number
  title: ReactNode
  state: StepState
  summary?: ReactNode
  action?: ReactNode
  children?: ReactNode
  last?: boolean
  refEl?: (el: HTMLDivElement | null) => void
}): React.JSX.Element {
  return (
    <div
      ref={refEl}
      className="relative flex scroll-mt-4 gap-4"
      data-testid={`sync-step-${index}`}
      data-state={state}
    >
      <div className="flex flex-col items-center">
        <div
          className={cn(
            'flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition-colors',
            state === 'done' && 'bg-success text-white',
            state === 'active' && 'bg-accent text-white ring-4 ring-accent/15',
            state === 'upcoming' && 'border border-line-strong text-subtle'
          )}
        >
          {state === 'done' ? <Check className="size-3.5" strokeWidth={3} /> : index}
        </div>
        {!last && (
          <div className={cn('my-1.5 w-px flex-1', state === 'done' ? 'bg-success/40' : 'bg-line')} />
        )}
      </div>
      <div className={cn('min-w-0 flex-1', !last && 'pb-6')}>
        <div className="flex min-h-7 items-center gap-3">
          <h3 className={cn('flex-1 text-[14px] font-semibold', state === 'upcoming' && 'text-subtle')}>
            {title}
          </h3>
          {action}
        </div>
        {state === 'done' && summary && <div className="mt-1.5">{summary}</div>}
        {state === 'active' && <div className="mt-3 flex flex-col gap-4">{children}</div>}
      </div>
    </div>
  )
}

const DB_TAGS: Record<SyncDbKind, { tone: 'accent' | 'neutral' | 'success'; icon: ReactNode }> = {
  postgres: { tone: 'accent', icon: <Zap /> },
  mysql: { tone: 'neutral', icon: <RefreshCw /> },
  d1: { tone: 'success', icon: <Cloud /> }
}

function DbChoice({
  value,
  onSelect
}: {
  value: SyncDbKind | null
  onSelect: (k: SyncDbKind) => void
}): React.JSX.Element {
  const { t } = useTranslation('sync')
  return (
    <div className="grid grid-cols-1 gap-3 @xl:grid-cols-3" role="radiogroup" aria-label={t('wizard.stepDb')}>
      {DB_KINDS.map((k) => {
        const selected = value === k
        return (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onSelect(k)}
            data-testid={`sync-db-${k}`}
            className={cn(
              'relative flex items-start gap-3 rounded-xl border bg-app p-4 text-left transition-all @xl:flex-col',
              selected
                ? 'border-accent ring-2 ring-accent/25'
                : 'border-line hover:-translate-y-px hover:border-line-strong hover:shadow-sm'
            )}
          >
            <DbLogo kind={k} size="lg" />
            <div className="flex min-w-0 flex-1 flex-col gap-3 self-stretch pr-6 @xl:pr-0">
              <div>
                <div className="text-[13.5px] font-semibold">{t(`db.${k}`)}</div>
                <p className="mt-1 text-xs leading-relaxed text-muted">{t(`db.${k}Desc`)}</p>
              </div>
              <Badge tone={DB_TAGS[k].tone} className="mt-auto self-start [&_svg]:size-3">
                {DB_TAGS[k].icon}
                {t(`db.${k}Tag`)}
              </Badge>
            </div>
            {selected && (
              <span className="absolute right-3 top-3 flex size-5 items-center justify-center rounded-full bg-accent text-white">
                <Check className="size-3" strokeWidth={3} />
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

function TestSummary({
  config,
  result
}: {
  config: SyncDbConfig
  result: SyncTestResult
}): React.JSX.Element {
  const { t } = useTranslation('sync')
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted"
      data-testid="sync-test-summary"
    >
      <span className="flex items-center gap-1.5 font-medium text-success">
        <CircleCheck className="size-3.5" />
        {t('test.ok', { ms: result.latencyMs ?? 0 })}
      </span>
      <span className="flex min-w-0 items-center gap-1.5">
        <DbLogo kind={config.kind} size="xs" />
        <span className="truncate font-mono">{describeTarget(config)}</span>
      </span>
      <Badge tone={result.hasVault ? 'accent' : 'neutral'}>
        {result.hasVault ? t('test.vaultFoundShort') : t('test.noVaultShort')}
      </Badge>
    </div>
  )
}

function TestFailure({ error }: { error: string }): React.JSX.Element {
  const { t } = useTranslation('sync')
  const hint = errorHint(error)
  return (
    <Callout tone="danger" title={t('test.failed')} testId="sync-test-error">
      <span className="selectable block break-words font-mono text-[11.5px] leading-relaxed text-fg">
        {error || t('test.unknownError')}
      </span>
      {hint && <span className="mt-1.5 block">{t(`test.hints.${hint}`)}</span>}
    </Callout>
  )
}

function VaultStep({
  config,
  mode,
  editing,
  onBusy,
  onDone,
  onRetest
}: {
  config: SyncDbConfig
  mode: 'create' | 'join'
  editing: boolean
  onBusy: (busy: boolean) => void
  onDone: (o: Outcome) => void
  onRetest: () => void
}): React.JSX.Element {
  const { t } = useTranslation('sync')
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [ack, setAck] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (!busy) return
    const started = Date.now()
    const id = window.setInterval(() => setElapsed(Date.now() - started), 200)
    return () => window.clearInterval(id)
  }, [busy])

  const tooShort = pw.length < MIN_MASTER_PASSWORD
  const mismatch = mode === 'create' && pw2 !== pw
  const invalid = tooShort || (mode === 'create' && (mismatch || !ack))
  const wrong = !!error && isWrongPasswordError(error)
  const vaultExists = !!error && /already contains a vault|created the vault first/i.test(error)
  const vaultGone = !!error && /does not contain a vault/i.test(error)

  const submit = async (): Promise<void> => {
    setSubmitted(true)
    setError(null)
    if (invalid || busy) return
    setElapsed(0)
    setBusy(true)
    onBusy(true)
    try {
      if (mode === 'create') await call('sync.create', config, pw)
      else await call('sync.join', config, pw)
      onDone(mode === 'create' ? 'created' : 'joined')
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
      onBusy(false)
    }
  }

  const progress = 95 * (1 - Math.exp(-elapsed / 4000))

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
      data-testid={`sync-vault-${mode}`}
    >
      <p className="text-[13px] leading-relaxed text-muted">
        {mode === 'create' ? t('vault.createDesc') : t('vault.joinDesc')}
      </p>
      {editing && mode === 'create' && <Callout tone="warning">{t('vault.editCreateNote')}</Callout>}

      {mode === 'create' ? (
        <>
          <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
            <Field
              label={t('vault.masterPassword')}
              error={submitted && tooShort ? t('vault.minLength') : undefined}
            >
              <PasswordInput
                autoFocus
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                disabled={busy}
                data-testid="sync-master-password"
              />
            </Field>
            <Field
              label={t('vault.confirm')}
              error={submitted && !tooShort && mismatch ? t('vault.mismatch') : undefined}
              hint={
                pw2 && !mismatch ? (
                  <span className="flex items-center gap-1 text-success">
                    <Check className="size-3" strokeWidth={3} />
                    {t('vault.match')}
                  </span>
                ) : undefined
              }
            >
              <PasswordInput
                value={pw2}
                onChange={(e) => setPw2(e.target.value)}
                disabled={busy}
                data-testid="sync-master-password-confirm"
              />
            </Field>
          </div>
          <StrengthMeter password={pw} />
          <label
            className={cn(
              'flex cursor-default items-start gap-3 rounded-lg border p-3 transition-colors',
              submitted && !ack ? 'border-danger/50 bg-danger/5' : 'border-warning/30 bg-warning/5'
            )}
          >
            <Checkbox
              checked={ack}
              onCheckedChange={(v) => setAck(v === true)}
              disabled={busy}
              className="mt-0.5"
              data-testid="sync-ack-unrecoverable"
            />
            <span className="text-[13px] leading-relaxed">
              <span className="font-medium text-fg">{t('vault.ack')}</span>{' '}
              <span className="text-muted">{t('vault.ackDesc')}</span>
              {submitted && !ack && (
                <span className="mt-1 block text-xs text-danger">{t('vault.ackRequired')}</span>
              )}
            </span>
          </label>
        </>
      ) : (
        <Field
          label={t('vault.masterPassword')}
          error={wrong ? t('vault.wrongPassword') : submitted && tooShort ? t('vault.minLength') : undefined}
        >
          <PasswordInput
            autoFocus
            value={pw}
            onChange={(e) => {
              setPw(e.target.value)
              if (wrong) setError(null)
            }}
            disabled={busy}
            className="max-w-sm"
            data-testid="sync-master-password"
          />
        </Field>
      )}

      {error && !wrong && (
        <Callout
          tone="danger"
          testId="sync-setup-error"
          action={
            (vaultExists || vaultGone) && (
              <Button size="sm" variant="secondary" onClick={onRetest}>
                {t('vault.testAgain')}
              </Button>
            )
          }
        >
          <span className="selectable break-words">
            {vaultExists ? t('vault.vaultExists') : vaultGone ? t('vault.noVaultNow') : error}
          </span>
        </Callout>
      )}

      {busy ? (
        <div
          className="rounded-xl border border-line bg-app p-4"
          data-testid="sync-setup-progress"
          aria-live="polite"
        >
          <div className="flex items-center gap-3">
            <Spinner className="size-5 text-accent" />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium">
                {mode === 'create' ? t('vault.creating') : t('vault.joining')}
              </div>
              <div className="mt-0.5 text-xs text-muted">{t('vault.progress')}</div>
            </div>
            <span className="font-mono text-xs tabular-nums text-subtle">
              {t('vault.elapsed', { s: (elapsed / 1000).toFixed(1) })}
            </span>
          </div>
          <ProgressBar value={progress} className="mt-3 h-1.5" />
        </div>
      ) : (
        <div className="flex items-center justify-end">
          <Button
            type="submit"
            variant="primary"
            size="lg"
            data-testid={mode === 'create' ? 'sync-create' : 'sync-join'}
          >
            {mode === 'create' ? <LockKeyhole /> : <KeyRound />}
            {mode === 'create' ? t('vault.create') : t('vault.join')}
          </Button>
        </div>
      )}
    </form>
  )
}

function SetupDone({
  outcome,
  editing,
  onFinish
}: {
  outcome: Outcome
  editing: boolean
  onFinish: () => void
}): React.JSX.Element {
  const { t } = useTranslation('sync')
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [])
  return (
    <section
      ref={ref}
      className="scroll-my-6 rounded-2xl border border-line bg-panel px-8 py-10 text-center"
      data-testid="sync-setup-done"
    >
      <div className="mx-auto mb-5 flex size-16 items-center justify-center rounded-2xl bg-success/12 text-success ring-8 ring-success/5">
        <CloudCheck className="size-8" />
      </div>
      <h2 className="text-[18px] font-semibold">{t('vault.doneTitle')}</h2>
      <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-muted">
        {outcome === 'created' ? t('vault.doneCreated') : t('vault.doneJoined')}
      </p>
      {outcome === 'created' && !editing && (
        <div className="mx-auto mt-6 max-w-md rounded-xl border border-line bg-app p-4 text-left">
          <div className="mb-3 flex items-center gap-2 text-[13px] font-semibold">
            <Laptop className="size-4 text-accent" />
            {t('vault.nextTitle')}
          </div>
          <ol className="flex flex-col gap-2.5">
            {[1, 2, 3].map((n) => (
              <li key={n} className="flex gap-3 text-xs leading-relaxed text-muted">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent">
                  {n}
                </span>
                <span className="pt-0.5">{t(`vault.next${n}`)}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
      <Button variant="primary" size="lg" className="mt-7" onClick={onFinish} data-testid="sync-done">
        {t('vault.done')}
      </Button>
    </section>
  )
}
