import { Bot, CircleAlert, CircleCheck, Loader2, Pencil, Plus, RefreshCcw, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  AI_PRESETS,
  AI_PRESET_IDS,
  type AiAuthStyle,
  type AiConfigSummary,
  type AiPresetId,
  type AiProtocol,
  type AiTestResult
} from '@shared/ai'
import { SECRET_MASK } from '@shared/schemas'
import { Button } from '@/components/ui/button'
import { Select, Switch } from '@/components/ui/controls'
import { Input, Textarea } from '@/components/ui/input'
import { SecretInput } from '@/components/SecretInput'
import { call, errorMessage } from '@/lib/api'
import { useAi } from '@/stores/ai'
import { useApp } from '@/stores/app'
import { Callout, NumberField, SettingsCard, SettingsGroup, SettingsRow } from './ui'
import { useSaveAiSettings } from './GeneralSection'

interface FormState {
  id?: string
  name: string
  preset: AiPresetId
  protocol: AiProtocol
  authStyle: AiAuthStyle
  baseUrl: string
  apiKey: string
  model: string
  headersText: string
}

function presetDefaults(preset: AiPresetId): Pick<FormState, 'protocol' | 'authStyle' | 'baseUrl'> {
  const p = AI_PRESETS[preset]
  return { protocol: p.protocol, authStyle: p.authStyle, baseUrl: p.baseUrl }
}

function newForm(): FormState {
  return { name: '', preset: 'openai', ...presetDefaults('openai'), apiKey: '', model: AI_PRESETS.openai.defaultModel ?? '', headersText: '' }
}

function editForm(c: AiConfigSummary): FormState {
  return {
    id: c.id,
    name: c.name,
    preset: c.preset,
    protocol: c.protocol,
    authStyle: c.authStyle,
    baseUrl: c.baseUrl,
    apiKey: c.apiKey ? SECRET_MASK : '',
    model: c.model,
    headersText: Object.entries(c.customHeaders ?? {})
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n')
  }
}

function parseHeaders(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Za-z0-9-]+)\s*:\s*(.+?)\s*$/.exec(line)
    if (m) out[m[1]] = m[2]
  }
  return Object.keys(out).length ? out : undefined
}

function toInput(f: FormState): { id?: string; name: string; preset: AiPresetId; protocol: AiProtocol; baseUrl: string; model: string; apiKey: string; authStyle: AiAuthStyle; customHeaders?: Record<string, string> } {
  return {
    id: f.id,
    name: f.name,
    preset: f.preset,
    protocol: f.protocol,
    baseUrl: f.baseUrl,
    model: f.model,
    apiKey: f.apiKey,
    authStyle: f.authStyle,
    customHeaders: parseHeaders(f.headersText)
  }
}

