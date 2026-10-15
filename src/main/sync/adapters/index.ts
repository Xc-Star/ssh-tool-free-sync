import type { SyncDbConfig } from '@shared/types'
import { SyncAdapterError, type SyncAdapter } from '../adapter'
import { D1Adapter, d1Label } from './d1'
import { MysqlAdapter, mysqlLabel } from './mysql'
import { PostgresAdapter, postgresLabel } from './postgres'
import { WebdavAdapter, webdavLabel } from './webdav'

export { D1Adapter, MysqlAdapter, PostgresAdapter, WebdavAdapter }

export function createAdapter(config: SyncDbConfig): SyncAdapter {
  switch (config.kind) {
    case 'postgres':
      return new PostgresAdapter(config)
    case 'mysql':
      return new MysqlAdapter(config)
    case 'd1':
      return new D1Adapter(config)
    case 'webdav':
      return new WebdavAdapter(config)
    default:
      throw new SyncAdapterError(
        'config',
        `Unsupported sync database type: ${String((config as { kind?: unknown }).kind)}`
      )
  }
}

/** Human readable target without secrets (the same text as `SyncAdapter.label`). */
export function describeDbConfig(config: SyncDbConfig): string {
  switch (config.kind) {
    case 'postgres':
      return postgresLabel(config)
    case 'mysql':
      return mysqlLabel(config)
    case 'd1':
      return d1Label(config)
    case 'webdav':
      return webdavLabel(config)
    default:
      return 'Unknown database'
  }
}
