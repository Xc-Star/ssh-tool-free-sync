// The API-key fields below use SECRET_MASK from ./schemas as the "unchanged" marker over IPC.

// ---------------------------------------------------------------- provider presets

/** Wire protocol used to talk to the provider. */
export type AiProtocol = 'openai' | 'anthropic'

/** How the API key is transmitted. */
export type AiAuthStyle = 'bearer' | 'x-api-key' | 'none'

export type AiPresetId =
  | 'openai'
  | 'claude'
  | 'gemini'
  | 'deepseek'
  | 'qwen'
  | 'zhipu'
  | 'minimax'
  | 'ollama'
  | 'openai-compatible'
  | 'anthropic-compatible'
  | 'custom'

export interface AiPreset {
  protocol: AiProtocol
  authStyle: AiAuthStyle
  baseUrl: string
  defaultModel?: string
  /** False for local runtimes (Ollama) that need no key. */
  needsKey: boolean
}

/**
 * DBX-style provider presets. The preset only pre-fills baseUrl / protocol / auth style /
 * default model — every field stays editable, so `*-compatible` presets cover any gateway.
 */
export const AI_PRESETS: Record<AiPresetId, AiPreset> = {
  openai: { protocol: 'openai', authStyle: 'bearer', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o', needsKey: true },
  claude: { protocol: 'anthropic', authStyle: 'x-api-key', baseUrl: 'https://api.anthropic.com', defaultModel: 'claude-sonnet-4-5', needsKey: true },
  // Gemini exposes an official OpenAI-compatible endpoint, so no third protocol is needed.
  gemini: { protocol: 'openai', authStyle: 'bearer', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', defaultModel: 'gemini-2.5-flash', needsKey: true },
  deepseek: { protocol: 'openai', authStyle: 'bearer', baseUrl: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat', needsKey: true },
  qwen: { protocol: 'openai', authStyle: 'bearer', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen-plus', needsKey: true },
  zhipu: { protocol: 'openai', authStyle: 'bearer', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-4.6', needsKey: true },
  minimax: { protocol: 'openai', authStyle: 'bearer', baseUrl: 'https://api.minimaxi.com/v1', needsKey: true },
  ollama: { protocol: 'openai', authStyle: 'none', baseUrl: 'http://localhost:11434/v1', needsKey: false },
  'openai-compatible': { protocol: 'openai', authStyle: 'bearer', baseUrl: '', needsKey: true },
  'anthropic-compatible': { protocol: 'anthropic', authStyle: 'x-api-key', baseUrl: '', needsKey: true },
  custom: { protocol: 'openai', authStyle: 'none', baseUrl: '', needsKey: false }
}

export const AI_PRESET_IDS = Object.keys(AI_PRESETS) as AiPresetId[]

// ---------------------------------------------------------------- provider configs

/** Full config as stored in the main process (raw API key — never crosses IPC). */
export interface AiProviderConfig {
  id: string
  name: string
  preset: AiPresetId
  protocol: AiProtocol
  baseUrl: string
  apiKey: string
  model: string
  authStyle: AiAuthStyle
  /** Extra HTTP headers (gateway auth, tenant routing). */
  customHeaders?: Record<string, string>
}

/** Config as sent over IPC: `apiKey` is SECRET_MASK when set, '' when empty. */
export type AiConfigSummary = Omit<AiProviderConfig, 'apiKey'> & { apiKey: string }

/** Upsert payload; `apiKey: SECRET_MASK` means "keep the stored key". */
export interface AiConfigInput {
  id?: string
  name: string
  preset: AiPresetId
  protocol: AiProtocol
  baseUrl: string
  model: string
  apiKey: string
  authStyle?: AiAuthStyle
  customHeaders?: Record<string, string>
}

export interface AiTestResult {
  ok: boolean
  latencyMs?: number
  /** Sample of usable chat models (filled by the test call). */
  models?: string[]
  error?: string
}

/**
 * OpenAI-compatible gateways (new-api / one-api / OpenAI itself / Ollama / DeepSeek …) serve
 * their API under `/v1`, but users naturally paste the bare domain. Append `/v1` when the URL
 * has no path component; any explicit path (e.g. zhipu's `/api/paas/v4`) is left untouched.
 * Anthropic endpoints already hang off the bare domain (`/v1/messages` is added per request).
 */
export function normalizeAiBaseUrl(baseUrl: string, protocol: AiProtocol): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (protocol === 'anthropic') return trimmed
  try {
    const u = new URL(trimmed)
    if (u.pathname === '' || u.pathname === '/') return `${trimmed}/v1`
  } catch {
    // Not a parseable URL — leave as-is so the request fails with a clear error.
  }
  return trimmed
}

// ---------------------------------------------------------------- agent messages

/** Canonical internal message format (OpenAI-style); Anthropic shape is converted at the provider edge. */
export type AiMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: AiToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string }

export interface AiToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

export interface AiChatRequest {
  conversationId: string
  sessionId: string
  /** Full history including the new user message. */
  messages: AiMessage[]
}

/** Tool result content used when the user declines a command (shared so renderer + main stay in sync). */
export const AI_DECLINED_RESULT = 'The user DECLINED this action. Do not retry it; explain what you wanted to do and ask how to proceed.'
