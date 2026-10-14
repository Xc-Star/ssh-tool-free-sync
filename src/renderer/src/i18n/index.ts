import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

type Dict = Record<string, unknown>

/**
 * Every file in ./locales/<lang>/<namespace>.ts is a namespace (default export). New feature
 * namespaces are picked up automatically.
 */
const zh = import.meta.glob<Dict>('./locales/zh-CN/*.ts', { eager: true, import: 'default' })
const en = import.meta.glob<Dict>('./locales/en/*.ts', { eager: true, import: 'default' })

function toResources(mods: Record<string, Dict>): Record<string, Dict> {
  const out: Record<string, Dict> = {}
  for (const [path, mod] of Object.entries(mods)) {
    const ns = path.split('/').pop()!.replace(/\.ts$/, '')
    out[ns] = mod
  }
  return out
}

const resources = { 'zh-CN': toResources(zh), en: toResources(en) }

void i18n.use(initReactI18next).init({
  resources,
  lng: 'zh-CN',
  fallbackLng: 'en',
  ns: Object.keys(resources.en),
  defaultNS: 'common',
  interpolation: { escapeValue: false },
  returnNull: false
})

export default i18n
