import { ChevronDown, ChevronRight, GripVertical, Plus, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ConnectionSettings, ProxyConfig } from '@shared/schemas'
import { HostAvatar } from '@/components/HostAvatar'
import { SecretInput } from '@/components/SecretInput'
import { Button } from '@/components/ui/button'
import { Select, Switch } from '@/components/ui/controls'
import { SheetSection } from '@/components/ui/dialog'
import { Field, Input } from '@/components/ui/input'
import { getTheme, TERMINAL_THEMES } from '@/features/terminal/themes'
import { useApp } from '@/stores/app'
import { getItem, useItems } from '@/stores/vault'
import { HostPicker } from './HostPicker'

const CHARSETS = ['utf-8', 'gbk', 'gb18030', 'big5', 'shift_jis', 'euc-jp', 'euc-kr', 'iso-8859-1', 'iso-8859-15', 'windows-1251', 'windows-1252', 'koi8-r']

export type Inherited = Partial<ConnectionSettings> & { source?: Record<string, string> }

interface Props {
  value: Partial<ConnectionSettings>
  onChange: (patch: Partial<ConnectionSettings>) => void
  itemId?: string
  inherited?: Inherited
  excludeHostId?: string
  showPort?: boolean
}

function numOrUndef(s: string): number | undefined {
  if (s.trim() === '') return undefined
  const n = Number(s)
  return Number.isFinite(n) ? Math.round(n) : undefined
}

