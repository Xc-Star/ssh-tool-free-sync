import { AlertCircle, Loader2, Pencil, RotateCw, Unplug, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { HostAvatar } from '@/components/HostAvatar'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { closePane, reconnectSession, type SessionState } from '@/stores/tabs'
import { openEditor } from '@/stores/ui'
import { getItem } from '@/stores/vault'

function hostIdOf(s: SessionState): string | undefined {
  return s.spec.kind === 'ssh' || s.spec.kind === 'telnet' ? s.spec.hostId : undefined
}

/** Termius-like connection screen shown while connecting or after a failed attempt. */
export function ConnectingOverlay({ session, tabId, paneId }: { session: SessionState; tabId: string; paneId: string }): React.JSX.Element {
  const { t } = useTranslation('terminal')
  const hostId = hostIdOf(session)
  const host = hostId ? getItem('host', hostId) : undefined
  const failed = session.status === 'error'
  const subtitle =
    session.spec.kind === 'ssh' || session.spec.kind === 'telnet'
      ? host
        ? `${session.spec.kind}://${host.data.username ? `${host.data.username}@` : ''}${host.data.address}${host.data.port && host.data.port !== 22 ? `:${host.data.port}` : ''}`
        : session.spec.inline
          ? `${session.spec.kind}://${session.spec.inline.address}`
          : ''
      : session.kind
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-app/95 backdrop-blur-sm" data-testid="connecting-overlay">
      <div className="flex w-[440px] max-w-[90%] flex-col items-center gap-4">
        <div className="relative">
          <HostAvatar size="lg" osHint={session.osHint ?? host?.data.osHint} label={session.title} kind={session.kind === 'local' ? 'local' : session.kind === 'serial' ? 'serial' : 'ssh'} />
          {!failed && (
            <span className="absolute -bottom-1 -right-1 flex size-6 items-center justify-center rounded-full border-2 border-app bg-accent text-white">
              <Loader2 className="size-3.5 animate-spin" />
            </span>
          )}
          {failed && (
            <span className="absolute -bottom-1 -right-1 flex size-6 items-center justify-center rounded-full border-2 border-app bg-danger text-white">
              <AlertCircle className="size-3.5" />
            </span>
          )}
        </div>
        <div className="text-center">
          <div className="text-[16px] font-semibold">{session.title}</div>
          {subtitle && <div className="mt-0.5 font-mono text-xs text-muted">{subtitle}</div>}
        </div>
        <div className={cn('text-sm font-medium', failed ? 'text-danger' : 'text-muted')}>{failed ? t('failed') : t('connecting')}</div>
        {failed && session.error && <div className="selectable max-w-full break-words rounded-lg bg-danger/10 px-3 py-2 text-center text-xs text-danger">{session.error}</div>}
        {session.logs.length > 0 && (
          <div className="selectable max-h-40 w-full overflow-y-auto rounded-lg border border-line bg-panel px-3 py-2 font-mono text-[11px] leading-5 text-muted">
            {session.logs.slice(-12).map((l, i) => (
              <div key={i} className={cn(l.level === 'error' && 'text-danger', l.level === 'warn' && 'text-warning')}>
                {l.line}
              </div>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          {failed && (
            <Button variant="primary" onClick={() => void reconnectSession(session.id)}>
              <RotateCw />
              {t('reconnect')}
            </Button>
          )}
          {hostId && (
            <Button variant="secondary" onClick={() => openEditor('host', hostId)}>
              <Pencil />
              {t('editHost')}
            </Button>
          )}
          <Button variant="ghost" onClick={() => closePane(tabId, paneId)}>
            <X />
            {t('close')}
          </Button>
        </div>
      </div>
    </div>
  )
}

/** Bottom banner shown when an established connection drops (terminal content stays visible). */
export function DisconnectedBanner({ session, tabId, paneId }: { session: SessionState; tabId: string; paneId: string }): React.JSX.Element {
  const { t } = useTranslation('terminal')
  return (
    <div className="absolute inset-x-3 bottom-3 z-10 flex items-center gap-3 rounded-lg border border-line bg-elevated/95 px-3 py-2 shadow-pop backdrop-blur" data-testid="disconnected-banner">
      <Unplug className="size-4 shrink-0 text-warning" />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{t('disconnected')}</div>
        <div className="truncate text-xs text-muted">{session.error ?? t('pressEnterToReconnect')}</div>
      </div>
      <Button size="sm" variant="primary" onClick={() => void reconnectSession(session.id)}>
        <RotateCw />
        {t('reconnect')}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => closePane(tabId, paneId)}>
        {t('close')}
      </Button>
    </div>
  )
}
