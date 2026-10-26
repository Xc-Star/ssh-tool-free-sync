import type { AiMessage, AiProtocol, AiProviderConfig, AiToolCall } from '@shared/ai'

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>

export interface ProviderTool {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ChatOptions {
  config: AiProviderConfig
  messages: AiMessage[]
  tools: ProviderTool[]
  signal?: AbortSignal
  /** Streamed assistant text. */
  onDelta: (text: string) => void
}

export interface ChatResult {
  text: string
  toolCalls: AiToolCall[]
}

export interface ProviderAdapter {
  chat(opts: ChatOptions): Promise<ChatResult>
  listModels(config: AiProviderConfig, signal?: AbortSignal): Promise<string[]>
}

export class AiProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string
  ) {
    super(message)
    this.name = 'AiProviderError'
  }
}

/** Models that cannot take part in a chat/agent conversation. */
const NON_CHAT_MODEL = /embed|bge-|rerank|tts|whisper|asr|audio|voice|dall-?e|image|imagen|video|sora|veo|flux|moderation|realtime|guard|scribe|speech|transcri/i

export function filterChatModels(ids: string[]): string[] {
  return [...new Set(ids)].filter((id) => id && !NON_CHAT_MODEL.test(id)).sort()
}

function buildHeaders(config: AiProviderConfig, extra: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...extra }
  if (config.apiKey) {
    if (config.authStyle === 'bearer') headers.authorization = `Bearer ${config.apiKey}`
    else if (config.authStyle === 'x-api-key') headers['x-api-key'] = config.apiKey
  }
  for (const [k, v] of Object.entries(config.customHeaders ?? {})) {
    if (k && v) headers[k.toLowerCase()] = v
  }
  return headers
}

async function errorFromResponse(res: Response): Promise<AiProviderError> {
  let body = ''
  try {
    body = await res.text()
  } catch {
    // ignore
  }
  // A wrong base URL typically lands on the gateway's HTML single-page app instead of the API.
  if (body.trimStart().startsWith('<')) {
    return new AiProviderError(`HTTP ${res.status}: the endpoint returned an HTML page instead of the API — check the Base URL (OpenAI-compatible services usually need /v1)`, res.status, body)
  }
  let detail = body
  try {
    const j = JSON.parse(body)
    detail = j?.error?.message || j?.error?.msg || j?.message || body
  } catch {
    // keep raw body
  }
  const hint = res.status === 401 || res.status === 403 ? ' (check the API key)' : res.status === 404 ? ' (check the base URL and model name)' : ''
  return new AiProviderError(`HTTP ${res.status}${hint}: ${detail.slice(0, 500)}`, res.status, body)
}

/**
 * POST that retries transient failures (network errors, 429, 5xx) a couple of times with backoff,
 * mirroring the DBX behavior of only retrying rate-limit / timeout / temporary network errors.
 */
async function postStream(fetchImpl: FetchImpl, url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<Response> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= 2; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 600 * attempt))
      if (signal?.aborted) throw new Error('aborted')
    }
    try {
      const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal })
      if (res.ok) return res
      const err = await errorFromResponse(res)
      if ((res.status === 429 || res.status >= 500) && res.status < 600 && attempt < 2) {
        lastErr = err
        continue
      }
      throw err
    } catch (err) {
      if (err instanceof AiProviderError) throw err
      if (signal?.aborted) throw new Error('aborted', { cause: err })
      lastErr = err
      if (attempt >= 2) throw new Error(`Cannot reach the AI provider: ${(err as Error).message}`, { cause: err })
    }
  }
  throw lastErr
}

/** Parses a `text/event-stream` body and hands every `data:` payload to `onData`. */
async function readSse(res: Response, onData: (payload: string) => void): Promise<void> {
  if (!res.body) throw new AiProviderError('Empty response body')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '')
      buf = buf.slice(nl + 1)
      if (line.startsWith('data:')) {
        const payload = line.slice(5).trim()
        if (payload && payload !== '[DONE]') onData(payload)
      }
    }
  }
  const tail = buf.trim()
  if (tail.startsWith('data:')) {
    const payload = tail.slice(5).trim()
    if (payload && payload !== '[DONE]') onData(payload)
  }
}

