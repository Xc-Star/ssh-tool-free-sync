import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/700.css'
import './styles.css'
import './i18n'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { initApp } from './stores/app'
import { initPromptsAndTransfers } from './stores/prompts'
import { initTabs } from './stores/tabs'
import { initVault } from './stores/vault'

async function boot(): Promise<void> {
  await initApp()
  initTabs()
  initPromptsAndTransfers()
  await initVault()
  try {
    await Promise.all([document.fonts.load('14px "JetBrains Mono"'), document.fonts.load('bold 14px "JetBrains Mono"')])
  } catch {
    // fall back to system monospace
  }
  createRoot(document.getElementById('root')!).render(<App />)
}

void boot()
