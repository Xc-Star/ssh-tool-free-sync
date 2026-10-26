import { describe, expect, it } from 'vitest'
import type { AiConfigInput } from '@shared/ai'
import { normalizeAiBaseUrl } from '@shared/ai'
import { SECRET_MASK } from '@shared/schemas'
import { AiConfigStore, buildProviderConfig } from '../../src/main/ai/config-store'
import { LocalDb } from '../../src/main/vault/db'
import type { SecretProtector } from '../../src/main/vault/keystore'

/** Prefix-based fake: available → xor-free marker; unavailable → plaintext passthrough. */
function fakeProtector(available = true): SecretProtector {
  return {
    available: () => available,
    backend: () => 'test',
    weak: () => !available,
    encrypt: (buf) => Buffer.concat([Buffer.from('E:'), buf]),
    decrypt: (buf) => {
      if (!buf.subarray(0, 2).equals(Buffer.from('E:'))) throw new Error('decrypt failed')
      return buf.subarray(2)
    }
  }
}

function makeStore(available = true): { store: AiConfigStore; db: LocalDb } {
  const db = new LocalDb(':memory:')
  return { store: new AiConfigStore(db, fakeProtector(available)), db }
}

const baseInput = (over: Partial<AiConfigInput> = {}): AiConfigInput => ({
  name: 'My DeepSeek',
  preset: 'deepseek',
  protocol: 'openai',
  baseUrl: 'https://api.deepseek.com/v1/',
  model: 'deepseek-chat',
  apiKey: 'sk-secret',
  ...over
})

