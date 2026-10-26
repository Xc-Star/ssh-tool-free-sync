import type { AiChatRequest, AiConfigInput, AiMessage, AiProviderConfig, AiTestResult, AiToolCall } from '@shared/ai'
import { AI_DECLINED_RESULT } from '@shared/ai'
import { clamp, uuidv7 } from '@shared/util'
import type { Emitter } from '../services/emitter'
import type { SettingsService } from '../services/settings'
import type { SessionManager } from '../sessions/session-manager'
import type { SshConnection } from '../ssh/connect'
import type { ConnectionPool } from '../ssh/pool'
import { buildProviderConfig, type AiConfigStore } from './config-store'
import { createAdapter, type FetchImpl, type ProviderTool } from './providers'

const TOOLS: ProviderTool[] = [
  {
    name: 'run_command',
    description:
      'Run a shell command on the connected remote host in a non-interactive shell and get stdout, stderr and the exit code. ' +
      'Every call runs in a FRESH shell: the working directory, variables and background jobs do NOT persist between calls — ' +
      'chain steps in one command (e.g. `cd /var/log && tail -n 50 syslog`) or use absolute paths. ' +
      'Output above ~48 KB is truncated from the middle, so prefer targeted commands (head/tail/grep) over dumping large files.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute' },
        timeoutSec: { type: 'number', description: 'Optional timeout in seconds (5-600)' }
      },
      required: ['command']
    }
  },
  {
    name: 'send_keys',
    description:
      'Type text directly into the user\'s visible interactive terminal and capture the output that follows. ' +
      "Use ONLY when run_command cannot work: sudo/admin password prompts, full-screen tools (vim, top), interactive wizards. " +
      "Use \\r for Enter. This action always requires explicit user approval.",
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Exact text to type into the terminal; use \\r for Enter' },
        waitSec: { type: 'number', description: 'How long to wait for terminal output, 1-60 seconds (default 10)' }
      },
      required: ['text']
    }
  }
]

/** 5 minutes without an answer counts as a declined command (DBX behavior). */
const CONFIRM_TIMEOUT_MS = 5 * 60_000
const MAX_STDOUT_CHARS = 32 * 1024
const MAX_STDERR_CHARS = 16 * 1024

export function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s
  const head = Math.floor(max * 0.7)
  const tail = max - head
  return `${s.slice(0, head)}\n[... ${s.length - max} characters truncated ...]\n${s.slice(-tail)}`
}

interface PendingConfirm {
  conversationId: string
  settle(approved: boolean): void
}

/**
 * The SSH session backing an agent run, duck-typed so unit tests can inject fakes
 * (a real `SshSession` satisfies this shape).
 */
interface SshSessionLike {
  info: { kind: string; title?: string; osHint?: string; status?: string; hostId?: string }
  connection?: { exec: SshConnection['exec'] }
  captureWrite?: (text: string, opts?: { quietMs?: number; timeoutMs?: number; maxChars?: number }) => Promise<string>
}

export interface AiServiceDeps {
  store: AiConfigStore
  settings: SettingsService
  sessions: SessionManager
  pool: ConnectionPool
  emitter: Emitter
  fetchImpl: FetchImpl
}

/** Runs the tool-calling agent loop against a user-configured provider and drives the SSH session. */
export class AiService {
  private readonly runs = new Map<string, AbortController>()
  private readonly pendingConfirms = new Map<string, PendingConfirm>()
  /** Conversations where the user picked "approve + run the rest automatically". */
  private readonly autoConversations = new Set<string>()

  constructor(private readonly deps: AiServiceDeps) {}

  // ---------------------------------------------------------------- config helpers

  /**
   * Builds a full config from an input for a one-off request (test / model discovery), where
   * name and model may still be blank — the fetch-models button exists precisely because the
   * user does not know the model yet.
   */
  materialize(input: AiConfigInput): AiProviderConfig {
    const existing = input.id ? this.deps.store.get(input.id) : undefined
    return buildProviderConfig(input, existing, { forRequest: true })
  }