export function ConnectionSettingsForm({ value, onChange, itemId, inherited = {}, excludeHostId, showPort }: Props): React.JSX.Element {
  const { t } = useTranslation('hosts')
  const { t: tc } = useTranslation()
  const identities = useItems('identity')
  const keys = useItems('key')
  const snippets = useItems('snippet')
  const setSection = useApp((s) => s.setSection)
  const [advancedOpen, setAdvancedOpen] = useState(
    !!(value.jumpHostIds?.length || value.proxy || value.envVars?.length || value.startupSnippetId || value.agentForwarding || value.charset || value.keepAliveInterval !== undefined)
  )

  const inh = (key: keyof ConnectionSettings, display?: string): string | undefined => {
    const v = inherited[key]
    if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) return undefined
    const shown = display ?? String(v)
    const src = inherited.source?.[key]
    return src ? t('editor.inherited', { group: src, value: shown }) : t('editor.inheritedShort', { value: shown })
  }

  const identity = value.identityId ? getItem('identity', value.identityId) : undefined
  const proxy = value.proxy

  const setProxy = (patch: Partial<ProxyConfig> | null): void => {
    if (patch === null) onChange({ proxy: undefined })
    else onChange({ proxy: { type: 'socks5', host: '', port: 1080, ...(proxy ?? {}), ...patch } as ProxyConfig })
  }

  return (
    <>
      <SheetSection title={t('editor.credentials')}>
        {showPort && (
          <Field label={t('editor.port')}>
            <Input
              type="number"
              min={1}
              max={65535}
              value={value.port ?? ''}
              placeholder={inh('port') ?? '22'}
              onChange={(e) => onChange({ port: numOrUndef(e.target.value) })}
              className="w-32"
              data-testid="host-port"
            />
          </Field>
        )}
        <Field label={t('editor.identity')}>
          <Select
            value={value.identityId}
            onChange={(v) => onChange({ identityId: v })}
            allowEmpty
            emptyLabel={t('editor.noIdentity')}
            placeholder={inh('identityId', inherited.identityId ? getItem('identity', inherited.identityId)?.data.label : undefined) ?? t('editor.noIdentity')}
            options={identities.map((i) => ({ value: i.id, label: i.data.label, hint: i.data.username }))}
          />
        </Field>
        {identity ? (
          <p className="rounded-lg bg-accent-soft px-3 py-2 text-xs text-accent">{t('editor.usingIdentity', { name: identity.data.label })}</p>
        ) : (
          <>
            <Field label={t('editor.username')}>
              <Input value={value.username ?? ''} placeholder={inh('username') ?? 'root'} onChange={(e) => onChange({ username: e.target.value || undefined })} data-testid="host-username" />
            </Field>
            <Field label={t('editor.password')}>
              <SecretInput
                value={value.password}
                onChange={(v) => onChange({ password: v || undefined })}
                itemId={itemId}
                path="password"
                savedPlaceholder={t('editor.passwordSaved')}
                placeholder={inherited.password ? inh('password', '••••••') : undefined}
                testId="host-password"
              />
            </Field>
            <Field
              label={
                <span className="flex items-center justify-between">
                  {t('editor.key')}
                  <button type="button" className="text-[11px] font-normal text-accent hover:underline" onClick={() => setSection('keychain')}>
                    {t('editor.manageKeys')}
                  </button>
                </span>
              }
            >
              <Select
                value={value.keyId}
                onChange={(v) => onChange({ keyId: v })}
                allowEmpty
                emptyLabel={t('editor.noKey')}
                placeholder={inh('keyId', inherited.keyId ? getItem('key', inherited.keyId)?.data.label : undefined) ?? t('editor.noKey')}
                options={keys.map((k) => ({ value: k.id, label: k.data.label, hint: k.data.keyType }))}
              />
            </Field>
          </>
        )}
        <label className="flex items-center justify-between gap-3">
          <span>
            <span className="block text-[13px]">{t('editor.useAgent')}</span>
            <span className="block text-xs text-subtle">{t('editor.useAgentHint')}</span>
          </span>
          <Switch checked={value.useAgent ?? inherited.useAgent ?? false} onCheckedChange={(v) => onChange({ useAgent: v })} />
        </label>
      </SheetSection>

      <SheetSection>
        <button type="button" className="-my-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-subtle hover:text-fg" onClick={() => setAdvancedOpen((o) => !o)}>
          {advancedOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          {t('editor.advanced')}
        </button>
        {advancedOpen && (
          <div className="flex flex-col gap-4 pt-1">
            <Field label={t('editor.jumpHosts')} hint={t('editor.jumpHostsHint')}>
              <div className="flex flex-col gap-1.5">
                {(value.jumpHostIds ?? []).map((id, idx) => {
                  const h = getItem('host', id)
                  return (
                    <div key={`${id}-${idx}`} className="flex h-9 items-center gap-2 rounded-lg border border-line bg-input px-2">
                      <GripVertical className="size-3.5 text-subtle" />
                      <span className="w-4 text-center text-xs text-subtle">{idx + 1}</span>
                      <HostAvatar size="sm" osHint={h?.data.osHint} label={h?.data.label} />
                      <span className="min-w-0 flex-1 truncate text-[13px]">{h ? h.data.label || h.data.address : id}</span>
                      <button type="button" className="rounded p-1 text-subtle hover:text-danger" onClick={() => onChange({ jumpHostIds: (value.jumpHostIds ?? []).filter((_, i) => i !== idx) })}>
                        <X className="size-3.5" />
                      </button>
                    </div>
                  )
                })}
                {!value.jumpHostIds?.length && inherited.jumpHostIds?.length ? (
                  <p className="text-xs text-subtle">{inh('jumpHostIds', inherited.jumpHostIds.map((id) => getItem('host', id)?.data.label ?? id).join(' → '))}</p>
                ) : null}
                <HostPicker onPick={(id) => onChange({ jumpHostIds: [...(value.jumpHostIds ?? []), id] })} exclude={[...(excludeHostId ? [excludeHostId] : []), ...(value.jumpHostIds ?? [])]}>
                  <Button size="sm" variant="ghost" className="self-start">
                    <Plus />
                    {t('editor.addJumpHost')}
                  </Button>
                </HostPicker>
              </div>
            </Field>

            <Field label={t('editor.proxy')}>
              <Select
                value={proxy?.type}
                onChange={(v) => (v ? setProxy({ type: v as ProxyConfig['type'] }) : setProxy(null))}
                allowEmpty
                emptyLabel={t('editor.proxyNone')}
                placeholder={inh('proxy', inherited.proxy ? `${inherited.proxy.type} ${inherited.proxy.host}:${inherited.proxy.port}` : undefined) ?? t('editor.proxyNone')}
                options={[
                  { value: 'socks5', label: 'SOCKS5' },
                  { value: 'socks4', label: 'SOCKS4' },
                  { value: 'http', label: 'HTTP CONNECT' }
                ]}
              />
              {proxy && (
                <div className="mt-2 grid grid-cols-[1fr_96px] gap-2">
                  <Input value={proxy.host} placeholder={t('editor.proxyHost')} onChange={(e) => setProxy({ host: e.target.value })} />
                  <Input type="number" value={proxy.port} placeholder={t('editor.proxyPort')} onChange={(e) => setProxy({ port: numOrUndef(e.target.value) ?? 1080 })} />
                  <Input value={proxy.username ?? ''} placeholder={t('editor.proxyUser')} onChange={(e) => setProxy({ username: e.target.value || undefined })} />
                  <div className="col-span-2">
                    <SecretInput
                      value={proxy.password}
                      onChange={(v) => setProxy({ password: v || undefined })}
                      itemId={itemId}
                      path="proxy.password"
                      placeholder={t('editor.proxyPassword')}
                      savedPlaceholder={t('editor.passwordSaved')}
                    />
                  </div>
                </div>
              )}
            </Field>

            <label className="flex items-center justify-between gap-3">
              <span>
                <span className="block text-[13px]">{t('editor.agentForwarding')}</span>
                <span className="block text-xs text-subtle">{t('editor.agentForwardingHint')}</span>
              </span>
              <Switch checked={value.agentForwarding ?? inherited.agentForwarding ?? false} onCheckedChange={(v) => onChange({ agentForwarding: v })} />
            </label>

            <div className="grid grid-cols-2 gap-3">
              <Field label={t('editor.keepAlive')} hint={t('editor.keepAliveHint')}>
                <Input
                  type="number"
                  min={0}
                  value={value.keepAliveInterval ?? ''}
                  placeholder={inherited.keepAliveInterval !== undefined ? String(inherited.keepAliveInterval) : tc('default')}
                  onChange={(e) => onChange({ keepAliveInterval: numOrUndef(e.target.value) })}
                />
              </Field>
              <Field label={t('editor.charset')}>
                <Select
                  value={value.charset}
                  onChange={(v) => onChange({ charset: v })}
                  allowEmpty
                  emptyLabel={inherited.charset ?? 'utf-8'}
                  placeholder={inherited.charset ?? 'utf-8'}
                  options={CHARSETS.map((c) => ({ value: c, label: c.toUpperCase() }))}
                />
              </Field>
            </div>

            <Field label={t('editor.startupSnippet')}>
              <Select
                value={value.startupSnippetId}
                onChange={(v) => onChange({ startupSnippetId: v })}
                allowEmpty
                emptyLabel={t('editor.noSnippet')}
                placeholder={inh('startupSnippetId', inherited.startupSnippetId ? getItem('snippet', inherited.startupSnippetId)?.data.label : undefined) ?? t('editor.noSnippet')}
                options={snippets.map((s) => ({ value: s.id, label: s.data.label }))}
              />
            </Field>

            <Field label={t('editor.envVars')} hint={t('editor.envHint')}>
              <div className="flex flex-col gap-1.5">
                {(value.envVars ?? []).map((env, idx) => (
                  <div key={idx} className="grid grid-cols-[1fr_1fr_auto] gap-1.5">
                    <Input
                      value={env.name}
                      placeholder={t('editor.envName')}
                      className="font-mono"
                      onChange={(e) => onChange({ envVars: (value.envVars ?? []).map((x, i) => (i === idx ? { ...x, name: e.target.value } : x)) })}
                    />
                    <Input
                      value={env.value}
                      placeholder={t('editor.envValue')}
                      className="font-mono"
                      onChange={(e) => onChange({ envVars: (value.envVars ?? []).map((x, i) => (i === idx ? { ...x, value: e.target.value } : x)) })}
                    />
                    <Button size="icon" variant="ghost" onClick={() => onChange({ envVars: (value.envVars ?? []).filter((_, i) => i !== idx) })}>
                      <Trash2 />
                    </Button>
                  </div>
                ))}
                <Button size="sm" variant="ghost" className="self-start" onClick={() => onChange({ envVars: [...(value.envVars ?? []), { name: '', value: '' }] })}>
                  <Plus />
                  {t('editor.addEnv')}
                </Button>
              </div>
            </Field>
          </div>
        )}
      </SheetSection>

      <SheetSection title={t('editor.appearance')}>
        <div className="grid grid-cols-[1fr_96px] gap-3">
          <Field label={t('editor.terminalTheme')}>
            <Select
              value={value.terminalTheme}
              onChange={(v) => onChange({ terminalTheme: v })}
              allowEmpty
              emptyLabel={inherited.terminalTheme ? getTheme(inherited.terminalTheme).name : t('editor.themeDefault')}
              placeholder={t('editor.themeDefault')}
              options={TERMINAL_THEMES.map((th) => ({
                value: th.id,
                label: (
                  <span className="flex items-center gap-2">
                    <span className="flex h-3.5 w-6 overflow-hidden rounded-sm border border-line">
                      <span className="flex-1" style={{ background: th.theme.background }} />
                      <span className="flex-1" style={{ background: th.theme.blue }} />
                      <span className="flex-1" style={{ background: th.theme.green }} />
                    </span>
                    {th.name}
                  </span>
                )
              }))}
            />
          </Field>
          <Field label={t('editor.fontSize')}>
            <Input
              type="number"
              min={6}
              max={64}
              value={value.fontSize ?? ''}
              placeholder={inherited.fontSize ? String(inherited.fontSize) : tc('default')}
              onChange={(e) => onChange({ fontSize: numOrUndef(e.target.value) })}
            />
          </Field>
        </div>
      </SheetSection>
    </>
  )
}
