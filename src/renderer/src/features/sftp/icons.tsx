import {
  File,
  FileArchive,
  FileBraces,
  FileCode,
  FileImage,
  FileKey,
  FileMusic,
  FileQuestionMark,
  FileSpreadsheet,
  FileSymlink,
  FileTerminal,
  FileText,
  FileVideoCamera,
  Folder,
  FolderSymlink,
  HardDrive,
  type LucideIcon
} from 'lucide-react'
import type { FileEntry } from '@shared/types'
import { HostAvatar } from '@/components/HostAvatar'
import { cn } from '@/lib/utils'
import { useItem } from '@/stores/vault'
import type { PaneSource } from './store'
import { extOf, hostTitle, isDriveEntry } from './utils'

const BY_EXT: Record<string, LucideIcon> = {}
const groups: [LucideIcon, string][] = [
  [FileArchive, 'zip tar gz tgz bz2 tbz2 xz txz zst 7z rar lz lzma deb rpm apk jar war ear iso dmg cab'],
  [FileImage, 'png jpg jpeg gif bmp webp svg ico tif tiff heic avif psd'],
  [FileVideoCamera, 'mp4 mkv mov avi webm flv wmv m4v mpg mpeg'],
  [FileMusic, 'mp3 wav flac ogg m4a aac opus wma mid midi'],
  [FileTerminal, 'sh bash zsh ksh fish ps1 psm1 bat cmd command'],
  [FileCode, 'js mjs cjs jsx ts mts cts tsx py rb go rs java kt kts c h cc cpp cxx hpp cs php swift lua pl pm sql html htm css scss less vue svelte xml dart scala r'],
  [FileBraces, 'json jsonc json5 yaml yml toml ini conf cfg cnf env properties lock plist'],
  [FileText, 'txt md markdown rst log readme nfo rtf doc docx pdf'],
  [FileSpreadsheet, 'csv tsv xls xlsx ods'],
  [FileKey, 'pem key pub crt cer der p12 pfx csr gpg asc ppk kdbx']
]
for (const [icon, exts] of groups) for (const ext of exts.split(' ')) BY_EXT[ext] = icon

export function fileIconFor(name: string): LucideIcon {
  return BY_EXT[extOf(name)] ?? File
}

/** Icon for a directory listing entry (folder / file type / symlink / drive). */
export function EntryIcon({ entry, className }: { entry: Pick<FileEntry, 'name' | 'path' | 'type' | 'targetType'>; className?: string }): React.JSX.Element {
  if (entry.type === 'dir') {
    if (isDriveEntry(entry)) return <HardDrive className={cn('text-muted', className)} />
    return <Folder className={cn('text-accent', className)} fill="currentColor" fillOpacity={0.18} />
  }
  if (entry.type === 'symlink') {
    return entry.targetType === 'dir' ? <FolderSymlink className={cn('text-accent', className)} /> : <FileSymlink className={cn('text-muted', className)} />
  }
  if (entry.type === 'other') return <FileQuestionMark className={cn('text-subtle', className)} />
  const Icon = fileIconFor(entry.name)
  return <Icon className={cn('text-muted', className)} />
}

/** Avatar of a pane source: local disk badge or the host's OS avatar. */
export function SourceAvatar({ source, size = 'sm', className }: { source: PaneSource; size?: 'sm' | 'md' | 'lg'; className?: string }): React.JSX.Element {
  const host = useItem('host', source.kind === 'host' ? source.hostId : undefined)
  if (source.kind === 'host') return <HostAvatar size={size} osHint={host?.data.osHint} label={host ? hostTitle(host.data) : source.hostId} className={className} />
  const dims = { sm: 'size-6 rounded-md [&_svg]:size-3.5', md: 'size-9 rounded-lg [&_svg]:size-[18px]', lg: 'size-14 rounded-2xl [&_svg]:size-7' }[size]
  return (
    <div className={cn('flex shrink-0 items-center justify-center bg-accent-soft text-accent', dims, className)}>
      <HardDrive />
    </div>
  )
}
