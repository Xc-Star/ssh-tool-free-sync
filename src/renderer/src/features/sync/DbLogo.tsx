import { siCloudflare, siMariadb, siMysql, siNeon, siPostgresql, siSupabase } from 'simple-icons'
import type { SyncDbKind } from '@shared/types'
import { cn } from '@/lib/utils'

export interface BrandIconData {
  title: string
  path: string
  hex: string
}

/** WebDAV is a protocol, not a vendor: a neutral cloud glyph stands in for every server (Nextcloud, Synology, …). */
const webdavIcon: BrandIconData = {
  title: 'WebDAV',
  path: 'M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z',
  hex: '4E86E4'
}

export const BRANDS = {
  postgres: siPostgresql,
  mysql: siMysql,
  mariadb: siMariadb,
  d1: siCloudflare,
  webdav: webdavIcon,
  supabase: siSupabase,
  neon: siNeon
} satisfies Record<string, BrandIconData>

function luminance(hex: string): number {
  const n = parseInt(hex, 16)
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]
}

/** Simple Icons logo in its brand color; very dark brand colors fall back to the text color so they stay visible in dark mode. */
export function BrandIcon({
  icon,
  className
}: {
  icon: BrandIconData
  className?: string
}): React.JSX.Element {
  const fill = luminance(icon.hex) < 0.05 ? 'currentColor' : `#${icon.hex}`
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn('shrink-0', className)}
      fill={fill}
      role="img"
      aria-label={icon.title}
    >
      <path d={icon.path} />
    </svg>
  )
}

const SIZES = {
  xs: { tile: 'size-5 rounded', icon: 'size-3', badge: 'hidden' },
  sm: { tile: 'size-7 rounded-md', icon: 'size-4', badge: 'hidden' },
  md: { tile: 'size-9 rounded-lg', icon: 'size-5', badge: 'size-4 -bottom-1 -right-1 [&_svg]:size-2.5' },
  lg: {
    tile: 'size-12 rounded-xl',
    icon: 'size-7',
    badge: 'size-[22px] -bottom-1.5 -right-1.5 [&_svg]:size-3.5'
  }
}

/** Database logo on a tinted tile. MySQL / MariaDB shows the MariaDB seal as a small badge. */
export function DbLogo({
  kind,
  size = 'md',
  className
}: {
  kind: SyncDbKind
  size?: keyof typeof SIZES
  className?: string
}): React.JSX.Element {
  const icon = BRANDS[kind]
  const s = SIZES[size]
  return (
    <span
      className={cn('relative flex shrink-0 items-center justify-center text-fg', s.tile, className)}
      style={{ backgroundColor: `#${icon.hex}24` }}
    >
      <BrandIcon icon={icon} className={s.icon} />
      {kind === 'mysql' && (
        <span
          className={cn(
            'absolute flex items-center justify-center rounded-full border border-line bg-elevated text-fg',
            s.badge
          )}
        >
          <BrandIcon icon={BRANDS.mariadb} />
        </span>
      )}
    </span>
  )
}
