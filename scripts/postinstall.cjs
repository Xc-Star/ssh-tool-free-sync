// node-pty 1.1.0 publishes its macOS `spawn-helper` without the execute bit (mode 644). Without it every local
// terminal fails with "posix_spawnp failed", both in tests and in the packaged app (electron-builder copies
// the file with its mode). Restore the bit after install; nothing to do on Windows.
const fs = require('node:fs')
const path = require('node:path')

if (process.platform !== 'win32') {
  const root = path.join(__dirname, '..', 'node_modules', 'node-pty')
  for (const dir of ['prebuilds/darwin-arm64', 'prebuilds/darwin-x64', 'build/Release']) {
    const helper = path.join(root, ...dir.split('/'), 'spawn-helper')
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755)
  }
}
