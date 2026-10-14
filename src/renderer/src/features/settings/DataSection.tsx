import {
  Archive,
  ArchiveRestore,
  ArrowLeftRight,
  CircleCheck,
  FileCode,
  FileSpreadsheet,
  FileText,
  FolderPlus,
  KeyRound,
  Sheet,
  ShieldCheck,
  Waypoints
} from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { TFunction } from 'i18next'
import type { ImportResult, SshConfigEntry } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/controls'
import { Dialog, DialogBody, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { Field, Input, PasswordInput } from '@/components/ui/input'
import { Badge, EmptyState, Spinner } from '@/components/ui/misc'
import { call, errorMessage } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Callout, SettingsCard, SettingsGroup, SettingsRow } from './ui'

const MIN_BACKUP_PASSWORD = 8
const CSV_HEADER = 'label,address,port,username,password,group,tags'
const CSV_EXAMPLE = 'web-1,10.0.0.5,22,deploy,,Production/Web,linux;nginx'
const COUNT_KEYS = ['hosts', 'groups', 'keys', 'forwards', 'knownHosts', 'other'] as const

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() || p
}

function summarize(r: ImportResult, t: TFunction<'settings'>): string {
  return COUNT_KEYS.filter((k) => r[k] > 0)
    .map((k) => t(`data.summary.${k}`, { count: r[k] }))
    .join(t('data.listSeparator'))
}

/** Toasts the outcome of an import (counts, skipped items and the first errors). */
export function notifyImport(r: ImportResult, t: TFunction<'settings'>): void {
  const text = summarize(r, t)
  const skipped = r.skipped ? t('data.summary.skipped', { count: r.skipped }) : undefined
  if (text) toast.success(t('data.imported', { summary: text }), { description: skipped })
  else if (!r.errors.length) toast.info(t('data.nothingImported'), { description: skipped })
  if (r.errors.length) {
    const more = r.errors.length > 3 ? `\n${t('data.moreErrors', { count: r.errors.length - 3 })}` : ''
    toast.warning(t('data.errorsTitle', { count: r.errors.length }), {
      description: r.errors.slice(0, 3).join('\n') + more
    })
  }
}

