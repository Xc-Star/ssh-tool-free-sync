import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { SFTPWrapper } from 'ssh2'
import type { TransferInfo } from '@shared/types'
import { uuidv7 } from '@shared/util'
import type { Emitter } from '../services/emitter'
import type { PromptService } from '../services/prompts'
import type { SettingsService } from '../services/settings'
import type { FsService } from './fs-service'
import type { FsAdapter } from './fs-types'
import { SftpFs } from './sftp-fs'

interface Task extends TransferInfo {
  parentId?: string
  mode: number
  mtime: number
  abort?: () => void
  lastBytes: number
  lastTick: number
}

interface Batch {
  id: string
  dstFsId: string
  dstDir: string
  decision?: 'overwrite' | 'skip' | 'rename'
  promptChain: Promise<unknown>
}

class CanceledError extends Error {
  constructor() {
    super('Canceled')
  }
}

/** Upload / download / remote-to-remote transfer queue with concurrency and conflict handling. */
export class TransferQueue {
  private tasks: Task[] = []
  private batches = new Map<string, Batch>()
  private running = 0
  private updateTimer: NodeJS.Timeout | null = null
  private speedTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly fsService: FsService,
    private readonly emitter: Emitter,
    private readonly prompts: PromptService,
    private readonly settings: SettingsService
  ) {}

  list(): TransferInfo[] {
    return this.tasks.map(publicInfo)
  }

  async enqueue(req: { srcFsId: string; srcPaths: string[]; dstFsId: string; dstDir: string }): Promise<string> {
    const src = this.fsService.get(req.srcFsId)
    const dst = this.fsService.get(req.dstFsId)
    const batchId = uuidv7()
    this.batches.set(batchId, { id: batchId, dstFsId: req.dstFsId, dstDir: req.dstDir, promptChain: Promise.resolve() })
    const parentListing = new Map<string, Awaited<ReturnType<FsAdapter['list']>>>()
    for (const p of req.srcPaths) {
      const parent = src.dirname(p)
      let entry
      try {
        if (!parentListing.has(parent)) parentListing.set(parent, await src.list(parent))
        entry = parentListing.get(parent)!.find((e) => e.path === p || e.name === src.basename(p))
      } catch {
        entry = undefined
      }
      entry ??= await src.stat(p)
      const isDir = entry.type === 'dir' || (entry.type === 'symlink' && entry.targetType === 'dir')
      this.tasks.push(this.makeTask(batchId, src, dst, p, dst.join(req.dstDir, entry.name), entry.name, isDir, entry.size, entry.mode, entry.mtime))
    }
    this.pump()
    return batchId
  }

  private makeTask(
    batchId: string,
    src: FsAdapter,
    dst: FsAdapter,
    srcPath: string,
    dstPath: string,
    name: string,
    isDir: boolean,
    size: number,
    mode: number,
    mtime: number,
    parentId?: string
  ): Task {
    return {
      id: uuidv7(),
      batchId,
      parentId,
      srcFsId: src.id,
      dstFsId: dst.id,
      srcLabel: src.label,
      dstLabel: dst.label,
      srcPath,
      dstPath,
      name,
      isDir,
      size: isDir ? 0 : size,
      transferred: 0,
      speed: 0,
      status: 'queued',
      mode,
      mtime,
      lastBytes: 0,
      lastTick: Date.now()
    }
  }

  cancel(id: string): void {
    const t = this.tasks.find((x) => x.id === id)
    if (!t) return
    const cancelOne = (task: Task): void => {
      if (task.status === 'queued' || task.status === 'running') {
        task.status = 'canceled'
        task.endedAt = Date.now()
        task.abort?.()
      }
    }
    cancelOne(t)
    // cancel queued descendants of a directory task
    const ids = new Set([t.id])
    for (const task of this.tasks) {
      if (task.parentId && ids.has(task.parentId)) {
        ids.add(task.id)
        cancelOne(task)
      }
    }
    this.scheduleUpdate()
  }

  retry(id: string): void {
    const t = this.tasks.find((x) => x.id === id)
    if (!t || !['error', 'canceled'].includes(t.status)) return
    t.status = 'queued'
    t.error = undefined
    t.transferred = 0
    t.speed = 0
    t.endedAt = undefined
    this.pump()
  }

  clear(): void {
    this.tasks = this.tasks.filter((t) => t.status === 'queued' || t.status === 'running')
    for (const id of [...this.batches.keys()]) if (!this.tasks.some((t) => t.batchId === id)) this.batches.delete(id)
    this.scheduleUpdate()
  }

  cancelAll(): void {
    for (const t of this.tasks) if (t.status === 'queued' || t.status === 'running') this.cancel(t.id)
  }

  private pump(): void {
    const limit = this.settings.get().sftp.concurrency
    while (this.running < limit) {
      const next = this.tasks.find((t) => t.status === 'queued')
      if (!next) break
      this.running++
      next.status = 'running'
      next.startedAt = Date.now()
      next.lastTick = Date.now()
      next.lastBytes = 0
      void this.run(next).finally(() => {
        this.running--
        this.pump()
      })
    }
    this.ensureSpeedTimer()
    this.scheduleUpdate()
  }

  private async run(t: Task): Promise<void> {
    try {
      const src = this.fsService.get(t.srcFsId)
      const dst = this.fsService.get(t.dstFsId)
      if (t.isDir) await this.runDir(t, src, dst)
      else await this.runFile(t, src, dst)
      if (t.status === 'running') {
        t.status = 'done'
        if (!t.isDir) t.transferred = t.size
      }
    } catch (err) {
      if (t.status !== 'canceled') {
        t.status = 'error'
        t.error = (err as Error).message
      }
    } finally {
      t.endedAt = Date.now()
      t.abort = undefined
      this.scheduleUpdate()
      this.checkBatchDone(t.batchId)
    }
  }

  private checkBatchDone(batchId: string): void {
    if (this.tasks.some((t) => t.batchId === batchId && (t.status === 'queued' || t.status === 'running'))) return
    const b = this.batches.get(batchId)
    if (b) this.emitter.emit('fs.changed', { fsId: b.dstFsId, dir: b.dstDir })
  }

  private async runDir(t: Task, src: FsAdapter, dst: FsAdapter): Promise<void> {
    const existing = await dst.exists(t.dstPath)
    if (existing && existing.type !== 'dir') throw new Error('A file with the same name already exists')
    if (!existing) await dst.mkdir(t.dstPath)
    const children = await src.list(t.srcPath)
    const idx = this.tasks.indexOf(t)
    const childTasks = children
      .filter((c) => c.type !== 'other')
      .map((c) => {
        const isDir = c.type === 'dir' || (c.type === 'symlink' && c.targetType === 'dir')
        return this.makeTask(t.batchId, src, dst, c.path, dst.join(t.dstPath, c.name), c.name, isDir, c.size, c.mode, c.mtime, t.id)
      })
    this.tasks.splice(idx + 1, 0, ...childTasks)
    t.size = 0
  }

  private async decide(t: Task, dst: FsAdapter, srcSize: number): Promise<'overwrite' | 'skip' | 'rename' | null> {
    const existing = await dst.exists(t.dstPath)
    if (!existing) return null
    if (existing.type === 'dir') throw new Error('A folder with the same name already exists')
    const batch = this.batches.get(t.batchId)!
    if (batch.decision) return batch.decision
    const policy = this.settings.get().sftp.conflictPolicy
    if (policy !== 'ask') return policy
    const p = batch.promptChain.then(async () => {
      if (batch.decision) return batch.decision
      const r = await this.prompts.ask({
        type: 'conflict',
        fileName: t.name,
        dstPath: t.dstPath,
        srcSize,
        dstSize: existing.size,
        srcMtime: t.mtime,
        dstMtime: existing.mtime
      })
      if (!r) return 'skip' as const
      if (r.applyToAll) batch.decision = r.action
      return r.action
    })
    batch.promptChain = p.catch(() => undefined)
    return p
  }

  private async uniqueName(dst: FsAdapter, p: string): Promise<string> {
    const dir = dst.dirname(p)
    const base = dst.basename(p)
    const dot = base.lastIndexOf('.')
    const stem = dot > 0 ? base.slice(0, dot) : base
    const ext = dot > 0 ? base.slice(dot) : ''
    for (let i = 1; i < 1000; i++) {
      const candidate = dst.join(dir, `${stem} (${i})${ext}`)
      if (!(await dst.exists(candidate))) return candidate
    }
    throw new Error('Could not find a free file name')
  }

  private async runFile(t: Task, src: FsAdapter, dst: FsAdapter): Promise<void> {
    const decision = await this.decide(t, dst, t.size)
    if ((t.status as string) === 'canceled') throw new CanceledError()
    if (decision === 'skip') {
      t.status = 'skipped'
      return
    }
    if (decision === 'rename') {
      t.dstPath = await this.uniqueName(dst, t.dstPath)
      t.name = dst.basename(t.dstPath)
    }
    if (t.srcFsId === t.dstFsId && t.srcPath === t.dstPath) throw new Error('Source and destination are the same')

    if (src.kind === 'local' && dst instanceof SftpFs) {
      await this.withChannel(t, dst, (ch, done) =>
        ch.fastPut(t.srcPath, t.dstPath, { step: (n) => (t.transferred = n), mode: t.mode || 0o644 }, done)
      )
    } else if (src instanceof SftpFs && dst.kind === 'local') {
      await this.withChannel(t, src, (ch, done) => ch.fastGet(t.srcPath, t.dstPath, { step: (n) => (t.transferred = n) }, done))
    } else {
      const rs = await src.createReadStream(t.srcPath)
      const ws = await dst.createWriteStream(t.dstPath, t.mode || 0o644)
      const counter = new Transform({
        transform: (chunk: Buffer, _enc, cb) => {
          t.transferred += chunk.length
          cb(null, chunk)
        }
      })
      t.abort = () => rs.destroy(new CanceledError())
      await pipeline(rs, counter, ws)
    }
    if (t.mtime && dst.utimes) await dst.utimes(t.dstPath, t.mtime, t.mtime).catch(() => {})
  }

  /** Runs a fast transfer on a dedicated SFTP channel so it can be aborted. */
  private async withChannel(t: Task, fsys: SftpFs, fn: (ch: SFTPWrapper, done: (err?: Error | null) => void) => void): Promise<void> {
    const ch = await fsys.openChannel()
    try {
      await new Promise<void>((resolve, reject) => {
        t.abort = () => {
          try {
            ch.end()
          } catch {
            // ignore
          }
          reject(new CanceledError())
        }
        fn(ch, (err) => (err ? reject(err) : resolve()))
      })
    } finally {
      try {
        ch.end()
      } catch {
        // ignore
      }
    }
  }

  private ensureSpeedTimer(): void {
    if (this.speedTimer) return
    this.speedTimer = setInterval(() => {
      const now = Date.now()
      let active = false
      for (const t of this.tasks) {
        if (t.status !== 'running') continue
        active = true
        const dt = (now - t.lastTick) / 1000
        if (dt > 0) t.speed = Math.max(0, (t.transferred - t.lastBytes) / dt)
        t.lastBytes = t.transferred
        t.lastTick = now
      }
      this.scheduleUpdate()
      if (!active && this.speedTimer) {
        clearInterval(this.speedTimer)
        this.speedTimer = null
      }
    }, 500)
  }

  private scheduleUpdate(): void {
    if (this.updateTimer) return
    this.updateTimer = setTimeout(() => {
      this.updateTimer = null
      this.emitter.emit('transfer.update', this.list())
    }, 150)
  }

  /** Waits until no task is queued or running (tests). */
  async idle(timeoutMs = 60_000): Promise<void> {
    const start = Date.now()
    while (this.tasks.some((t) => t.status === 'queued' || t.status === 'running')) {
      if (Date.now() - start > timeoutMs) throw new Error('transfer queue timeout')
      await new Promise((r) => setTimeout(r, 50))
    }
  }
}

function publicInfo(t: Task): TransferInfo {
  return {
    id: t.id,
    batchId: t.batchId,
    srcFsId: t.srcFsId,
    dstFsId: t.dstFsId,
    srcLabel: t.srcLabel,
    dstLabel: t.dstLabel,
    srcPath: t.srcPath,
    dstPath: t.dstPath,
    name: t.name,
    isDir: t.isDir,
    size: t.size,
    transferred: t.transferred,
    speed: t.speed,
    status: t.status,
    error: t.error,
    startedAt: t.startedAt,
    endedAt: t.endedAt
  }
}
