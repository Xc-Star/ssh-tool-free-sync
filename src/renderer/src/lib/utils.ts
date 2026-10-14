import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

export function formatDate(ms: number | undefined, locale: string): string {
  if (!ms) return '-'
  const d = new Date(ms)
  return d.toLocaleString(locale, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function relativeTime(ms: number | undefined, locale: string): string {
  if (!ms) return '-'
  const diff = Date.now() - ms
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const s = Math.round(diff / 1000)
  if (Math.abs(s) < 60) return rtf.format(-s, 'second')
  const m = Math.round(s / 60)
  if (Math.abs(m) < 60) return rtf.format(-m, 'minute')
  const h = Math.round(m / 60)
  if (Math.abs(h) < 24) return rtf.format(-h, 'hour')
  const d = Math.round(h / 24)
  if (Math.abs(d) < 30) return rtf.format(-d, 'day')
  return formatDate(ms, locale)
}

export async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text)
}

/** Stable color from a string (for avatars / tag dots). */
export function colorFor(s: string): string {
  const palette = ['#5b7fff', '#33c47b', '#f0a53a', '#e0607e', '#9b6cff', '#29b6c9', '#f07a3a', '#7cb342', '#d65db1', '#3d9bf0']
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return palette[h % palette.length]
}

export function isMacKeyboard(): boolean {
  return navigator.platform.toLowerCase().includes('mac')
}
