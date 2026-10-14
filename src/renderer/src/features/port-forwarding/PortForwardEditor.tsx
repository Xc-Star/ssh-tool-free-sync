import { Globe, Laptop, Server, TriangleAlert } from 'lucide-react'
import { type ReactNode, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { KindInput } from '@shared/schemas'
import { Button } from '@/components/ui/button'
import { confirm } from '@/components/ui/confirm'
import { Switch } from '@/components/ui/controls'
import { Sheet, SheetSection } from '@/components/ui/dialog'
import { Field, Input, Label } from '@/components/ui/input'
import { Badge, Segmented, Spinner } from '@/components/ui/misc'
import { call, errorMessage, isMac, vaultApi } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useApp } from '@/stores/app'
import { getItem, useItems } from '@/stores/vault'
import { ForwardDiagram } from './ForwardDiagram'
import { DEFAULT_BIND_ADDRESS, type ForwardType, isExposedAddress, useForwardFormat } from './format'
import { HostPicker } from './HostPicker'

interface FormState {
  type: ForwardType
  hostId: string
  label: string
  bindAddress: string
  bindPort: string
  destHost: string
  destPort: string
  autoStart: boolean
}

type FormErrors = Partial<Record<'hostId' | 'bindPort' | 'destHost' | 'destPort', string>>

const FIELD_IDS: Record<keyof FormErrors, string> = {
  hostId: 'pf-host',
  bindPort: 'pf-bind-port',
  destHost: 'pf-dest-host',
  destPort: 'pf-dest-port'
}

