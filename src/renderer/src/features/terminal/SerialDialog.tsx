import { RefreshCw, Trash2, Usb } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { SerialProfileData } from '@shared/schemas'
import type { SerialPortInfo } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Checkbox, Select, Switch } from '@/components/ui/controls'
import { Dialog, DialogBody, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { Field, Input } from '@/components/ui/input'
import { call, errorMessage, vaultApi } from '@/lib/api'
import { openTab } from '@/stores/tabs'
import { useUi } from '@/stores/ui'
import { useItems } from '@/stores/vault'

const BAUD = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1500000]

export function SerialDialog(): React.JSX.Element | null {
  const open = useUi((s) => s.serialDialogOpen)
  if (!open) return null
  return <SerialDialogInner />
}

function SerialDialogInner(): React.JSX.Element {
  const { t } = useTranslation('terminal')
  const { t: tc } = useTranslation()
  const profiles = useItems('serialProfile')
  const [ports, setPorts] = useState<SerialPortInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState<SerialProfileData | null>(null)
  const [save, setSave] = useState(false)
  const [error, setError] = useState<string>()

  const close = (): void => useUi.setState({ serialDialogOpen: false })

  const refresh = async (): Promise<void> => {
    setLoading(true)
    try {
      const list = await call('session.serialPorts')
      setPorts(list)
      setForm((f) => (f && !f.path && list[0] ? { ...f, path: list[0].path } : f))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void call('serial.defaultProfile').then((p) => setForm(p))
    void refresh()
  }, [])

  if (!form) return <></>
  const update = (patch: Partial<SerialProfileData>): void => setForm({ ...form, ...patch })

  const connect = async (): Promise<void> => {
    if (!form.path.trim()) return
    try {
      const profile = { ...form, label: form.label.trim() || form.path }
      if (save) {
        const saved = await vaultApi.upsert('serialProfile', profile)
        await openTab({ kind: 'serial', profileId: saved.id })
      } else {
        await openTab({ kind: 'serial', inline: profile })
      }
      close()
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent
        title={
          <span className="flex items-center gap-2">
            <Usb className="size-4 text-accent" />
            {t('serialTitle')}
          </span>
        }
        width="max-w-lg"
      >
        <DialogBody className="flex flex-col gap-4">
          {profiles.length > 0 && (
            <div>
              <div className="mb-1.5 text-xs font-medium text-muted">{t('savedProfiles')}</div>
              <div className="flex flex-col gap-1">
                {profiles.map((p) => (
                  <div key={p.id} className="group flex h-9 items-center gap-2 rounded-lg border border-line bg-panel px-2.5">
                    <Usb className="size-4 text-subtle" />
                    <button
                      className="min-w-0 flex-1 truncate text-left text-[13px]"
                      onClick={() => {
                        void openTab({ kind: 'serial', profileId: p.id })
                        close()
                      }}
                    >
                      {p.data.label} <span className="text-xs text-subtle">({p.data.path} · {p.data.baudRate})</span>
                    </button>
                    <button className="hidden rounded p-1 text-subtle hover:text-danger group-hover:block" onClick={() => void vaultApi.remove([p.id])}>
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
          <Field
            label={
              <span className="flex items-center justify-between">
                {t('serialPort')}
                <button className="flex items-center gap-1 text-[11px] font-normal text-accent" onClick={() => void refresh()}>
                  <RefreshCw className={loading ? 'size-3 animate-spin' : 'size-3'} />
                  {t('refreshPorts')}
                </button>
              </span>
            }
            hint={ports.length === 0 && !loading ? t('noPorts') : undefined}
            error={error}
          >
            <div className="grid grid-cols-[1fr_1fr] gap-2">
              <Select
                value={ports.some((p) => p.path === form.path) ? form.path : undefined}
                onChange={(v) => v && update({ path: v })}
                placeholder="—"
                options={ports.map((p) => ({ value: p.path, label: p.path, hint: p.manufacturer }))}
              />
              <Input value={form.path} onChange={(e) => update({ path: e.target.value })} className="font-mono" />
            </div>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('baudRate')}>
              <Select value={String(form.baudRate)} onChange={(v) => v && update({ baudRate: Number(v) })} options={BAUD.map((b) => ({ value: String(b), label: String(b) }))} />
            </Field>
            <Field label={t('dataBits')}>
              <Select value={String(form.dataBits)} onChange={(v) => v && update({ dataBits: Number(v) as 5 | 6 | 7 | 8 })} options={[5, 6, 7, 8].map((b) => ({ value: String(b), label: String(b) }))} />
            </Field>
            <Field label={t('stopBits')}>
              <Select value={String(form.stopBits)} onChange={(v) => v && update({ stopBits: Number(v) as 1 | 1.5 | 2 })} options={[1, 1.5, 2].map((b) => ({ value: String(b), label: String(b) }))} />
            </Field>
            <Field label={t('parity')}>
              <Select
                value={form.parity}
                onChange={(v) => v && update({ parity: v as SerialProfileData['parity'] })}
                options={['none', 'even', 'odd', 'mark', 'space'].map((p) => ({ value: p, label: p }))}
              />
            </Field>
            <Field label={t('flowControl')}>
              <Select
                value={form.flowControl}
                onChange={(v) => v && update({ flowControl: v as SerialProfileData['flowControl'] })}
                options={[
                  { value: 'none', label: 'none' },
                  { value: 'hardware', label: 'RTS/CTS' },
                  { value: 'software', label: 'XON/XOFF' }
                ]}
              />
            </Field>
            <Field label={t('lineEnding')}>
              <Select
                value={form.lineEnding}
                onChange={(v) => v && update({ lineEnding: v as SerialProfileData['lineEnding'] })}
                options={[
                  { value: 'cr', label: 'CR' },
                  { value: 'lf', label: 'LF' },
                  { value: 'crlf', label: 'CR+LF' }
                ]}
              />
            </Field>
          </div>
          <label className="flex items-center justify-between">
            <span className="text-[13px]">{t('localEcho')}</span>
            <Switch checked={form.localEcho} onCheckedChange={(v) => update({ localEcho: v })} />
          </label>
          <div className="flex items-center gap-3">
            <label className="flex shrink-0 items-center gap-2 text-[13px]">
              <Checkbox checked={save} onCheckedChange={(v) => setSave(v === true)} />
              {t('saveProfile')}
            </label>
            {save && <Input value={form.label === 'Serial' ? '' : form.label} placeholder={t('profileName')} onChange={(e) => update({ label: e.target.value })} />}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            {tc('cancel')}
          </Button>
          <Button variant="primary" onClick={() => void connect()} disabled={!form.path.trim()}>
            {t('open')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
