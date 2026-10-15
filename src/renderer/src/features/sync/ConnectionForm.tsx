import {
  BookOpen,
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  FileUp,
  LifeBuoy,
  ShieldCheck,
  Server
} from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { SslMode } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Select, Switch } from '@/components/ui/controls'
import { Field, Input, Label, Textarea } from '@/components/ui/input'
import { call, errorMessage } from '@/lib/api'
import { cn, copyText } from '@/lib/utils'
import { Callout } from '@/features/settings/ui'
import { BRANDS, BrandIcon } from './DbLogo'
import { SecretInput } from './fields'
import {
  DEFAULT_PORT,
  type D1Form,
  type FieldErrors,
  isPrivateHost,
  needsCa,
  SSL_MODES,
  type SqlForm,
  sqlHost,
  URL_SCHEMES,
  type WebdavForm
} from './model'

const CF_TOKENS_URL = 'https://dash.cloudflare.com/profile/api-tokens'
const CF_D1_DOCS_URL = 'https://developers.cloudflare.com/d1/'
const WEBDAV_DOCS_URL = 'https://docs.nextcloud.com/server/latest/user_manual/en/files/access_webdav.html'
const WRANGLER_CMD = 'npx wrangler d1 create sshtool'

function openExternal(url: string): void {
  call('app.openExternal', url).catch((err) => toast.error(errorMessage(err)))
}

export function Disclosure({
  title,
  icon,
  defaultOpen = false,
  children,
  testId,
  className
}: {
  title: ReactNode
  icon?: ReactNode
  defaultOpen?: boolean
  children: ReactNode
  testId?: string
  className?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={cn('rounded-xl border border-line bg-app', className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-left text-[13px] font-medium hover:text-fg"
        data-testid={testId}
      >
        {icon && <span className="text-accent [&_svg]:size-4">{icon}</span>}
        <span className="flex-1">{title}</span>
        <ChevronRight className={cn('size-4 text-subtle transition-transform', open && 'rotate-90')} />
      </button>
      {open && <div className="border-t border-line px-3.5 pb-3.5 pt-3">{children}</div>}
    </div>
  )
}

function Advanced({
  children,
  defaultOpen
}: {
  children: ReactNode
  defaultOpen: boolean
}): React.JSX.Element {
  const { t } = useTranslation('sync')
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-1 text-xs font-medium text-muted hover:text-fg"
        data-testid="sync-advanced-toggle"
      >
        <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
        {t('form.advanced')}
      </button>
      {open && <div className="mt-3 flex flex-col gap-3 border-l-2 border-line pl-4">{children}</div>}
    </div>
  )
}

function CodeLine({ text }: { text: string }): React.JSX.Element {
  const { t } = useTranslation('sync')
  const [copied, setCopied] = useState(false)
  return (
    <div className="mt-2 flex items-center gap-2 rounded-md border border-line bg-panel py-1 pl-3 pr-1">
      <code className="selectable min-w-0 flex-1 truncate font-mono text-xs text-fg">{text}</code>
      <Button
        size="xs"
        variant="ghost"
        onClick={() =>
          void copyText(text).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
        }
      >
        {copied ? <Check className="text-success" /> : <Copy />}
        {copied ? t('help.copied') : t('help.copy')}
      </Button>
    </div>
  )
}

function HelpStep({ n, children }: { n: number; children: ReactNode }): React.JSX.Element {
  return (
    <li className="flex gap-3">
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent">
        {n}
      </span>
      <div className="min-w-0 flex-1 text-xs leading-relaxed text-muted">{children}</div>
    </li>
  )
}

const strong = <strong className="font-semibold text-fg" />

export function D1Help({ defaultOpen }: { defaultOpen: boolean }): React.JSX.Element {
  const { t } = useTranslation('sync')
  return (
    <Disclosure title={t('help.d1Title')} icon={<BookOpen />} defaultOpen={defaultOpen} testId="sync-help-d1">
      <ol className="flex flex-col gap-3">
        <HelpStep n={1}>
          <Trans t={t} i18nKey="help.d1Step1" components={{ b: strong }} />
          <CodeLine text={WRANGLER_CMD} />
        </HelpStep>
        <HelpStep n={2}>
          <Trans t={t} i18nKey="help.d1Step2" components={{ b: strong }} />
        </HelpStep>
        <HelpStep n={3}>
          <Trans
            t={t}
            i18nKey="help.d1Step3"
            components={{
              b: strong,
              code: <code className="rounded bg-panel px-1 font-mono text-[11px] text-fg" />
            }}
          />
        </HelpStep>
      </ol>
      <Callout tone="warning" className="mt-3.5 px-3 py-2.5">
        {t('help.d1Warning')}
      </Callout>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => openExternal(CF_TOKENS_URL)}
          data-testid="sync-open-cf-tokens"
        >
          <ExternalLink />
          {t('help.openTokens')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => openExternal(CF_D1_DOCS_URL)}
          data-testid="sync-open-d1-docs"
        >
          <BookOpen />
          {t('help.openDocs')}
        </Button>
      </div>
    </Disclosure>
  )
}