function parseJson(payload: string): any {
  try {
    return JSON.parse(payload)
  } catch {
    return undefined
  }
}

function reqSignal(signal: AbortSignal | undefined, timeoutMs = 300_000): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

/** Parses a models-list response, translating a non-JSON body into a clear base-URL hint. */
async function parseModelList(res: Response): Promise<string[]> {
  const text = await res.text()
  let j: any
  try {
    j = JSON.parse(text)
  } catch {
    throw new AiProviderError(
      text.trimStart().startsWith('<')
        ? 'The endpoint returned an HTML page instead of the API — check the Base URL (OpenAI-compatible services usually need /v1)'
        : `The endpoint returned a non-JSON response: ${text.slice(0, 200)}`
    )
  }
  const ids: string[] = (j?.data ?? j?.models ?? []).map((m: any) => m?.id ?? m?.name).filter((id: unknown) => typeof id === 'string')
  return filterChatModels(ids)
}

// ---------------------------------------------------------------- OpenAI-compatible

interface OpenAiToolCallDelta {
  index?: number
  id?: string
  function?: { name?: string; arguments?: string }
}

function openaiMessages(messages: AiMessage[]): any[] {
  const out: any[] = []
  for (const m of messages) {
    if (m.role === 'system') out.push({ role: 'system', content: m.content })
    else if (m.role === 'user') out.push({ role: 'user', content: m.content })
    else if (m.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: m.content || null,
        ...(m.toolCalls?.length
          ? {
              tool_calls: m.toolCalls.map((t) => ({
                id: t.id,
                type: 'function',
                function: { name: t.name, arguments: JSON.stringify(t.args) }
              }))
            }
          : {})
      })
    } else {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content })
    }
  }
  return out
}

class OpenAiAdapter implements ProviderAdapter {
  constructor(private readonly fetchImpl: FetchImpl) {}

  async chat(opts: ChatOptions): Promise<ChatResult> {
    const { config, tools } = opts
    const body: Record<string, unknown> = {
      model: config.model,
      messages: openaiMessages(opts.messages),
      stream: true
    }
    if (tools.length) {
      body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
      body.tool_choice = 'auto'
    }
    const res = await postStream(
      this.fetchImpl,
      `${config.baseUrl}/chat/completions`,
      buildHeaders(config, {}),
      body,
      reqSignal(opts.signal)
    )

    let text = ''
    const calls = new Map<number, { id: string; name: string; args: string }>()
    await readSse(res, (payload) => {
      const j = parseJson(payload)
      const delta = j?.choices?.[0]?.delta
      if (typeof delta?.content === 'string' && delta.content) {
        text += delta.content
        opts.onDelta(delta.content)
      }
      for (const tc of (delta?.tool_calls ?? []) as OpenAiToolCallDelta[]) {
        if (tc.index === undefined) continue
        const cur = calls.get(tc.index) ?? { id: '', name: '', args: '' }
        if (tc.id) cur.id = tc.id
        if (tc.function?.name) cur.name = tc.function.name
        if (tc.function?.arguments) cur.args += tc.function.arguments
        calls.set(tc.index, cur)
      }
    })

    const toolCalls: AiToolCall[] = []
    for (const [, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      let args: Record<string, unknown>
      try {
        args = c.args ? JSON.parse(c.args) : {}
      } catch {
        args = { _raw: c.args }
      }
      toolCalls.push({ id: c.id || `call_${Math.random().toString(36).slice(2)}`, name: c.name, args })
    }
    return { text, toolCalls }
  }

  async listModels(config: AiProviderConfig, signal?: AbortSignal): Promise<string[]> {
    const res = await this.fetchImpl(`${config.baseUrl}/models`, { headers: buildHeaders(config, {}), signal })
    if (!res.ok) throw await errorFromResponse(res)
    return await parseModelList(res)
  }
}

// ---------------------------------------------------------------- Anthropic Messages

function anthropicMessages(messages: AiMessage[]): { system: string; messages: any[] } {
  const system: string[] = []
  const out: any[] = []
  const pendingToolResults: any[] = []
  const flushToolResults = (): void => {
    if (pendingToolResults.length) {
      out.push({ role: 'user', content: pendingToolResults.splice(0) })
    }
  }
  for (const m of messages) {
    if (m.role === 'system') {
      system.push(m.content)
      continue
    }
    if (m.role === 'user') {
      flushToolResults()
      // Anthropic wants strictly alternating roles: merge consecutive user turns into one.
      const last = out[out.length - 1]
      if (last?.role === 'user' && Array.isArray(last.content)) last.content.push({ type: 'text', text: m.content })
      else out.push({ role: 'user', content: [{ type: 'text', text: m.content }] })
    } else if (m.role === 'assistant') {
      flushToolResults()
      const content: any[] = []
      if (m.content) content.push({ type: 'text', text: m.content })
      for (const t of m.toolCalls ?? []) content.push({ type: 'tool_use', id: t.id, name: t.name, input: t.args })
      out.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '' }] })
    } else {
      // Anthropic wants tool results inside a user message; merge consecutive ones.
      pendingToolResults.push({ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content })
    }
  }
  flushToolResults()
  return { system: system.join('\n\n'), messages: out }
}

