import { describe, expect, it } from 'vitest'
import type { AiProviderConfig } from '@shared/ai'
import { createAdapter, filterChatModels, type FetchImpl, type ProviderTool } from '../../src/main/ai/providers'

const config = (over: Partial<AiProviderConfig> = {}): AiProviderConfig => ({
  id: 'c1',
  name: 'test',
  preset: 'openai-compatible',
  protocol: 'openai',
  baseUrl: 'https://api.test/v1',
  apiKey: 'sk-test',
  model: 'm1',
  authStyle: 'bearer',
  ...over
})

const TOOLS: ProviderTool[] = [
  { name: 'run_command', description: 'run', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }
]

/** Builds a `text/event-stream` Response from raw SSE chunk strings. */
function sseResponse(...chunks: string[]): Response {
  const enc = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(enc.encode(chunk))
      c.close()
    }
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })
}

function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), { status, headers: { 'content-type': 'application/json' } })
}

interface Captured {
  url: string
  body: any
  headers: Record<string, string>
}

/** fetch fake that records requests and plays back scripted responses in order. */
function scriptedFetch(responses: Response[]): { impl: FetchImpl; calls: Captured[] } {
  const calls: Captured[] = []
  const impl: FetchImpl = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: (init?.headers ?? {}) as Record<string, string> })
    const res = responses.shift()
    if (!res) throw new Error('no scripted response left')
    return res
  }
  return { impl, calls }
}

describe('OpenAI adapter', () => {
  it('streams text and assembles tool calls split across chunks', async () => {
    const { impl, calls } = scriptedFetch([
      sseResponse(
        'data: {"choices":[{"delta":{"content":"Check"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"ing."}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"run_command","arguments":""}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"command\\":\\"ls -la\\"}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        'data: [DONE]\n\n'
      )
    ])
    const deltas: string[] = []
    const res = await createAdapter('openai', impl).chat({ config: config(), messages: [{ role: 'user', content: 'go' }], tools: TOOLS, onDelta: (t) => deltas.push(t) })
    expect(res.text).toBe('Checking.')
    expect(res.toolCalls).toEqual([{ id: 'call_1', name: 'run_command', args: { command: 'ls -la' } }])
    expect(deltas).toEqual(['Check', 'ing.'])
    expect(calls[0].url).toBe('https://api.test/v1/chat/completions')
    expect(calls[0].body.tools[0].function.name).toBe('run_command')
    expect(calls[0].headers.authorization).toBe('Bearer sk-test')
  })

  it('converts canonical messages to the OpenAI wire format', async () => {
    const { impl, calls } = scriptedFetch([sseResponse('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n')])
    await createAdapter('openai', impl).chat({
      config: config(),
      tools: [],
      onDelta: () => {},
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'plan', toolCalls: [{ id: 'c1', name: 'run_command', args: { command: 'ls' } }] },
        { role: 'tool', toolCallId: 'c1', name: 'run_command', content: 'exit code: 0' }
      ]
    })
    expect(calls[0].body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'plan', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_command', arguments: '{"command":"ls"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'exit code: 0' }
    ])
  })

  it('maps 401 to a helpful error mentioning the API key', async () => {
    const { impl } = scriptedFetch([errorResponse(401, 'bad key')])
    await expect(
      createAdapter('openai', impl).chat({ config: config(), messages: [{ role: 'user', content: 'x' }], tools: [], onDelta: () => {} })
    ).rejects.toThrow(/check the API key/)
  })

  it('treats a stream without finish_reason or [DONE] as incomplete', async () => {
    const { impl } = scriptedFetch([sseResponse('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')])
    await expect(
      createAdapter('openai', impl).chat({ config: config(), messages: [{ role: 'user', content: 'x' }], tools: [], onDelta: () => {} })
    ).rejects.toThrow(/before the response was complete/)
  })

  it('retries a 500 once and then succeeds', async () => {
    let n = 0
    const impl: FetchImpl = async () => {
      n++
      return n === 1 ? errorResponse(500, 'boom') : sseResponse('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n')
    }
    const res = await createAdapter('openai', impl).chat({ config: config(), messages: [{ role: 'user', content: 'x' }], tools: [], onDelta: () => {} })
    expect(res.text).toBe('ok')
    expect(n).toBe(2)
  })

  it('lists and filters chat models', async () => {
    const { impl } = scriptedFetch([
      jsonResponse({ data: [{ id: 'gpt-4o' }, { id: 'text-embedding-3-small' }, { id: 'tts-1' }, { id: 'gpt-4o-mini' }, { id: 'gpt-4o' }] })
    ])
    const models = await createAdapter('openai', impl).listModels(config())
    expect(models).toEqual(['gpt-4o', 'gpt-4o-mini'])
  })

  it('explains when a wrong base URL lands on an HTML page (200 or error status)', async () => {
    const html = new Response('<!doctype html><html><body>gateway</body></html>', { status: 200, headers: { 'content-type': 'text/html' } })
    const { impl: impl200 } = scriptedFetch([html])
    await expect(createAdapter('openai', impl200).listModels(config())).rejects.toThrow(/HTML page instead of the API/)

    const html404 = new Response('<!doctype html><html>not found</html>', { status: 404 })
    const { impl: impl404 } = scriptedFetch([html404])
    await expect(createAdapter('openai', impl404).listModels(config())).rejects.toThrow(/HTML page instead of the API/)
  })
})

