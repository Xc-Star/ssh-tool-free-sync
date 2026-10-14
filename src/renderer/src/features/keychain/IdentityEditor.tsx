import { Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { IdentityData } from '@shared/schemas'
import { SecretInput } from '@/components/SecretInput'
import { Button } from '@/components/ui/button'
import { confirm } from '@/components/ui/confirm'
import { Select } from '@/components/ui/controls'
import { Sheet, SheetSection } from '@/components/ui/dialog'
import { Field, Input } from '@/components/ui/input'
import { errorMessage, vaultApi } from '@/lib/api'
import { useItem, useItems } from '@/stores/vault'

export function IdentityEditor({ id, onClose }: { id?: string; defaults?: Record<string, unknown>; onClose: () => void }): React.JSX.Element {
  const { t } = useTranslation('keychain')
  const { t: tc } = useTranslation()
  const existing = useItem('identity', id)
  const keys = useItems('key')
  const [form, setForm] = useState<Partial<IdentityData> & { label: string }>(() => (existing ? structuredClone(existing.data) : { label: '', username: '' }))
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState<string>()

  const update = (patch: Partial<IdentityData>): void => {
    setForm((f) => ({ ...f, ...patch }))
    setDirty(true)
    setError(undefined)
  }

  const requestClose = async (): Promise<void> => {
    if (dirty && !(await confirm({ title: tc('unsavedTitle'), message: tc('unsaved'), confirmLabel: tc('discard'), danger: true }))) return
    onClose()
  }

  const save = async (): Promise<void> => {
    const label = form.label.trim() || form.username?.trim()
    if (!label) {
      setError(tc('required'))
      return
    }
    try {
      await vaultApi.upsert('identity', { ...form, label, password: form.password || undefined, keyId: form.keyId || undefined }, { id })
      toast.success(tc('savedToast'))
      onClose()
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  const remove = async (): Promise<void> => {
    if (!existing) return
    if (!(await confirm({ title: tc('deleteConfirmTitle'), message: tc('deleteConfirm', { name: existing.data.label }), confirmLabel: tc('delete'), danger: true }))) return
    await vaultApi.remove([existing.id])
    onClose()
  }

  return (
    <Sheet
      open
      onOpenChange={(o) => !o && void requestClose()}
      title={existing ? t('identity.editIdentity') : t('identity.newIdentity')}
      subtitle={existing?.data.label}
      footer={
        <>
          {existing && (
            <Button variant="danger-ghost" size="icon" onClick={() => void remove()}>
              <Trash2 />
            </Button>
          )}
          <div className="flex-1" />
          <Button variant="ghost" onClick={() => void requestClose()}>
            {tc('cancel')}
          </Button>
          <Button variant="primary" onClick={() => void save()} data-testid="identity-save">
            {tc('save')}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <SheetSection>
          <Field label={t('identity.label')} error={error}>
            <Input autoFocus={!existing} value={form.label} onChange={(e) => update({ label: e.target.value })} placeholder={t('identity.labelPlaceholder')} />
          </Field>
          <Field label={t('identity.username')}>
            <Input value={form.username ?? ''} onChange={(e) => update({ username: e.target.value })} placeholder="root" />
          </Field>
          <Field label={t('identity.password')}>
            <SecretInput value={form.password} onChange={(v) => update({ password: v || undefined })} itemId={id} path="password" savedPlaceholder={t('editor.saved')} />
          </Field>
          <Field label={t('identity.key')}>
            <Select
              value={form.keyId}
              onChange={(v) => update({ keyId: v })}
              allowEmpty
              emptyLabel={t('identity.noKey')}
              placeholder={t('identity.noKey')}
              options={keys.map((k) => ({ value: k.id, label: k.data.label, hint: k.data.keyType }))}
            />
          </Field>
        </SheetSection>
        <button type="submit" className="hidden" />
      </form>
    </Sheet>
  )
}
