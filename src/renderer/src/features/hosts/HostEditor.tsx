import { Plug, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { HostData } from '@shared/schemas'
import { Button } from '@/components/ui/button'
import { confirm } from '@/components/ui/confirm'
import { Select, Switch } from '@/components/ui/controls'
import { Sheet, SheetSection } from '@/components/ui/dialog'
import { Field, Input, Textarea } from '@/components/ui/input'
import { errorMessage, vaultApi } from '@/lib/api'
import { openHost } from '@/stores/tabs'
import { useUi } from '@/stores/ui'
import { useItem, useItems } from '@/stores/vault'
import { ConnectionSettingsForm } from './ConnectionSettingsForm'
import { TagInput } from './TagInput'
import { groupLabel, inheritedSettings } from './utils'

type HostForm = Partial<HostData> & { address: string; tagIds: string[] }

/** Removes empty optional values so stored items stay clean. */
export function cleanSettings<T extends Record<string, unknown>>(data: T): T {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === '') continue
    if (k === 'envVars' && Array.isArray(v)) {
      const envs = (v as { name: string; value: string }[]).filter((e) => e.name.trim())
      if (envs.length) out[k] = envs.map((e) => ({ name: e.name.trim(), value: e.value }))
      continue
    }
    if (k === 'proxy' && v && typeof v === 'object' && !(v as { host?: string }).host) continue
    if (k === 'jumpHostIds' && Array.isArray(v) && !v.length) continue
    out[k] = v
  }
  return out as T
}

