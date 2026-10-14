import type { Api, Events, SendChannels } from '@shared/ipc'
import type { Item, ItemKind, KindInput } from '@shared/schemas'

const bridge = window.sshtool

export class RpcError extends Error {
  code?: string
  constructor(message: string, code?: string) {
    super(message)
    this.name = 'RpcError'
    this.code = code
  }
}

/** Typed request/response call into the main process. */
export async function call<K extends keyof Api>(method: K, ...args: Parameters<Api[K]>): Promise<Awaited<ReturnType<Api[K]>>> {
  const res = await bridge.invoke(method, ...args)
  if (!res.ok) throw new RpcError(res.error.message, res.error.code)
  return res.value as Awaited<ReturnType<Api[K]>>
}

export function on<K extends keyof Events>(event: K, listener: (payload: Events[K]) => void): () => void {
  return bridge.on(event, listener as (p: unknown) => void)
}

export function send<C extends keyof SendChannels>(channel: C, ...args: SendChannels[C]): void {
  bridge.send(channel, ...args)
}

export function onSessionData(listener: (id: string, data: string) => void): () => void {
  return bridge.onSessionData(listener)
}

export function getPathForFile(file: File): string {
  return bridge.getPathForFile(file)
}

export const platform = bridge.platform
export const isMac = platform === 'darwin'
export const isWin = platform === 'win32'

/** Typed vault helpers. */
export const vaultApi = {
  upsert<K extends ItemKind>(kind: K, data: KindInput[K], opts?: { id?: string; localOnly?: boolean }): Promise<Item<K>> {
    return call('vault.upsert', kind, data as never, opts) as Promise<Item<K>>
  },
  reveal<K extends ItemKind>(id: string): Promise<Item<K> | null> {
    return call('vault.reveal', id) as Promise<Item<K> | null>
  },
  patch(id: string, patch: Record<string, unknown>): Promise<Item> {
    return call('vault.patch', id, patch)
  },
  remove(ids: string[]): Promise<void> {
    return call('vault.remove', ids)
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
