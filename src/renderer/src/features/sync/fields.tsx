import { useTranslation } from 'react-i18next'
import { SECRET_MASK } from '@shared/schemas'
import { PasswordInput } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { passwordStrength } from './model'

/** Four-segment strength bar with a label. */
export function StrengthMeter({
  password,
  className
}: {
  password: string
  className?: string
}): React.JSX.Element {
  const { t } = useTranslation('sync')
  const { level, score } = passwordStrength(password)
  const filled = password ? Math.max(score, 1) : 0
  const bar = score <= 1 ? 'bg-danger' : score === 2 ? 'bg-warning' : 'bg-success'
  const text = score <= 1 ? 'text-danger' : score === 2 ? 'text-warning' : 'text-success'
  return (
    <div
      className={cn('flex items-center gap-3', className)}
      data-testid="sync-password-strength"
      data-level={password ? level : 'empty'}
    >
      <div className="flex flex-1 gap-1" aria-hidden>
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className={cn(
              'h-1.5 flex-1 rounded-full transition-colors duration-200',
              i <= filled ? bar : 'bg-line'
            )}
          />
        ))}
      </div>
      <span className={cn('min-w-16 text-right text-xs font-medium', password ? text : 'text-subtle')}>
        {password ? t(`vault.strength.${level}`) : t('vault.strengthLabel')}
      </span>
    </div>
  )
}

/**
 * Password field for stored connection secrets. The main process returns SECRET_MASK for a saved secret: the field then
 * shows empty with a "saved" placeholder, and clearing it again keeps the saved value.
 */
export function SecretInput({
  value,
  onChange,
  saved,
  placeholder,
  disabled,
  testId,
  id
}: {
  value: string
  onChange: (v: string) => void
  saved: boolean
  placeholder?: string
  disabled?: boolean
  testId?: string
  id?: string
}): React.JSX.Element {
  const { t } = useTranslation('sync')
  const masked = value === SECRET_MASK
  return (
    <PasswordInput
      id={id}
      value={masked ? '' : value}
      placeholder={masked || (saved && !value) ? t('form.secretSaved') : placeholder}
      onChange={(e) => onChange(e.target.value === '' && saved ? SECRET_MASK : e.target.value)}
      disabled={disabled}
      data-testid={testId}
    />
  )
}