export function DataSection(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const [sshOpen, setSshOpen] = useState(false)
  const [backup, setBackup] = useState<{ mode: 'export' | 'import'; path: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const all = { name: t('data.filters.all'), extensions: ['*'] }

  const run = async (id: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(id)
    try {
      await fn()
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const importCsv = (): Promise<void> =>
    run('csv', async () => {
      const [path] = await call('app.openFileDialog', {
        title: t('data.csv'),
        filters: [{ name: t('data.filters.csv'), extensions: ['csv'] }, all]
      })
      if (path) notifyImport(await call('import.csv', path), t)
    })

  const importKnownHosts = (choose: boolean): Promise<void> =>
    run('knownHosts', async () => {
      let path: string | undefined
      if (choose) {
        ;[path] = await call('app.openFileDialog', { title: t('data.knownHosts'), filters: [all] })
        if (!path) return
      }
      notifyImport(await call('knownHosts.importFile', path), t)
    })

  const importBackup = (): Promise<void> =>
    run('backupImport', async () => {
      const [path] = await call('app.openFileDialog', {
        title: t('data.importBackupTitle'),
        filters: [{ name: t('data.filters.backup'), extensions: ['sshtool', 'json'] }, all]
      })
      if (path) setBackup({ mode: 'import', path })
    })

  const exportBackup = (): Promise<void> =>
    run('backupExport', async () => {
      const path = await call('app.saveFileDialog', {
        title: t('data.exportBackupTitle'),
        defaultPath: `sshtool-backup-${today()}.sshtool`,
        filters: [{ name: t('data.filters.backup'), extensions: ['sshtool'] }]
      })
      if (path) setBackup({ mode: 'export', path })
    })

  const exportCsv = (): Promise<void> =>
    run('csvExport', async () => {
      const path = await call('app.saveFileDialog', {
        title: t('data.csvExport'),
        defaultPath: `sshtool-hosts-${today()}.csv`,
        filters: [{ name: t('data.filters.csv'), extensions: ['csv'] }]
      })
      if (!path) return
      const count = await call('export.hostsCsv', path)
      toast.success(t('data.exportedHosts', { count }), { description: path })
    })

  const actionButton = (
    id: string,
    label: string,
    onClick: () => void,
    testId?: string,
    variant: 'secondary' | 'ghost' = 'secondary'
  ): ReactNode => (
    <Button size="sm" variant={variant} onClick={onClick} disabled={busy !== null} data-testid={testId}>
      {busy === id && variant === 'secondary' && <Spinner className="size-3.5" />}
      {label}
    </Button>
  )

  return (
    <>
      <SettingsGroup title={t('data.import')}>
        <SettingsCard>
          <SettingsRow icon={<FileCode />} label={t('data.sshConfig')} description={t('data.sshConfigDesc')}>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setSshOpen(true)}
              disabled={busy !== null}
              data-testid="import-ssh-config"
            >
              {t('data.importBtn')}
            </Button>
          </SettingsRow>
          <SettingsRow
            icon={<FileSpreadsheet />}
            align="start"
            label={t('data.csv')}
            description={
              <>
                {t('data.csvDesc')}
                <code className="selectable mt-1.5 block overflow-x-auto whitespace-pre rounded-md border border-line bg-app px-2.5 py-1.5 font-mono text-[11px] leading-5 text-fg">
                  {CSV_HEADER}
                  {'\n'}
                  <span className="text-subtle">{CSV_EXAMPLE}</span>
                </code>
                <span className="mt-1.5 block">{t('data.csvNotes')}</span>
              </>
            }
          >
            {actionButton('csv', t('data.importBtn'), () => void importCsv(), 'import-csv')}
          </SettingsRow>
          <SettingsRow
            icon={<ShieldCheck />}
            label={t('data.knownHosts')}
            description={t('data.knownHostsDesc')}
          >
            {actionButton(
              'knownHosts',
              t('data.chooseFile'),
              () => void importKnownHosts(true),
              undefined,
              'ghost'
            )}
            {actionButton(
              'knownHosts',
              t('data.importDefault'),
              () => void importKnownHosts(false),
              'import-known-hosts'
            )}
          </SettingsRow>
          <SettingsRow
            icon={<ArchiveRestore />}
            label={t('data.backupImport')}
            description={t('data.backupImportDesc')}
          >
            {actionButton('backupImport', t('data.importBtn'), () => void importBackup(), 'import-backup')}
          </SettingsRow>
        </SettingsCard>
      </SettingsGroup>

      <SettingsGroup title={t('data.export')}>
        <SettingsCard>
          <SettingsRow
            icon={<Archive />}
            label={t('data.backupExport')}
            description={t('data.backupExportDesc')}
          >
            {actionButton('backupExport', t('data.exportBtn'), () => void exportBackup(), 'export-backup')}
          </SettingsRow>
          <SettingsRow icon={<Sheet />} label={t('data.csvExport')} description={t('data.csvExportDesc')}>
            {actionButton('csvExport', t('data.exportBtn'), () => void exportCsv(), 'export-csv')}
          </SettingsRow>
        </SettingsCard>
      </SettingsGroup>

      {sshOpen && <SshConfigImportDialog onClose={() => setSshOpen(false)} />}
      {backup && (
        <BackupPasswordDialog mode={backup.mode} path={backup.path} onClose={() => setBackup(null)} />
      )}
    </>
  )
}

function Chip({
  icon,
  children,
  title
}: {
  icon: ReactNode
  children: ReactNode
  title?: string
}): React.JSX.Element {
  return (
    <span
      className="inline-flex h-5 max-w-full items-center gap-1 rounded border border-line bg-app px-1.5 text-[11px] text-muted [&_svg]:size-3"
      title={title}
    >
      {icon}
      <span className="truncate">{children}</span>
    </span>
  )
}

function SshConfigImportDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { t } = useTranslation('settings')
  const { t: tc } = useTranslation()
  const [path, setPath] = useState<string | undefined>()
  const [entries, setEntries] = useState<SshConfigEntry[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [group, setGroup] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)

  useEffect(() => {
    let alive = true
    setEntries(null)
    setLoadError(null)
    call('import.sshConfigPreview', path)
      .then((list) => {
        if (!alive) return
        setEntries(list)
        setSelected(new Set(list.flatMap((e, i) => (e.exists ? [] : [i]))))
      })
      .catch((err) => {
        if (!alive) return
        setLoadError(errorMessage(err))
        setEntries([])
      })
    return () => {
      alive = false
    }
  }, [path])

  const chooseFile = async (): Promise<void> => {
    try {
      const [p] = await call('app.openFileDialog', {
        title: t('data.sshDialogTitle'),
        filters: [{ name: t('data.filters.all'), extensions: ['*'] }]
      })
      if (p) setPath(p)
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  const toggle = (i: number): void =>
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })

  const apply = async (): Promise<void> => {
    if (!entries) return
    setBusy(true)
    try {
      const r = await call(
        'import.sshConfigApply',
        entries.filter((_, i) => selected.has(i)),
        group.trim() || undefined
      )
      setResult(r)
      notifyImport(r, t)
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const total = entries?.length ?? 0
  const allSelected = total > 0 && selected.size === total

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent
        title={t('data.sshDialogTitle')}
        description={t('data.sshDialogDesc')}
        width="max-w-[640px]"
        data-testid="ssh-config-dialog"
      >
        {result ? (
          <>
            <DialogBody className="flex flex-col items-center gap-4 py-6 text-center">
              <div className="flex size-12 items-center justify-center rounded-2xl bg-success/12 text-success">
                <CircleCheck className="size-6" />
              </div>
              <div>
                <div className="text-[15px] font-semibold">{t('data.resultTitle')}</div>
                <div className="mt-1 text-xs text-muted">
                  {summarize(result, t) || t('data.nothingImported')}
                </div>
              </div>
              <div className="grid w-full grid-cols-4 gap-2" data-testid="ssh-config-result">
                {(['hosts', 'groups', 'keys', 'forwards'] as const).map((k) => (
                  <div key={k} className="rounded-lg border border-line bg-panel px-3 py-2.5">
                    <div className="text-[18px] font-semibold tabular-nums">{result[k]}</div>
                    <div className="text-[11px] text-muted">{t(`data.resultLabels.${k}`)}</div>
                  </div>
                ))}
              </div>
              {result.errors.length > 0 && (
                <Callout
                  tone="warning"
                  title={t('data.errorsTitle', { count: result.errors.length })}
                  className="w-full text-left"
                >
                  <ul className="selectable mt-1 max-h-32 list-disc overflow-y-auto pl-4">
                    {result.errors.map((e, i) => (
                      <li key={i} className="break-all">
                        {e}
                      </li>
                    ))}
                  </ul>
                </Callout>
              )}
            </DialogBody>
            <DialogFooter>
              <Button variant="primary" onClick={onClose} autoFocus>
                {tc('done')}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 px-5 pb-3 pt-1">
              <div
                className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-line bg-input px-2.5"
                title={path}
              >
                <FileText className="size-3.5 shrink-0 text-subtle" />
                <span className="selectable truncate font-mono text-xs text-muted">
                  {path ?? t('data.defaultConfigPath')}
                </span>
              </div>
              <Button variant="secondary" onClick={() => void chooseFile()} disabled={busy}>
                {t('data.chooseFile')}
              </Button>
            </div>
            <DialogBody className="pt-0">
              {entries === null ? (
                <div className="flex h-40 items-center justify-center gap-2 text-xs text-muted">
                  <Spinner />
                  {t('data.loading')}
                </div>
              ) : loadError ? (
                <Callout tone="danger" title={t('data.loadFailed')}>
                  <span className="selectable break-all">{loadError}</span>
                </Callout>
              ) : total === 0 ? (
                <EmptyState
                  icon={<FileCode />}
                  title={t('data.noEntries')}
                  description={t('data.noEntriesDesc')}
                  className="py-10"
                />
              ) : (
                <div className="overflow-hidden rounded-lg border border-line">
                  <label className="flex h-9 items-center gap-3 border-b border-line bg-panel px-3 text-xs text-muted">
                    <Checkbox
                      checked={allSelected}
                      onCheckedChange={(v) =>
                        setSelected(v === true ? new Set(entries.map((_, i) => i)) : new Set())
                      }
                      disabled={busy}
                      data-testid="ssh-config-select-all"
                    />
                    <span>{t('data.selected', { selected: selected.size, total })}</span>
                  </label>
                  <div className="max-h-[340px] divide-y divide-line overflow-y-auto">
                    {entries.map((e, i) => (
                      <label
                        key={`${e.alias}-${i}`}
                        className={cn(
                          'flex items-start gap-3 px-3 py-2.5 transition-colors hover:bg-panel-hover',
                          !selected.has(i) && 'opacity-70'
                        )}
                        data-testid="ssh-config-entry"
                      >
                        <Checkbox
                          checked={selected.has(i)}
                          onCheckedChange={() => toggle(i)}
                          className="mt-0.5"
                          disabled={busy}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-[13px] font-medium">{e.alias}</span>
                            {e.exists && <Badge tone="warning">{t('data.exists')}</Badge>}
                          </div>
                          <div className="mt-0.5 truncate font-mono text-xs text-muted">
                            {e.user ? `${e.user}@` : ''}
                            {e.hostName}
                            {e.port ? `:${e.port}` : ''}
                          </div>
                          {(e.identityFiles.length > 0 || e.proxyJump || e.forwards.length > 0) && (
                            <div className="mt-1.5 flex flex-wrap gap-1.5">
                              {e.identityFiles.length > 0 && (
                                <Chip icon={<KeyRound />} title={e.identityFiles.join('\n')}>
                                  {e.identityFiles.map(basename).join(', ')}
                                </Chip>
                              )}
                              {e.proxyJump && (
                                <Chip icon={<Waypoints />}>{t('data.jump', { host: e.proxyJump })}</Chip>
                              )}
                              {e.forwards.length > 0 && (
                                <Chip icon={<ArrowLeftRight />}>
                                  {t('data.forwards', { count: e.forwards.length })}
                                </Chip>
                              )}
                            </div>
                          )}
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </DialogBody>
            <DialogFooter className="gap-2">
              {total > 0 && (
                <Input
                  icon={<FolderPlus />}
                  value={group}
                  onChange={(e) => setGroup(e.target.value)}
                  placeholder={t('data.targetGroupPlaceholder')}
                  aria-label={t('data.targetGroup')}
                  className="mr-auto w-56"
                  disabled={busy}
                  data-testid="ssh-config-group"
                />
              )}
              <Button variant="ghost" onClick={onClose} disabled={busy}>
                {tc('cancel')}
              </Button>
              <Button
                variant="primary"
                onClick={() => void apply()}
                disabled={busy || selected.size === 0}
                data-testid="ssh-config-apply"
              >
                {busy && <Spinner className="text-current" />}
                {t('data.importCount', { count: selected.size })}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function BackupPasswordDialog({
  mode,
  path,
  onClose
}: {
  mode: 'export' | 'import'
  path: string
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  const { t: tc } = useTranslation()
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<{ pw?: string; pw2?: string; general?: string }>({})

  const submit = async (): Promise<void> => {
    const e: typeof errors = {}
    if (mode === 'export') {
      if (pw.length < MIN_BACKUP_PASSWORD) e.pw = t('data.minLength', { count: MIN_BACKUP_PASSWORD })
      else if (pw2 !== pw) e.pw2 = t('data.mismatch')
    } else if (!pw) e.pw = tc('required')
    setErrors(e)
    if (Object.keys(e).length) return
    setBusy(true)
    try {
      if (mode === 'export') {
        const count = await call('backup.export', path, pw)
        toast.success(t('data.exported', { count }), { description: path })
      } else {
        notifyImport(await call('backup.import', path, pw), t)
      }
      onClose()
    } catch (err) {
      const msg = errorMessage(err)
      setErrors(/wrong backup password/i.test(msg) ? { pw: t('data.wrongPassword') } : { general: msg })
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent
        title={mode === 'export' ? t('data.exportBackupTitle') : t('data.importBackupTitle')}
        description={mode === 'export' ? t('data.exportBackupDesc') : t('data.importBackupDesc')}
        width="max-w-[440px]"
        data-testid={`backup-dialog-${mode}`}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <DialogBody className="flex flex-col gap-3.5 pb-1">
            <div
              className="flex items-center gap-2 rounded-md border border-line bg-panel px-2.5 py-2"
              title={path}
            >
              {mode === 'export' ? (
                <Archive className="size-4 shrink-0 text-subtle" />
              ) : (
                <ArchiveRestore className="size-4 shrink-0 text-subtle" />
              )}
              <div className="min-w-0">
                <div className="truncate text-[13px] font-medium">{basename(path)}</div>
                <div className="selectable truncate font-mono text-[11px] text-subtle">{path}</div>
              </div>
            </div>
            <Field
              label={t('data.backupPassword')}
              error={errors.pw}
              hint={mode === 'export' ? t('data.minLength', { count: MIN_BACKUP_PASSWORD }) : undefined}
            >
              <PasswordInput
                autoFocus
                value={pw}
                disabled={busy}
                onChange={(e) => {
                  setPw(e.target.value)
                  setErrors((x) => ({ ...x, pw: undefined }))
                }}
                data-testid="backup-password"
              />
            </Field>
            {mode === 'export' && (
              <Field label={t('data.confirmPassword')} error={errors.pw2}>
                <PasswordInput
                  value={pw2}
                  disabled={busy}
                  onChange={(e) => {
                    setPw2(e.target.value)
                    setErrors((x) => ({ ...x, pw2: undefined }))
                  }}
                  data-testid="backup-password-confirm"
                />
              </Field>
            )}
            {errors.general && <Callout tone="danger">{errors.general}</Callout>}
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              {tc('cancel')}
            </Button>
            <Button variant="primary" type="submit" disabled={busy} data-testid="backup-submit">
              {busy && <Spinner className="text-current" />}
              {mode === 'export' ? tc('export') : tc('import')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
