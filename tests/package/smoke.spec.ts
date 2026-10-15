import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { launchApp, rpc, terminalText } from '../e2e/app'

/**
 * Smoke test for a packaged build: `npx electron-builder --dir`, then `npm run test:package`.
 * Checks what only shows up after packaging: the archive contents, code signing and locales on macOS,
 * and that the installed app starts and loads its native modules (a local shell through node-pty).
 */

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { name: string; productName: string; version: string }

interface PackagedApp {
  exe: string
  resources: string
}

function findPackagedApp(): PackagedApp {
  const root = path.resolve('release', pkg.version)
  const candidates =
    process.platform === 'win32'
      ? [path.join(root, 'win-unpacked', `${pkg.productName}.exe`)]
      : process.platform === 'darwin'
        ? ['mac-arm64', 'mac', 'mac-universal'].map((d) => path.join(root, d, `${pkg.productName}.app`, 'Contents', 'MacOS', pkg.productName))
        : ['linux-unpacked', 'linux-arm64-unpacked'].map((d) => path.join(root, d, pkg.name))
  const exe = process.env.SSHTOOL_PACKAGED_APP || candidates.find((c) => fs.existsSync(c))
  if (!exe) throw new Error(`No packaged app found (looked for ${candidates.join(', ')}). Run "npx electron-builder --dir" first.`)
  if (process.platform === 'darwin') {
    const bundle = path.resolve(exe, '..', '..', '..')
    return { exe, resources: path.join(bundle, 'Contents', 'Resources') }
  }
  return { exe, resources: path.join(path.dirname(exe), 'resources') }
}

/** Top-level entries of an asar archive, read from its JSON header. */
function asarTopLevel(file: string): string[] {
  const fd = fs.openSync(file, 'r')
  try {
    const prefix = Buffer.alloc(8)
    fs.readSync(fd, prefix, 0, 8, 0)
    const header = Buffer.alloc(prefix.readUInt32LE(4))
    fs.readSync(fd, header, 0, header.length, 8)
    const json = header.subarray(8, 8 + header.readUInt32LE(4)).toString('utf8')
    return Object.keys((JSON.parse(json) as { files: Record<string, unknown> }).files).sort()
  } finally {
    fs.closeSync(fd)
  }
}

let app: PackagedApp

test.beforeAll(() => {
  app = findPackagedApp()
})

test('the archive contains only the app (no sources, tests or local files)', () => {
  expect(asarTopLevel(path.join(app.resources, 'app.asar'))).toEqual(['node_modules', 'out', 'package.json', 'resources'])
})

test('macOS: valid code signature, Chinese locales and an executable pty helper (every architecture)', () => {
  test.skip(process.platform !== 'darwin', 'macOS only')
  const root = path.resolve('release', pkg.version)
  const bundles = ['mac-arm64', 'mac', 'mac-universal']
    .map((d) => path.join(root, d, `${pkg.productName}.app`))
    .filter((b) => fs.existsSync(b))
  expect(bundles.length).toBeGreaterThan(0)
  for (const bundle of bundles) {
    const verify = spawnSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundle], { encoding: 'utf8' })
    expect(verify.status, `${bundle}: ${verify.stderr}`).toBe(0)
    const locales = path.join(bundle, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Resources')
    for (const locale of ['en', 'zh_CN', 'zh_TW']) expect(fs.existsSync(path.join(locales, `${locale}.lproj`)), `${bundle}: ${locale}.lproj`).toBe(true)
    // node-pty starts every local shell through spawn-helper; without the execute bit all local terminals fail.
    const prebuilds = path.join(bundle, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', 'node-pty', 'prebuilds')
    const helpers = fs.readdirSync(prebuilds).map((d) => path.join(prebuilds, d, 'spawn-helper')).filter((f) => fs.existsSync(f))
    expect(helpers.length, `${bundle}: spawn-helper`).toBeGreaterThan(0)
    for (const helper of helpers) expect(fs.statSync(helper).mode & 0o111, `${helper} is not executable`).not.toBe(0)
  }
})

test('the installed app starts and runs a local shell (native modules load)', async () => {
  // A predictable POSIX shell on macOS / Linux (the app lists $SHELL first); PowerShell on Windows.
  if (process.platform !== 'win32') process.env.SHELL = '/bin/sh'
  const r = await launchApp('package', { executablePath: app.exe })
  try {
    expect((await rpc<{ version: string }>(r.win, 'app.info')).version).toBe(pkg.version)
    await r.win.click('[data-testid=new-tab-menu]')
    await r.win.click('[data-testid=new-local-terminal]')
    const pane = r.win.locator('[data-testid=terminal-view]:not(.invisible) [data-testid=terminal-pane]').first()
    await pane.waitFor()
    const sid = (await pane.getAttribute('data-session-id')) ?? ''
    await expect.poll(async () => (await terminalText(r.win, sid)).trim().length).toBeGreaterThan(0)
    await pane.click()
    await r.win.keyboard.type('echo pkg-$((40+2))')
    await r.win.keyboard.press('Enter')
    await expect.poll(() => terminalText(r.win, sid)).toContain('pkg-42')
  } finally {
    await r.close()
  }
})