export function WebdavHelp({ defaultOpen }: { defaultOpen: boolean }): React.JSX.Element {
  const { t } = useTranslation('sync')
  return (
    <Disclosure
      title={t('help.webdavTitle')}
      icon={<BookOpen />}
      defaultOpen={defaultOpen}
      testId="sync-help-webdav"
    >
      <div className="flex flex-col gap-2.5 text-xs leading-relaxed text-muted">
        <p>{t('help.webdav1')}</p>
        <p>
          <Trans t={t} i18nKey="help.webdav2" components={{ b: strong }} />
        </p>
        <p>{t('help.webdav3')}</p>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => openExternal(WEBDAV_DOCS_URL)}
          data-testid="sync-open-webdav-docs"
        >
          <BookOpen />
          {t('help.openWebdavDocs')}
        </Button>
      </div>
    </Disclosure>
  )
}

export function SqlHelp(): React.JSX.Element {
  const { t } = useTranslation('sync')
  return (
    <Disclosure title={t('help.sqlTitle')} icon={<LifeBuoy />} testId="sync-help-sql">
      <div className="flex flex-col gap-2.5 text-xs leading-relaxed text-muted">
        <p>{t('help.sql1')}</p>
        <div className="flex flex-wrap gap-1.5">
          {[BRANDS.supabase, BRANDS.neon].map((b) => (
            <span
              key={b.title}
              className="inline-flex h-6 items-center gap-1.5 rounded-full border border-line bg-panel px-2.5 text-[11px] text-fg"
            >
              <BrandIcon icon={b} className="size-3.5" />
              {b.title}
            </span>
          ))}
          <span className="inline-flex h-6 items-center gap-1.5 rounded-full border border-line bg-panel px-2.5 text-[11px] text-fg">
            <Server className="size-3.5 text-muted" />
            {t('help.selfHosted')}
          </span>
        </div>
        <p>
          <Trans t={t} i18nKey="help.sql2" components={{ b: strong }} />
        </p>
        <p>{t('help.sql3')}</p>
      </div>
    </Disclosure>
  )
}

interface FormProps {
  errors: FieldErrors | null
  disabled?: boolean
  savedSecret: boolean
}

