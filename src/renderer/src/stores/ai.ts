import type { AiConfigSummary, AiMessage, AiReasoning } from '@shared/ai'
import { uuidv7 } from '@shared/util'
import { create } from 'zustand'
import { call, on } from '@/lib/api'

export type ToolStatus = 'running' | 'pending-confirm' | 'done' | 'declined' | 'error' | 'aborted'

export interface UiToolCall {
  callId: string
  name: string
  args: Record<string, unknown>
  status: ToolStatus
  /** Tool result content exactly as the main process recorded it (replayed in the next history). */
  result?: string
  confirmId?: string
}

export interface UiMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** Optional terminal context attached to a user message (sent but rendered collapsed). */
  context?: string
  /** Model reasoning; replayed in later history because some providers require it. */
  reasoning?: AiReasoning
  pending?: boolean
  toolCalls?: UiToolCall[]
}

export interface Conversation {
  id: string
  sessionId: string
  messages: UiMessage[]
  status: 'idle' | 'running'
  /** Shown as an inline banner; cleared by the next send. */
  error?: string
  notice?: string
}

interface AiState {
  configs: AiConfigSummary[]
  configsLoaded: boolean
  /** Keyed by terminal session id; one current conversation per session. */
  conversations: Record<string, Conversation>
  refreshConfigs: () => Promise<void>
  ensureConversation: (sessionId: string) => Conversation
  newConversation: (sessionId: string) => void
  send: (sessionId: string, text: string, context?: string) => void
  abort: (sessionId: string) => void
  resolveConfirm: (confirmId: string, approve: boolean, autoRest?: boolean) => void
}

/** Converts the UI messages into the canonical history the main process expects. */
function buildHistory(conv: Conversation): AiMessage[] {
  const msgs: AiMessage[] = []
  for (const m of conv.messages) {
    if (m.role === 'user') {
      msgs.push({ role: 'user', content: m.context ? `${m.content}\n\n[recent terminal output]\n${m.context}` : m.content })
      continue
    }
    // Dangling calls (aborted mid-run) would desync tool_call/tool pairs — drop them.
    const calls = (m.toolCalls ?? []).filter((c) => c.result !== undefined)
    const toolCalls = calls.map((c) => ({ id: c.callId, name: c.name, args: c.args }))
    if (m.content || toolCalls.length) {
      msgs.push({ role: 'assistant', content: m.content, ...(toolCalls.length ? { toolCalls } : {}), ...(m.reasoning ? { reasoning: m.reasoning } : {}) })
    }
    for (const c of calls) msgs.push({ role: 'tool', toolCallId: c.callId, name: c.name, content: c.result ?? '' })
  }
  return msgs
}

function emptyConversation(sessionId: string): Conversation {
  return { id: uuidv7(), sessionId, messages: [], status: 'idle' }
}

