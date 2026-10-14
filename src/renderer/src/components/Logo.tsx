import { cn } from '@/lib/utils'

/** App logo (same artwork as build/icon.svg). */
export function Logo({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="96 96 832 832" className={cn('size-7 shrink-0', className)} aria-hidden>
      <defs>
        <linearGradient id="sshtool-logo-bg" x1="0.1" y1="0" x2="0.9" y2="1">
          <stop offset="0" stopColor="#5b7fff" />
          <stop offset="1" stopColor="#6d3df5" />
        </linearGradient>
      </defs>
      <rect x="96" y="96" width="832" height="832" rx="196" fill="url(#sshtool-logo-bg)" />
      <rect x="204" y="262" width="616" height="500" rx="68" fill="#10132a" />
      <path d="M316 452 L432 544 L316 636" fill="none" stroke="#ffffff" strokeWidth="58" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="472" y="606" width="212" height="58" rx="29" fill="#7ee0ff" />
    </svg>
  )
}