export function SqlConnectionForm({
  kind,
  form,
  onChange,
  errors,
  disabled,
  savedSecret
}: FormProps & {
  kind: 'postgres' | 'mysql'
  form: SqlForm
  onChange: (patch: Partial<SqlForm>) => void
}): React.JSX.Element {
  const { t } = useTranslation('sync')
  const err = (k: keyof FieldErrors): string | undefined => {
    const key = errors?.[k]
    return key ? t(`form.errors.${key}`, { schemes: URL_SCHEMES[kind].join(' / ') }) : undefined
  }
  const host = sqlHost(form)
  const insecure = form.ssl === 'disable' && !!host && !isPrivateHost(host)

  const loadCa = async (): Promise<void> => {
    try {
      const [p] = await call('app.openFileDialog', {
        title: t('form.caLoad'),
        filters: [
          { name: t('form.caFiles'), extensions: ['pem', 'crt', 'cer'] },
          { name: t('form.allFiles'), extensions: ['*'] }
        ]
      })
      if (!p) return
      const text = await call('app.readTextFile', p, 256 * 1024)
      if (!/-----BEGIN [A-Z ]*CERTIFICATE-----/.test(text)) toast.warning(t('form.caNotPem'))
      onChange({ ca: text.trim() })
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  return (
    <div className="flex flex-col gap-4" data-testid="sync-sql-form">
      <label className="flex cursor-default items-center justify-between gap-4 rounded-lg border border-line bg-app px-3.5 py-2.5">
        <span className="min-w-0">
          <span className="block text-[13px] font-medium">{t('form.useUrl')}</span>
          <span className="block text-xs text-muted">{t('form.useUrlDesc')}</span>
        </span>
        <Switch
          checked={form.useUrl}
          onCheckedChange={(useUrl) => onChange({ useUrl })}
          disabled={disabled}
          data-testid="sync-url-toggle"
        />
      </label>

      {form.useUrl ? (
        <Field label={t('form.url')} error={err('url')} hint={t('form.urlDesc')}>
          <Input
            value={form.url}
            onChange={(e) => onChange({ url: e.target.value })}
            placeholder={
              kind === 'postgres'
                ? 'postgresql://user:password@db.example.com:5432/sshtool'
                : 'mysql://user:password@db.example.com:3306/sshtool'
            }
            className="font-mono text-xs"
            disabled={disabled}
            autoFocus
            data-testid="sync-field-url"
          />
        </Field>
      ) : (
        <>
          <div className="grid grid-cols-[1fr_112px] gap-3">
            <Field label={t('form.host')} error={err('host')}>
              <Input
                value={form.host}
                onChange={(e) => onChange({ host: e.target.value })}
                placeholder="db.example.com"
                disabled={disabled}
                autoFocus
                data-testid="sync-field-host"
              />
            </Field>
            <Field label={t('form.port')} error={err('port')}>
              <Input
                value={form.port}
                onChange={(e) => onChange({ port: e.target.value.replace(/[^\d]/g, '') })}
                placeholder={String(DEFAULT_PORT[kind])}
                inputMode="numeric"
                disabled={disabled}
                data-testid="sync-field-port"
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('form.database')} error={err('database')}>
              <Input
                value={form.database}
                onChange={(e) => onChange({ database: e.target.value })}
                placeholder="sshtool"
                disabled={disabled}
                data-testid="sync-field-database"
              />
            </Field>
            <Field label={t('form.user')} error={err('user')}>
              <Input
                value={form.user}
                onChange={(e) => onChange({ user: e.target.value })}
                placeholder="sshtool"
                disabled={disabled}
                data-testid="sync-field-user"
              />
            </Field>
          </div>
          <Field label={t('form.password')}>
            <SecretInput
              value={form.password}
              onChange={(password) => onChange({ password })}
              saved={savedSecret}
              disabled={disabled}
              testId="sync-field-password"
            />
          </Field>
        </>
      )}

      <div className="flex flex-col gap-1.5">
        <Label>{t('form.ssl')}</Label>
        <div className="grid grid-cols-1 items-start gap-x-3 gap-y-1.5 @xl:grid-cols-[180px_1fr]">
          <div data-testid="sync-field-ssl">
            <Select
              value={form.ssl}
              onChange={(v) => v && onChange({ ssl: v as SslMode })}
              options={SSL_MODES.map((m) => ({ value: m, label: t(`form.sslModes.${m}`) }))}
              disabled={disabled}
            />
          </div>
          <p className="pt-1 text-xs leading-relaxed text-muted">{t(`form.sslDesc.${form.ssl}`)}</p>
        </div>
        {insecure ? (
          <Callout tone="warning" className="mt-1.5 px-3 py-2.5" testId="sync-ssl-warning">
            {t('form.sslInsecure')}
          </Callout>
        ) : (
          <p className="flex items-center gap-1.5 text-xs text-subtle">
            <ShieldCheck className="size-3.5 shrink-0" />
            {t('form.sslRecommend')}
          </p>
        )}
      </div>

      {needsCa(form.ssl) && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-end justify-between gap-3">
            <Label htmlFor="sync-ca">
              {t('form.ca')} <span className="font-normal text-subtle">· {t('form.optional')}</span>
            </Label>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => void loadCa()}
              disabled={disabled}
              data-testid="sync-ca-load"
            >
              <FileUp />
              {t('form.caLoad')}
            </Button>
          </div>
          <Textarea
            id="sync-ca"
            rows={4}
            value={form.ca}
            onChange={(e) => onChange({ ca: e.target.value })}
            placeholder={'-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----'}
            className="resize-y font-mono text-[11px] leading-4"
            disabled={disabled}
            data-testid="sync-field-ca"
          />
          <p className="text-xs text-subtle">{t('form.caDesc')}</p>
        </div>
      )}

      <Advanced defaultOpen={!!errors?.tablePrefix || form.tablePrefix !== 'sshtool_'}>
        <Field label={t('form.prefix')} error={err('tablePrefix')} hint={t('form.prefixDesc')}>
          <Input
            value={form.tablePrefix}
            onChange={(e) => onChange({ tablePrefix: e.target.value })}
            placeholder="sshtool_"
            className="w-56 font-mono text-xs"
            disabled={disabled}
            data-testid="sync-field-prefix"
          />
        </Field>
      </Advanced>
    </div>
  )
}