  async testConfig(input: AiConfigInput): Promise<AiTestResult> {
    const config = this.materialize(input)
    const adapter = createAdapter(config.protocol, this.deps.fetchImpl)
    const t0 = Date.now()
    try {
      const models = await adapter.listModels(config)
      return { ok: true, latencyMs: Date.now() - t0, models: models.slice(0, 10) }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }

  async listModels(input: AiConfigInput): Promise<string[]> {
    const config = this.materialize(input)
    return createAdapter(config.protocol, this.deps.fetchImpl).listModels(config)
  }

  // ---------------------------------------------------------------- agent loop

  /** Validates the request, starts the agent loop and returns immediately (results arrive as `ai.*` events). */
  chat(req: AiChatRequest): void {
    if (!req?.conversationId || !req?.sessionId || !Array.isArray(req.messages)) throw new Error('Invalid chat request')
    if (this.runs.has(req.conversationId)) throw new Error('This conversation is already running')
    const session = this.deps.sessions.get(req.sessionId)
    if (!session) throw new Error('Session not found')
    if (session.info.kind !== 'ssh') throw new Error('The AI assistant only works on SSH sessions')

    const aiSettings = this.deps.settings.get().ai
    const config = this.deps.store.resolveActive(aiSettings.activeConfigId)
    if (!config) throw new Error('No AI provider is configured yet — add one in Settings → AI')

    const abort = new AbortController()
    this.runs.set(req.conversationId, abort)
    void this.runLoop(req, config, abort.signal).finally(() => {
      this.runs.delete(req.conversationId)
      for (const [id, p] of [...this.pendingConfirms]) {
        if (p.conversationId === req.conversationId) {
          this.pendingConfirms.delete(id)
          p.settle(false)
        }
      }
    })
  }

  abort(conversationId: string): void {
    this.runs.get(conversationId)?.abort()
  }

  resolveConfirm(confirmId: string, approve: boolean, autoRest?: boolean): void {
    const p = this.pendingConfirms.get(confirmId)
    if (!p) return
    if (approve && autoRest) this.autoConversations.add(p.conversationId)
    p.settle(approve)
  }

  private async runLoop(req: AiChatRequest, config: AiProviderConfig, signal: AbortSignal): Promise<void> {
    const { conversationId, sessionId } = req
    const emitter = this.deps.emitter
    const adapter = createAdapter(config.protocol, this.deps.fetchImpl)
    const messages: AiMessage[] = [{ role: 'system', content: this.systemPrompt(sessionId) }, ...req.messages]
    try {
      const maxTurns = this.deps.settings.get().ai.maxTurns
      let stopped: 'stop' | 'maxTurns' = 'maxTurns'
      for (let turn = 0; turn < maxTurns; turn++) {
        if (signal.aborted) throw new Error('aborted')
        const res = await adapter.chat({
          config,
          messages,
          tools: TOOLS,
          signal,
          onDelta: (text) => emitter.emit('ai.delta', { conversationId, text })
        })
        messages.push(res.toolCalls.length ? { role: 'assistant', content: res.text, toolCalls: res.toolCalls } : { role: 'assistant', content: res.text })
        if (!res.toolCalls.length) {
          stopped = 'stop'
          break
        }
        for (const call of res.toolCalls) {
          if (signal.aborted) throw new Error('aborted')
          emitter.emit('ai.toolCall', { conversationId, callId: call.id, name: call.name, args: call.args })
          let ok = true
          let result = ''
          try {
            if (this.needsConfirm(conversationId, call.name)) {
              const approved = await this.confirmGate(conversationId, call, signal)
              if (!approved) {
                ok = false
                result = AI_DECLINED_RESULT
              }
            }
            if (ok) result = await this.executeTool(sessionId, call)
          } catch (err) {
            ok = false
            result = `Error: ${(err as Error).message}`
          }
          if (signal.aborted) throw new Error('aborted')
          emitter.emit('ai.toolResult', { conversationId, callId: call.id, name: call.name, ok, result })
          messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: result })
        }
      }
      emitter.emit('ai.done', { conversationId, reason: stopped })
    } catch (err) {
      if (signal.aborted) emitter.emit('ai.done', { conversationId, reason: 'aborted' })
      else emitter.emit('ai.done', { conversationId, reason: 'error', error: (err as Error).message })
    }
  }

  private needsConfirm(conversationId: string, toolName: string): boolean {
    // Typing into the live terminal is never auto-approved: its effects cannot be predicted.
    if (toolName === 'send_keys') return true
    const autoApprove = this.deps.settings.get().ai.autoApprove || this.autoConversations.has(conversationId)
    return !autoApprove
  }

  private confirmGate(conversationId: string, call: AiToolCall, signal: AbortSignal): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const confirmId = uuidv7()
      let settled = false
      const settle = (approved: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        this.pendingConfirms.delete(confirmId)
        resolve(approved)
      }
      const onAbort = (): void => settle(false)
      const timer = setTimeout(() => settle(false), CONFIRM_TIMEOUT_MS)
      this.pendingConfirms.set(confirmId, { conversationId, settle })
      signal.addEventListener('abort', onAbort, { once: true })
      this.deps.emitter.emit('ai.confirm', { confirmId, conversationId, callId: call.id, name: call.name, args: call.args })
    })
  }

  // ---------------------------------------------------------------- tools

  private async executeTool(sessionId: string, call: AiToolCall): Promise<string> {
    if (call.name === 'run_command') return await this.runCommand(sessionId, call.args)
    if (call.name === 'send_keys') return await this.sendKeys(sessionId, call.args)
    return `Error: unknown tool "${call.name}"`
  }

  private async runCommand(sessionId: string, args: Record<string, unknown>): Promise<string> {
    const command = typeof args.command === 'string' ? args.command : ''
    if (!command.trim()) return 'Error: empty command'
    const defaultSec = this.deps.settings.get().ai.commandTimeoutSec
    const timeoutSec = clamp(Math.round(Number(args.timeoutSec) || defaultSec), 5, 600)

    const session = this.deps.sessions.get(sessionId) as SshSessionLike | undefined
    const hostId = session?.info.hostId
    const exec = async (): Promise<{ code: number | null; stdout: string; stderr: string }> => {
      if (session?.info.kind === 'ssh' && session.connection) {
        return await session.connection.exec(command, { timeoutMs: timeoutSec * 1000, maxBytes: 512 * 1024 })
      }
      if (hostId) {
        const lease = await this.deps.pool.acquire(hostId)
        try {
          return await lease.conn.exec(command, { timeoutMs: timeoutSec * 1000, maxBytes: 512 * 1024 })
        } finally {
          lease.release()
        }
      }
      throw new Error('the terminal session is disconnected and the host has no stored connection')
    }

    // Errors propagate to the loop, which reports them as a failed tool result (ok=false)
    // while still feeding the message back to the model.
    const res = await exec()
    const stdout = truncateMiddle(res.stdout, MAX_STDOUT_CHARS)
    const stderr = truncateMiddle(res.stderr, MAX_STDERR_CHARS)
    const parts = [`exit code: ${res.code ?? 'unknown'}`]
    if (stdout) parts.push(`--- stdout ---\n${stdout}`)
    if (stderr) parts.push(`--- stderr ---\n${stderr}`)
    if (!stdout && !stderr) parts.push('(no output)')
    return parts.join('\n')
  }

  private async sendKeys(sessionId: string, args: Record<string, unknown>): Promise<string> {
    const text = typeof args.text === 'string' ? args.text : ''
    if (!text) return 'Error: empty text'
    const waitSec = clamp(Math.round(Number(args.waitSec) || 10), 1, 60)
    const session = this.deps.sessions.get(sessionId) as SshSessionLike | undefined
    if (session?.info.kind !== 'ssh' || typeof session.captureWrite !== 'function') {
      return 'Error: send_keys only works on SSH terminal sessions'
    }
    const captured = await session.captureWrite(text, { timeoutMs: waitSec * 1000 })
    if (!captured.trim()) return 'Text typed into the terminal. No output was captured within the wait window.'
    return `Terminal output after typing:\n${truncateMiddle(captured, MAX_STDERR_CHARS)}`
  }

  // ---------------------------------------------------------------- prompt

  private systemPrompt(sessionId: string): string {
    const s = this.deps.sessions.get(sessionId) as SshSessionLike | undefined
    const label = s?.info.title ?? 'remote host'
    const os = s?.info.osHint ?? 'unknown OS'
    const status = s?.info.status ?? 'unknown'
    return [
      'You are an AI operations assistant embedded in an SSH terminal application. You complete tasks on the remote server by running commands on the user\'s behalf.',
      `Target: "${label}" (${os}), session status: ${status}.`,
      '',
      'Tool usage rules:',
      '- run_command executes in a non-interactive shell: no persisted cwd/env between calls, no TTY. Chain steps with && or use absolute paths.',
      '- Command output is truncated from the middle when large; use head/tail/grep/wc for big files.',
      '- The user approves every command before it runs. A declined command must not be retried; explain and ask instead.',
      '- send_keys types into the user\'s visible terminal; reserve it for TTY-only interactions (sudo password prompts, editors, interactive wizards) and always say what you are about to type.',
      '- Before destructive operations (rm -rf, dd, mkfs, shutdown, dropping data), explain the impact first.',
      '- After each command, briefly interpret the result for the user. Finish with a short summary of what was done once the task is complete.',
      '- Reply in the user\'s language (default to Chinese when they write Chinese).'
    ].join('\n')
  }
}
