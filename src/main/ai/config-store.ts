import { AI_PRESETS, normalizeAiBaseUrl, type AiConfigInput, type AiConfigSummary, type AiPresetId, type AiProtocol, type AiProviderConfig } from '@shared/ai'
import { SECRET_MASK } from '@shared/schemas'
import { uuidv7 } from '@shared/util'
import type { LocalDb } from '../vault/db'
import type { SecretProtector } from '../vault/keystore'

const KV_KEY = 'ai.configs'

/** Persisted shape: the API key is wrapped by the OS keychain when available. */
interface StoredConfig extends Omit<AiProviderConfig, 'apiKey'> {
  key: { enc: boolean; v: string }
}

/**
 * Named AI provider configs (DBX-style: multiple configs per provider are allowed).
 * Stored in the local kv table — never synced, never sent to the renderer unmasked.
 */
export class AiConfigStore {
  constructor(
    private readonly db: LocalDb,
    private readonly protector: SecretProtector
  ) {}

  private readAll(): AiProviderConfig[] {
    const rows = this.db.kvGetJson<StoredConfig[]>(KV_KEY) ?? []
    const out: AiProviderConfig[] = []
    for (const r of rows) {
      let apiKey = ''
      if (r.key?.v) {
        if (r.key.enc) {
          try {
            apiKey = this.protector.decrypt(Buffer.from(r.key.v, 'base64')).toString('utf8')
          } catch {
            apiKey = '' // keychain could not hand the key back; user re-enters it
          }
        } else {
          apiKey = r.key.v
        }
      }
      out.push({
        id: r.id,
        name: r.name,
        preset: r.preset,
        protocol: r.protocol,
        // Normalize on read so configs saved before the /v1 auto-append keep working.
        baseUrl: normalizeAiBaseUrl(r.baseUrl, r.protocol),
        model: r.model,
        authStyle: r.authStyle,
        customHeaders: r.customHeaders,
        apiKey
      })
    }
    return out
  }

  private writeAll(configs: AiProviderConfig[]): void {
    const rows: StoredConfig[] = configs.map((c) => {
      const enc = this.protector.available() && c.apiKey !== ''
      return {
        id: c.id,
        name: c.name,
        preset: c.preset,
        protocol: c.protocol,
        baseUrl: c.baseUrl,
        model: c.model,
        authStyle: c.authStyle,
        customHeaders: c.customHeaders,
        key: {
          enc,
          v: enc ? this.protector.encrypt(Buffer.from(c.apiKey, 'utf8')).toString('base64') : c.apiKey
        }
      }
    })
    this.db.kvSetJson(KV_KEY, rows)
  }

  list(): AiProviderConfig[] {
    return this.readAll()
  }

  get(id: string): AiProviderConfig | undefined {
    return this.readAll().find((c) => c.id === id)
  }

  /** The config the agent should use (settings.ai.activeConfigId, else the first one). */
  resolveActive(activeConfigId: string | undefined): AiProviderConfig | undefined {
    const all = this.readAll()
    if (!all.length) return undefined
    return all.find((c) => c.id === activeConfigId) ?? all[0]
  }

  summaries(): AiConfigSummary[] {
    return this.readAll().map(maskConfig)
  }

  save(input: AiConfigInput): AiConfigSummary {
    const all = this.readAll()
    const existing = input.id ? all.find((c) => c.id === input.id) : undefined
    const config = buildProviderConfig(input, existing)
    if (!config.id) config.id = uuidv7()

    const next = existing ? all.map((c) => (c.id === existing.id ? config : c)) : [...all, config]
    this.writeAll(next)
    return maskConfig(config)
  }

  remove(id: string): void {
    this.writeAll(this.readAll().filter((c) => c.id !== id))
  }
}

/**
 * Validates an input and builds a full config. `existing` supplies the stored API key when the
 * input carries SECRET_MASK ("unchanged"). Used both for saving and for test/model-list calls
 * that need the real key without persisting anything.
 *
 * `forRequest` builds a config for a one-off models/test request, where the user may not have
 * picked a model (that is the point of "fetch models") or typed a name yet — only the Base URL
 * is required then.
 */
export function buildProviderConfig(input: AiConfigInput, existing?: AiProviderConfig, opts: { forRequest?: boolean } = {}): AiProviderConfig {
  const strict = !opts.forRequest
  if (strict && (!input?.name || typeof input.name !== 'string')) throw new Error('Config name is required')
  const preset: AiPresetId = AI_PRESETS[input?.preset] ? input.preset : 'custom'
  const protocol: AiProtocol = input?.protocol === 'anthropic' ? 'anthropic' : 'openai'
  const baseUrl = normalizeAiBaseUrl(input?.baseUrl ?? '', protocol)
  const model = (input?.model ?? '').trim()
  if (!baseUrl) throw new Error('Base URL is required')
  if (strict && !model) throw new Error('Model is required')
  // A masked key means "unchanged"; anything else (including '') replaces the stored key.
  const apiKey = input?.apiKey === SECRET_MASK ? (existing?.apiKey ?? '') : (input?.apiKey ?? '')
  return {
    id: existing?.id ?? input?.id ?? '',
    name: (input?.name ?? '').trim(),
    preset,
    protocol,
    baseUrl,
    model,
    authStyle: input?.authStyle ?? AI_PRESETS[preset].authStyle,
    customHeaders: input?.customHeaders && Object.keys(input.customHeaders).length ? input.customHeaders : undefined,
    apiKey
  }
}

/** Replaces the raw API key with SECRET_MASK (set) or '' (unset) before crossing IPC. */
export function maskConfig(c: AiProviderConfig): AiConfigSummary {
  return { ...c, apiKey: c.apiKey ? SECRET_MASK : '' }
}
