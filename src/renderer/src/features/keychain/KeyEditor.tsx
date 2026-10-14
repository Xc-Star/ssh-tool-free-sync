import { Copy, Download, Trash2, Upload } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { SECRET_MASK } from '@shared/schemas'
import { SecretInput } from '@/components/SecretInput'
import { Button } from '@/components/ui/button'
import { confirm, promptText } from '@/components/ui/confirm'
import { Switch } from '@/components/ui/controls'
import { Sheet, SheetSection } from '@/components/ui/dialog'
import { Field, Input, Textarea } from '@/components/ui/input'
import { Badge } from '@/components/ui/misc'
import { call, errorMessage, RpcError, vaultApi } from '@/lib/api'
import { copyText } from '@/lib/utils'
import { useItem } from '@/stores/vault'
import { ExportKeyDialog } from './ExportKeyDialog'

/** Imports key files chosen in a file dialog, asking for passphrases when needed. */
export async function importKeyFiles(t: (k: string, o?: Record<string, unknown>) => string): Promise<void> {
  const info = await call('app.info')
  const paths = await call('app.openFileDialog', { title: t('importFile'), multi: true, defaultPath: `${info.homeDir}/.ssh` })
  let imported = 0
  for (const p of paths) {
    const name = p.split(/[\\/]/).pop() ?? p
    let passphrase: string | undefined
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await call('keys.importFile', p, name, passphrase)
        imported++
        break
      } catch (err) {
        if (err instanceof RpcError && err.code === 'NEEDS_PASSPHRASE') {
          const pw = await promptText({ title: t('passphrasePrompt', { name }), password: true })
          if (pw === null) break
          passphrase = pw
          continue
        }
        toast.error(`${name}: ${errorMessage(err)}`)
        break
      }
    }
  }
  if (imported) toast.success(t('importedCount', { count: imported }))
}

