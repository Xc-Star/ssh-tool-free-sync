import type { EventName, Events } from '@shared/ipc'

/** Pushes events to the renderer (Electron) or to test listeners. */
export interface Emitter {
  emit<K extends EventName>(event: K, payload: Events[K]): void
  sessionData(id: string, data: string): void
}

/** In-memory emitter used by tests and as a fallback. */
export class MemoryEmitter implements Emitter {
  readonly events: { event: EventName; payload: unknown }[] = []
  readonly data = new Map<string, string>()
  private listeners = new Map<string, Set<(payload: unknown) => void>>()

  emit<K extends EventName>(event: K, payload: Events[K]): void {
    this.events.push({ event, payload })
    for (const l of this.listeners.get(event) ?? []) l(payload)
  }

  sessionData(id: string, data: string): void {
    this.data.set(id, (this.data.get(id) ?? '') + data)
    for (const l of this.listeners.get(`data:${id}`) ?? []) l(data)
  }

  on<K extends EventName>(event: K | `data:${string}`, listener: (payload: K extends EventName ? Events[K] : string) => void): () => void {
    const set = this.listeners.get(event) ?? new Set()
    set.add(listener as (p: unknown) => void)
    this.listeners.set(event, set)
    return () => set.delete(listener as (p: unknown) => void)
  }
}
