// Post-install repairs that npm's own dependency installs cannot express.
//
// 1. node-pty 1.1.0 publishes its macOS `spawn-helper` without the execute bit (mode 644). Without it
//    every local terminal fails with "posix_spawnp failed", both in tests and in the packaged app
//    (electron-builder copies the file with its mode). Restore the bit after install; nothing to do
//    on Windows.
// 2. electron's own postinstall downloads and unpacks the platform binary and writes
//    `node_modules/electron/path.txt`. When installs run with --ignore-scripts, or that step is
//    interrupted, `path.txt` never appears and `electron-vite dev` fails with the cryptic
//    "Error: Electron uninstall". Re-running electron's installer is a no-op once the binary is in
//    place, so it is safe to call on every install.
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.join(__dirname, '..')

if (process.platform !== 'win32') {
  const nodePty = path.join(root, 'node_modules', 'node-pty')
  for (const dir of ['prebuilds/darwin-arm64', 'prebuilds/darwin-x64', 'build/Release']) {
    const helper = path.join(nodePty, ...dir.split('/'), 'spawn-helper')
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755)
  }
}

ensureElectronBinary()

function ensureElectronBinary() {
  const skip = process.env.ELECTRON_SKIP_BINARY_DOWNLOAD
  if (skip === '1' || skip === 'true') return

  const dir = path.join(root, 'node_modules', 'electron')
  const installer = path.join(dir, 'install.js')
  if (!fs.existsSync(installer) || electronBinaryPath(dir)) return

  console.log('[postinstall] The Electron binary is missing; running electron/install.js …')
  const result = spawnSync(process.execPath, [installer], { cwd: dir, stdio: 'inherit' })
  if (result.status !== 0) {
    console.warn(
      '[postinstall] Could not install the Electron binary. Run `node node_modules/electron/install.js` ' +
        'manually, or set ELECTRON_MIRROR (e.g. https://npmmirror.com/mirrors/electron/) if the download is blocked.'
    )
    return
  }
  if (!electronBinaryPath(dir)) {
    console.warn('[postinstall] electron/install.js finished but the binary is still missing.')
  }
}

/** Absolute path of the unpacked Electron executable, or null when it is not installed. */
function electronBinaryPath(dir) {
  try {
    const relative = fs.readFileSync(path.join(dir, 'path.txt'), 'utf-8').trim()
    const executable = path.join(dir, 'dist', relative)
    return relative && fs.existsSync(executable) ? executable : null
  } catch {
    return null
  }
}
