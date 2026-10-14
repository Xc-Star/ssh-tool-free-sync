import { create } from 'zustand'
import { ITEM_KINDS, type Item, type ItemKind, PREF_ITEM_ID, terminalPrefsSchema, type TerminalPrefs } from '@shared/schemas'
import { call, on } from '@/lib/api'

type ItemsByKind = { [K in ItemKind]: Item<K>[] }

interface VaultState {
  items: ItemsByKind
  loaded: boolean
}

const empty = Object.fromEntries(ITEM_KINDS.map((k) => [k, []])) as unknown as ItemsByKind

export const useVault = create<VaultState>(() => ({ items: empty, loaded: false }))

async function loadKinds(kinds: readonly ItemKind[]): Promise<void> {
  const results = await Promise.all(kinds.map((k) => call('vault.list', k).catch(() => [] as Item[])))
  useVault.setState((s) => {
    const items = { ...s.items }
    kinds.forEach((k, i) => {
      ;(items as Record<ItemKind, Item[]>)[k] = results[i]
    })
    return { items, loaded: true }
  })
}

export async function initVault(): Promise<void> {
  on('vault.changed', ({ kinds }) => void loadKinds(kinds))
  on('lock.changed', (lock) => {
    if (lock.locked) useVault.setState({ items: empty, loaded: false })
    else void loadKinds(ITEM_KINDS)
  })
  const lock = await call('lock.status')
  if (!lock.locked) await loadKinds(ITEM_KINDS)
}

export function useItems<K extends ItemKind>(kind: K): Item<K>[] {
  return useVault((s) => s.items[kind]) as Item<K>[]
}

export function getItems<K extends ItemKind>(kind: K): Item<K>[] {
  return useVault.getState().items[kind] as Item<K>[]
}

export function getItem<K extends ItemKind>(kind: K, id: string | undefined): Item<K> | undefined {
  if (!id) return undefined
  return getItems(kind).find((i) => i.id === id)
}

export function useItem<K extends ItemKind>(kind: K, id: string | undefined): Item<K> | undefined {
  return useVault((s) => (id ? (s.items[kind] as Item<K>[]).find((i) => i.id === id) : undefined))
}

const defaultPrefs = terminalPrefsSchema.parse({})

export function useTerminalPrefs(): TerminalPrefs {
  const pref = useVault((s) => s.items.pref.find((p) => p.id === PREF_ITEM_ID))
  return pref?.data.terminal ? { ...defaultPrefs, ...pref.data.terminal } : defaultPrefs
}

export function getTerminalPrefs(): TerminalPrefs {
  const pref = useVault.getState().items.pref.find((p) => p.id === PREF_ITEM_ID)
  return pref?.data.terminal ? { ...defaultPrefs, ...pref.data.terminal } : defaultPrefs
}

export async function saveTerminalPrefs(patch: Partial<TerminalPrefs>): Promise<void> {
  const pref = useVault.getState().items.pref.find((p) => p.id === PREF_ITEM_ID)
  const terminal = { ...getTerminalPrefs(), ...patch }
  await call('vault.upsert', 'pref', { ...(pref?.data ?? {}), terminal }, { id: PREF_ITEM_ID })
}

export function useShortcutOverrides(): Record<string, string> {
  return useVault((s) => s.items.pref.find((p) => p.id === PREF_ITEM_ID)?.data.shortcuts) ?? {}
}

export async function saveShortcutOverrides(shortcuts: Record<string, string>): Promise<void> {
  const pref = useVault.getState().items.pref.find((p) => p.id === PREF_ITEM_ID)
  await call('vault.upsert', 'pref', { ...(pref?.data ?? {}), shortcuts }, { id: PREF_ITEM_ID })
}
