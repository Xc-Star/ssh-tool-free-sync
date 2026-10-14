import type { SshConnection } from './connect'

const KNOWN_IDS = [
  'ubuntu',
  'debian',
  'centos',
  'rhel',
  'fedora',
  'arch',
  'manjaro',
  'alpine',
  'opensuse',
  'suse',
  'rocky',
  'almalinux',
  'amzn',
  'raspbian',
  'kali',
  'linuxmint',
  'gentoo',
  'nixos',
  'ol',
  'freebsd',
  'openwrt',
  'synology'
]

/** Parses `/etc/os-release` + `uname -s` output into a short OS hint used for host icons. */
export function parseOsHint(output: string): string {
  const id = /^ID="?([^"\n]+)"?/m.exec(output)?.[1]?.toLowerCase().trim()
  const like = /^ID_LIKE="?([^"\n]+)"?/m.exec(output)?.[1]?.toLowerCase() ?? ''
  if (id) {
    if (id.startsWith('opensuse')) return 'opensuse'
    if (KNOWN_IDS.includes(id)) return id
    for (const l of like.split(/\s+/)) if (KNOWN_IDS.includes(l)) return l
    return 'linux'
  }
  if (/\bDarwin\b/.test(output)) return 'macos'
  if (/\bFreeBSD\b/.test(output)) return 'freebsd'
  if (/\bLinux\b/.test(output)) return 'linux'
  if (/Windows|MINGW|MSYS|CYGWIN/i.test(output)) return 'windows'
  return 'unknown'
}

export async function detectOs(conn: SshConnection): Promise<string> {
  try {
    const { stdout } = await conn.exec('cat /etc/os-release 2>/dev/null; echo ---; uname -s 2>/dev/null', {
      maxBytes: 16384,
      timeoutMs: 8000
    })
    return parseOsHint(stdout)
  } catch {
    return 'unknown'
  }
}