export function KeyEditor({ id, onClose }: { id?: string; defaults?: Record<string, unknown>; onClose: () => void }): React.JSX.Element {
  const { t } = useTranslation('keychain')
  const { t: tc } = useTranslation()
  const existing = useItem('key', id)
  const [label, setLabel] = useState(existing?.data.label ?? '')
  const [privateKey, setPrivateKey] = useState<string>(existing?.data.privateKey ?? '')
  const [passphrase, setPassphrase] = useState<string | undefined>(existing?.data.passphrase)
  const [certificate, setCertificate] = useState(existing?.data.certificate ?? '')
  const [error, setError] = useState<string>()
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [exporting, setExporting] = useState(false)

  const mark = <T,>(fn: (v: T) => void) => (v: T): void => {
    fn(v)
    setDirty(true)
    setError(undefined)
  }

  const requestClose = async (): Promise<void> => {
    if (dirty && !(await confirm({ title: tc('unsavedTitle'), message: tc('unsaved'), confirmLabel: tc('discard'), danger: true }))) return
    onClose()
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      if (!existing) {
        if (!privateKey.trim()) {
          setError(t('editor.invalidKey'))
          return
        }
        await call('keys.import', { label: label.trim(), privateKey, passphrase: passphrase || undefined, certificate: certificate || undefined })
      } else {
        const changedKey = privateKey !== SECRET_MASK && privateKey !== existing.data.privateKey
        const changedPass = passphrase !== SECRET_MASK && passphrase !== existing.data.passphrase
        let derived = {}
        if (changedKey || changedPass) {
          const pem = changedKey ? privateKey : (await vaultApi.reveal<'key'>(existing.id))?.data.privateKey ?? ''
          const pw = passphrase === SECRET_MASK ? (await vaultApi.reveal<'key'>(existing.id))?.data.passphrase : passphrase
          const info = await call('keys.inspect', pem, pw || undefined)
          derived = { keyType: info.keyType, publicKey: info.publicKey, fingerprint: info.fingerprint }
        }
        await vaultApi.upsert(
          'key',
          {
            ...existing.data,
            ...derived,
            label: label.trim() || existing.data.label,
            privateKey,
            passphrase: passphrase || undefined,
            certificate: certificate.trim() || undefined
          },
          { id: existing.id }
        )
      }
      toast.success(tc('savedToast'))
      onClose()
    } catch (err) {
      if (err instanceof RpcError && err.code === 'NEEDS_PASSPHRASE') setError(t('editor.needsPassphrase'))
      else setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!existing) return
    if (!(await confirm({ title: tc('deleteConfirmTitle'), message: tc('deleteConfirm', { name: existing.data.label }), confirmLabel: tc('delete'), danger: true }))) return
    await vaultApi.remove([existing.id])
    onClose()
  }

  const savePrivate = async (): Promise<void> => {
    if (!existing) return
    const p = await call('app.saveFileDialog', { defaultPath: existing.data.label.replace(/[^\w.-]+/g, '_') || 'id_key' })
    if (!p) return
    await call('keys.savePrivateKey', existing.id, p)
    toast.success(t('savedTo', { path: p }))
  }

  return (
    <Sheet
      open
      onOpenChange={(o) => !o && void requestClose()}
      title={existing ? t('editor.editKey') : t('editor.newKey')}
      subtitle={existing?.data.label}
      width="w-[520px]"
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
          <Button variant="primary" onClick={() => void save()} disabled={busy} data-testid="key-save">
            {tc('save')}
          </Button>
        </>
      }
    >
      <SheetSection>
        <Field label={t('editor.label')}>
          <Input autoFocus={!existing} value={label} onChange={(e) => mark(setLabel)(e.target.value)} placeholder={t('editor.labelPlaceholder')} data-testid="key-label" />
        </Field>
        <Field label={t('editor.privateKey')} error={error}>
          {existing ? (
            <SecretInput multiline value={privateKey} onChange={mark(setPrivateKey)} itemId={existing.id} path="privateKey" savedPlaceholder={t('editor.saved')} />
          ) : (
            <Textarea
              rows={8}
              value={privateKey}
              onChange={(e) => mark(setPrivateKey)(e.target.value)}
              placeholder={t('editor.privateKeyPlaceholder')}
              className="font-mono text-xs"
              data-testid="key-private"
            />
          )}
        </Field>
        <Field label={t('editor.passphrase')}>
          <SecretInput
            value={passphrase}
            onChange={mark((v: string) => setPassphrase(v || undefined))}
            itemId={existing?.id}
            path="passphrase"
            placeholder={t('editor.passphrasePlaceholder')}
            savedPlaceholder={t('editor.saved')}
          />
        </Field>
      </SheetSection>

      {existing && (
        <SheetSection title={t('editor.publicKey')}>
          <div className="flex items-center gap-2">
            <Badge tone="accent">{existing.data.keyType || '?'}</Badge>
            <span className="selectable min-w-0 flex-1 truncate font-mono text-xs text-muted" title={existing.data.fingerprint}>
              {existing.data.fingerprint}
            </span>
          </div>
          <div className="relative">
            <Textarea readOnly rows={4} value={existing.data.publicKey} className="selectable resize-none pr-10 font-mono text-[11px] text-muted" />
            <button
              className="absolute right-2 top-2 rounded p-1 text-subtle hover:text-fg"
              onClick={() => void copyText(existing.data.publicKey).then(() => toast.success(t('publicKeyCopied')))}
            >
              <Copy className="size-3.5" />
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => setExporting(true)}>
              <Upload />
              {t('exportToHost')}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => void savePrivate()}>
              <Download />
              {t('savePrivateKey')}
            </Button>
          </div>
        </SheetSection>
      )}

      <SheetSection title={t('editor.certificate')}>
        <Field hint={t('editor.certificateHint')}>
          <Textarea rows={3} value={certificate} onChange={(e) => mark(setCertificate)(e.target.value)} className="font-mono text-[11px]" placeholder="ssh-ed25519-cert-v01@openssh.com AAAA…" />
        </Field>
      </SheetSection>

      {existing && (
        <SheetSection>
          <label className="flex items-center justify-between gap-3">
            <span>
              <span className="block text-[13px]">{t('deviceOnly')}</span>
              <span className="block text-xs text-subtle">{t('deviceOnlyHint')}</span>
            </span>
            <Switch
              checked={existing.localOnly}
              onCheckedChange={(v) => void call('vault.setLocalOnly', existing.id, v).catch((err) => toast.error(errorMessage(err)))}
              data-testid="key-device-only"
            />
          </label>
        </SheetSection>
      )}
      {exporting && existing && <ExportKeyDialog keyId={existing.id} onClose={() => setExporting(false)} />}
    </Sheet>
  )
}
