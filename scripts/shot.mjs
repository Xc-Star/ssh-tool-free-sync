// Launches the built app with Playwright, runs optional UI steps and saves a screenshot.
//
// Usage:
//   npx electron-vite build [--outDir out-x]
//   node scripts/shot.mjs --out .tmp/shot.png [--app out-x/main/index.js] [--user-data .tmp/ud] [--size 1280x800]
//        [--steps '[{"click":"[data-testid=tab-sftp]"},{"wait":800},{"fill":["input","abc"]},{"press":"Enter"}]']
//        [--eval "window.localStorage.clear()"] [--timeout 90000]
//   On Windows PowerShell 5.1 pass JSON/JS through files instead: --steps-file steps.json --eval-file seed.js
//   (scripts/seed-demo.js seeds demo hosts/groups/keys/snippets).
// Use a fresh --user-data (default: new temp dir) unless you need state from a previous run, and never run
// two instances against the same --user-data at the same time (single-instance lock).
import { _electron } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : def
}

const out = path.resolve(opt('out', '.tmp/shot.png'))
const userData = path.resolve(opt('user-data', fs.mkdtempSync(path.join(os.tmpdir(), 'sshtool-shot-'))))
const [w, h] = opt('size', '1280x800').split('x').map(Number)
// Windows PowerShell 5.1 mangles double quotes in native arguments: prefer --steps-file / --eval-file there.
const stepsFile = opt('steps-file')
const steps = stepsFile ? JSON.parse(fs.readFileSync(stepsFile, 'utf8')) : JSON.parse(opt('steps', '[]'))
const evalFile = opt('eval-file')
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.mkdirSync(userData, { recursive: true })

const exe = opt('exe')
const app = await _electron.launch({
  ...(exe ? { executablePath: path.resolve(exe), args: [] } : { args: [path.resolve(opt('app', 'out/main/index.js'))] }),
  env: { ...process.env, SSHTOOL_USER_DATA: userData, ELECTRON_RENDERER_URL: '' },
  timeout: 30000
})
const watchdog = setTimeout(() => {
  console.error('watchdog: giving up')
  try {
    app.process().kill()
  } catch {
    // ignore
  }
  process.exit(2)
}, Number(opt('timeout', '90000')))
const logs = []
try {
  const win = await app.firstWindow()
  win.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
  win.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
  await app.evaluate(({ BrowserWindow }, size) => {
    const bw = BrowserWindow.getAllWindows()[0]
    bw.setSize(size.w, size.h)
  }, { w, h })
  await win.waitForSelector('[data-testid=tab-vault]', { timeout: 20000 })
  const evalCode = evalFile ? fs.readFileSync(evalFile, 'utf8') : opt('eval')
  if (evalCode) {
    await win.evaluate(evalCode)
    await win.waitForTimeout(Number(opt('eval-wait', '1500')))
  }
  for (const s of steps) {
    if (s.click) await win.click(s.click, { timeout: 10000 })
    if (s.dblclick) await win.dblclick(s.dblclick, { timeout: 10000 })
    if (s.rightclick) await win.click(s.rightclick, { button: 'right', timeout: 10000 })
    if (s.fill) await win.fill(s.fill[0], s.fill[1], { timeout: 10000 })
    if (s.type) await win.keyboard.type(s.type)
    if (s.press) await win.keyboard.press(s.press)
    if (s.hover) await win.hover(s.hover, { timeout: 10000 })
    if (s.waitFor) await win.waitForSelector(s.waitFor, { timeout: 15000 })
    if (s.wait) await win.waitForTimeout(s.wait)
  }
  await win.waitForTimeout(Number(opt('settle', '600')))
  await win.screenshot({ path: out })
  console.log(`screenshot: ${out}`)
  console.log(`userData: ${userData}`)
} catch (err) {
  console.error('FAILED:', err.message)
  process.exitCode = 1
} finally {
  if (logs.length) console.log(logs.slice(-40).join('\n'))
  const pid = app.process().pid
  await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 8000))])
  // Kill the whole Electron process tree: helper processes keep stdio pipes open otherwise.
  if (pid) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    else {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // already exited
      }
    }
  }
  clearTimeout(watchdog)
  process.exit(process.exitCode ?? 0)
}