class AnthropicAdapter implements ProviderAdapter {
  constructor(private readonly fetchImpl: FetchImpl) {}

  private headers(config: AiProviderConfig): Record<string, string> {
    return buildHeaders(config, { 'anthropic-version': '2023-06-01' })
  }

  async chat(opts: ChatOptions): Promise<ChatResult> {
    const { config, tools } = opts
    const { system, messages } = anthropicMessages(opts.messages)
    const body: Record<string, unknown> = {
      model: config.model,
      max_tokens: 8192,
      messages,
      stream: true
    }
    if (system) body.system = system
    if (tools.length) {
      body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
    }
    const res = await postStream(this.fetchImpl, `${config.baseUrl}/v1/messages`, this.headers(config), body, reqSignal(opts.signal))

    let text = ''
    // per content-block index: accumulating tool_use block
    const blocks = new Map<number, { id: string; name: string; json: string }>()
    await readSse(res, (payload) => {
      const j = parseJson(payload)
      switch (j?.type) {
        case 'content_block_start': {
          const b = j.content_block
          if (b?.type === 'tool_use') blocks.set(j.index, { id: b.id, name: b.name, json: '' })
          break
        }
        case 'content_block_delta': {
          const d = j.delta
          if (d?.type === 'text_delta' && d.text) {
            text += d.text
            opts.onDelta(d.text)
          } else if (d?.type === 'input_json_delta' && d.partial_json) {
            const b = blocks.get(j.index)
            if (b) b.json += d.partial_json
          }
          break
        }
        case 'error':
          throw new AiProviderError(j.error?.message || 'Anthropic stream error', undefined, payload)
      }
    })

    const toolCalls: AiToolCall[] = []
    for (const [, b] of [...blocks.entries()].sort((a, b2) => a[0] - b2[0])) {
      let args: Record<string, unknown>
      try {
        args = b.json ? JSON.parse(b.json) : {}
      } catch {
        args = { _raw: b.json }
      }
      toolCalls.push({ id: b.id, name: b.name, args })
    }
    return { text, toolCalls }
  }

  async listModels(config: AiProviderConfig, signal?: AbortSignal): Promise<string[]> {
    const res = await this.fetchImpl(`${config.baseUrl}/v1/models`, { headers: this.headers(config), signal })
    if (!res.ok) throw await errorFromResponse(res)
    return await parseModelList(res)
  }
}

export function createAdapter(protocol: AiProtocol, fetchImpl: FetchImpl): ProviderAdapter {
  return protocol === 'anthropic' ? new AnthropicAdapter(fetchImpl) : new OpenAiAdapter(fetchImpl)
}