export function AiSection(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const settings = useApp((s) => s.settings)
  const save = useSaveAiSettings()
  const configs = useAi((s) => s.configs)
  const [form, setForm] = useState<FormState | null>(null)

  useEffect(() => {
    void useAi.getState().refreshConfigs()
  }, [])

  const presetLabel = (p: AiPresetId): string => t(`ai.presets.${p}`)

  return (
    <>
      <SettingsGroup
        title={t('ai.providers')}
        description={t('ai.providersDesc')}
        action={
          <Button size="xs" variant="secondary" onClick={() => setForm(newForm())} data-testid="ai-add-config">
            <Plus />
            {t('ai.add')}
          </Button>
        }
      >
        <SettingsCard testId="ai-config-list">
          {configs.length === 0 && (
            <div className="px-4 py-6 text-center text-xs text-subtle" data-testid="ai-config-empty">
              {t('ai.empty')}
            </div>
          )}
          {configs.map((c) => {
            const active = settings.ai.activeConfigId === c.id
            return (
              <SettingsRow
                key={c.id}
                icon={<Bot />}
                label={
                  <span className="flex items-center gap-2">
                    {c.name}
                    <span className="rounded border border-line px-1.5 py-px text-[10px] font-normal text-subtle">{presetLabel(c.preset)}</span>
                  </span>
                }
                description={
                  <span className="font-mono text-[11px]">
                    {c.model} · {c.baseUrl}
                  </span>
                }
              >
                <Button size="xs" variant={active ? 'primary' : 'ghost'} disabled={active} onClick={() => save({ activeConfigId: c.id })}>
                  {active ? t('ai.active') : t('ai.activate')}
                </Button>
                <Button size="icon-xs" variant="ghost" onClick={() => setForm(editForm(c))}>
                  <Pencil />
                </Button>
                <Button
                  size="icon-xs"
                  variant="danger-ghost"
                  onClick={() => {
                    void call('ai.removeConfig', c.id)
                      .then(() => useAi.getState().refreshConfigs())
                      .catch((err) => toast.error(errorMessage(err)))
                    if (settings.ai.activeConfigId === c.id) save({ activeConfigId: undefined })
                  }}
                >
                  <Trash2 />
                </Button>
              </SettingsRow>
            )
          })}
        </SettingsCard>
        {form && <ConfigForm form={form} onChange={setForm} presetLabel={presetLabel} />}
      </SettingsGroup>

      <SettingsGroup title={t('ai.agent')} description={t('ai.agentDesc')}>
        <SettingsCard>
          <SettingsRow label={t('ai.autoApprove')} description={t('ai.autoApproveDesc')}>
            <Switch checked={settings.ai.autoApprove} onCheckedChange={(v) => save({ autoApprove: v })} data-testid="ai-auto-approve" />
          </SettingsRow>
          <SettingsRow label={t('ai.maxTurns')} description={t('ai.maxTurnsDesc')}>
            <NumberField value={settings.ai.maxTurns} onChange={(maxTurns) => save({ maxTurns })} min={1} max={100} testId="ai-max-turns" />
          </SettingsRow>
          <SettingsRow label={t('ai.commandTimeout')} description={t('ai.commandTimeoutDesc')}>
            <NumberField
              value={settings.ai.commandTimeoutSec}
              onChange={(commandTimeoutSec) => save({ commandTimeoutSec })}
              min={5}
              max={600}
              step={5}
              suffix="s"
              testId="ai-command-timeout"
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsGroup>

      <p className="mt-4 px-1 text-xs text-subtle">{t('ai.privacyNote')}</p>
    </>
  )
}

