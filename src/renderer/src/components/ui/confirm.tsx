import { type ReactNode, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { create } from 'zustand'
import { Button } from './button'
import { Dialog, DialogBody, DialogContent, DialogFooter } from './dialog'
import { Field, Input } from './input'

interface ConfirmRequest {
  kind: 'confirm'
  title: ReactNode
  message?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  resolve: (v: boolean) => void
}

interface TextRequest {
  kind: 'text'
  title: ReactNode
  label?: ReactNode
  initial?: string
  placeholder?: string
  confirmLabel?: string
  password?: boolean
  validate?: (v: string) => string | undefined
  /** Select only the file stem (before the extension) when the dialog opens. */
  selectStem?: boolean
  resolve: (v: string | null) => void
}

const useDialogs = create<{ queue: (ConfirmRequest | TextRequest)[] }>(() => ({ queue: [] }))

export function confirm(opts: Omit<ConfirmRequest, 'kind' | 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => useDialogs.setState((s) => ({ queue: [...s.queue, { ...opts, kind: 'confirm', resolve }] })))
}

export function promptText(opts: Omit<TextRequest, 'kind' | 'resolve'>): Promise<string | null> {
  return new Promise((resolve) => useDialogs.setState((s) => ({ queue: [...s.queue, { ...opts, kind: 'text', resolve }] })))
}

function pop(): void {
  useDialogs.setState((s) => ({ queue: s.queue.slice(1) }))
}

export function DialogHost(): React.JSX.Element | null {
  const req = useDialogs((s) => s.queue[0])
  if (!req) return null
  return req.kind === 'confirm' ? <ConfirmDialog key={queueKey(req)} req={req} /> : <TextDialog key={queueKey(req)} req={req} />
}

let seq = 0
const keys = new WeakMap<object, number>()
function queueKey(o: object): number {
  if (!keys.has(o)) keys.set(o, ++seq)
  return keys.get(o)!
}

function ConfirmDialog({ req }: { req: ConfirmRequest }): React.JSX.Element {
  const { t } = useTranslation()
  const confirmRef = useRef<HTMLButtonElement>(null)
  const done = (v: boolean): void => {
    pop()
    req.resolve(v)
  }
  return (
    <Dialog open onOpenChange={(o) => !o && done(false)}>
      <DialogContent
        title={req.title}
        description={undefined}
        width="max-w-sm"
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          confirmRef.current?.focus()
        }}
      >
        {req.message && <DialogBody className="text-[13px] leading-relaxed text-muted">{req.message}</DialogBody>}
        <DialogFooter>
          <Button variant="ghost" onClick={() => done(false)}>
            {req.cancelLabel ?? t('cancel')}
          </Button>
          <Button ref={confirmRef} variant={req.danger ? 'danger' : 'primary'} onClick={() => done(true)} data-testid="confirm-ok">
            {req.confirmLabel ?? t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function TextDialog({ req }: { req: TextRequest }): React.JSX.Element {
  const { t } = useTranslation()
  const [value, setValue] = useState(req.initial ?? '')
  const [error, setError] = useState<string>()
  const ref = useRef<HTMLInputElement>(null)
  // Until the user types, clicks or moves the caret, keep the initial selection (all text, or only the file stem).
  const pristine = useRef(true)
  const applyInitialSelection = (): void => {
    const el = ref.current
    if (!el || !pristine.current || document.activeElement !== el) return
    if (req.selectStem && req.initial) {
      const dot = req.initial.lastIndexOf('.')
      el.setSelectionRange(0, dot > 0 ? dot : req.initial.length)
    } else el.select()
  }
  const done = (v: string | null): void => {
    if (v !== null) {
      const err = req.validate?.(v)
      if (err) {
        setError(err)
        return
      }
    }
    pop()
    req.resolve(v)
  }
  return (
    <Dialog open onOpenChange={(o) => !o && done(null)}>
      <DialogContent
        title={req.title}
        width="max-w-sm"
        onOpenAutoFocus={(e) => {
          // Radix would focus the first tabbable element (the close button); focus the input instead.
          e.preventDefault()
          ref.current?.focus()
          applyInitialSelection()
        }}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault()
            done(value)
          }}
        >
          <DialogBody>
            <Field label={req.label} error={error}>
              <Input
                ref={ref}
                type={req.password ? 'password' : 'text'}
                value={value}
                placeholder={req.placeholder}
                onFocus={() => {
                  // When a closing menu returns focus to its trigger, the dialog's focus trap pulls it back and
                  // selects the whole text; restore our selection after that.
                  requestAnimationFrame(applyInitialSelection)
                }}
                onMouseDown={() => {
                  pristine.current = false
                }}
                onKeyDown={() => {
                  pristine.current = false
                }}
                onChange={(e) => {
                  pristine.current = false
                  setValue(e.target.value)
                  setError(undefined)
                }}
              />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => done(null)}>
              {t('cancel')}
            </Button>
            <Button variant="primary" type="submit">
              {req.confirmLabel ?? t('ok')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
