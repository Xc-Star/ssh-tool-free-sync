import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Loader2,
  MessageSquarePlus,
  Paperclip,
  Send,
  Square,
  Terminal,
  X,
  Zap
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from '@/components/ui/button'
import { Select, Switch, Tip } from '@/components/ui/controls'
import { Textarea } from '@/components/ui/input'
import { call } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useApp } from '@/stores/app'
import { useAi, type UiMessage, type UiToolCall } from '@/stores/ai'
import { activateTab, useTabs } from '@/stores/tabs'
import { bufferText } from '@/features/terminal/registry'
import { useSaveAiSettings } from '@/features/settings/GeneralSection'

const CONTEXT_CHARS = 8000

export function AiPanel({ sessionId, onClose }: { sessionId?: string; onClose: () => void }): React.JSX.Element {
  const { t } = useTranslation('ai')
  const session = useTabs((s) => (sessionId ? s.sessions[sessionId] : undefined))
  const conversation = useAi((s) => (sessionId ? s.conversations[sessionId] : undefined))
  const configs = useAi((s) => s.configs)
  const settings = useApp((s) => s.settings)
  const save = useSaveAiSettings()
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void useAi.getState().refreshConfigs()
  }, [])

  const lastLen = conversation?.messages.length ?? 0
  const lastContent = conversation?.messages[conversation.messages.length - 1]?.content
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lastLen, lastContent])

  if (!sessionId || !session) {
    return (
      <PanelShell onClose={onClose}>
        <EmptyHint text={t('noSession')} />
      </PanelShell>
    )
  }
  if (session.kind !== 'ssh') {
    return (
      <PanelShell onClose={onClose} sessionTitle={session.title}>
        <EmptyHint text={t('notSsh')} />
      </PanelShell>
    )
  }

  const conv = conversation
  const running = conv?.status === 'running'
  const noConfig = configs.length === 0

  return (
    <PanelShell
      onClose={onClose}
      sessionTitle={session.title}
      headerExtra={
        <>
          <Tip content={t('autoApprove')}>
            <span className="flex items-center gap-1">
              <Zap className={cn('size-3.5', settings.ai.autoApprove ? 'text-warning' : 'text-subtle')} />
              <Switch checked={settings.ai.autoApprove} onCheckedChange={(v) => save({ autoApprove: v })} />
            </span>
          </Tip>
          <Tip content={t('newChat')}>
            <Button size="icon-xs" variant="ghost" onClick={() => useAi.getState().newConversation(sessionId)} data-testid="ai-new-chat">
              <MessageSquarePlus />
            </Button>
          </Tip>
        </>
      }
    >
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-3" data-testid="ai-messages">
        {!conv || conv.messages.length === 0 ? (
          noConfig ? (
            <EmptyHint text={t('noConfig')} action={<OpenSettingsButton />} />
          ) : (
            <EmptyHint text={t('empty')} sessionId={sessionId} suggestions />
          )
        ) : (
          <>
            {conv.error && (
              <div className="mb-3 rounded-lg border border-danger/35 bg-danger/10 px-3 py-2 text-xs leading-relaxed text-danger" data-testid="ai-error">
                {conv.error}
              </div>
            )}
            {conv.notice && (
              <div className="mb-3 rounded-lg border border-warning/35 bg-warning/10 px-3 py-2 text-xs text-warning">
                {conv.notice === 'maxTurns' ? t('maxTurns') : t('aborted')}
              </div>
            )}
            {conv.messages.map((m) => (
              <MessageRow key={m.id} message={m} />
            ))}
            {running && !conv.messages.some((m) => m.pending) && !conv.messages.some((m) => m.toolCalls?.some((c) => c.status === 'running' || c.status === 'pending-confirm')) && (
              <div className="flex items-center gap-2 px-1 py-2 text-xs text-subtle">
                <Loader2 className="size-3.5 animate-spin" />
                {t('thinking')}
              </div>
            )}
          </>
        )}
      </div>

      {noConfig ? (
        <div className="border-t border-line p-3 text-center">
          <OpenSettingsButton />
        </div>
      ) : (
        <ChatInput sessionId={sessionId} running={running} connected={session.status === 'connected'} />
      )}
    </PanelShell>
  )
}

