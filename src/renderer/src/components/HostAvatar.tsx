import * as icons from 'simple-icons'
import { Monitor, Server, Terminal, Usb } from 'lucide-react'
import { cn, colorFor } from '@/lib/utils'

interface SimpleIcon {
  path: string
  hex: string
  title: string
}

const OS_ICONS: Record<string, SimpleIcon | undefined> = {
  ubuntu: icons.siUbuntu,
  debian: icons.siDebian,
  centos: icons.siCentos,
  rhel: icons.siRedhat,
  fedora: icons.siFedora,
  arch: icons.siArchlinux,
  manjaro: icons.siManjaro,
  alpine: icons.siAlpinelinux,
  opensuse: icons.siOpensuse,
  suse: icons.siOpensuse,
  rocky: icons.siRockylinux,
  almalinux: icons.siAlmalinux,
  raspbian: icons.siRaspberrypi,
  kali: icons.siKalilinux,
  linuxmint: icons.siLinuxmint,
  gentoo: icons.siGentoo,
  nixos: icons.siNixos,
  freebsd: icons.siFreebsd,
  openwrt: icons.siOpenwrt,
  synology: icons.siSynology,
  macos: icons.siApple,
  linux: icons.siLinux
}

/** Rounded square avatar showing the detected OS of a host (Termius style). */
export function HostAvatar({
  osHint,
  label,
  kind = 'ssh',
  size = 'md',
  className
}: {
  osHint?: string
  label?: string
  kind?: 'ssh' | 'local' | 'serial' | 'telnet'
  size?: 'sm' | 'md' | 'lg'
  className?: string
}): React.JSX.Element {
  const dims = { sm: 'size-6 rounded-md [&_svg]:size-3.5', md: 'size-9 rounded-lg [&_svg]:size-[18px]', lg: 'size-14 rounded-2xl [&_svg]:size-7' }[size]
  const icon = osHint ? OS_ICONS[osHint] : undefined
  if (kind === 'local')
    return (
      <div className={cn('flex shrink-0 items-center justify-center bg-[#2f3446] text-white', dims, className)}>
        <Terminal />
      </div>
    )
  if (kind === 'serial')
    return (
      <div className={cn('flex shrink-0 items-center justify-center bg-[#7a5af5] text-white', dims, className)}>
        <Usb />
      </div>
    )
  if (icon) {
    const hex = icon.hex
    const r = parseInt(hex.slice(0, 2), 16)
    const g = parseInt(hex.slice(2, 4), 16)
    const b = parseInt(hex.slice(4, 6), 16)
    // Very light brand colors become the glyph color on a dark tile instead.
    const light = 0.2126 * r + 0.7152 * g + 0.0722 * b > 170
    return (
      <div
        className={cn('flex shrink-0 items-center justify-center', light ? 'bg-[#2f3446]' : 'text-white', dims, className)}
        style={light ? { color: `#${hex}` } : { backgroundColor: `#${hex}` }}
        title={icon.title}
      >
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d={icon.path} />
        </svg>
      </div>
    )
  }
  return (
    <div className={cn('flex shrink-0 items-center justify-center text-white', dims, className)} style={{ backgroundColor: colorFor(label ?? '') }}>
      {kind === 'telnet' ? <Monitor /> : <Server />}
    </div>
  )
}
