import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDownUp, ArrowLeftRight, Check, ChevronDown, ChevronUp, CircleAlert, Copy, Download, FolderOpen, RotateCw, Upload, X } from 'lucide-react'
import { memo, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TransferInfo } from '@shared/types'
import { clamp, formatBytes, formatDuration } from '@shared/util'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/controls'
import { Badge, ProgressBar } from '@/components/ui/misc'
import { call } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useTransfers } from '@/stores/prompts'
import { EntryIcon } from './icons'
import { type Direction, directionOf } from './utils'

const HEIGHT_KEY = 'sshtool.sftp.transfersHeight'
const MIN_H = 120
const DEFAULT_H = 220
const ROW_H = 36

function readHeight(): number {
  const v = Number(localStorage.getItem(HEIGHT_KEY))
  return Number.isFinite(v) && v >= MIN_H ? v : DEFAULT_H
}

const DIR_STYLE: Record<Direction, { icon: React.ComponentType<{ className?: string }>; className: string }> = {
  upload: { icon: Upload, className: 'bg-accent-soft text-accent' },
  download: { icon: Download, className: 'bg-success/12 text-success' },
  remote: { icon: ArrowLeftRight, className: 'bg-warning/12 text-warning' },
  local: { icon: Copy, className: 'bg-panel-hover text-muted' }
}

function summarize(list: TransferInfo[]): { active: number; done: number; failed: number; finished: number; total: number; transferred: number; speed: number } {
  const s = { active: 0, done: 0, failed: 0, finished: 0, total: 0, transferred: 0, speed: 0 }
  for (const x of list) {
    if (x.status === 'queued' || x.status === 'running') {
      s.active++
      if (!x.isDir) {
        s.total += x.size
        s.transferred += x.transferred
        if (x.status === 'running') s.speed += x.speed
      }
    } else {
      s.finished++
      if (x.status === 'done' || x.status === 'skipped') s.done++
      else if (x.status === 'error') s.failed++
    }
  }
  return s
}