function OpenSettingsButton(): React.JSX.Element {
  const { t } = useTranslation('ai')
  const setSection = useApp((s) => s.setSection)
  return (
    <Button
      size="sm"
      variant="secondary"
      onClick={() => {
        // The settings page lives in the vault tab; just switching the section would keep the
        // terminal tab in front and look like the button did nothing.
        activateTab('vault')
        setSection('settings', 'ai')
      }}
      data-testid="ai-open-settings"
    >
      {t('openSettings')}
    </Button>
  )
}

function PanelShell({
  children,
  onClose,
  sessionTitle,
  headerExtra
}: {
  children: React.ReactNode
  onClose: () => void
  sessionTitle?: string
  headerExtra?: React.ReactNode
}): React.JSX.Element {
  const { t } = useTranslation('ai')
  const configs = useAi((s) => s.configs)
  const settings = useApp((s) => s.settings)
  const save = useSaveAiSettings()
  const activeId = settings.ai.activeConfigId && configs.some((c) => c.id === settings.ai.activeConfigId) ? settings.ai.activeConfigId : ''

  return (
    <div className="flex h-full w-[340px] shrink-0 flex-col border-l border-line bg-sidebar" data-testid="ai-panel">
      <div className="flex h-10 items-center gap-1.5 border-b border-line px-3">
        <Bot className="size-4 shrink-0 text-accent" />
        <span className="flex-1 truncate text-[13px] font-semibold" title={sessionTitle}>
          {t('title')}
        </span>
        <div className="w-[104px] shrink-0">
          <Select
            value={activeId}
            onChange={(id) => save({ activeConfigId: id || undefined })}
            options={configs.map((c) => ({ value: c.id, label: c.name }))}
            allowEmpty
            emptyLabel={configs.length ? t('configDefault') : t('configNone')}
            className="h-7 text-xs"
          />
        </div>
        {headerExtra}
        <Button size="icon-xs" variant="ghost" onClick={onClose}>
          <X />
        </Button>
      </div>
      {children}
    </div>
  )
}

function EmptyHint({ text, action, suggestions, sessionId }: { text: string; action?: React.ReactNode; suggestions?: boolean; sessionId?: string }): React.JSX.Element {
  const { t } = useTranslation('ai')
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      <Bot className="size-8 text-subtle" />
      <p className="text-xs leading-relaxed text-muted">{text}</p>
      {action}
      {suggestions && sessionId && (
        <div className="mt-2 flex w-full flex-col gap-1.5">
          {[t('suggest1'), t('suggest2'), t('suggest3')].map((s) => (
            <SuggestionChip key={s} text={s} sessionId={sessionId} />
          ))}
        </div>
      )}
    </div>
  )
}

function SuggestionChip({ text, sessionId }: { text: string; sessionId: string }): React.JSX.Element {
  return (
    <button
      className="w-full rounded-lg border border-line bg-panel px-3 py-2 text-left text-xs text-muted transition-colors hover:border-accent/40 hover:text-fg"
      onClick={() => useAi.getState().send(sessionId, text)}
    >
      {text}
    </button>
  )
}

