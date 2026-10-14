import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { Item, PortForwardData } from '@shared/schemas'

export type ForwardType = PortForwardData['type']

export const FORWARD_TYPES: readonly ForwardType[] = ['local', 'remote', 'dynamic']

export const DEFAULT_BIND_ADDRESS = '127.0.0.1'

/** `host:port`, with IPv6 literals wrapped in brackets. */
export function formatHostPort(host: string, port: number | string | undefined): string {
  const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return port === undefined || port === '' ? h : `${h}:${port}`
}

/** True for bind addresses that expose the port beyond the local machine. */
export function isExposedAddress(addr: string): boolean {
  const a = addr.trim()
  return a === '0.0.0.0' || a === '::' || a === '*' || a === '[::]'
}

export function hostName(host: Item<'host'>): string {
  return host.data.label || host.data.address
}

export function hostTarget(host: Item<'host'>): string {
  const { username, address, port } = host.data
  return `${username ? `${username}@` : ''}${address}${port && port !== 22 ? `:${port}` : ''}`
}

type DescribeInput = Pick<PortForwardData, 'type' | 'bindPort' | 'destHost' | 'destPort'> & {
  bindAddress?: string
  label?: string
}

/** Display helpers for forwarding rules (label with a generated fallback). */
export function useForwardFormat(): {
  fallback: (d: DescribeInput) => string
  title: (d: DescribeInput) => string
} {
  const { t } = useTranslation('forwarding')
  return useMemo(() => {
    const fallback = (d: DescribeInput): string =>
      d.type === 'dynamic'
        ? t('fallback.dynamic', { bind: formatHostPort(d.bindAddress || DEFAULT_BIND_ADDRESS, d.bindPort) })
        : t(`fallback.${d.type}`, { bind: d.bindPort, dest: formatHostPort(d.destHost || '?', d.destPort) })
    return { fallback, title: (d) => d.label?.trim() || fallback(d) }
  }, [t])
}
