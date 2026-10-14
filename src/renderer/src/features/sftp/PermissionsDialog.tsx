import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { modeToPermissions } from '@shared/util'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/controls'
import { Dialog, DialogBody, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { Field, Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/misc'
import { call, errorMessage } from '@/lib/api'
import { cn } from '@/lib/utils'
import { EntryIcon } from './icons'
import { type ChmodTarget, refreshMatching } from './store'
import { isDirEntry } from './utils'

const WHO = ['owner', 'group', 'others'] as const
const WHAT = ['read', 'write', 'execute'] as const

function toOctal(mode: number): string {
  const s = (mode & 0o7777).toString(8)
  return mode & 0o7000 ? s.padStart(4, '0') : s.padStart(3, '0')
}

/** chmod dialog: rwx grid for owner/group/others kept in sync with an octal field. */
export function PermissionsDialog({ target, onClose }: { target: ChmodTarget; onClose: () => void }): React.JSX.Element {
  const { t } = useTranslation('sftp')
  const { t: tc } = useTranslation()
  const first = target.entries[0]
  const [mode, setMode] = useState(first.mode & 0o7777)
  const [octal, setOctal] = useState(toOctal(first.mode))
  const [recursive, setRecursive] = useState(false)
  const [busy, setBusy] = useState(false)
  const hasDir = target.entries.some(isDirEntry)
  const octalValid = /^[0-7]{3,4}$/.test(octal)

  const setBits = (next: number): void => {
    setMode(next)
    setOctal(toOctal(next))
  }

  const onOctal = (raw: string): void => {
    const v = raw.replace(/[^0-7]/g, '').slice(0, 4)
    setOctal(v)
    if (/^[0-7]{3,4}$/.test(v)) {
      const n = parseInt(v, 8)
      // Three digits keep the special bits (setuid/setgid/sticky) of the current mode.
      setMode(v.length === 4 ? n : (mode & 0o7000) | n)
    }
  }

  const apply = async (): Promise<void> => {
    if (!octalValid) return
    setBusy(true)
    try {
      for (const e of target.entries) await call('fs.chmod', target.fsId, e.path, mode, recursive && isDirEntry(e))
      toast.success(t('chmodApplied'))
      onClose()
      void refreshMatching(target.fsId, target.dir)
    } catch (err) {
      toast.error(t('chmodFailed'), { description: errorMessage(err) })
    } finally {
      setBusy(false)
    }
  }

  const single = target.entries.length === 1
  const typeForPreview = single ? first.type : 'file'

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent
        width="max-w-md"
        title={t('chmodTitle')}
        description={
          single ? (
            <span className="flex min-w-0 items-center gap-1.5">
              <EntryIcon entry={first} className="size-3.5 shrink-0" />
              <span className="truncate font-mono">{first.path}</span>
            </span>
          ) : (
            t('chmodMany', { count: target.entries.length })
          )
        }
        data-testid="sftp-permissions-dialog"
      >
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault()
            void apply()
          }}
        >
          <DialogBody className="flex flex-col gap-4">
            <div className="overflow-hidden rounded-lg border border-line">
              <div className="grid grid-cols-[1fr_repeat(3,64px)] bg-panel text-[11px] font-semibold uppercase tracking-wide text-subtle">
                <div className="px-3 py-2" />
                {WHAT.map((w) => (
                  <div key={w} className="py-2 text-center">
                    {t(w)}
                  </div>
                ))}
              </div>
              {WHO.map((who, row) => (
                <div key={who} className="grid grid-cols-[1fr_repeat(3,64px)] items-center border-t border-line">
                  <div className="px-3 py-2.5 text-[13px]">{t(who)}</div>
                  {WHAT.map((what, col) => {
                    const bit = 1 << (8 - (row * 3 + col))
                    return (
                      <div key={what} className="flex justify-center">
                        <Checkbox
                          checked={(mode & bit) !== 0}
                          onCheckedChange={(v) => setBits(v === true ? mode | bit : mode & ~bit)}
                          aria-label={`${t(who)} ${t(what)}`}
                          data-testid={`sftp-perm-${who}-${what}`}
                        />
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>
            <div className="flex items-start gap-3">
              <Field label={t('octal')} error={octalValid ? undefined : t('octalInvalid')} className="w-36 shrink-0">
                <Input value={octal} onChange={(e) => onOctal(e.target.value)} maxLength={4} className="font-mono" inputMode="numeric" data-testid="sftp-perm-octal" />
              </Field>
              <Field label={t('preview')} className="min-w-0 flex-1">
                <div className={cn('flex h-8 items-center rounded-md border border-line bg-panel px-2.5 font-mono text-[13px]', !octalValid && 'opacity-50')}>
                  {modeToPermissions(mode & 0o777, typeForPreview)}
                </div>
              </Field>
            </div>
            {hasDir && (
              <label className="flex cursor-default items-start gap-2.5">
                <Checkbox checked={recursive} onCheckedChange={(v) => setRecursive(v === true)} className="mt-0.5" data-testid="sftp-perm-recursive" />
                <span className="flex flex-col gap-0.5">
                  <span className="text-[13px]">{t('recursive')}</span>
                  <span className="text-xs leading-relaxed text-subtle">{t('recursiveHint')}</span>
                </span>
              </label>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              {tc('cancel')}
            </Button>
            <Button variant="primary" type="submit" disabled={!octalValid || busy} data-testid="sftp-perm-apply">
              {busy && <Spinner className="text-white" />}
              {tc('apply')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
