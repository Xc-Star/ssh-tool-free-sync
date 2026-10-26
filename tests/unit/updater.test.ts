import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryEmitter } from '../../src/main/services/emitter'
import { UpdateService } from '../../src/main/services/updater'
import { DEFAULT_SETTINGS, type LocalSettings } from '../../src/shared/types'

const API_URL = 'https://api.github.com/repos/Xc-Star/ssh-tool-free-sync/releases/latest'
const ATOM_URL = 'https://github.com/Xc-Star/ssh-tool-free-sync/releases.atom'
const TAG_URL = (tag: string): string => `https://github.com/Xc-Star/ssh-tool-free-sync/releases/tag/${tag}`

function releaseResponse(tag: string): Response {
  return { ok: true, status: 200, json: async () => ({ tag_name: tag, html_url: TAG_URL(tag) }) } as unknown as Response
}

function atomResponse(...tags: string[]): Response {
  const entries = tags
    .map((tag) => `  <entry><link rel="alternate" type="text/html" href="${TAG_URL(tag)}"/><title>SSH Tool ${tag}</title></entry>`)
    .join('\n')
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Release notes</title>\n${entries}\n</feed>`
  return { ok: true, status: 200, text: async () => xml } as unknown as Response
}

function httpResponse(status: number): Response {
  return { ok: false, status, json: async () => ({}), text: async () => '' } as unknown as Response
}

function makeService(opts: {
  appVersion?: string
  autoCheckUpdates?: boolean
  initialDelayMs?: number
  intervalMs?: number
  api?: () => Promise<Response>
  atom?: () => Promise<Response>
} = {}): { svc: UpdateService; emitter: MemoryEmitter; calls: string[]; settings: LocalSettings } {
  const emitter = new MemoryEmitter()
  const settings: LocalSettings = { ...DEFAULT_SETTINGS, autoCheckUpdates: opts.autoCheckUpdates ?? true }
  const calls: string[] = []
  const svc = new UpdateService({
    appVersion: opts.appVersion ?? '1.2.3',
    getSettings: () => settings,
    emitter,
    initialDelayMs: opts.initialDelayMs,
    intervalMs: opts.intervalMs,
    fetchImpl: (url) => {
      const u = String(url)
      calls.push(u)
      return u === ATOM_URL
        ? (opts.atom ? opts.atom() : Promise.resolve(atomResponse('v1.2.3')))
        : (opts.api ? opts.api() : Promise.resolve(releaseResponse('v1.2.3')))
    }
  })
  return { svc, emitter, calls, settings }
}

describe('UpdateService.checkNow', () => {
  it('reports and emits an available update, stripping the v prefix', async () => {
    const { svc, emitter } = makeService({ api: () => Promise.resolve(releaseResponse('v1.3.0')) })
    await expect(svc.checkNow()).resolves.toEqual({
      status: 'available',
      version: '1.3.0',
      url: TAG_URL('v1.3.0'),
      currentVersion: '1.2.3'
    })
    expect(emitter.events).toEqual([
      { event: 'update.available', payload: { version: '1.3.0', url: TAG_URL('v1.3.0') } }
    ])
  })

  it('compares numerically, not lexicographically', async () => {
    const { svc } = makeService({ appVersion: '0.1.9', api: () => Promise.resolve(releaseResponse('v0.1.10')) })
    await expect(svc.checkNow()).resolves.toMatchObject({ status: 'available', version: '0.1.10' })
  })

  it.each([
    ['same version', 'v1.2.3'],
    ['older version', 'v1.2.2'],
    ['prerelease tag', 'v1.3.0-beta.1'],
    ['non-version tag', 'latest'],
    ['missing tag', undefined]
  ])('treats %s as up-to-date', async (_name, tag) => {
    const { svc, emitter } = makeService({
      api: () =>
        Promise.resolve({ ok: true, status: 200, json: async () => ({ tag_name: tag }) } as unknown as Response)
    })
    await expect(svc.checkNow()).resolves.toEqual({ status: 'up-to-date', currentVersion: '1.2.3' })
    expect(emitter.events).toEqual([])
  })

  it('falls back to the Atom feed when the API is rate limited', async () => {
    const { svc, emitter, calls } = makeService({
      api: () => Promise.resolve(httpResponse(403)),
      atom: () => Promise.resolve(atomResponse('v1.3.0'))
    })
    await expect(svc.checkNow()).resolves.toMatchObject({ status: 'available', version: '1.3.0', url: TAG_URL('v1.3.0') })
    expect(calls).toEqual([API_URL, ATOM_URL])
    expect(emitter.events).toHaveLength(1)
  })

  it('skips prerelease entries in the Atom feed', async () => {
    const { svc } = makeService({
      api: () => Promise.reject(new TypeError('fetch failed')),
      atom: () => Promise.resolve(atomResponse('v1.3.0-beta.1', 'v1.2.9', 'v1.2.3'))
    })
    await expect(svc.checkNow()).resolves.toMatchObject({ status: 'available', version: '1.2.9' })
  })

  it('reports unavailable instead of an error when both channels fail', async () => {
    const { svc, emitter } = makeService({
      api: () => Promise.resolve(httpResponse(403)),
      atom: () => Promise.resolve(httpResponse(403))
    })
    await expect(svc.checkNow()).resolves.toEqual({ status: 'unavailable', currentVersion: '1.2.3' })
    expect(emitter.events).toEqual([])
  })

  it('reports unavailable when the network is down', async () => {
    const { svc } = makeService({
      api: () => Promise.reject(new TypeError('fetch failed')),
      atom: () => Promise.reject(new TypeError('fetch failed'))
    })
    await expect(svc.checkNow()).resolves.toEqual({ status: 'unavailable', currentVersion: '1.2.3' })
  })

  it('notifies a version only once', async () => {
    const { svc, emitter } = makeService({ api: () => Promise.resolve(releaseResponse('v1.3.0')) })
    await svc.checkNow()
    await svc.checkNow()
    expect(emitter.events).toHaveLength(1)
  })

  it('runs even when autoCheckUpdates is off', async () => {
    const { svc, calls } = makeService({ autoCheckUpdates: false, api: () => Promise.resolve(releaseResponse('v1.3.0')) })
    await expect(svc.checkNow()).resolves.toMatchObject({ status: 'available' })
    expect(calls).toEqual([API_URL])
  })
})

describe('UpdateService background loop', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('checks once after the initial delay, then on the interval', async () => {
    const { svc, calls } = makeService({ initialDelayMs: 100, intervalMs: 200 })
    svc.start()
    expect(calls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(100)
    expect(calls).toEqual([API_URL])
    await vi.advanceTimersByTimeAsync(200)
    expect(calls).toEqual([API_URL, API_URL])
    svc.stop()
  })

  it('emits update.available when the background check finds a newer release', async () => {
    const { svc, emitter } = makeService({ initialDelayMs: 100, api: () => Promise.resolve(releaseResponse('v2.0.0')) })
    svc.start()
    await vi.advanceTimersByTimeAsync(100)
    expect(emitter.events).toEqual([{ event: 'update.available', payload: { version: '2.0.0', url: TAG_URL('v2.0.0') } }])
    svc.stop()
  })

  it('does not fetch while autoCheckUpdates is off', async () => {
    const { svc, calls, settings } = makeService({ autoCheckUpdates: true, initialDelayMs: 100, intervalMs: 200 })
    settings.autoCheckUpdates = false
    svc.start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls).toHaveLength(0)
    svc.stop()
  })

  it('stays silent on background failures and keeps the loop alive', async () => {
    const { svc, emitter, calls } = makeService({
      initialDelayMs: 100,
      intervalMs: 200,
      api: () => Promise.reject(new TypeError('fetch failed')),
      atom: () => Promise.reject(new TypeError('fetch failed'))
    })
    svc.start()
    await vi.advanceTimersByTimeAsync(100)
    expect(emitter.events).toEqual([])
    await vi.advanceTimersByTimeAsync(200)
    expect(calls).toEqual([API_URL, ATOM_URL, API_URL, ATOM_URL])
    svc.stop()
  })

  it('stop() cancels the pending first check', async () => {
    const { svc, calls } = makeService({ initialDelayMs: 100 })
    svc.start()
    svc.stop()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(calls).toHaveLength(0)
  })
})