function MessageRow({ message }: { message: UiMessage }): React.JSX.Element {
  if (message.role === 'user') {
    return (
      <div className="mb-3 flex flex-col items-end" data-testid="ai-msg-user">
        <div className="max-w-[92%] rounded-xl rounded-br-sm border border-accent/25 bg-accent-soft px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap break-words">
          {message.content}
        </div>
        {message.context && <ContextChip context={message.context} />}
      </div>
    )
  }
  return (
    <div className="mb-3" data-testid="ai-msg-assistant">
      {message.content ? (
        <div className="px-0.5 text-[13px] leading-relaxed text-fg">
          <Markdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: ({ href, children }) => (
                <a
                  href={href}
                  onClick={(e) => {
                    e.preventDefault()
                    if (href) void call('app.openExternal', href).catch(() => {})
                  }}
                  className="text-accent hover:underline"
                >
                  {children}
                </a>
              ),
              code: ({ className, children, ...props }) => {
                const block = /language-/.test(className ?? '')
                return block ? (
                  <code className={cn('font-mono', className)} {...props}>
                    {children}
                  </code>
                ) : (
                  <code className="rounded bg-panel px-1 py-0.5 font-mono text-[12px] text-accent" {...props}>
                    {children}
                  </code>
                )
              },
              pre: ({ children }) => (
                <pre className="my-1.5 max-w-full overflow-x-auto rounded-lg border border-line bg-panel p-2.5 font-mono text-[12px] leading-relaxed text-muted">
                  {children}
                </pre>
              )
            }}
          >
            {message.content}
          </Markdown>
        </div>
      ) : null}
      {message.toolCalls?.map((c) => (
        <CommandCard key={c.callId} call={c} />
      ))}
    </div>
  )
}

function ContextChip({ context }: { context: string }): React.JSX.Element {
  const { t } = useTranslation('ai')
  return (
    <details className="mt-1 max-w-[92%]">
      <summary className="cursor-pointer select-none text-[11px] text-subtle hover:text-muted">{t('contextAttached')}</summary>
      <pre className="mt-1 max-h-40 overflow-auto rounded-lg border border-line bg-panel p-2 font-mono text-[11px] leading-relaxed text-subtle">
        {context}
      </pre>
    </details>
  )
}

