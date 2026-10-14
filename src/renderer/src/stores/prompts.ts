import { create } from 'zustand'
import type { PromptRequest, TransferInfo } from '@shared/types'
import { call, on } from '@/lib/api'

interface PromptState {
  queue: PromptRequest[]
}

export const usePrompts = create<PromptState>(() => ({ queue: [] }))

export function respondPrompt(id: string, response: unknown): void {
  usePrompts.setState((s) => ({ queue: s.queue.filter((p) => p.id !== id) }))
  void call('prompt.respond', id, response).catch(() => {})
}

interface TransferState {
  transfers: TransferInfo[]
  panelOpen: boolean
}

export const useTransfers = create<TransferState>(() => ({ transfers: [], panelOpen: false }))

export function initPromptsAndTransfers(): void {
  on('prompt.request', (req) => usePrompts.setState((s) => ({ queue: [...s.queue, req] })))
  on('prompt.cancel', ({ id }) => usePrompts.setState((s) => ({ queue: s.queue.filter((p) => p.id !== id) })))
  on('transfer.update', (transfers) => {
    const prev = useTransfers.getState().transfers
    const grew = transfers.length > prev.length
    useTransfers.setState({ transfers, ...(grew ? { panelOpen: true } : {}) })
  })
  void call('transfer.list').then((transfers) => useTransfers.setState({ transfers }))
}
