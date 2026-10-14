import { SECRET_MASK, SECRET_PATHS, type Item, type ItemKind } from '@shared/schemas'

function getPath(obj: any, path: string): unknown {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
}

function setPath(obj: any, path: string, value: unknown): void {
  const keys = path.split('.')
  let o = obj
  for (let i = 0; i < keys.length - 1; i++) {
    if (o[keys[i]] == null || typeof o[keys[i]] !== 'object') return
    o = o[keys[i]]
  }
  const last = keys[keys.length - 1]
  if (value === undefined) delete o[last]
  else o[last] = value
}

/** Returns a copy of the item whose secret fields are replaced by SECRET_MASK. */
export function maskItem<T extends Item>(item: T): T {
  const paths = SECRET_PATHS[item.kind]
  if (!paths) return item
  const data = structuredClone(item.data)
  for (const p of paths) {
    const v = getPath(data, p)
    if (typeof v === 'string' && v.length > 0) setPath(data, p, SECRET_MASK)
  }
  return { ...item, data }
}

/** Restores masked secret fields of `incoming` from `existing` (a masked value means "unchanged"). */
export function unmaskData(kind: ItemKind, incoming: any, existing: any | undefined): any {
  const paths = SECRET_PATHS[kind]
  if (!paths) return incoming
  const out = structuredClone(incoming)
  for (const p of paths) {
    if (getPath(out, p) === SECRET_MASK) setPath(out, p, existing ? getPath(existing, p) : undefined)
  }
  return out
}

/** Removes any lingering masks (defensive: a mask must never be persisted). */
export function stripMasks(kind: ItemKind, data: any): any {
  const paths = SECRET_PATHS[kind]
  if (!paths) return data
  for (const p of paths) if (getPath(data, p) === SECRET_MASK) setPath(data, p, undefined)
  return data
}