export function HostEditor({ id, defaults, onClose }: { id?: string; defaults?: Record<string, unknown>; onClose: () => void }): React.JSX.Element {
  const { t } = useTranslation('hosts')
  const { t: tc } = useTranslation()
  const existing = useItem('host', id)
  const groups = useItems('group')
  const [form, setForm] = useState<HostForm>(() =>
    existing
      ? (structuredClone(existing.data) as HostForm)
      : ({ address: '', label: '', tagIds: [], sshEnabled: true, telnetEnabled: false, groupId: useUi.getState().hostsGroupId, ...(defaults ?? {}) } as HostForm)
  )
  const [dirty, setDirty] = useState(false)
  const [errors, setErrors] = useState<{ address?: string; port?: string }>({})
  const [saving, setSaving] = useState(false)
  // `groups` is a dependency on purpose: inheritedSettings() reads groups from the store.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const inherited = useMemo(() => inheritedSettings(form.groupId), [form.groupId, groups])

  const update = (patch: Partial<HostForm>): void => {
    setForm((f) => ({ ...f, ...patch }))
    setDirty(true)
    if ('address' in patch || 'port' in patch) setErrors({})
  }

  const requestClose = async (): Promise<void> => {
    if (dirty && !(await confirm({ title: tc('unsavedTitle'), message: tc('unsaved'), confirmLabel: tc('discard'), danger: true }))) return
    onClose()
  }

  const validate = (): boolean => {
    const e: typeof errors = {}
    const addr = form.address.trim()
    if (!addr || /\s/.test(addr)) e.address = t('editor.invalidAddress')
    if (form.port !== undefined && (form.port < 1 || form.port > 65535)) e.port = t('editor.invalidPort')
    if (form.telnetPort !== undefined && (form.telnetPort < 1 || form.telnetPort > 65535)) e.port = t('editor.invalidPort')
    setErrors(e)
    return !Object.keys(e).length
  }

  const save = async (connect = false): Promise<void> => {
    if (!validate()) return
    setSaving(true)
    try {
      const data = cleanSettings({ ...form, address: form.address.trim(), label: (form.label ?? '').trim() }) as HostData
      const saved = await vaultApi.upsert('host', data, { id })
      toast.success(tc('savedToast'))
      onClose()
      if (connect) void openHost(saved.id, saved.data.sshEnabled === false && saved.data.telnetEnabled ? 'telnet' : 'ssh')
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!id) return
    const name = form.label || form.address
    if (!(await confirm({ title: tc('deleteConfirmTitle'), message: tc('deleteConfirm', { name }), confirmLabel: tc('delete'), danger: true }))) return
    await vaultApi.remove([id])
    toast.success(tc('deletedToast'))
    onClose()
  }

  const groupOptions = groups
    .map((g) => ({ value: g.id, label: groupLabel(g.id) }))
    .sort((a, b) => a.label.localeCompare(b.label))

  return (
    <Sheet
      open
      onOpenChange={(o) => !o && void requestClose()}
      title={existing ? t('editor.editHost') : t('editor.newHost')}
      subtitle={existing ? existing.data.label || existing.data.address : undefined}
      footer={
        <>
          {existing && (
            <Button variant="danger-ghost" size="icon" onClick={() => void remove()} title={t('editor.deleteHost')}>
              <Trash2 />
            </Button>
          )}
          <div className="flex-1" />
          <Button variant="ghost" onClick={() => void requestClose()}>
            {tc('cancel')}
          </Button>
          <Button variant="secondary" onClick={() => void save(true)} disabled={saving}>
            <Plug />
            {t('editor.saveAndConnect')}
          </Button>
          <Button variant="primary" onClick={() => void save(false)} disabled={saving} data-testid="host-save">
            {tc('save')}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void save(false)
        }}
      >
        <SheetSection>
          <Field label={t('editor.address')} error={errors.address}>
            <Input
              autoFocus={!existing}
              value={form.address}
              placeholder={t('editor.addressPlaceholder')}
              onChange={(e) => update({ address: e.target.value })}
              className="h-10 text-[14px]"
              data-testid="host-address"
            />
          </Field>
          <Field label={t('editor.label')}>
            <Input value={form.label ?? ''} placeholder={t('editor.labelPlaceholder')} onChange={(e) => update({ label: e.target.value })} data-testid="host-label" />
          </Field>
        </SheetSection>

        <SheetSection title={t('editor.general')}>
          <Field label={t('editor.group')}>
            <Select value={form.groupId} onChange={(v) => update({ groupId: v })} allowEmpty emptyLabel={t('editor.noGroup')} placeholder={t('editor.noGroup')} options={groupOptions} />
          </Field>
          <Field label={t('editor.tags')}>
            <TagInput value={form.tagIds} onChange={(tagIds) => update({ tagIds })} />
          </Field>
        </SheetSection>

        <SheetSection
          title={t('editor.ssh')}
          right={<Switch checked={form.sshEnabled !== false} onCheckedChange={(v) => update({ sshEnabled: v })} aria-label={t('editor.enableSsh')} />}
        >
          {form.sshEnabled === false && <p className="text-xs text-subtle">{tc('disabled')}</p>}
        </SheetSection>
        {form.sshEnabled !== false && (
          <ConnectionSettingsForm value={form} onChange={(p) => update(p as Partial<HostForm>)} itemId={id} inherited={inherited} excludeHostId={id} showPort />
        )}

        <SheetSection
          title={t('editor.telnet')}
          right={<Switch checked={!!form.telnetEnabled} onCheckedChange={(v) => update({ telnetEnabled: v })} aria-label={t('editor.enableTelnet')} />}
        >
          {form.telnetEnabled && (
            <Field label={t('editor.telnetPort')} error={errors.port}>
              <Input
                type="number"
                className="w-32"
                value={form.telnetPort ?? ''}
                placeholder="23"
                onChange={(e) => update({ telnetPort: e.target.value ? Number(e.target.value) : undefined })}
              />
            </Field>
          )}
        </SheetSection>

        <SheetSection title={t('editor.notes')}>
          <Textarea rows={3} value={form.notes ?? ''} onChange={(e) => update({ notes: e.target.value || undefined })} />
        </SheetSection>
        <button type="submit" className="hidden" />
      </form>
    </Sheet>
  )
}