describe('Anthropic adapter', () => {
  it('streams text and assembles tool_use blocks from input_json_delta', async () => {
    const events = [
      'data: {"type":"message_start","message":{}}\n\n',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Look"}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ing."}}\n\n',
      'data: {"type":"content_block_stop","index":0}\n\n',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_1","name":"run_command","input":{}}}\n\n',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":"}}\n\n',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"df -h\\""}}\n\n',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"}"}}\n\n',
      'data: {"type":"content_block_stop","index":1}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
      'data: {"type":"message_stop"}\n\n'
    ]
    const { impl, calls } = scriptedFetch([sseResponse(...events)])
    const deltas: string[] = []
    const res = await createAdapter('anthropic', impl).chat({
      config: config({ protocol: 'anthropic', preset: 'claude', authStyle: 'x-api-key', baseUrl: 'https://api.anthropic.com' }),
      messages: [{ role: 'user', content: 'go' }],
      tools: TOOLS,
      onDelta: (t) => deltas.push(t)
    })
    expect(res.text).toBe('Looking.')
    expect(res.toolCalls).toEqual([{ id: 'tu_1', name: 'run_command', args: { command: 'df -h' } }])
    expect(deltas).toEqual(['Look', 'ing.'])
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages')
    expect(calls[0].headers['x-api-key']).toBe('sk-test')
    expect(calls[0].headers['anthropic-version']).toBe('2023-06-01')
    expect(calls[0].body.tools[0]).toEqual({ name: 'run_command', description: 'run', input_schema: TOOLS[0].parameters })
  })

  it('extracts the system prompt, merges tool results into one user turn and merges consecutive user messages', async () => {
    const { impl, calls } = scriptedFetch([sseResponse('data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n', 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n', 'data: {"type":"message_stop"}\n\n')])
    await createAdapter('anthropic', impl).chat({
      config: config({ protocol: 'anthropic' }),
      tools: [],
      onDelta: () => {},
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'one' },
        { role: 'user', content: 'two' },
        { role: 'assistant', content: 'plan', toolCalls: [
          { id: 'c1', name: 'run_command', args: { command: 'ls' } },
          { id: 'c2', name: 'run_command', args: { command: 'pwd' } }
        ] },
        { role: 'tool', toolCallId: 'c1', name: 'run_command', content: 'r1' },
        { role: 'tool', toolCallId: 'c2', name: 'run_command', content: 'r2' }
      ]
    })
    expect(calls[0].body.system).toBe('sys')
    expect(calls[0].body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'plan' },
          { type: 'tool_use', id: 'c1', name: 'run_command', input: { command: 'ls' } },
          { type: 'tool_use', id: 'c2', name: 'run_command', input: { command: 'pwd' } }
        ]
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'c1', content: 'r1' },
          { type: 'tool_result', tool_use_id: 'c2', content: 'r2', cache_control: { type: 'ephemeral' } }
        ]
      }
    ])
  })

  it('returns signed thinking verbatim and sends it back unchanged', async () => {
    const anthropic = config({ protocol: 'anthropic' })
    const { impl, calls } = scriptedFetch([
      sseResponse(
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Check disk."}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig"}}\n\n',
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"redacted_thinking","data":"opaque"}}\n\n',
        'data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"tu_1","name":"run_command","input":{}}}\n\n',
        'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"df -h\\"}"}}\n\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n'
      ),
      sseResponse('data: {"type":"message_stop"}\n\n')
    ])
    const reasoning: string[] = []
    const adapter = createAdapter('anthropic', impl)
    const res = await adapter.chat({ config: anthropic, messages: [{ role: 'user', content: 'go' }], tools: TOOLS, onDelta: () => {}, onReasoning: (t) => reasoning.push(t) })
    expect(reasoning).toEqual(['Check disk.'])
    expect(res.rawContent).toEqual([
      { type: 'thinking', thinking: 'Check disk.', signature: 'sig' },
      { type: 'redacted_thinking', data: 'opaque' },
      { type: 'tool_use', id: 'tu_1', name: 'run_command', input: { command: 'df -h' } }
    ])

    await adapter.chat({
      config: anthropic,
      tools: TOOLS,
      onDelta: () => {},
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: res.text, toolCalls: res.toolCalls, rawContent: res.rawContent },
        { role: 'tool', toolCallId: 'tu_1', name: 'run_command', content: 'ok' }
      ]
    })
    expect(calls[1].body.messages[1]).toEqual({ role: 'assistant', content: res.rawContent })
  })

  it('treats a stream without message_stop or a stop reason as incomplete', async () => {
    const { impl } = scriptedFetch([sseResponse('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n')])
    await expect(
      createAdapter('anthropic', impl).chat({ config: config({ protocol: 'anthropic' }), messages: [{ role: 'user', content: 'x' }], tools: [], onDelta: () => {} })
    ).rejects.toThrow(/before the response was complete/)
  })
})

describe('filterChatModels', () => {
  it('drops non-chat models and de-duplicates', () => {
    expect(filterChatModels(['bge-m3', 'claude-sonnet-4-5', 'text-embedding-3', 'whisper-1', 'claude-sonnet-4-5', 'dall-e-3', 'gpt-4o-realtime', 'claude-haiku'])).toEqual([
      'claude-haiku',
      'claude-sonnet-4-5'
    ])
  })
})
