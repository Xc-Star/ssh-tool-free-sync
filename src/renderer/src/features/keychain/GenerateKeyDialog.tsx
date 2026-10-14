import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogBody, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { Field, Input, PasswordInput } from '@/components/ui/input'
import { Segmented } from '@/components/ui/misc'
import { call, errorMessage } from '@/lib/api'
import { useApp } from '@/stores/app'
import { openEditor } from '@/stores/ui'

type KeyType = 'ed25519' | 'rsa' | 'ecdsa'

export function GenerateKeyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }): React.JSX.Element {
  const { t } = useTranslation('keychain')
  const { t: tc } = useTranslation()
  const deviceName = useApp((s) => s.info?.deviceName ?? 'sshtool')
  const [type, setType] = useState<KeyType>('ed25519')
  const [bits, setBits] = useState(4096)
  const [label, setLabel] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [comment, setComment] = useState(`sshtool@${deviceName}`)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const bitOptions = type === 'rsa' ? [2048, 3072, 4096] : type === 'ecdsa' ? [256, 384, 521] : []

  const generate = async (): Promise<void> => {
    if (passphrase !== confirmPw) {
      setError(t('generate.mismatch'))
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      const item = await call('keys.generate', {
        label: label.trim() || `${type}-${new Date().toISOString().slice(0, 10)}`,
        type,
        bits: type === 'ed25519' ? undefined : bits,
        passphrase: passphrase || undefined,
        comment: comment.trim() || undefined
      })
      toast.success(tc('savedToast'))
      onOpenChange(false)
      openEditor('key', item.id)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={t('generate.title')} width="max-w-md">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void generate()
          }}
        >
          <DialogBody className="flex flex-col gap-4">
            <Field label={t('generate.label')}>
              <Input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} placeholder={`${type}-${new Date().toISOString().slice(0, 10)}`} data-testid="genkey-label" />
            </Field>
            <Field label={t('generate.type')}>
              <Segmented<KeyType>
                value={type}
                onChange={(v) => {
                  setType(v)
                  setBits(v === 'rsa' ? 4096 : 256)
                }}
                options={[
                  { value: 'ed25519', label: `ED25519 · ${t('generate.recommended')}` },
                  { value: 'rsa', label: 'RSA' },
                  { value: 'ecdsa', label: 'ECDSA' }
                ]}
              />
            </Field>
            {bitOptions.length > 0 && (
              <Field label={t('generate.bits')}>
                <Segmented<string> value={String(bits)} onChange={(v) => setBits(Number(v))} options={bitOptions.map((b) => ({ value: String(b), label: String(b) }))} size="sm" />
              </Field>
            )}
            <Field label={t('generate.passphrase')} hint={t('generate.passphraseHint')}>
              <PasswordInput value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
            </Field>
            {passphrase && (
              <Field label={t('generate.passphraseConfirm')}>
                <PasswordInput value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} />
              </Field>
            )}
            <Field label={t('generate.comment')}>
              <Input value={comment} onChange={(e) => setComment(e.target.value)} className="font-mono" />
            </Field>
            {error && <p className="text-xs text-danger">{error}</p>}
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {tc('cancel')}
            </Button>
            <Button variant="primary" type="submit" disabled={busy} data-testid="genkey-submit">
              {busy ? t('generate.generating') : t('generate.generate')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