export function D1ConnectionForm({
  form,
  onChange,
  errors,
  disabled,
  savedSecret
}: FormProps & { form: D1Form; onChange: (patch: Partial<D1Form>) => void }): React.JSX.Element {
  const { t } = useTranslation('sync')
  const err = (k: keyof FieldErrors): string | undefined => {
    const key = errors?.[k]
    return key ? t(`form.errors.${key}`) : undefined
  }
  const accountWarn =
    form.accountId.trim() && !/^[0-9a-f]{32}$/i.test(form.accountId.trim())
      ? t('form.warnings.accountId')
      : undefined
  const dbWarn =
    form.databaseId.trim() &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(form.databaseId.trim())
      ? t('form.warnings.databaseId')
      : undefined
  return (
    <div className="flex flex-col gap-4" data-testid="sync-d1-form">
      <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
        <Field label={t('form.accountId')} error={err('accountId')} hint={accountWarn}>
          <Input
            value={form.accountId}
            onChange={(e) => onChange({ accountId: e.target.value })}
            placeholder="0123456789abcdef0123456789abcdef"
            className="font-mono text-xs"
            disabled={disabled}
            autoFocus
            data-testid="sync-field-account-id"
          />
        </Field>
        <Field label={t('form.databaseId')} error={err('databaseId')} hint={dbWarn}>
          <Input
            value={form.databaseId}
            onChange={(e) => onChange({ databaseId: e.target.value })}
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            className="font-mono text-xs"
            disabled={disabled}
            data-testid="sync-field-database-id"
          />
        </Field>
      </div>
      <Field label={t('form.apiToken')} error={err('apiToken')} hint={t('form.apiTokenDesc')}>
        <SecretInput
          value={form.apiToken}
          onChange={(apiToken) => onChange({ apiToken })}
          saved={savedSecret}
          disabled={disabled}
          testId="sync-field-api-token"
        />
      </Field>
      <Advanced
        defaultOpen={
          !!errors?.tablePrefix || !!errors?.baseUrl || form.tablePrefix !== 'sshtool_' || !!form.baseUrl
        }
      >
        <Field label={t('form.prefix')} error={err('tablePrefix')} hint={t('form.prefixDesc')}>
          <Input
            value={form.tablePrefix}
            onChange={(e) => onChange({ tablePrefix: e.target.value })}
            placeholder="sshtool_"
            className="w-56 font-mono text-xs"
            disabled={disabled}
            data-testid="sync-field-prefix"
          />
        </Field>
        <Field label={t('form.baseUrl')} error={err('baseUrl')} hint={t('form.baseUrlDesc')}>
          <Input
            value={form.baseUrl}
            onChange={(e) => onChange({ baseUrl: e.target.value })}
            placeholder="https://api.cloudflare.com/client/v4"
            className="font-mono text-xs"
            disabled={disabled}
            data-testid="sync-field-base-url"
          />
        </Field>
      </Advanced>
    </div>
  )
}

export function WebdavConnectionForm({
  form,
  onChange,
  errors,
  disabled,
  savedSecret
}: FormProps & { form: WebdavForm; onChange: (patch: Partial<WebdavForm>) => void }): React.JSX.Element {
  const { t } = useTranslation('sync')
  const err = (k: keyof FieldErrors): string | undefined => {
    const key = errors?.[k]
    return key ? t(`form.errors.${key}`) : undefined
  }
  const insecure = form.url.trim().toLowerCase().startsWith('http://')
  return (
    <div className="flex flex-col gap-4" data-testid="sync-webdav-form">
      <Field label={t('form.webdavUrl')} error={err('url')} hint={t('form.webdavUrlDesc')}>
        <Input
          value={form.url}
          onChange={(e) => onChange({ url: e.target.value })}
          placeholder="https://cloud.example.com/remote.php/dav/files/me/sshtool/"
          className="font-mono text-xs"
          disabled={disabled}
          autoFocus
          data-testid="sync-field-webdav-url"
        />
      </Field>
      <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
        <Field label={t('form.username')} hint={t('form.optional')}>
          <Input
            value={form.username}
            onChange={(e) => onChange({ username: e.target.value })}
            placeholder="me@example.com"
            disabled={disabled}
            data-testid="sync-field-webdav-username"
          />
        </Field>
        <Field label={t('form.password')} hint={t('form.webdavPasswordDesc')}>
          <SecretInput
            value={form.password}
            onChange={(password) => onChange({ password })}
            saved={savedSecret}
            disabled={disabled}
            testId="sync-field-webdav-password"
          />
        </Field>
      </div>
      {insecure ? (
        <Callout tone="warning" className="px-3 py-2.5" testId="sync-webdav-insecure">
          {t('form.webdavInsecure')}
        </Callout>
      ) : (
        <p className="flex items-center gap-1.5 text-xs text-subtle">
          <ShieldCheck className="size-3.5 shrink-0" />
          {t('form.webdavSecure')}
        </p>
      )}
      <Advanced defaultOpen={!!errors?.tablePrefix || form.tablePrefix !== 'sshtool_'}>
        <Field label={t('form.prefix')} error={err('tablePrefix')} hint={t('form.webdavPrefixDesc')}>
          <Input
            value={form.tablePrefix}
            onChange={(e) => onChange({ tablePrefix: e.target.value })}
            placeholder="sshtool_"
            className="w-56 font-mono text-xs"
            disabled={disabled}
            data-testid="sync-field-prefix"
          />
        </Field>
      </Advanced>
    </div>
  )
}
