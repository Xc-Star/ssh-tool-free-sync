import { Eye, EyeOff, X } from 'lucide-react'
import { useState } from 'react'
import { SECRET_MASK } from '@shared/schemas'
import { vaultApi } from '@/lib/api'
import { cn } from '@/lib/utils'
import { inputClass } from './ui/input'

function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), obj)
}

/**
 * Input for a secret stored in the vault. The renderer only receives SECRET_MASK for saved secrets;
 * the eye button fetches the real value on demand (vault.reveal).
 */
export function SecretInput({
  value,
  onChange,
  itemId,
  path,
  placeholder,
  savedPlaceholder,
  className,
  multiline,
  testId
}: {
  value: string | undefined
  onChange: (v: string) => void
  itemId?: string
  path: string
  placeholder?: string
  savedPlaceholder?: string
  className?: string
  multiline?: boolean
  testId?: string
}): React.JSX.Element {
  const [visible, setVisible] = useState(false)
  const masked = value === SECRET_MASK
  const reveal = async (): Promise<void> => {
    if (masked && itemId) {
      const full = await vaultApi.reveal(itemId)
      const real = getPath(full?.data, path)
      onChange(typeof real === 'string' ? real : '')
    }
    setVisible((v) => !v)
  }
  const common = {
    value: masked ? '' : (value ?? ''),
    placeholder: masked ? savedPlaceholder : placeholder,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(e.target.value),
    spellCheck: false,
    autoComplete: 'new-password',
    'data-testid': testId
  }
  const buttons = (
    <span className="absolute right-1.5 top-1.5 flex items-center gap-0.5">
      {(masked || value) && (
        <button type="button" tabIndex={-1} onClick={() => onChange('')} className="rounded p-1 text-subtle hover:text-fg">
          <X className="size-3.5" />
        </button>
      )}
      <button type="button" tabIndex={-1} onClick={() => void reveal()} className="rounded p-1 text-subtle hover:text-fg">
        {visible ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
      </button>
    </span>
  )
  if (multiline) {
    return (
      <div className={cn('relative', className)}>
        <textarea
          {...common}
          rows={6}
          className={cn(inputClass, 'h-auto min-h-[120px] py-2 pr-16 font-mono text-xs', !visible && !masked && value && '[-webkit-text-security:disc]')}
        />
        {buttons}
      </div>
    )
  }
  return (
    <div className={cn('relative', className)}>
      <input {...common} type={visible ? 'text' : 'password'} className={cn(inputClass, 'pr-16')} />
      {buttons}
    </div>
  )
}
