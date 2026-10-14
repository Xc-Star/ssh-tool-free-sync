import type { PromptRequest, PromptResponses } from '@shared/types'
import { uuidv7 } from '@shared/util'
import type { Emitter } from './emitter'

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
export type PromptInput = DistributiveOmit<PromptRequest, 'id'>

interface Pending {
  resolve: (value: unknown) => void
  sessionId?: string
}

/**
 * Asks the user something (host key, password, 2FA, conflict…) through the renderer and waits
 * for the answer. Resolves to null when cancelled.
 */
export class PromptService {
  private pending = new Map<string, Pending>()
  /** Test hook: answer prompts programmatically instead of asking the renderer. */
  autoResponder?: (req: PromptRequest) => unknown

  constructor(private readonly emitter: Emitter) {}

  ask<R extends PromptInput>(req: R): Promise<PromptResponses[R['type']] | null> {
    const id = uuidv7()
    const full = { ...req, id } as PromptRequest
    if (this.autoResponder) return Promise.resolve(this.autoResponder(full) as PromptResponses[R['type']] | null)
    return new Promise((resolve) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, sessionId: 'sessionId' in full ? full.sessionId : undefined })
      this.emitter.emit('prompt.request', full)
    })
  }

  respond(id: string, response: unknown): void {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    p.resolve(response ?? null)
  }

  cancel(id: string): void {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    this.emitter.emit('prompt.cancel', { id })
    p.resolve(null)
  }

  cancelForSession(sessionId: string): void {
    for (const [id, p] of this.pending) if (p.sessionId === sessionId) this.cancel(id)
  }

  cancelAll(): void {
    for (const id of [...this.pending.keys()]) this.cancel(id)
  }
}
