import { describe, expect, it, vi } from 'vitest'
import { AI_DECLINED_RESULT } from '@shared/ai'
import { AiService, type AiServiceDeps } from '../../src/main/ai/agent'
import { AiConfigStore } from '../../src/main/ai/config-store'
import type { FetchImpl } from '../../src/main/ai/providers'
import { MemoryEmitter } from '../../src/main/services/emitter'
import type { SettingsService } from '../../src/main/services/settings'
import { LocalDb } from '../../src/main/vault/db'
import type { SecretProtector } from '../../src/main/vault/keystore'
import type { ConnectionPool } from '../../src/main/ssh/pool'
import type { SessionManager } from '../../src/main/sessions/session-manager'
import { DEFAULT_SETTINGS, type LocalSettings } from '../../src/shared/types'

// ---------------------------------------------------------------- fakes

const protector: SecretProtector = {
  available: () => true,
  backend: () => 'test',
  weak: () => false,
  encrypt: (buf) => Buffer.concat([Buffer.from('E:'), buf]),
  decrypt: (buf) => buf.subarray(2)
}

function sse(...chunks: string[]): Response {
  const enc = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(enc.encode(chunk))
      c.close()
    }
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const openAiText = (text: string): Response =>
  sse(`data: {"choices":[{"delta":{"content":${JSON.stringify(text)}}}]}\n\n`, 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n', 'data: [DONE]\n\n')

const openAiToolCall = (id: string, name: string, args: unknown): Response =>
  sse(
    `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"${id}","function":{"name":"${name}","arguments":""}}]}}]}\n\n`,
    `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":${JSON.stringify(JSON.stringify(args))}}}]}}]}\n\n`,
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n'
  )

interface Fixture {
  svc: AiService
  emitter: MemoryEmitter
  fetchImpl: ReturnType<typeof vi.fn>
  settings: LocalSettings
  exec: ReturnType<typeof vi.fn>
  poolAcquire: ReturnType<typeof vi.fn>
  captureWrite: ReturnType<typeof vi.fn>
}

function makeFixture(opts: {
  responses: Response[]
  ai?: Partial<LocalSettings['ai']>
  sessionConnected?: boolean
  hostId?: string
  kind?: string
  withConfig?: boolean
}): Fixture {
  const emitter = new MemoryEmitter()
  const db = new LocalDb(':memory:')
  const store = new AiConfigStore(db, protector)
  if (opts.withConfig !== false) {
    store.save({ name: 't', preset: 'custom', protocol: 'openai', baseUrl: 'https://api.test/v1', model: 'm1', apiKey: 'k', authStyle: 'none' })
  }
  const settings: LocalSettings = { ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, ...opts.ai } }
  const exec = vi.fn(async () => ({ code: 0, stdout: 'total 0\n', stderr: '' }))
  const conn = { exec }
  const captureWrite = vi.fn(async () => 'password prompt\n[sudo] password:')
  const session = {
    info: { id: 's1', kind: opts.kind ?? 'ssh', title: 'web-1', status: 'connected', startedAt: 0, hostId: opts.hostId, osHint: 'linux' },
    ...(opts.sessionConnected === false ? {} : { connection: conn }),
    captureWrite
  }
  const sessions = { get: (id: string) => (id === 's1' ? session : undefined) } as unknown as SessionManager
  const poolAcquire = vi.fn(async () => ({ conn, release: () => {} }))
  const pool = { acquire: poolAcquire } as unknown as ConnectionPool
  const fetchImpl = vi.fn(async () => {
    const res = opts.responses.shift()
    if (!res) throw new Error('no scripted response left')
    return res
  })
  const deps: AiServiceDeps = {
    store,
    settings: { get: () => settings } as unknown as SettingsService,
    sessions,
    pool,
    emitter,
    fetchImpl: fetchImpl as unknown as FetchImpl
  }
  return { svc: new AiService(deps), emitter, fetchImpl, settings, exec, poolAcquire, captureWrite }
}

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`timeout waiting for ${what}`)
}

const doneEvents = (f: Fixture) => f.emitter.events.filter((e) => e.event === 'ai.done')
const eventsOf = <P = any>(f: Fixture, name: string): P[] => f.emitter.events.filter((e) => e.event === name).map((e) => e.payload as P)

function chat(f: Fixture): void {
  f.svc.chat({ conversationId: 'conv1', sessionId: 's1', messages: [{ role: 'user', content: 'list files' }] })
}

