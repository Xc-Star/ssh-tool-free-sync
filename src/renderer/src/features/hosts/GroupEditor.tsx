import { Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { GroupData } from '@shared/schemas'
import { Button } from '@/components/ui/button'
import { confirm } from '@/components/ui/confirm'
import { Select } from '@/components/ui/controls'
import { Sheet, SheetSection } from '@/components/ui/dialog'
import { Field, Input } from '@/components/ui/input'
import { errorMessage, vaultApi } from '@/lib/api'
import { useUi } from '@/stores/ui'
import { useItem, useItems } from '@/stores/vault'
import { ConnectionSettingsForm } from './ConnectionSettingsForm'
import { cleanSettings } from './HostEditor'
import { descendantGroupIds, groupLabel, inheritedSettings } from './utils'

export function GroupEditor({ id, defaults, onClose }: { id?: string; defaults?: Record<string, unknown>; onClose: () => void }): React.JSX.Element {
  const { t } = useTranslation('hosts')
  const { t: tc } = useTranslation()
  const existing = useItem('group', id)
  const groups = useItems('group')
  const [form, setForm] = useState<Partial<GroupData> & { name: string }>(() =>
    existing ? structuredClone(existing.data) : { name: '', parentId: useUi.getState().hostsGroupId, ...(defaults ?? {}) }
  )
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState<string>()
  // `groups` is a dependency on purpose: inheritedSettings() reads groups from the store.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const inherited = useMemo(() => inheritedSettings(form.parentId), [form.parentId, groups])

  const update = (patch: Partial<GroupData>): void => {
    setForm((f) => ({ ...f, ...patch }))
    setDirty(true)
    setError(undefined)
  }

  const requestClose = async (): Promise<void> => {
    if (dirty && !(await confirm({ title: tc('unsavedTitle'), message: tc('unsaved'), confirmLabel: tc('discard'), danger: true }))) return
    onClose()
  }

  const save = async (): Promise<void> => {
    if (!form.name.trim()) {
      setError(t('editor.required'))
      return
    }
    try {
      await vaultApi.upsert('group', cleanSettings({ ...form, name: form.name.trim() }) as GroupData, { id })
      toast.success(tc('savedToast'))
      onClose()
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  const remove = async (): Promise<void> => {
    if (!id) return
    if (!(await confirm({ title: tc('deleteConfirmTitle'), message: t('deleteGroupConfirm', { name: form.name }), confirmLabel: tc('delete'), danger: true }))) return
    await vaultApi.remove([id])
    if (useUi.getState().hostsGroupId === id) useUi.setState({ hostsGroupId: existing?.data.parentId })
    onClose()
  }

  // A group cannot become its own descendant.
  const blocked = id ? descendantGroupIds(id, groups) : new Set<string>()
  const parentOptions = groups
    .filter((g) => !blocked.has(g.id))
    .map((g) => ({ value: g.id, label: groupLabel(g.id) }))
    .sort((a, b) => a.label.localeCompare(b.label))

  return (
    <Sheet
      open
      onOpenChange={(o) => !o && void requestClose()}
      title={existing ? t('group.editGroup') : t('group.newGroup')}
      subtitle={existing?.data.name}
      footer={
        <>
          {existing && (
            <Button variant="danger-ghost" size="icon" onClick={() => void remove()} title={t('group.deleteGroup')}>
              <Trash2 />
            </Button>
          )}
          <div className="flex-1" />
          <Button variant="ghost" onClick={() => void requestClose()}>
            {tc('cancel')}
          </Button>
          <Button variant="primary" onClick={() => void save()} data-testid="group-save">
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
          <Field label={t('group.name')} error={error}>
            <Input autoFocus={!existing} value={form.name} placeholder={t('group.namePlaceholder')} onChange={(e) => update({ name: e.target.value })} data-testid="group-name" />
          </Field>
          <Field label={t('group.parent')}>
            <Select value={form.parentId} onChange={(v) => update({ parentId: v })} allowEmpty emptyLabel={t('group.noParent')} placeholder={t('group.noParent')} options={parentOptions} />
          </Field>
        </SheetSection>
        <div className="px-4 pt-4">
          <h3 className="text-[13px] font-semibold">{t('group.defaults')}</h3>
          <p className="mt-0.5 text-xs text-subtle">{t('group.defaultsHint')}</p>
        </div>
        <ConnectionSettingsForm value={form} onChange={update} itemId={id} inherited={inherited} showPort />
        <button type="submit" className="hidden" />
      </form>
    </Sheet>
  )
}