function CommandCard({ call }: { call: UiToolCall }): React.JSX.Element {
  const { t } = useTranslation('ai')
  const isKeys = call.name === 'send_keys'
  const command = typeof call.args.command === 'string' ? call.args.command : ''
  const keysText = typeof call.args.text === 'string' ? call.args.text.replace(/\r/g, '⏎\n') : ''
  const body = isKeys ? keysText : command
  const long = (call.result ?? '').split('\n').length > 10
  const [open, setOpen] = useState(!long)

  const statusIcon =
    call.status === 'done' ? (
      <Check className="size-3.5 text-success" />
    ) : call.status === 'error' ? (
      <X className="size-3.5 text-danger" />
    ) : call.status === 'declined' ? (
      <X className="size-3.5 text-subtle" />
    ) : call.status === 'running' ? (
      <Loader2 className="size-3.5 animate-spin text-accent" />
    ) : null

  return (
    <div
      className={cn(
        'my-2 overflow-hidden rounded-lg border bg-panel',
        call.status === 'pending-confirm' ? 'border-warning/50' : call.status === 'error' ? 'border-danger/35' : 'border-line'
      )}
      data-testid="ai-command-card"
    >
      <div className="flex items-start gap-2 px-2.5 py-2">
        {isKeys ? <Terminal className="mt-0.5 size-3.5 shrink-0 text-accent" /> : <span className="mt-0.5 shrink-0 font-mono text-xs text-accent">$</span>}
        <pre className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-[11.5px] leading-relaxed text-fg">{body}</pre>
        <Tip content={t('copy')}>
          <button className="shrink-0 rounded p-1 text-subtle hover:text-fg" onClick={() => void navigator.clipboard.writeText(body)}>
            <Copy className="size-3" />
          </button>
        </Tip>
      </div>

      {call.status === 'pending-confirm' && (
        <div className="flex items-center gap-1.5 border-t border-warning/30 bg-warning/5 px-2.5 py-1.5">
          <span className="flex-1 text-[11px] text-warning">{t('confirmAsk')}</span>
          <Button
            size="xs"
            variant="primary"
            onClick={() => call.confirmId && useAi.getState().resolveConfirm(call.confirmId, true)}
            data-testid="ai-approve"
          >
            {t('approve')}
          </Button>
          <Button size="xs" variant="ghost" onClick={() => call.confirmId && useAi.getState().resolveConfirm(call.confirmId, false)}>
            {t('decline')}
          </Button>
          <Tip content={t('autoRestTip')}>
            <Button
              size="xs"
              variant="ghost"
              className="text-warning"
              onClick={() => call.confirmId && useAi.getState().resolveConfirm(call.confirmId, true, true)}
              data-testid="ai-approve-auto"
            >
              {t('autoRest')}
            </Button>
          </Tip>
        </div>
      )}

      {call.status !== 'pending-confirm' && call.result !== undefined && (
        <div className="border-t border-line">
          <button className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[11px] text-subtle hover:text-muted" onClick={() => setOpen((v) => !v)}>
            {statusIcon}
            <span className="flex-1">
              {call.status === 'declined' ? t('statusDeclined') : call.status === 'error' ? t('statusError') : t('statusDone')}
            </span>
            {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          </button>
          {open && (
            <pre className="max-h-64 overflow-auto border-t border-line px-2.5 py-2 font-mono text-[11px] leading-relaxed text-muted" data-testid="ai-command-output">
              {call.result}
            </pre>
          )}
        </div>
      )}

      {call.status === 'running' && call.result === undefined && (
        <div className="flex items-center gap-1.5 border-t border-line px-2.5 py-1.5 text-[11px] text-subtle">
          <Loader2 className="size-3 animate-spin" />
          {t('statusRunning')}
        </div>
      )}
    </div>
  )
}

function ChatInput({ sessionId, running, connected }: { sessionId: string; running: boolean; connected: boolean }): React.JSX.Element {
  const { t } = useTranslation('ai')
  const [text, setText] = useState('')
  const [withContext, setWithContext] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)

  const submit = (): void => {
    const value = text.trim()
    if (!value || running) return
    const context = withContext ? bufferText(sessionId).slice(-CONTEXT_CHARS) : undefined
    useAi.getState().send(sessionId, value, context)
    setText('')
    if (ref.current) ref.current.style.height = 'auto'
  }

  return (
    <div className="border-t border-line p-2.5">
      <div className="mb-1.5 flex items-center gap-2">
        <Tip content={t('attachContext')}>
          <button
            className={cn('rounded-md border border-line p-1 text-subtle transition-colors hover:text-fg', withContext && 'border-accent/50 text-accent')}
            onClick={() => setWithContext((v) => !v)}
            data-testid="ai-context-toggle"
          >
            <Paperclip className="size-3.5" />
          </button>
        </Tip>
        {!connected && <span className="text-[11px] text-warning">{t('disconnected')}</span>}
      </div>
      <div className="flex items-end gap-1.5">
        <Textarea
          ref={ref}
          value={text}
          rows={1}
          placeholder={t('inputPlaceholder')}
          className="max-h-40 min-h-[34px] flex-1 resize-none py-2 text-[13px]"
          onChange={(e) => {
            setText(e.target.value)
            e.currentTarget.style.height = 'auto'
            e.currentTarget.style.height = `${Math.min(e.currentTarget.scrollHeight, 160)}px`
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
          data-testid="ai-input"
        />
        {running ? (
          <Tip content={t('stop')}>
            <Button size="icon-sm" variant="danger" onClick={() => useAi.getState().abort(sessionId)} data-testid="ai-stop">
              <Square />
            </Button>
          </Tip>
        ) : (
          <Tip content={t('send')}>
            <Button size="icon-sm" variant="primary" disabled={!text.trim()} onClick={submit} data-testid="ai-send">
              <Send />
            </Button>
          </Tip>
        )}
      </div>
    </div>
  )
}