const PORT_PLACEHOLDER: Record<ForwardType, { bind: string; dest: string }> = {
  local: { bind: '8080', dest: '80' },
  remote: { bind: '9000', dest: '3000' },
  dynamic: { bind: '1080', dest: '' }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function portStr(v: unknown): string {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return typeof v === 'string' ? v.replace(/\D/g, '').slice(0, 5) : ''
}

function isForwardType(v: unknown): v is ForwardType {
  return v === 'local' || v === 'remote' || v === 'dynamic'
}

function initialForm(id: string | undefined, defaults: Record<string, unknown> | undefined): FormState {
  const src: Record<string, unknown> = (id ? getItem('portForward', id)?.data : undefined) ?? defaults ?? {}
  return {
    type: isForwardType(src.type) ? src.type : 'local',
    hostId: str(src.hostId) ?? '',
    label: str(src.label) ?? '',
    bindAddress: str(src.bindAddress) ?? DEFAULT_BIND_ADDRESS,
    bindPort: portStr(src.bindPort),
    destHost: str(src.destHost) ?? '',
    destPort: portStr(src.destPort),
    autoStart: src.autoStart === true
  }
}

function validPort(s: string): boolean {
  const n = Number(s)
  return /^\d+$/.test(s) && n >= 1 && n <= 65535
}

function Required({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <>
      {children}
      <span className="ml-0.5 text-danger">*</span>
    </>
  )
}

const invalidInput = 'border-danger focus:border-danger focus:ring-danger/20'

export function PortForwardEditor({
  id,
  defaults,
  onClose
}: {
  id?: string
  defaults?: Record<string, unknown>
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation('forwarding')
  const { t: tc } = useTranslation()
  const fmt = useForwardFormat()
  const hosts = useItems('host')
  const [initial] = useState(() => initialForm(id, defaults))
  const [existingTitle] = useState(() => {
    const item = id ? getItem('portForward', id) : undefined
    return item ? fmt.title(item.data) : undefined
  })
  const isEdit = existingTitle !== undefined
  const [form, setForm] = useState(initial)
  const [submitted, setSubmitted] = useState(false)
  const [saving, setSaving] = useState(false)
  const runState = useApp((s) => (id ? s.forwards[id] : undefined))
  const bodyRef = useRef<HTMLDivElement>(null)

  const set = <K extends keyof FormState>(key: K, value: FormState[K]): void =>
    setForm((f) => ({ ...f, [key]: value }))
  const host = hosts.find((h) => h.id === form.hostId)
  const dirty = JSON.stringify(form) !== JSON.stringify(initial)

  const errors = useMemo<FormErrors>(() => {
    const e: FormErrors = {}
    if (!form.hostId || !host) e.hostId = t('errors.host')
    if (!validPort(form.bindPort)) e.bindPort = t('errors.port')
    if (form.type !== 'dynamic') {
      if (!form.destHost.trim()) e.destHost = t('errors.destHost')
      if (!validPort(form.destPort)) e.destPort = t('errors.port')
    }
    return e
  }, [form, host, t])
  const shown: FormErrors = submitted ? errors : {}

  const bindAddress = form.bindAddress.trim() || DEFAULT_BIND_ADDRESS
  const destHost = form.destHost.trim()
  const fallbackLabel = validPort(form.bindPort)
    ? fmt.fallback({
        type: form.type,
        bindAddress,
        bindPort: Number(form.bindPort),
        destHost,
        destPort: Number(form.destPort) || undefined
      })
    : undefined
  const exposed = isExposedAddress(bindAddress)
  const running = runState?.status === 'running' || runState?.status === 'starting'

  const requestClose = async (): Promise<void> => {
    if (dirty && !saving) {
      const ok = await confirm({
        title: tc('unsavedTitle'),
        message: tc('unsaved'),
        confirmLabel: tc('discard'),
        danger: true
      })
      if (!ok) return
    }
    onClose()
  }

  const save = async (): Promise<void> => {
    if (saving) return
    setSubmitted(true)
    const firstInvalid = (['hostId', 'bindPort', 'destHost', 'destPort'] as const).find((k) => errors[k])
    if (firstInvalid) {
      const el = document.getElementById(FIELD_IDS[firstInvalid])
      el?.scrollIntoView({ block: 'nearest' })
      el?.focus()
      return
    }
    setSaving(true)
    try {
      const data: KindInput['portForward'] = {
        label: form.label.trim(),
        type: form.type,
        hostId: form.hostId,
        bindAddress,
        bindPort: Number(form.bindPort),
        autoStart: form.autoStart,
        ...(form.type === 'dynamic' ? {} : { destHost, destPort: Number(form.destPort) })
      }
      const item = await vaultApi.upsert('portForward', data, id ? { id } : undefined)
      const status = useApp.getState().forwards[item.id]?.status
      onClose()
      if (status === 'running' || status === 'starting') {
        // Restart in the background so the drawer closes right away (reconnecting may take a while).
        try {
          await call('forward.stop', item.id)
          await call('forward.start', item.id)
          toast.success(t('restarted'))
        } catch (err) {
          toast.error(t('restartFailed'), { description: errorMessage(err) })
        }
      } else {
        toast.success(tc('savedToast'))
      }
    } catch (err) {
      toast.error(tc('errorTitle'), { description: errorMessage(err) })
      setSaving(false)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.defaultPrevented || e.nativeEvent.isComposing) return
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault()
      void save()
      return
    }
    const target = e.target as HTMLElement
    if (e.key === 'Enter' && target.tagName === 'INPUT' && bodyRef.current?.contains(target)) {
      e.preventDefault()
      void save()
    }
  }

  const listenTitle =
    form.type === 'local'
      ? t('sectionListenLocal')
      : form.type === 'remote'
        ? t('sectionListenRemote')
        : t('sectionListenSocks')

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) void requestClose()
      }}
      title={isEdit ? t('editTitle') : t('newTitle')}
      subtitle={existingTitle}
      width="w-[480px]"
      actions={
        runState && runState.status !== 'stopped' ? (
          <Badge
            tone={
              runState.status === 'running' ? 'success' : runState.status === 'error' ? 'danger' : 'accent'
            }
          >
            {runState.status === 'starting' ? (
              <Spinner className="size-3 text-accent" />
            ) : (
              <span className="size-1.5 rounded-full bg-current" />
            )}
            {t(`status.${runState.status}`)}
          </Badge>
        ) : undefined
      }
      footer={
        <>
          {running && <span className="truncate text-xs text-muted">{t('restartHint')}</span>}
          <div className="flex-1" />
          <Button variant="ghost" onClick={() => void requestClose()}>
            {tc('cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void save()}
            disabled={saving}
            title={isMac ? '⌘S' : 'Ctrl+S'}
            data-testid="forward-save"
          >
            {saving && <Spinner className="size-3.5 text-white" />}
            {tc('save')}
          </Button>
        </>
      }
    >
      <div ref={bodyRef} onKeyDown={onKeyDown} data-testid="forward-editor">
        <SheetSection title={t('sectionType')}>
          <Segmented
            value={form.type}
            onChange={(v) => set('type', v)}
            className="flex w-full [&>button]:flex-1"
            options={[
              { value: 'local', label: t('types.local'), icon: <Laptop /> },
              { value: 'remote', label: t('types.remote'), icon: <Server /> },
              { value: 'dynamic', label: t('types.dynamic'), icon: <Globe /> }
            ]}
          />
          <p className="text-xs leading-relaxed text-muted">{t(`typeHint.${form.type}`)}</p>
          <ForwardDiagram
            type={form.type}
            host={host}
            bind={{ host: bindAddress, port: form.bindPort }}
            dest={{ host: destHost, port: form.destPort }}
          />
        </SheetSection>

        <SheetSection title={t('sectionGeneral')}>
          <Field label={<Required>{t('host')}</Required>} error={shown.hostId} htmlFor="pf-host">
            <HostPicker
              id="pf-host"
              value={form.hostId}
              onChange={(v) => set('hostId', v)}
              invalid={!!shown.hostId}
              testId="forward-host"
            />
          </Field>
          <Field label={t('label')} hint={t('labelHint')} htmlFor="pf-label">
            <Input
              id="pf-label"
              value={form.label}
              onChange={(e) => set('label', e.target.value)}
              placeholder={fallbackLabel ?? t('labelPlaceholder')}
              maxLength={255}
              data-testid="forward-label"
            />
          </Field>
        </SheetSection>

        <SheetSection title={listenTitle}>
          <div className="grid grid-cols-[1fr_112px] gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pf-bind-address">{t('bindAddress')}</Label>
              <Input
                id="pf-bind-address"
                value={form.bindAddress}
                onChange={(e) => set('bindAddress', e.target.value)}
                placeholder={DEFAULT_BIND_ADDRESS}
                className="font-mono"
                maxLength={255}
                data-testid="forward-bind-address"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pf-bind-port">
                <Required>{t('bindPort')}</Required>
              </Label>
              <Input
                id="pf-bind-port"
                value={form.bindPort}
                onChange={(e) => set('bindPort', portStr(e.target.value))}
                placeholder={PORT_PLACEHOLDER[form.type].bind}
                inputMode="numeric"
                aria-invalid={!!shown.bindPort || undefined}
                className={cn('font-mono', shown.bindPort && invalidInput)}
                data-testid="forward-bind-port"
              />
            </div>
          </div>
          {shown.bindPort && <p className="-mt-1 text-xs text-danger">{shown.bindPort}</p>}
          {exposed ? (
            <div className="flex items-start gap-2 rounded-md bg-warning/10 px-2.5 py-2 text-xs leading-relaxed text-warning">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              <span>{t('bindExposed')}</span>
            </div>
          ) : (
            <p className="text-xs leading-relaxed text-subtle">
              {form.type === 'remote' ? t('bindHintRemote') : t('bindHintLocal')}
            </p>
          )}
        </SheetSection>

        {form.type !== 'dynamic' && (
          <SheetSection title={t('sectionDestination')}>
            <div className="grid grid-cols-[1fr_112px] gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="pf-dest-host">
                  <Required>{t('destHost')}</Required>
                </Label>
                <Input
                  id="pf-dest-host"
                  value={form.destHost}
                  onChange={(e) => set('destHost', e.target.value)}
                  placeholder="127.0.0.1"
                  aria-invalid={!!shown.destHost || undefined}
                  className={cn('font-mono', shown.destHost && invalidInput)}
                  maxLength={255}
                  data-testid="forward-dest-host"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="pf-dest-port">
                  <Required>{t('destPort')}</Required>
                </Label>
                <Input
                  id="pf-dest-port"
                  value={form.destPort}
                  onChange={(e) => set('destPort', portStr(e.target.value))}
                  placeholder={PORT_PLACEHOLDER[form.type].dest}
                  inputMode="numeric"
                  aria-invalid={!!shown.destPort || undefined}
                  className={cn('font-mono', shown.destPort && invalidInput)}
                  data-testid="forward-dest-port"
                />
              </div>
            </div>
            {(shown.destHost || shown.destPort) && (
              <p className="-mt-1 text-xs text-danger">{shown.destHost ?? shown.destPort}</p>
            )}
            <p className="text-xs leading-relaxed text-subtle">
              {form.type === 'remote' ? t('destHintRemote') : t('destHintLocal')}
            </p>
          </SheetSection>
        )}

        <SheetSection title={t('sectionOptions')}>
          <label className="flex cursor-default items-center justify-between gap-4">
            <span className="min-w-0">
              <span className="block text-[13px] font-medium">{t('autoStartLabel')}</span>
              <span className="block text-xs text-muted">{t('autoStartHint')}</span>
            </span>
            <Switch
              checked={form.autoStart}
              onCheckedChange={(v) => set('autoStart', v)}
              data-testid="forward-autostart"
            />
          </label>
        </SheetSection>
      </div>
    </Sheet>
  )
}
