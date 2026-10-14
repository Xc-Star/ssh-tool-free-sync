import { KeyRound, ShieldAlert, ShieldQuestion, FileWarning, Lock, User } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PromptRequest } from '@shared/types'
import { formatBytes } from '@shared/util'
import { Button } from './ui/button'
import { Checkbox } from './ui/controls'
import { Dialog, DialogBody, DialogContent, DialogFooter } from './ui/dialog'
import { Field, Input, PasswordInput } from './ui/input'
import { formatDate } from '@/lib/utils'
import { focusTerminal } from '@/features/terminal/registry'
import { respondPrompt, usePrompts } from '@/stores/prompts'
import { activeSessionId } from '@/stores/tabs'

/** Renders the first pending main-process prompt as a modal dialog. */
export function PromptHost(): React.JSX.Element | null {
  const req = usePrompts((s) => s.queue[0])
  if (!req) return null
  return <PromptDialog key={req.id} req={req} />
}

function PromptDialog({ req }: { req: PromptRequest }): React.JSX.Element {
  const { t, i18n } = useTranslation('prompts')
  const { t: tc } = useTranslation()
  const [value, setValue] = useState('')
  const [save, setSave] = useState(true)
  const [answers, setAnswers] = useState<string[]>(req.type === 'keyboard-interactive' ? req.prompts.map(() => '') : [])
  const [applyAll, setApplyAll] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 30)
  }, [])

  const cancel = (): void => {
    if (req.type === 'hostkey') respondPrompt(req.id, 'reject')
    else if (req.type === 'conflict') respondPrompt(req.id, { action: 'skip', applyToAll: false })
    else respondPrompt(req.id, null)
  }

  let content: React.ReactNode
  if (req.type === 'hostkey') {
    content = (
      <>
        <DialogBody className="flex flex-col gap-3">
          <div className="flex items-start gap-3">
            <div className={req.changed ? 'text-danger' : 'text-warning'}>{req.changed ? <ShieldAlert className="size-8" /> : <ShieldQuestion className="size-8" />}</div>
            <p className="text-[13px] leading-relaxed text-muted">
              {req.changed ? t('hostkeyChanged', { host: `${req.host}:${req.port}` }) : t('hostkeyNew', { host: `${req.hostLabel} (${req.host}:${req.port})` })}
            </p>
          </div>
          <div className="selectable rounded-lg border border-line bg-panel p-3 font-mono text-xs leading-6">
            <div>
              <span className="text-subtle">{t('keyType')}: </span>
              {req.keyType}
            </div>
            <div className="break-all">
              <span className="text-subtle">{t('fingerprint')}: </span>
              {req.fingerprint}
            </div>
            {req.oldFingerprint && (
              <div className="break-all text-danger">
                <span className="text-subtle">{t('oldFingerprint')}: </span>
                {req.oldFingerprint}
              </div>
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => respondPrompt(req.id, 'reject')}>
            {t('reject')}
          </Button>
          <Button variant="secondary" onClick={() => respondPrompt(req.id, 'accept-once')}>
            {t('acceptOnce')}
          </Button>
          <Button variant={req.changed ? 'danger' : 'primary'} onClick={() => respondPrompt(req.id, 'accept-save')} data-testid="hostkey-accept">
            {t('acceptSave')}
          </Button>
        </DialogFooter>
      </>
    )
  } else if (req.type === 'password' || req.type === 'passphrase' || req.type === 'username') {
    const isUser = req.type === 'username'
    const label =
      req.type === 'password'
        ? t('passwordFor', { user: req.username, host: req.hostLabel })
        : req.type === 'passphrase'
          ? t('passphraseFor', { key: req.keyLabel })
          : t('usernameFor', { host: req.hostLabel })
    content = (
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (isUser) respondPrompt(req.id, { value })
          else respondPrompt(req.id, { value, save: req.allowSave && save })
        }}
      >
        <DialogBody className="flex flex-col gap-3">
          <Field label={label} error={'message' in req ? req.message : undefined}>
            {isUser ? (
              <Input ref={inputRef} value={value} onChange={(e) => setValue(e.target.value)} data-testid="prompt-input" />
            ) : (
              <PasswordInput ref={inputRef} value={value} onChange={(e) => setValue(e.target.value)} data-testid="prompt-input" />
            )}
          </Field>
          {!isUser && req.allowSave && (
            <label className="flex items-center gap-2 text-[13px] text-muted">
              <Checkbox checked={save} onCheckedChange={(v) => setSave(v === true)} />
              {req.type === 'password' ? t('savePassword') : t('savePassphrase')}
            </label>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={cancel}>
            {tc('cancel')}
          </Button>
          <Button variant="primary" type="submit" data-testid="prompt-submit">
            {t('continue')}
          </Button>
        </DialogFooter>
      </form>
    )
  } else if (req.type === 'keyboard-interactive') {
    content = (
      <form
        onSubmit={(e) => {
          e.preventDefault()
          respondPrompt(req.id, { answers })
        }}
      >
        <DialogBody className="flex flex-col gap-3">
          {(req.name || req.instructions) && <p className="whitespace-pre-line text-[13px] text-muted">{[req.name, req.instructions].filter(Boolean).join('\n')}</p>}
          {req.prompts.map((p, i) => (
            <Field key={i} label={p.prompt}>
              {p.echo ? (
                <Input ref={i === 0 ? inputRef : undefined} value={answers[i]} onChange={(e) => setAnswers((a) => a.map((x, j) => (j === i ? e.target.value : x)))} />
              ) : (
                <PasswordInput ref={i === 0 ? inputRef : undefined} value={answers[i]} onChange={(e) => setAnswers((a) => a.map((x, j) => (j === i ? e.target.value : x)))} />
              )}
            </Field>
          ))}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={cancel}>
            {tc('cancel')}
          </Button>
          <Button variant="primary" type="submit">
            {t('continue')}
          </Button>
        </DialogFooter>
      </form>
    )
  } else {
    const r = req
    content = (
      <>
        <DialogBody className="flex flex-col gap-3">
          <p className="text-[13px] text-muted">{t('conflict', { name: r.fileName })}</p>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-lg border border-line bg-panel p-2.5">
              <div className="mb-1 font-medium text-fg">{t('source')}</div>
              <div className="text-muted">{formatBytes(r.srcSize)}</div>
              <div className="text-muted">{formatDate(r.srcMtime, i18n.language)}</div>
            </div>
            <div className="rounded-lg border border-line bg-panel p-2.5">
              <div className="mb-1 font-medium text-fg">{t('target')}</div>
              <div className="text-muted">{formatBytes(r.dstSize)}</div>
              <div className="text-muted">{formatDate(r.dstMtime, i18n.language)}</div>
            </div>
          </div>
          <label className="flex items-center gap-2 text-[13px] text-muted">
            <Checkbox checked={applyAll} onCheckedChange={(v) => setApplyAll(v === true)} />
            {t('applyToAll')}
          </label>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => respondPrompt(r.id, { action: 'skip', applyToAll: applyAll })}>
            {t('skip')}
          </Button>
          <Button variant="secondary" onClick={() => respondPrompt(r.id, { action: 'rename', applyToAll: applyAll })}>
            {t('keepBoth')}
          </Button>
          <Button variant="primary" onClick={() => respondPrompt(r.id, { action: 'overwrite', applyToAll: applyAll })}>
            {t('overwrite')}
          </Button>
        </DialogFooter>
      </>
    )
  }

  const title =
    req.type === 'hostkey'
      ? req.changed
        ? t('hostkeyChangedTitle')
        : t('hostkeyNewTitle')
      : req.type === 'password'
        ? t('passwordTitle')
        : req.type === 'passphrase'
          ? t('passphraseTitle')
          : req.type === 'username'
            ? t('usernameTitle')
            : req.type === 'keyboard-interactive'
              ? t('kiTitle')
              : t('conflictTitle')
  const Icon = req.type === 'passphrase' ? KeyRound : req.type === 'username' ? User : req.type === 'conflict' ? FileWarning : Lock

  return (
    <Dialog open onOpenChange={(o) => !o && cancel()}>
      <DialogContent
        width={req.type === 'hostkey' ? 'max-w-lg' : 'max-w-md'}
        title={
          <span className="flex items-center gap-2">
            {req.type !== 'hostkey' && <Icon className="size-4 text-accent" />}
            {title}
          </span>
        }
        description={'hostLabel' in req && req.type === 'keyboard-interactive' ? t('kiFor', { host: req.hostLabel }) : undefined}
        data-testid={`prompt-${req.type}`}
        onCloseAutoFocus={(e) => {
          // Return the keyboard to the terminal that asked (instead of the now hidden host card that opened it).
          const sid = activeSessionId()
          if (!sid) return
          e.preventDefault()
          focusTerminal(sid, { auto: true })
        }}
      >
        {content}
      </DialogContent>
    </Dialog>
  )
}
