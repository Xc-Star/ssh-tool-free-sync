import { ChevronDown, ClipboardPaste, Copy, FileUp, KeyRound, Lock, MonitorSmartphone, Pencil, Plus, Sparkles, Trash2, Upload, UserRound } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Card, CardGrid, Page, PageBody, PageHeader } from '@/components/Page'
import { Button } from '@/components/ui/button'
import { confirm } from '@/components/ui/confirm'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Tip
} from '@/components/ui/controls'
import { Badge, EmptyState, Segmented } from '@/components/ui/misc'
import { call, errorMessage, vaultApi } from '@/lib/api'
import { copyText } from '@/lib/utils'
import { openEditor } from '@/stores/ui'
import { getItem, useItems } from '@/stores/vault'
import { ExportKeyDialog } from './ExportKeyDialog'
import { GenerateKeyDialog } from './GenerateKeyDialog'
import { importKeyFiles } from './KeyEditor'

type Tab = 'keys' | 'identities'

export function KeychainPage(): React.JSX.Element {
  const { t } = useTranslation('keychain')
  const { t: tc } = useTranslation()
  const keys = useItems('key')
  const identities = useItems('identity')
  const hosts = useItems('host')
  const [tab, setTab] = useState<Tab>('keys')
  const [search, setSearch] = useState('')
  const [generating, setGenerating] = useState(false)
  const [exportKeyId, setExportKeyId] = useState<string | null>(null)

  const s = search.trim().toLowerCase()
  const visibleKeys = useMemo(
    () =>
      keys
        .filter((k) => !s || k.data.label.toLowerCase().includes(s) || k.data.keyType.toLowerCase().includes(s) || k.data.fingerprint.toLowerCase().includes(s))
        .sort((a, b) => a.data.label.localeCompare(b.data.label)),
    [keys, s]
  )
  const visibleIdentities = useMemo(
    () =>
      identities
        .filter((i) => !s || i.data.label.toLowerCase().includes(s) || i.data.username.toLowerCase().includes(s))
        .sort((a, b) => a.data.label.localeCompare(b.data.label)),
    [identities, s]
  )
  const usage = useMemo(() => {
    const m = new Map<string, number>()
    for (const h of hosts) if (h.data.keyId) m.set(h.data.keyId, (m.get(h.data.keyId) ?? 0) + 1)
    return m
  }, [hosts])

  const removeItem = async (id: string, name: string): Promise<void> => {
    if (!(await confirm({ title: tc('deleteConfirmTitle'), message: tc('deleteConfirm', { name }), confirmLabel: tc('delete'), danger: true }))) return
    await vaultApi.remove([id])
    toast.success(tc('deletedToast'))
  }

  const keyMenu = (
    <div className="flex">
      <Button variant="primary" className="rounded-r-none" onClick={() => setGenerating(true)} data-testid="new-key">
        <Plus />
        {t('newKey')}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="primary" className="rounded-l-none border-l border-white/20 px-1.5" data-testid="new-key-menu">
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setGenerating(true)}>
            <Sparkles />
            {t('generateKey')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void importKeyFiles(t)} data-testid="import-key-file">
            <FileUp />
            {t('importFile')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => openEditor('key')} data-testid="paste-key">
            <ClipboardPaste />
            {t('pasteKey')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )

  return (
    <Page>
      <PageHeader
        search={search}
        onSearch={setSearch}
        searchPlaceholder={t('searchPlaceholder')}
        actions={
          <>
            <Segmented<Tab>
              value={tab}
              onChange={setTab}
              options={[
                { value: 'keys', label: `${t('keys')} ${keys.length || ''}`.trim(), icon: <KeyRound /> },
                { value: 'identities', label: `${t('identities')} ${identities.length || ''}`.trim(), icon: <UserRound /> }
              ]}
            />
            {tab === 'keys' ? (
              keyMenu
            ) : (
              <Button variant="primary" onClick={() => openEditor('identity')} data-testid="new-identity">
                <Plus />
                {t('newIdentity')}
              </Button>
            )}
          </>
        }
      />
      <PageBody>
        {tab === 'keys' &&
          (keys.length === 0 ? (
            <EmptyState
              icon={<KeyRound />}
              title={t('emptyKeysTitle')}
              description={t('emptyKeysDesc')}
              action={
                <div className="mt-2 flex flex-wrap justify-center gap-2">
                  <Button variant="primary" onClick={() => setGenerating(true)}>
                    <Sparkles />
                    {t('generateKey')}
                  </Button>
                  <Button variant="secondary" onClick={() => void importKeyFiles(t)}>
                    <FileUp />
                    {t('importFile')}
                  </Button>
                  <Button variant="secondary" onClick={() => openEditor('key')}>
                    <ClipboardPaste />
                    {t('pasteKey')}
                  </Button>
                </div>
              }
            />
          ) : (
            <CardGrid>
              {visibleKeys.map((k) => (
                <ContextMenu key={k.id}>
                  <ContextMenuTrigger asChild>
                    <div>
                      <Card
                        testId="key-card"
                        onClick={() => openEditor('key', k.id)}
                        icon={
                          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
                            <KeyRound className="size-[18px]" />
                          </div>
                        }
                        title={k.data.label}
                        subtitle={
                          <span className="flex items-center gap-1.5">
                            <span className="uppercase">{k.data.keyType.replace(/^ssh-/, '') || '?'}</span>
                            {usage.get(k.id) ? <span>· {t('usedBy', { count: usage.get(k.id) })}</span> : null}
                          </span>
                        }
                        right={
                          <div className="flex items-center gap-1">
                            {k.data.passphrase && (
                              <Tip content={t('encrypted')}>
                                <Lock className="size-3.5 text-subtle" />
                              </Tip>
                            )}
                            {k.localOnly && (
                              <Tip content={t('deviceOnly')}>
                                <MonitorSmartphone className="size-3.5 text-warning" />
                              </Tip>
                            )}
                          </div>
                        }
                      >
                        <div className="mt-1 truncate font-mono text-[10.5px] text-subtle">{k.data.fingerprint}</div>
                      </Card>
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem onSelect={() => openEditor('key', k.id)}>
                      <Pencil />
                      {tc('edit')}
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => void copyText(k.data.publicKey).then(() => toast.success(t('publicKeyCopied')))}>
                      <Copy />
                      {t('copyPublicKey')}
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => setExportKeyId(k.id)}>
                      <Upload />
                      {t('exportToHost')}
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => void call('vault.setLocalOnly', k.id, !k.localOnly).catch((err) => toast.error(errorMessage(err)))}>
                      <MonitorSmartphone />
                      {t('deviceOnly')}
                      {k.localOnly && <Badge tone="warning" className="ml-auto">✓</Badge>}
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem danger onSelect={() => void removeItem(k.id, k.data.label)}>
                      <Trash2 />
                      {tc('delete')}
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              ))}
            </CardGrid>
          ))}
        {tab === 'identities' &&
          (identities.length === 0 ? (
            <EmptyState
              icon={<UserRound />}
              title={t('emptyIdentitiesTitle')}
              description={t('emptyIdentitiesDesc')}
              action={
                <Button variant="primary" className="mt-2" onClick={() => openEditor('identity')}>
                  <Plus />
                  {t('newIdentity')}
                </Button>
              }
            />
          ) : (
            <CardGrid>
              {visibleIdentities.map((i) => (
                <ContextMenu key={i.id}>
                  <ContextMenuTrigger asChild>
                    <div>
                      <Card
                        testId="identity-card"
                        onClick={() => openEditor('identity', i.id)}
                        icon={
                          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-success/12 text-success">
                            <UserRound className="size-[18px]" />
                          </div>
                        }
                        title={i.data.label}
                        subtitle={[i.data.username, i.data.keyId ? getItem('key', i.data.keyId)?.data.label : undefined, i.data.password ? '••••' : undefined]
                          .filter(Boolean)
                          .join(' · ')}
                      />
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem onSelect={() => openEditor('identity', i.id)}>
                      <Pencil />
                      {tc('edit')}
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => void call('vault.duplicate', i.id)}>
                      <Copy />
                      {tc('duplicate')}
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem danger onSelect={() => void removeItem(i.id, i.data.label)}>
                      <Trash2 />
                      {tc('delete')}
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              ))}
            </CardGrid>
          ))}
      </PageBody>
      <GenerateKeyDialog open={generating} onOpenChange={setGenerating} />
      {exportKeyId && <ExportKeyDialog keyId={exportKeyId} onClose={() => setExportKeyId(null)} />}
    </Page>
  )
}
