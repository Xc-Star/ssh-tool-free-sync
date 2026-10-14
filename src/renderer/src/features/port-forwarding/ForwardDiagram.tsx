import { ChevronRight, Globe, Laptop, Server, Target } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { Item } from '@shared/schemas'
import { HostAvatar } from '@/components/HostAvatar'
import { cn } from '@/lib/utils'
import { type ForwardType, hostName } from './format'

export interface DiagramAddress {
  host: string
  port?: string
}

function IconBox({ children, className }: { children: ReactNode; className?: string }): React.JSX.Element {
  return (
    <div
      className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg [&_svg]:size-4', className)}
    >
      {children}
    </div>
  )
}

function Node({
  icon,
  title,
  addr,
  badge,
  dim
}: {
  icon: ReactNode
  title: string
  addr?: DiagramAddress
  /** Pill on the top border (marks the side that opens the port). */
  badge?: string
  dim?: boolean
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'relative flex min-w-0 flex-1 flex-col items-center gap-1.5 rounded-lg border px-2 pb-2 pt-3 text-center transition-colors',
        badge ? 'border-accent/60 bg-accent-soft' : 'border-line bg-elevated'
      )}
    >
      {badge && (
        <span className="absolute -top-2 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-accent px-1.5 text-[10px] font-semibold leading-4 text-white">
          {badge}
        </span>
      )}
      {icon}
      <div
        className={cn('w-full truncate text-[11.5px] font-medium', dim ? 'text-subtle' : 'text-fg')}
        title={title}
      >
        {title}
      </div>
      <div className="flex w-full flex-col font-mono leading-4">
        <span className="truncate text-[10.5px] text-muted" title={addr?.host}>
          {addr?.host || '\u00a0'}
        </span>
        <span className="truncate text-[11px] font-semibold text-fg">
          {addr?.port ? `:${addr.port}` : '\u00a0'}
        </span>
      </div>
    </div>
  )
}

function Connector({ label }: { label?: string }): React.JSX.Element {
  return (
    <div className="flex w-[52px] shrink-0 flex-col items-center justify-center gap-1 self-center">
      <div className="flex w-full items-center">
        <span
          className={cn(
            'h-0 flex-1 border-t-2',
            label ? 'border-dashed border-accent' : 'border-line-strong'
          )}
        />
        <ChevronRight
          className={cn('-ml-1.5 size-4 shrink-0', label ? 'text-accent' : 'text-subtle')}
          strokeWidth={3}
        />
      </div>
      {label && (
        <span className="max-w-full text-center text-[9.5px] font-semibold uppercase leading-[1.15] tracking-wide text-accent">
          {label}
        </span>
      )}
    </div>
  )
}

/** Live "This computer ⇄ SSH host ⇄ Destination" diagram for the rule being edited. */
export function ForwardDiagram({
  type,
  host,
  bind,
  dest
}: {
  type: ForwardType
  host: Item<'host'> | undefined
  bind: DiagramAddress
  /** Destination (local / remote). */
  dest: DiagramAddress
}): React.JSX.Element {
  const { t } = useTranslation('forwarding')
  const listens = t('diagram.listens')
  const computer = (badge?: string, addr?: DiagramAddress): React.JSX.Element => (
    <Node
      icon={
        <IconBox className="bg-accent text-white">
          <Laptop />
        </IconBox>
      }
      title={t('diagram.thisComputer')}
      addr={addr}
      badge={badge}
    />
  )
  const sshHost = (badge?: string, addr?: DiagramAddress): React.JSX.Element => (
    <Node
      icon={
        host ? (
          <HostAvatar
            size="md"
            osHint={host.data.osHint}
            label={hostName(host)}
            className="size-8 [&_svg]:size-4"
          />
        ) : (
          <IconBox className="border border-dashed border-line-strong text-subtle">
            <Server />
          </IconBox>
        )
      }
      title={host ? hostName(host) : t('diagram.sshHost')}
      addr={addr ?? { host: host ? host.data.address : t('diagram.selectHost') }}
      badge={badge}
      dim={!host}
    />
  )
  const destination = (
    <Node
      icon={
        <IconBox className="bg-success/15 text-success">
          <Target />
        </IconBox>
      }
      title={t('diagram.destination')}
      addr={dest.host ? dest : { host: '—' }}
    />
  )

  let nodes: React.JSX.Element
  if (type === 'local') {
    nodes = (
      <>
        {computer(listens, bind)}
        <Connector label={t('diagram.tunnel')} />
        {sshHost()}
        <Connector />
        {destination}
      </>
    )
  } else if (type === 'remote') {
    nodes = (
      <>
        {sshHost(listens, bind)}
        <Connector label={t('diagram.tunnel')} />
        {computer()}
        <Connector />
        {destination}
      </>
    )
  } else {
    nodes = (
      <>
        {computer('SOCKS5', bind)}
        <Connector label={t('diagram.tunnel')} />
        {sshHost()}
        <Connector />
        <Node
          icon={
            <IconBox className="bg-success/15 text-success">
              <Globe />
            </IconBox>
          }
          title={t('diagram.anyDestination')}
          addr={{ host: '*', port: '*' }}
        />
      </>
    )
  }

  return (
    <div
      className="flex items-stretch rounded-xl border border-line bg-app px-3 pb-3 pt-4"
      data-testid="forward-diagram"
    >
      {nodes}
    </div>
  )
}
