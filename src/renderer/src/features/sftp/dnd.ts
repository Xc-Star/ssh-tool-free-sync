import type { PaneId } from './store'
import type { Flavor } from './utils'

/** MIME type of rows dragged between the two panes. */
export const DRAG_MIME = 'application/x-sshtool-sftp'

export interface DragPayload {
  paneId: PaneId
  fsId: string
  dir: string
  flavor: Flavor
  paths: string[]
}

// dataTransfer contents can't be read during dragover, so the active drag is also kept here.
let current: DragPayload | null = null

export function startDrag(e: React.DragEvent, payload: DragPayload, label: string): void {
  current = payload
  e.dataTransfer.effectAllowed = 'copy'
  e.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload))
  const ghost = document.createElement('div')
  ghost.textContent = label
  ghost.style.cssText =
    'position:fixed;top:-1000px;left:-1000px;padding:4px 10px;border-radius:6px;font:500 12px system-ui,sans-serif;' +
    'background:var(--c-accent);color:#fff;box-shadow:0 4px 12px rgba(0,0,0,.25);white-space:nowrap;max-width:320px;overflow:hidden;text-overflow:ellipsis'
  document.body.appendChild(ghost)
  e.dataTransfer.setDragImage(ghost, -12, -8)
  setTimeout(() => ghost.remove(), 0)
}

export function endDrag(): void {
  current = null
}

export function currentDrag(): DragPayload | null {
  return current
}

export function isPaneDrag(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes(DRAG_MIME)
}

export function isOsFileDrag(e: React.DragEvent): boolean {
  return !isPaneDrag(e) && e.dataTransfer.types.includes('Files')
}