function ConfigForm({
  form,
  onChange,
  presetLabel
}: {
  form: FormState
  onChange: (f: FormState | null) => void
  presetLabel: (p: AiPresetId) => string
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  const settings = useApp((s) => s.settings)
  const saveSettings = useSaveAiSettings()
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<AiTestResult | null>(null)
  const [models, setModels] = useState<string[]>([])
  const [loadingModels, setLoadingModels] = useState(false)

  const set = (patch: Partial<FormState>): void => onChange({ ...form, ...patch })
  const applyPreset = (preset: AiPresetId): void => {
    const defaults = presetDefaults(preset)
    // Replace the model when it is empty or still the old preset's default; keep hand-tuned values.
    const oldDefault = AI_PRESETS[form.preset].defaultModel
    const nextModel = !form.model || form.model === oldDefault ? (AI_PRESETS[preset].defaultModel ?? '') : form.model
    onChange({ ...form, preset, ...defaults, model: nextModel })
    setModels([])
    setTestResult(null)
  }

  const test = async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    try {
      setTestResult(await call('ai.testConfig', toInput(form)))
    } catch (err) {
      setTestResult({ ok: false, error: errorMessage(err) })
    } finally {
      setTesting(false)
    }
  }

  const fetchModels = async (): Promise<void> => {
    setLoadingModels(true)
    try {
      setModels(await call('ai.listModels', toInput(form)))
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setLoadingModels(false)
    }
  }

  const submit = (): void => {
    void call('ai.saveConfig', toInput(form))
      .then((saved) => {
        onChange(null)
        void useAi.getState().refreshConfigs()
        if (!settings.ai.activeConfigId) saveSettings({ activeConfigId: saved.id })
      })
      .catch((err) => toast.error(errorMessage(err)))
  }

  const preset = AI_PRESETS[form.preset]

  return (
    <div className="mt-2.5 rounded-xl border border-line bg-panel p-4" data-testid="ai-config-form">
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('ai.name')}>
          <Input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder={presetLabel(form.preset)} data-testid="ai-form-name" />
        </Field>
        <Field label={t('ai.preset')}>
          <Select
            value={form.preset}
            onChange={(v) => v && applyPreset(v as AiPresetId)}
            options={AI_PRESET_IDS.map((p) => ({ value: p, label: presetLabel(p) }))}
          />
        </Field>
        <Field label={t('ai.baseUrl')}>
          <Input value={form.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} placeholder="https://api.example.com/v1" spellCheck={false} />
        </Field>
        <Field label={t('ai.model')}>
          <div className="flex gap-1.5">
            <Input value={form.model} onChange={(e) => set({ model: e.target.value })} placeholder="gpt-4o" spellCheck={false} data-testid="ai-form-model" />
            <Button size="sm" variant="secondary" onClick={() => void fetchModels()} disabled={loadingModels}>
              {loadingModels ? <Loader2 className="animate-spin" /> : <RefreshCcw />}
              {t('ai.fetchModels')}
            </Button>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-subtle">{t('ai.modelHint')}</p>
        </Field>
        <Field label={t('ai.protocol')}>
          <Select
            value={form.protocol}
            onChange={(v) => set({ protocol: v === 'anthropic' ? 'anthropic' : 'openai' })}
            options={[
              { value: 'openai', label: 'OpenAI' },
              { value: 'anthropic', label: 'Anthropic' }
            ]}
          />
        </Field>
        <Field label={t('ai.authStyle')}>
          <Select
            value={form.authStyle}
            onChange={(v) => set({ authStyle: (v === 'x-api-key' ? 'x-api-key' : v === 'none' ? 'none' : 'bearer') as AiAuthStyle })}
            options={[
              { value: 'bearer', label: 'Bearer' },
              { value: 'x-api-key', label: 'x-api-key' },
              { value: 'none', label: t('ai.authNone') }
            ]}
          />
        </Field>
      </div>

      <div className="mt-3">
        <Field label={t('ai.apiKey')}>
          <SecretInput
            value={form.apiKey}
            onChange={(apiKey) => set({ apiKey })}
            path="apiKey"
            placeholder={preset.needsKey ? 'sk-…' : t('ai.apiKeyOptional')}
            savedPlaceholder={t('ai.apiKeySaved')}
            data-testid="ai-form-key"
          />
        </Field>
      </div>

      {models.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {models.slice(0, 24).map((m) => (
            <button
              key={m}
              className={m === form.model ? 'rounded-md border border-accent/60 bg-accent-soft px-2 py-0.5 font-mono text-[11px] text-accent' : 'rounded-md border border-line px-2 py-0.5 font-mono text-[11px] text-muted hover:text-fg'}
              onClick={() => set({ model: m })}
            >
              {m}
            </button>
          ))}
        </div>
      )}

      <details className="mt-3">
        <summary className="cursor-pointer select-none text-xs text-subtle hover:text-muted">{t('ai.advanced')}</summary>
        <div className="mt-2">
          <Field label={t('ai.customHeaders')}>
            <Textarea
              value={form.headersText}
              onChange={(e) => set({ headersText: e.target.value })}
              rows={3}
              placeholder={'X-Custom-Header: value'}
              className="font-mono text-xs"
            />
          </Field>
        </div>
      </details>

      {testResult && (
        <div className="mt-3">
          {testResult.ok ? (
            <Callout tone="success" icon={<CircleCheck />} title={t('ai.testOk', { ms: testResult.latencyMs ?? 0 })}>
              {testResult.models?.length ? (
                <>
                  {t('ai.testModels')}: <span className="font-mono">{testResult.models.slice(0, 5).join(', ')}</span>
                </>
              ) : null}
            </Callout>
          ) : (
            <Callout tone="danger" icon={<CircleAlert />} title={t('ai.testFail')}>
              {testResult.error}
            </Callout>
          )}
        </div>
      )}

      <div className="mt-4 flex items-center gap-2">
        <Button size="sm" variant="primary" onClick={submit} disabled={!form.name.trim() || !form.baseUrl.trim() || !form.model.trim()} data-testid="ai-form-save">
          {t('ai.save', { ns: 'settings' })}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onChange(null)}>
          {t('ai.cancel')}
        </Button>
        <span className="flex-1" />
        <Button size="sm" variant="secondary" onClick={() => void test()} disabled={testing}>
          {testing ? <Loader2 className="animate-spin" /> : <CircleCheck />}
          {t('ai.test')}
        </Button>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
      {children}
    </label>
  )
}
