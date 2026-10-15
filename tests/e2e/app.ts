import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron, type ElectronApplication, type Page } from '@playwright/test'

export interface Running {
  app: ElectronApplication
  win: Page
  userData: string
  /** `keepData` leaves the profile on disk so it can be relaunched with `launchApp(name, { userData })`. */
  close: (opts?: { keepData?: boolean }) => Promise<void>
}

/**
 * Extra Chromium/Electron flags for `_electron.launch`, e.g.
 * `SSHTOOL_E2E_ARGS="--no-sandbox --disable-gpu"` for containers or sandboxed environments that cannot
 * start Chromium's own sandbox. Empty by default so normal runs keep the sandbox on.
 */
const extraArgs = process.env.SSHTOOL_E2E_ARGS?.split(/\s+/).filter(Boolean) ?? []

/**
 * Launches the built app (out/) with an isolated profile (or an existing one, to simulate a restart).
 * `executablePath` starts a packaged app instead (see tests/package).
 */
export async function launchApp(name: string, opts: { userData?: string; executablePath?: string } = {}): Promise<Running> {
  const userData = opts.userData ?? fs.mkdtempSync(path.join(os.tmpdir(), `sshtool-e2e-${name}-`))
  const app = await _electron.launch({
    // The project folder (not out/main/index.js) so Electron reads package.json: real app version and name.
    ...(opts.executablePath
      ? { executablePath: opts.executablePath, args: extraArgs }
      : { args: [path.resolve('.'), ...extraArgs] }),
    env: { ...process.env, SSHTOOL_USER_DATA: userData, ELECTRON_RENDERER_URL: '' },
    timeout: 60_000
  })
  const win = await app.firstWindow()
  await win.waitForSelector('[data-testid=tab-vault]')
  let closed = false
  const close = async ({ keepData = false }: { keepData?: boolean } = {}): Promise<void> => {
    if (closed) return
    closed = true
    const pid = app.process().pid
    await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 8000))])
    if (pid) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
      else {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // already gone
        }
      }
    }
    if (!keepData) removeProfile(userData)
  }
  return { app, win, userData, close }
}

/** Electron's helper processes release their file locks a moment after being killed; retry, never fail a test. */
export function removeProfile(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  } catch {
    // leftover temp profile; harmless
  }
}

/** Calls a main-process RPC method through the preload bridge. */
export async function rpc<T = unknown>(win: Page, method: string, ...args: unknown[]): Promise<T> {
  const res = await win.evaluate(async ({ m, a }) => (globalThis as any).sshtool.invoke(m, ...a), { m: method, a: args })
  if (!res.ok) throw new Error(`${method}: ${res.error.message}`)
  return res.value as T
}

export async function terminalText(win: Page, sessionId: string): Promise<string> {
  return win.evaluate((id) => (globalThis as any).__sshtoolTerminalText?.(id) ?? '', sessionId)
}

export async function activeSessionId(win: Page): Promise<string> {
  const pane = win.locator('[data-testid=terminal-view]:not(.invisible) [data-testid=terminal-pane]').first()
  await pane.waitFor()
  return (await pane.getAttribute('data-session-id')) ?? ''
}