describe('AiConfigStore', () => {
  it('round-trips a config and decrypts the stored API key', () => {
    const { store } = makeStore()
    const saved = store.save(baseInput())
    expect(saved.apiKey).toBe(SECRET_MASK)
    expect(saved.baseUrl).toBe('https://api.deepseek.com/v1') // trailing slash stripped
    expect(store.list()).toEqual([
      expect.objectContaining({ name: 'My DeepSeek', apiKey: 'sk-secret', authStyle: 'bearer' })
    ])
  })

  it('keeps the stored key when the input carries the mask', () => {
    const { store } = makeStore()
    const saved = store.save(baseInput())
    store.save({ ...baseInput(), id: saved.id, name: 'Renamed', apiKey: SECRET_MASK })
    expect(store.list()).toEqual([expect.objectContaining({ name: 'Renamed', apiKey: 'sk-secret' })])
  })

  it('replaces the key when a new value is sent, and clears it on empty string', () => {
    const { store } = makeStore()
    const saved = store.save(baseInput())
    store.save({ ...baseInput(), id: saved.id, apiKey: 'sk-new' })
    expect(store.get(saved.id)?.apiKey).toBe('sk-new')
    store.save({ ...baseInput(), id: saved.id, apiKey: '' })
    expect(store.get(saved.id)?.apiKey).toBe('')
  })

  it('falls back to plaintext storage when the OS keychain is unavailable', () => {
    const { store, db } = makeStore(false)
    const saved = store.save(baseInput())
    const raw = db.kvGetJson<any[]>('ai.configs')
    expect(raw?.[0].key).toEqual({ enc: false, v: 'sk-secret' })
    expect(store.get(saved.id)?.apiKey).toBe('sk-secret')
  })

  it('survives a keychain that cannot decrypt (key becomes empty, others keep working)', () => {
    const { store, db } = makeStore(true)
    const saved = store.save(baseInput())
    // Corrupt the stored blob as if the keychain refused to hand the key back.
    const raw = db.kvGetJson<any[]>('ai.configs')!
    raw[0].key.v = Buffer.from('garbage!').toString('base64')
    db.kvSetJson('ai.configs', raw)
    expect(store.get(saved.id)?.apiKey).toBe('')
  })

  it('removes configs and resolves the active one', () => {
    const { store } = makeStore()
    const a = store.save(baseInput())
    const b = store.save(baseInput({ name: 'Ollama', preset: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen3', apiKey: '' }))
    expect(store.resolveActive(undefined)?.id).toBe(a.id)
    expect(store.resolveActive(b.id)?.id).toBe(b.id)
    expect(store.resolveActive('missing')?.id).toBe(a.id)
    store.remove(a.id)
    expect(store.list().map((c) => c.id)).toEqual([b.id])
    expect(store.resolveActive(undefined)?.id).toBe(b.id)
  })

  it('validates required fields', () => {
    const { store } = makeStore()
    expect(() => store.save(baseInput({ baseUrl: '' }))).toThrow('Base URL is required')
    expect(() => store.save(baseInput({ model: '' }))).toThrow('Model is required')
    expect(() => store.save(baseInput({ name: '' }))).toThrow('Config name is required')
  })

  it('forRequest mode drops the name/model requirements (fetch-models needs no model yet)', () => {
    // Simulates the "获取模型" button on a fresh openai-compatible / custom form:
    // no name, no model — only the base URL is known.
    const cfg = buildProviderConfig(
      { name: '', preset: 'openai-compatible', protocol: 'openai', baseUrl: 'https://newapi.example.com', model: '', apiKey: 'sk-x' },
      undefined,
      { forRequest: true }
    )
    expect(cfg.baseUrl).toBe('https://newapi.example.com/v1')
    expect(cfg.model).toBe('')
    expect(cfg.name).toBe('')
    expect(cfg.apiKey).toBe('sk-x')
    // Base URL is still required even for requests.
    expect(() => buildProviderConfig({ name: '', preset: 'custom', protocol: 'openai', baseUrl: '', model: '', apiKey: '' }, undefined, { forRequest: true })).toThrow(
      'Base URL is required'
    )
    // Strict mode (saving) keeps requiring both.
    expect(() => buildProviderConfig({ name: '', preset: 'custom', protocol: 'openai', baseUrl: 'https://x.test', model: 'm', apiKey: '' })).toThrow('Config name is required')
    expect(() => buildProviderConfig({ name: 'n', preset: 'custom', protocol: 'openai', baseUrl: 'https://x.test', model: '', apiKey: '' })).toThrow('Model is required')
  })

  it('derives auth style from the preset when omitted', () => {
    const { store } = makeStore()
    const claude = store.save(baseInput({ name: 'Claude', preset: 'claude', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5' }))
    expect(store.get(claude.id)?.authStyle).toBe('x-api-key')
    const ollama = store.save(baseInput({ name: 'Local', preset: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen3', apiKey: '' }))
    expect(store.get(ollama.id)?.authStyle).toBe('none')
  })

  it('auto-appends /v1 to bare domains for the OpenAI protocol (new-api style gateways)', () => {
    const { store } = makeStore()
    const saved = store.save(baseInput({ name: 'GW', preset: 'openai-compatible', baseUrl: 'https://newapi.example.com' }))
    expect(store.get(saved.id)?.baseUrl).toBe('https://newapi.example.com/v1')
    // Explicit paths (e.g. zhipu) and URLs that already end in /v1 are untouched.
    const zhipu = store.save(baseInput({ name: 'Z', preset: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4/' }))
    expect(store.get(zhipu.id)?.baseUrl).toBe('https://open.bigmodel.cn/api/paas/v4')
    const trailing = store.save(baseInput({ name: 'T', baseUrl: 'https://api.test/v1/' }))
    expect(store.get(trailing.id)?.baseUrl).toBe('https://api.test/v1')
    // Anthropic endpoints hang off the bare domain; nothing is appended.
    const claude = store.save(baseInput({ name: 'C', preset: 'claude', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5' }))
    expect(store.get(claude.id)?.baseUrl).toBe('https://api.anthropic.com')
  })

  it('normalizes bare-domain configs saved before the /v1 auto-append existed', () => {
    const { store, db } = makeStore()
    // Simulate a legacy row: bare domain, no /v1.
    db.kvSetJson('ai.configs', [
      { id: 'legacy1', name: 'Old', preset: 'openai-compatible', protocol: 'openai', baseUrl: 'https://newapi.example.com', model: 'm1', authStyle: 'bearer', key: { enc: false, v: 'k' } }
    ])
    expect(store.get('legacy1')?.baseUrl).toBe('https://newapi.example.com/v1')
  })
})

describe('normalizeAiBaseUrl', () => {
  it('appends /v1 only for openai protocol bare domains', () => {
    expect(normalizeAiBaseUrl('https://gw.example.com', 'openai')).toBe('https://gw.example.com/v1')
    expect(normalizeAiBaseUrl('https://gw.example.com/', 'openai')).toBe('https://gw.example.com/v1')
    expect(normalizeAiBaseUrl('http://localhost:11434', 'openai')).toBe('http://localhost:11434/v1')
    expect(normalizeAiBaseUrl('https://gw.example.com/v1', 'openai')).toBe('https://gw.example.com/v1')
    expect(normalizeAiBaseUrl('https://open.bigmodel.cn/api/paas/v4', 'openai')).toBe('https://open.bigmodel.cn/api/paas/v4')
    expect(normalizeAiBaseUrl('https://api.anthropic.com', 'anthropic')).toBe('https://api.anthropic.com')
    expect(normalizeAiBaseUrl('not a url', 'openai')).toBe('not a url')
  })
})