/** Collapsible transfer queue at the bottom of the SFTP page (height is remembered). */
export function TransfersPanel(): React.JSX.Element {
  const { t } = useTranslation('sftp')
  const transfers = useTransfers((s) => s.transfers)
  const open = useTransfers((s) => s.panelOpen)
  const [height, setHeight] = useState(readHeight)
  const heightRef = useRef(height)
  const rootRef = useRef<HTMLDivElement>(null)
  const sum = useMemo(() => summarize(transfers), [transfers])
  const toggle = (): void => useTransfers.setState((s) => ({ panelOpen: !s.panelOpen }))

  const startResize = (e: React.PointerEvent): void => {
    e.preventDefault()
    const startY = e.clientY
    const startH = heightRef.current
    const parentH = rootRef.current?.parentElement?.clientHeight ?? 800
    const max = Math.max(MIN_H, parentH - 240)
    const move = (ev: PointerEvent): void => {
      const h = clamp(startH - (ev.clientY - startY), MIN_H, max)
      heightRef.current = h
      setHeight(h)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.cursor = ''
      localStorage.setItem(HEIGHT_KEY, String(Math.round(heightRef.current)))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    document.body.style.cursor = 'row-resize'
  }

  const overall = sum.total > 0 ? (sum.transferred / sum.total) * 100 : 0

  return (
    <div
      ref={rootRef}
      data-testid="sftp-transfers-panel"
      data-open={open}
      className="@container relative flex max-h-[70%] shrink-0 flex-col overflow-hidden rounded-lg border border-line bg-panel"
      style={open ? { height } : undefined}
    >
      {open && <div className="absolute inset-x-0 top-0 z-10 h-1.5 cursor-row-resize" onPointerDown={startResize} />}
      <div
        className={cn('flex h-9 shrink-0 cursor-default items-center gap-2 pl-3 pr-1.5', open && 'border-b border-line')}
        onClick={(e) => {
          if (!(e.target as HTMLElement).closest('button')) toggle()
        }}
      >
        <ArrowDownUp className="size-4 shrink-0 text-muted" />
        <span className="text-[13px] font-semibold">{t('transfers')}</span>
        {sum.active > 0 && (
          <Badge tone="accent" data-testid="sftp-transfers-active">
            {t('activeCount', { count: sum.active })}
          </Badge>
        )}
        {sum.done > 0 && <Badge tone="success">{t('doneCount', { count: sum.done })}</Badge>}
        {sum.failed > 0 && <Badge tone="danger">{t('failedCount', { count: sum.failed })}</Badge>}
        {!transfers.length && !open && <span className="text-xs text-subtle">{t('noTransfers')}</span>}
        {sum.active > 0 && sum.total > 0 && (
          <div className="ml-2 hidden min-w-0 items-center gap-2 @2xl:flex">
            <ProgressBar value={overall} className="w-32" />
            <span className="whitespace-nowrap text-xs tabular-nums text-muted">
              {formatBytes(sum.transferred)} / {formatBytes(sum.total)}
              {sum.speed > 0 && ` · ${formatBytes(sum.speed)}/s`}
            </span>
          </div>
        )}
        <div className="flex-1" />
        {sum.finished > 0 && (
          <Button size="xs" variant="ghost" onClick={() => void call('transfer.clear').catch(() => {})} data-testid="sftp-transfers-clear">
            {t('clearFinished')}
          </Button>
        )}
        <Tip content={open ? t('hideTransfers') : t('showTransfers')}>
          <Button size="icon-xs" variant="ghost" onClick={toggle} aria-label={open ? t('hideTransfers') : t('showTransfers')} data-testid="sftp-transfers-toggle">
            {open ? <ChevronDown /> : <ChevronUp />}
          </Button>
        </Tip>
      </div>
      {open && (transfers.length ? <TransferList transfers={transfers} /> : <EmptyTransfers />)}
    </div>
  )
}

function EmptyTransfers(): React.JSX.Element {
  const { t } = useTranslation('sftp')
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center">
      <div className="flex size-9 items-center justify-center rounded-xl bg-accent-soft text-accent">
        <ArrowDownUp className="size-[18px]" />
      </div>
      <div className="text-[13px] font-medium">{t('noTransfers')}</div>
      <div className="max-w-md text-xs text-muted">{t('noTransfersHint')}</div>
    </div>
  )
}

function TransferList({ transfers }: { transfers: TransferInfo[] }): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: transfers.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    getItemKey: (i) => transfers[i]?.id ?? i,
    overscan: 8
  })
  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((vi) => {
          const tr = transfers[vi.index]
          return tr ? <TransferRow key={vi.key} tr={tr} start={vi.start} /> : null
        })}
      </div>
    </div>
  )
}