// ---------------------------------------------------------------- tests

describe('AiService agent loop', () => {
  it('runs a tool call end to end: confirm → exec → tool result → final answer', async () => {
    const f = makeFixture({ responses: [openAiToolCall('c1', 'run_command', { command: 'ls' }), openAiText('All good')] })
    chat(f)
    await until(() => eventsOf(f, 'ai.confirm').length === 1, 'confirm event')
    const confirm = eventsOf<{ confirmId: string; callId: string; name: string; args: Record<string, unknown> }>(f, 'ai.confirm')[0]
    expect(confirm.name).toBe('run_command')
    expect(confirm.args).toEqual({ command: 'ls' })
    expect(f.exec).not.toHaveBeenCalled() // nothing runs before approval

    f.svc.resolveConfirm(confirm.confirmId, true)
    await until(() => doneEvents(f).length === 1, 'done event')

    expect(f.exec).toHaveBeenCalledWith('ls', expect.objectContaining({ timeoutMs: 120_000 }))
    const toolResult = eventsOf<{ callId: string; ok: boolean; result: string }>(f, 'ai.toolResult')[0]
    expect(toolResult.ok).toBe(true)
    expect(toolResult.result).toContain('exit code: 0')
    expect(toolResult.result).toContain('total 0')
    expect(eventsOf(f, 'ai.delta').map((d) => (d as { text: string }).text).join('')).toBe('All good')
    expect(doneEvents(f)[0]).toEqual({ event: 'ai.done', payload: { conversationId: 'conv1', reason: 'stop' } })

    // The second request replays the tool result as history.
    const secondBody = JSON.parse(String(f.fetchImpl.mock.calls[1][1].body))
    expect(secondBody.messages).toEqual(
      expect.arrayContaining([{ role: 'tool', tool_call_id: 'c1', content: expect.stringContaining('exit code: 0') }])
    )
    // And the system prompt describes the target host.
    const firstBody = JSON.parse(String(f.fetchImpl.mock.calls[0][1].body))
    expect(firstBody.messages[0]).toEqual(expect.objectContaining({ role: 'system', content: expect.stringContaining('web-1') }))
  })

  it('declines the command when the user rejects it', async () => {
    const f = makeFixture({ responses: [openAiToolCall('c1', 'run_command', { command: 'rm -rf /' }), openAiText('understood')] })
    chat(f)
    await until(() => eventsOf(f, 'ai.confirm').length === 1, 'confirm event')
    f.svc.resolveConfirm((eventsOf<{ confirmId: string }>(f, 'ai.confirm')[0]).confirmId, false)
    await until(() => doneEvents(f).length === 1, 'done event')
    expect(f.exec).not.toHaveBeenCalled()
    const toolResult = eventsOf<{ ok: boolean; result: string }>(f, 'ai.toolResult')[0]
    expect(toolResult.ok).toBe(false)
    expect(toolResult.result).toBe(AI_DECLINED_RESULT)
  })

  it('skips confirmation in auto-approve mode, but send_keys still requires it', async () => {
    const f = makeFixture({ responses: [openAiToolCall('c1', 'run_command', { command: 'ls' }), openAiText('ok')] , ai: { autoApprove: true } })
    chat(f)
    await until(() => doneEvents(f).length === 1, 'done event')
    expect(eventsOf(f, 'ai.confirm')).toHaveLength(0)
    expect(f.exec).toHaveBeenCalledTimes(1)

    const f2 = makeFixture({ responses: [openAiToolCall('c1', 'send_keys', { text: 'yes\r' }), openAiText('ok')], ai: { autoApprove: true } })
    chat(f2)
    await until(() => eventsOf(f2, 'ai.confirm').length === 1, 'confirm event for send_keys')
    const confirm = eventsOf<{ confirmId: string }>(f2, 'ai.confirm')[0]
    f2.svc.resolveConfirm(confirm.confirmId, true)
    await until(() => doneEvents(f2).length === 1, 'done event')
    expect(f2.captureWrite).toHaveBeenCalledWith('yes\r', expect.objectContaining({ timeoutMs: 10_000 }))
    expect(eventsOf<{ result: string }>(f2, 'ai.toolResult')[0].result).toContain('[sudo] password:')
  })

  it('"auto this chat" approves the current call and skips later confirmations', async () => {
    const f = makeFixture({
      responses: [openAiToolCall('c1', 'run_command', { command: 'ls' }), openAiToolCall('c2', 'run_command', { command: 'pwd' }), openAiText('done')]
    })
    chat(f)
    await until(() => eventsOf(f, 'ai.confirm').length === 1, 'first confirm')
    f.svc.resolveConfirm((eventsOf<{ confirmId: string }>(f, 'ai.confirm')[0]).confirmId, true, true)
    await until(() => doneEvents(f).length === 1, 'done event')
    expect(f.exec).toHaveBeenCalledTimes(2)
    expect(eventsOf(f, 'ai.confirm')).toHaveLength(1)
  })

  it('stops with reason maxTurns when the model never finishes', async () => {
    const f = makeFixture({ responses: [openAiToolCall('c1', 'run_command', { command: 'ls' })], ai: { autoApprove: true, maxTurns: 1 } })
    chat(f)
    await until(() => doneEvents(f).length === 1, 'done event')
    expect(doneEvents(f)[0]).toEqual({ event: 'ai.done', payload: { conversationId: 'conv1', reason: 'maxTurns' } })
  })

  it('aborts a running conversation', async () => {
    const f = makeFixture({ responses: [openAiToolCall('c1', 'run_command', { command: 'ls' })] })
    chat(f)
    await until(() => eventsOf(f, 'ai.confirm').length === 1, 'confirm event')
    f.svc.abort('conv1')
    await until(() => doneEvents(f).length === 1, 'done event')
    expect(doneEvents(f)[0]).toEqual({ event: 'ai.done', payload: { conversationId: 'conv1', reason: 'aborted' } })
    expect(f.exec).not.toHaveBeenCalled()
  })

  it('truncates huge command output from the middle', async () => {
    const big = `${'x'.repeat(100_000)}END`
    const f = makeFixture({
      responses: [openAiToolCall('c1', 'run_command', { command: 'cat big' }), openAiText('ok')],
      ai: { autoApprove: true }
    })
    f.exec.mockResolvedValue({ code: 0, stdout: big, stderr: '' })
    chat(f)
    await until(() => doneEvents(f).length === 1, 'done event')
    const result = eventsOf<{ result: string }>(f, 'ai.toolResult')[0].result
    expect(result).toContain('characters truncated')
    expect(result.length).toBeLessThan(40_000)
    expect(result.endsWith('END')).toBe(true)
  })

  it('falls back to the pooled connection when the terminal session is disconnected', async () => {
    const f = makeFixture({
      responses: [openAiToolCall('c1', 'run_command', { command: 'ls' }), openAiText('ok')],
      sessionConnected: false,
      hostId: 'host-1',
      ai: { autoApprove: true }
    })
    chat(f)
    await until(() => doneEvents(f).length === 1, 'done event')
    expect(f.poolAcquire).toHaveBeenCalledWith('host-1')
    expect(f.exec).toHaveBeenCalledTimes(1)
  })

  it('reports an execution error to the model instead of crashing the loop', async () => {
    const f = makeFixture({ responses: [openAiToolCall('c1', 'run_command', { command: 'ls' }), openAiText('sorry')], ai: { autoApprove: true } })
    f.exec.mockRejectedValue(new Error('Command timed out'))
    chat(f)
    await until(() => doneEvents(f).length === 1, 'done event')
    const toolResult = eventsOf<{ ok: boolean; result: string }>(f, 'ai.toolResult')[0]
    expect(toolResult.ok).toBe(false)
    expect(toolResult.result).toBe('Error: Command timed out')
    expect(doneEvents(f)[0]).toEqual({ event: 'ai.done', payload: { conversationId: 'conv1', reason: 'stop' } })
  })

  it('validates the request upfront', () => {
    const f = makeFixture({ responses: [], withConfig: false })
    expect(() => f.svc.chat({ conversationId: 'a', sessionId: 'missing', messages: [] })).toThrow('Session not found')
    expect(() => f.svc.chat({ conversationId: 'a', sessionId: 's1', messages: [] })).toThrow('No AI provider is configured yet')
  })

  it('rejects non-ssh sessions', () => {
    const f = makeFixture({ responses: [], kind: 'local' })
    expect(() => f.svc.chat({ conversationId: 'a', sessionId: 's1', messages: [] })).toThrow('only works on SSH sessions')
  })
})