/** Subscribes to the ai.* events once (idempotent, safe to call from every mount). */
let wired = false
function wireEvents(get: () => AiState, set: (fn: (s: AiState) => Partial<AiState>) => void): void {
  if (wired) return
  wired = true

  const update = (conversationId: string, fn: (conv: Conversation) => Conversation): void => {
    set((s) => {
      for (const conv of Object.values(s.conversations)) {
        if (conv.id !== conversationId) continue
        return { conversations: { ...s.conversations, [conv.sessionId]: fn(conv) } }
      }
      return {}
    })
  }

  on('ai.delta', ({ conversationId, text }) =>
    update(conversationId, (conv) => {
      const msgs = [...conv.messages]
      const last = msgs[msgs.length - 1]
      if (last?.role === 'assistant' && last.pending) {
        msgs[msgs.length - 1] = { ...last, content: last.content + text }
      } else {
        msgs.push({ id: uuidv7(), role: 'assistant', content: text, pending: true })
      }
      return { ...conv, messages: msgs }
    })
  )

  on('ai.reasoning', ({ conversationId, text, source }) =>
    update(conversationId, (conv) => {
      const msgs = [...conv.messages]
      const last = msgs[msgs.length - 1]
      if (last?.role === 'assistant' && last.pending) {
        msgs[msgs.length - 1] = { ...last, reasoning: { content: (last.reasoning?.content ?? '') + text, source } }
      } else {
        msgs.push({ id: uuidv7(), role: 'assistant', content: '', pending: true, reasoning: { content: text, source } })
      }
      return { ...conv, messages: msgs }
    })
  )

  on('ai.toolCall', ({ conversationId, callId, name, args }) =>
    update(conversationId, (conv) => {
      const msgs = [...conv.messages]
      let last = msgs[msgs.length - 1]
      if (!(last?.role === 'assistant' && last.pending)) {
        msgs.push({ id: uuidv7(), role: 'assistant', content: '', pending: true })
        last = msgs[msgs.length - 1]
      }
      msgs[msgs.length - 1] = {
        ...last,
        pending: false,
        toolCalls: [...(last.toolCalls ?? []), { callId, name, args, status: 'running' }]
      }
      return { ...conv, messages: msgs }
    })
  )

  on('ai.confirm', ({ confirmId, conversationId, callId }) =>
    update(conversationId, (conv) => ({
      ...conv,
      messages: conv.messages.map((m) =>
        m.role === 'assistant'
          ? { ...m, toolCalls: m.toolCalls?.map((c) => (c.callId === callId ? { ...c, status: 'pending-confirm', confirmId } : c)) }
          : m
      )
    }))
  )

  on('ai.toolResult', ({ conversationId, callId, status, result }) =>
    update(conversationId, (conv) => ({
      ...conv,
      messages: conv.messages.map((m) =>
        m.role === 'assistant'
          ? {
              ...m,
              toolCalls: m.toolCalls?.map((c) =>
                c.callId === callId ? { ...c, status: status === 'ok' ? 'done' : status, result, confirmId: undefined } : c
              )
            }
          : m
      )
    }))
  )

  on('ai.done', ({ conversationId, reason, error }) =>
    update(conversationId, (conv) => {
      const messages = conv.messages.map((m) => (m.pending ? { ...m, pending: false } : m)).filter((m) => m.content || m.toolCalls?.length)
      return {
        ...conv,
        messages,
        status: 'idle',
        error: reason === 'error' ? (error ?? 'Unknown error') : undefined,
        notice: reason === 'maxTurns' ? 'maxTurns' : reason === 'aborted' ? 'aborted' : undefined
      }
    })
  )
}

export const useAi = create<AiState>((set, get) => {
  wireEvents(get, (fn) => set((s) => fn(s)))
  return {
    configs: [],
    configsLoaded: false,
    conversations: {},

    refreshConfigs: async () => {
      try {
        const configs = await call('ai.getConfigs')
        set({ configs, configsLoaded: true })
      } catch {
        set({ configsLoaded: true })
      }
    },

    ensureConversation: (sessionId) => {
      const conv = get().conversations[sessionId]
      if (conv) return conv
      const fresh = emptyConversation(sessionId)
      set((s) => ({ conversations: { ...s.conversations, [sessionId]: fresh } }))
      return fresh
    },

    newConversation: (sessionId) => {
      set((s) => ({ conversations: { ...s.conversations, [sessionId]: emptyConversation(sessionId) } }))
    },

    send: (sessionId, text, context) => {
      const conv = get().ensureConversation(sessionId)
      if (conv.status === 'running') return
      const userMsg: UiMessage = { id: uuidv7(), role: 'user', content: text, context }
      const history = buildHistory({ ...conv, messages: [...conv.messages, userMsg] })
      set((s) => ({
        conversations: {
          ...s.conversations,
          [sessionId]: { ...conv, messages: [...conv.messages, userMsg], status: 'running', error: undefined, notice: undefined }
        }
      }))
      call('ai.chat', { conversationId: conv.id, sessionId, messages: history }).catch((err) => {
        set((s) => ({
          conversations: { ...s.conversations, [sessionId]: { ...s.conversations[sessionId], status: 'idle', error: (err as Error).message } }
        }))
      })
    },

    abort: (sessionId) => {
      const conv = get().conversations[sessionId]
      if (conv?.status === 'running') void call('ai.abort', conv.id).catch(() => {})
    },

    resolveConfirm: (confirmId, approve, autoRest) => {
      // Optimistic UI: the matching card flips to running/declined immediately.
      set((s) => {
        const conversations = { ...s.conversations }
        for (const [sid, conv] of Object.entries(conversations)) {
          if (!conv.messages.some((m) => m.toolCalls?.some((c) => c.confirmId === confirmId))) continue
          conversations[sid] = {
            ...conv,
            messages: conv.messages.map((m) =>
              m.role === 'assistant'
                ? { ...m, toolCalls: m.toolCalls?.map((c) => (c.confirmId === confirmId ? { ...c, status: approve ? 'running' : 'declined' } : c)) }
                : m
            )
          }
        }
        return { conversations }
      })
      void call('ai.resolveConfirm', confirmId, approve, autoRest).catch(() => {})
    }
  }
})

export function conversationFor(sessionId: string | undefined): Conversation | undefined {
  if (!sessionId) return undefined
  return useAi.getState().conversations[sessionId]
}