const TransferRow = memo(function TransferRow({ tr, start }: { tr: TransferInfo; start: number }): React.JSX.Element {
  const { t } = useTranslation('sftp')
  const direction = directionOf(tr.srcFsId, tr.dstFsId)
  const dirStyle = DIR_STYLE[direction]
  const DirIcon = dirStyle.icon
  const active = tr.status === 'queued' || tr.status === 'running'
  const pct = tr.size > 0 ? (tr.transferred / tr.size) * 100 : tr.status === 'done' ? 100 : 0
  const eta = tr.status === 'running' && tr.speed > 0 && tr.size > tr.transferred ? formatDuration(((tr.size - tr.transferred) / tr.speed) * 1000) : ''
  const tone = tr.status === 'error' ? 'danger' : tr.status === 'done' ? 'success' : 'accent'
  const srcLabel = tr.srcFsId === 'local' ? t('local') : tr.srcLabel
  const dstLabel = tr.dstFsId === 'local' ? t('local') : tr.dstLabel
  let info = ''
  if (!tr.isDir) {
    if (tr.status === 'running') {
      info = `${formatBytes(tr.transferred)} / ${formatBytes(tr.size)}`
      if (tr.speed > 0) info += ` · ${formatBytes(tr.speed)}/s`
      if (eta) info += ` · ${t('eta', { time: eta })}`
    } else if (tr.status === 'error' || tr.status === 'canceled') info = `${formatBytes(tr.transferred)} / ${formatBytes(tr.size)}`
    else info = formatBytes(tr.size)
  }

  let status: React.ReactNode
  switch (tr.status) {
    case 'running':
      status = <span className="text-accent">{tr.isDir ? t('status.running') : `${Math.floor(pct)}%`}</span>
      break
    case 'done':
      status = (
        <span className="flex items-center gap-1 text-success">
          <Check className="size-3.5" />
          {t('status.done')}
        </span>
      )
      break
    case 'error':
      status = (
        <Tip content={<span className="selectable break-words">{tr.error}</span>}>
          <span className="flex min-w-0 items-center gap-1 text-danger">
            <CircleAlert className="size-3.5 shrink-0" />
            <span className="truncate">{tr.error ? `${t('status.error')}: ${tr.error}` : t('status.error')}</span>
          </span>
        </Tip>
      )
      break
    case 'skipped':
      status = <span className="text-warning">{t('status.skipped')}</span>
      break
    default:
      status = <span className="text-subtle">{t(`status.${tr.status}`)}</span>
  }

  return (
    <div
      className="group absolute inset-x-0 top-0 flex items-center gap-3 px-3 text-xs hover:bg-panel-hover"
      style={{ height: ROW_H, transform: `translateY(${start}px)` }}
      data-testid="sftp-transfer-row"
      data-status={tr.status}
    >
      <Tip content={t(`direction.${direction}`)}>
        <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-md', dirStyle.className)}>
          <DirIcon className="size-3.5" />
        </span>
      </Tip>
      <div className="flex min-w-0 flex-[1.3] items-center gap-2">
        <EntryIcon entry={{ name: tr.name, path: tr.srcPath, type: tr.isDir ? 'dir' : 'file' }} className="size-4 shrink-0" />
        <Tip content={<span className="font-mono">{`${tr.srcPath} → ${tr.dstPath}`}</span>}>
          <span className="truncate text-[13px] text-fg">{tr.name}</span>
        </Tip>
      </div>
      <div className="hidden min-w-0 flex-1 truncate text-muted @3xl:block">
        {srcLabel} → {dstLabel}
      </div>
      <div className="w-28 shrink-0 @2xl:w-36">{!tr.isDir && <ProgressBar value={pct} tone={tone} />}</div>
      <div className="hidden w-56 shrink-0 truncate tabular-nums text-muted @xl:block" data-testid="sftp-transfer-info">
        {info}
      </div>
      <div className="flex w-32 min-w-0 shrink-0 items-center">{status}</div>
      <div className="flex w-14 shrink-0 items-center justify-end gap-0.5">
        {active && (
          <Tip content={t('cancelTransfer')}>
            <Button size="icon-xs" variant="ghost" onClick={() => void call('transfer.cancel', tr.id).catch(() => {})} aria-label={t('cancelTransfer')} data-testid="sftp-transfer-cancel">
              <X />
            </Button>
          </Tip>
        )}
        {(tr.status === 'error' || tr.status === 'canceled') && (
          <Tip content={t('retryTransfer')}>
            <Button size="icon-xs" variant="ghost" onClick={() => void call('transfer.retry', tr.id).catch(() => {})} aria-label={t('retryTransfer')} data-testid="sftp-transfer-retry">
              <RotateCw />
            </Button>
          </Tip>
        )}
        {tr.status === 'done' && tr.dstFsId === 'local' && (
          <Tip content={t('showInFolder')}>
            <Button size="icon-xs" variant="ghost" className="opacity-0 group-hover:opacity-100" onClick={() => void call('app.showItemInFolder', tr.dstPath).catch(() => {})} aria-label={t('showInFolder')}>
              <FolderOpen />
            </Button>
          </Tip>
        )}
      </div>
    </div>
  )
})
