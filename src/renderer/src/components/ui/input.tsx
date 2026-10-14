import { Eye, EyeOff } from 'lucide-react'
import { forwardRef, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes, useState } from 'react'
import { cn } from '@/lib/utils'

export const inputClass =
  'h-8 w-full rounded-md border border-line bg-input px-2.5 text-[13px] text-fg placeholder:text-subtle outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:opacity-50'

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  icon?: ReactNode
  suffix?: ReactNode
}

export const Input = forwardRef<HTMLInputElement, InputProps>(({ className, icon, suffix, ...props }, ref) => {
  if (!icon && !suffix) return <input ref={ref} spellCheck={false} className={cn(inputClass, className)} {...props} />
  return (
    <div className={cn('relative flex items-center', className)}>
      {icon && <span className="pointer-events-none absolute left-2.5 text-subtle [&_svg]:size-4">{icon}</span>}
      <input ref={ref} spellCheck={false} className={cn(inputClass, icon && 'pl-8', suffix && 'pr-8')} {...props} />
      {suffix && <span className="absolute right-1.5 flex items-center">{suffix}</span>}
    </div>
  )
})
Input.displayName = 'Input'

export interface PasswordInputProps extends Omit<InputProps, 'type'> {
  /** Called when the user asks to reveal a value that is masked server side. */
  onReveal?: () => Promise<string | undefined>
}

export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(({ onReveal, ...props }, ref) => {
  const [visible, setVisible] = useState(false)
  const toggle = async (): Promise<void> => {
    if (!visible && onReveal) await onReveal()
    setVisible((v) => !v)
  }
  return (
    <Input
      ref={ref}
      type={visible ? 'text' : 'password'}
      autoComplete="new-password"
      suffix={
        <button type="button" tabIndex={-1} onClick={() => void toggle()} className="rounded p-1 text-subtle hover:text-fg [&_svg]:size-3.5">
          {visible ? <EyeOff /> : <Eye />}
        </button>
      }
      {...props}
    />
  )
})
PasswordInput.displayName = 'PasswordInput'

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    spellCheck={false}
    className={cn(
      'w-full rounded-md border border-line bg-input px-2.5 py-2 text-[13px] text-fg placeholder:text-subtle outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:opacity-50',
      className
    )}
    {...props}
  />
))
Textarea.displayName = 'Textarea'

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>): React.JSX.Element {
  return <label className={cn('text-xs font-medium text-muted', className)} {...props} />
}

export function Field({
  label,
  hint,
  error,
  children,
  className,
  htmlFor
}: {
  label?: ReactNode
  hint?: ReactNode
  error?: ReactNode
  children: ReactNode
  className?: string
  htmlFor?: string
}): React.JSX.Element {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label && <Label htmlFor={htmlFor}>{label}</Label>}
      {children}
      {error ? <p className="text-xs text-danger">{error}</p> : hint ? <p className="text-xs text-subtle">{hint}</p> : null}
    </div>
  )
}
