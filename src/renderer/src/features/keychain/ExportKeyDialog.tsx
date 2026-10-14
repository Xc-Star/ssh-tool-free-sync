import { Upload } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { HostAvatar } from '@/components/HostAvatar'
import { Button } from '@/components/ui/button'
import { Dialog, DialogBody, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { call, errorMessage } from '@/lib/api'
import { useItem } from '@/stores/vault'
import { HostPicker } from '../hosts/HostPicker'

export function ExportKeyDialog({ keyId, onClose }: { keyId: string; onClose: () => void }): React.JSX.Element {
  const { t } = useTranslation('keychain')
  const { t: tc } = useTranslation()
  const key = useItem('key', keyId)
  const [hostId, setHostId] = useState<string>()
  const host = useItem('host', hostId)
  const [busy, setBusy] = useState(false)

  const run = async (): Promise<void> => {
    if (!hostId) return
    setBusy(true)
    try {
      const res = await call('keys.exportToHost', keyId, hostId)
      const name = host?.data.label || host?.data.address || ''
      if (res.added) toast.success(t('exportDialog.added', { host: name }))
      else toast.info(t('exportDialog.exists', { host: name }))
      onClose()
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={t('exportDialog.title')} description={t('exportDialog.desc', { name: key?.data.label ?? '' })}>
        <DialogBody>
          <HostPicker onPick={setHostId}>
            <button className="flex h-11 w-full items-center gap-3 rounded-lg border border-line bg-input px-3 text-left hover:border-line-strong">
              {host ? (
                <>
                  <HostAvatar size="sm" osHint={host.data.osHint} label={host.data.label} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px]">{host.data.label || host.data.address}</span>
                    <span className="block truncate text-[11px] text-subtle">{host.data.address}</span>
                  </span>
                </>
              ) : (
                <span className="text-[13px] text-subtle">{t('exportDialog.pickHost')}</span>
              )}
            </button>
          </HostPicker>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {tc('cancel')}
          </Button>
          <Button variant="primary" disabled={!hostId || busy} onClick={() => void run()}>
            <Upload />
            {busy ? t('exportDialog.exporting') : t('exportDialog.export')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
