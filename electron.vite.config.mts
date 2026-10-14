import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin } from 'vite'

const sharedAlias = { '@shared': resolve('src/shared') }

/** Inject a strict Content-Security-Policy into the production renderer only (dev needs HMR inline scripts). */
function cspPlugin(): Plugin {
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'"
  ].join('; ')
  return {
    name: 'sshtool-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<head>',
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`
      )
    }
  }
}

export default defineConfig({
  main: {
    resolve: { alias: sharedAlias },
    build: {
      // chokidar v5 is ESM-only: bundle it instead of requiring it at runtime.
      externalizeDeps: { exclude: ['chokidar'] },
      rollupOptions: { external: ['node:sqlite'] }
    }
  },
  preload: {
    resolve: { alias: sharedAlias }
  },
  renderer: {
    resolve: {
      alias: { ...sharedAlias, '@': resolve('src/renderer/src') }
    },
    plugins: [react(), tailwindcss(), cspPlugin()]
  }
})
