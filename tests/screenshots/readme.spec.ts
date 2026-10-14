import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import type { ForwardState, TransferInfo } from '../../src/shared/types'
import { launchApp, removeProfile, type Running, rpc, terminalText } from '../e2e/app'
import { type D1Mock, startD1Mock } from '../helpers/d1-mock-server'
import { startTestSshServer, type TestSshServer } from '../helpers/ssh-test-server'

/**
 * Regenerates the README screenshots: docs/screenshots/<language>/<screen>.png (`npm run screenshots`).
 * Everything shown is the real app: SSH, SFTP and port forwarding run against the in-process test server,
 * sync against the local Cloudflare D1 mock. Each screen is captured once per UI language.
 */

const OUT = path.resolve('docs/screenshots')
const LANGS = ['zh-CN', 'en'] as const
const SIZE = { width: 1280, height: 800 }
const MASTER = 'readme-demo-master-password'
const PASSWORD = 'readme-demo'

const running: Running[] = []
let server: TestSshServer | undefined
let mock: D1Mock | undefined
let work: string | undefined
let drive: string | undefined

test.afterAll(async () => {
  for (const r of running) await r.close()
  await server?.close()
  await mock?.close()
  if (drive) spawnSync('subst', [`${drive}:`, '/d'], { stdio: 'ignore' })
  if (work) removeProfile(work)
})

// ------------------------------------------------------------------ fixtures

const COMPOSE = `services:
  api:
    image: ghcr.io/acme/shop-api:2.4.1
    restart: unless-stopped
    env_file: .env
    ports:
      - "127.0.0.1:8080:8080"
    depends_on: [redis]
  worker:
    image: ghcr.io/acme/shop-api:2.4.1
    command: ["node", "dist/worker.js"]
    restart: unless-stopped
    env_file: .env
  redis:
    image: redis:7-alpine
    restart: unless-stopped
    volumes:
      - redis-data:/data

volumes:
  redis-data:
`

const NGINX = `server {
    listen 443 ssl;
    server_name shop.example.com;

    ssl_certificate     /etc/letsencrypt/live/shop.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/shop.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
`

const DEPLOY = `#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
docker compose pull
docker compose up -d --remove-orphans
docker image prune -f
`

/** Writes a file with a modification time `hoursAgo` in the past (`content` may be a size in bytes of filler). */
function put(root: string, rel: string, content: string | number, hoursAgo: number): void {
  const file = path.join(root, ...rel.split('/'))
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof content === 'number' ? Buffer.alloc(content, 0x2a) : content)
  age(root, rel, hoursAgo)
}

function age(root: string, rel: string, hoursAgo: number): void {
  const t = new Date(Date.now() - hoursAgo * 3_600_000)
  fs.utimesSync(path.join(root, ...rel.split('/')), t, t)
}

function remoteFixture(root: string): void {
  const h = 'home/deploy'
  put(root, `${h}/docker-compose.yml`, COMPOSE, 2)
  put(root, `${h}/nginx.conf`, NGINX, 26)
  put(root, `${h}/deploy.sh`, DEPLOY, 50)
  put(root, `${h}/README.md`, '# shop-api\n\nProduction deployment of the shop API (Docker Compose behind nginx).\n', 140)
  put(root, `${h}/release-2.4.1.tar.gz`, 1_874_329, 3)
  put(root, `${h}/app/.env`, 'NODE_ENV=production\nPORT=8080\n', 3)
  put(root, `${h}/app/config.yml`, 'log_level: info\n', 3)
  put(root, `${h}/backups/shop-2026-10-14.sql.gz`, 2_431_100, 20)
  put(root, `${h}/logs/api.log`, 48_210, 1)
  put(root, `${h}/scripts/rotate-logs.sh`, '#!/bin/sh\nfind ~/logs -name "*.log" -mtime +14 -delete\n', 300)
  put(root, `${h}/.bashrc`, 'export EDITOR=vim\n', 900)
  put(root, `${h}/.ssh/authorized_keys`, '', 900)
  for (const [dir, hours] of [['app', 3], ['backups', 20], ['logs', 1], ['scripts', 300], ['.ssh', 900]] as const) age(root, `${h}/${dir}`, hours)
}

function localFixture(root: string): void {
  const p = 'projects/website'
  put(root, `${p}/dist/index.html`, '<!doctype html><html><head><title>Shop</title></head><body><div id="app"></div></body></html>\n', 4)
  put(root, `${p}/dist/assets/index-4f8a2c1e.js`, 183_442, 4)
  put(root, `${p}/dist/assets/index-91be3d07.css`, 24_118, 4)
  put(root, `${p}/dist/favicon.svg`, 1_204, 4)
  put(root, `${p}/public/favicon.svg`, 1_204, 200)
  put(root, `${p}/public/robots.txt`, 'User-agent: *\nAllow: /\n', 200)
  put(root, `${p}/src/main.ts`, 4_512, 5)
  put(root, `${p}/src/App.vue`, 7_930, 5)
  put(root, `${p}/docker-compose.yml`, COMPOSE, 2)
  put(root, `${p}/deploy.sh`, DEPLOY, 50)
  put(root, `${p}/nginx.conf`, NGINX, 26)
  put(root, `${p}/package.json`, 1_633, 30)
  put(root, `${p}/package-lock.json`, 312_904, 30)
  put(root, `${p}/README.md`, 2_281, 140)
  put(root, `${p}/tsconfig.json`, 512, 300)
  put(root, `${p}/vite.config.ts`, 640, 30)
  for (const [dir, hours] of [['dist/assets', 4], ['dist', 4], ['public', 200], ['src', 5]] as const) age(root, `${p}/${dir}`, hours)
}

/** Maps the local fixture to a spare drive letter (Windows) so the SFTP pane shows a short, neutral path. */
function mapDrive(target: string): string | undefined {
  if (process.platform !== 'win32') return undefined
  for (const letter of ['S', 'T', 'W', 'X', 'Y', 'Z']) {
    if (fs.existsSync(`${letter}:\\`)) continue
    if (spawnSync('subst', [`${letter}:`, target], { stdio: 'ignore' }).status === 0) return letter
  }
  return undefined
}

// ------------------------------------------------------------------ app helpers

async function launch(name: string, deviceName: string): Promise<Running> {
  process.env.SSHTOOL_DEVICE_NAME = deviceName
  const r = await launchApp(name)
  running.push(r)
  await r.app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].setContentSize(s.width, s.height), SIZE)
  await r.win.addStyleTag({ content: '[data-sonner-toaster] { display: none !important; }' })
  return r
}

/** Saves the current screen once per UI language, then switches back to Chinese (the labels the script clicks). */
async function capture(r: Running, name: string): Promise<void> {
  for (const lang of LANGS) {
    await rpc(r.win, 'settings.set', { language: lang })
    await r.win.mouse.move(SIZE.width - 4, SIZE.height - 4)
    await r.win.waitForTimeout(800)
    const file = path.join(OUT, lang, `${name}.png`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    await r.win.screenshot({ path: file })
  }
  await rpc(r.win, 'settings.set', { language: 'zh-CN' })
  await r.win.waitForTimeout(300)
}

const visiblePanes = (win: Page) => win.locator('[data-testid=terminal-view]:not(.invisible) [data-testid=terminal-pane]')
const pane = (win: Page, sessionId: string) => win.locator(`[data-testid=terminal-pane][data-session-id="${sessionId}"]`)

async function paneMenu(win: Page, sessionId: string, item: string): Promise<void> {
  await pane(win, sessionId).click({ button: 'right', modifiers: ['Shift'] })
  await win.getByRole('menuitem', { name: item }).click()
}

async function run(win: Page, sessionId: string, command: string, expected: string): Promise<void> {
  await pane(win, sessionId).click()
  await win.keyboard.type(command)
  await win.keyboard.press('Enter')
  await expect.poll(() => terminalText(win, sessionId)).toContain(expected)
}

type Ids = Record<'web1' | 'pfDb' | 'pfGrafana', string>

async function seed(win: Page, port: number): Promise<Ids> {
  const up = (kind: string, data: Record<string, unknown>): Promise<{ id: string }> => rpc(win, 'vault.upsert', kind, data)
  const web = await up('tag', { name: 'web' })
  const db = await up('tag', { name: 'db' })
  const k8s = await up('tag', { name: 'k8s' })
  const staging = await up('group', { name: 'Staging', username: 'deploy' })
  const lab = await up('group', { name: 'Home Lab' })
  const clients = await up('group', { name: 'Clients' })

  const web1 = await up('host', {
    label: 'web-prod-01',
    address: '127.0.0.1',
    port,
    username: 'deploy',
    password: PASSWORD,
    tagIds: [web.id],
    osHint: 'ubuntu'
  })
  await up('host', { label: 'web-prod-02', address: '203.0.113.12', username: 'deploy', tagIds: [web.id], osHint: 'ubuntu' })
  await up('host', { label: 'db-primary', address: '203.0.113.20', username: 'deploy', tagIds: [db.id], osHint: 'rocky' })
  await up('host', { label: 'db-replica', address: '203.0.113.21', username: 'deploy', tagIds: [db.id], osHint: 'rocky' })
  const bastion = await up('host', { label: 'bastion', address: 'bastion.example.com', username: 'ops', osHint: 'debian' })
  await up('host', { label: 'ci-runner', address: '203.0.113.50', username: 'runner', osHint: 'fedora' })
  const stageApp = await up('host', { label: 'stage-app', address: '198.51.100.7', groupId: staging.id, osHint: 'alpine' })
  await up('host', { label: 'k8s-master', address: '198.51.100.10', groupId: staging.id, tagIds: [k8s.id], osHint: 'centos' })
  await up('host', { label: 'nas', address: '192.168.1.20', username: 'admin', groupId: lab.id, osHint: 'synology' })
  await up('host', { label: 'raspberry-pi', address: '192.168.1.42', username: 'pi', groupId: lab.id, osHint: 'raspbian' })
  await up('host', { label: 'router', address: '192.168.1.1', username: 'root', groupId: lab.id, osHint: 'openwrt' })
  await up('host', { label: 'acme-erp', address: 'erp.acme.example', username: 'admin', groupId: clients.id, osHint: 'opensuse' })
  await up('host', { label: 'globex-web', address: 'web.globex.example', username: 'deploy', groupId: clients.id, osHint: 'debian' })

  const officeKey = await rpc<{ id: string }>(win, 'keys.generate', { label: 'Office-PC', type: 'ed25519', comment: 'deploy@office-pc' })
  await rpc(win, 'keys.generate', { label: 'CI deploy key', type: 'rsa', bits: 4096, comment: 'ci@runner' })
  await rpc(win, 'keys.generate', { label: 'YubiKey backup', type: 'ecdsa', bits: 384, comment: 'backup@yubikey' })
  await up('identity', { label: 'ops (shared)', username: 'ops', keyId: officeKey.id })
  await up('identity', { label: 'deploy', username: 'deploy', password: PASSWORD })

  await up('snippet', { label: 'Disk usage', script: 'df -h', tags: ['monitoring'] })
  await up('snippet', { label: 'Restart nginx', script: 'sudo nginx -t && sudo systemctl reload nginx', tags: ['web'] })
  await up('snippet', { label: 'Tail app logs', script: 'journalctl -u shop-api -f --since "10 min ago"', tags: ['logs'] })
  await up('snippet', { label: 'Update system', script: 'sudo apt update && sudo apt upgrade -y', tags: ['maintenance'] })
  await up('snippet', { label: 'Docker cleanup', script: 'docker system prune -af --volumes', tags: ['docker', 'maintenance'] })
  await up('snippet', {
    label: 'Deploy release',
    script: 'cd ~/app\ndocker compose pull\ndocker compose up -d --remove-orphans\ndocker image prune -f',
    tags: ['deploy', 'docker']
  })

  const pfDb = await up('portForward', {
    label: 'PostgreSQL · db-primary',
    type: 'local',
    hostId: web1.id,
    bindPort: 15432,
    destHost: '10.0.2.20',
    destPort: 5432
  })
  const pfGrafana = await up('portForward', {
    label: 'Grafana',
    type: 'local',
    hostId: web1.id,
    bindPort: 13000,
    destHost: '127.0.0.1',
    destPort: 3000,
    autoStart: true
  })
  await up('portForward', { label: 'SOCKS proxy', type: 'dynamic', hostId: bastion.id, bindPort: 11080 })
  await up('portForward', {
    label: 'Share dev server',
    type: 'remote',
    hostId: stageApp.id,
    bindAddress: '0.0.0.0',
    bindPort: 8080,
    destHost: '127.0.0.1',
    destPort: 5173
  })
  return { web1: web1.id, pfDb: pfDb.id, pfGrafana: pfGrafana.id }
}

// ------------------------------------------------------------------ the tour

test('README screenshots', async () => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'sshtool-readme-'))
  const remoteRoot = path.join(work, 'remote')
  const localRoot = path.join(work, 'local')
  remoteFixture(remoteRoot)
  localFixture(localRoot)
  drive = mapDrive(localRoot)
  const localProject = drive ? `${drive}:\\projects\\website` : path.join(localRoot, 'projects', 'website')

  server = await startTestSshServer({ users: { deploy: { password: PASSWORD } }, rootDir: remoteRoot })
  mock = await startD1Mock({
    accountId: '9f3b8c2e4a1d47e6b0c5f2a8d3e1b7c4',
    databaseId: 'c2a7e5d1-8f34-4b6a-9e1c-3d5f7a9b2e40',
    token: 'readme-demo-token-0123456789'
  })

  const a = await launch('readme-a', 'Office-PC')
  const { win } = a
  const ids = await seed(win, server.port)

  // Terminal: an SSH session split in two panes, plus a local shell tab.
  await win.locator('[data-testid=host-card]', { hasText: 'web-prod-01' }).click()
  await win.click('[data-testid=hostkey-accept]')
  await expect(visiblePanes(win)).toHaveCount(1)
  const left = (await visiblePanes(win).first().getAttribute('data-session-id')) ?? ''
  await expect.poll(() => terminalText(win, left)).toContain('Welcome to test-ssh')
  await paneMenu(win, left, '清屏')
  await run(win, left, 'uname -srm', 'x86_64')
  await run(win, left, 'cat /etc/os-release', 'LOGO=ubuntu-logo')
  await paneMenu(win, left, '向右分屏')
  await expect(visiblePanes(win)).toHaveCount(2)
  const right = (await visiblePanes(win).nth(1).getAttribute('data-session-id')) ?? ''
  await expect.poll(() => terminalText(win, right)).toContain('Welcome to test-ssh')
  await paneMenu(win, right, '清屏')
  await run(win, right, 'cat docker-compose.yml', 'redis-data:/data')
  await run(win, right, 'id', 'uid=1000(deploy)')
  await win.click('[data-testid=new-tab-menu]')
  await win.click('[data-testid=new-local-terminal]')
  await expect(win.locator('[data-testid=terminal-tab]')).toHaveCount(2)
  await win.locator('[data-testid=terminal-tab]').first().click()
  await pane(win, left).click()
  await capture(a, 'terminal')

  // SFTP: local project on the left, the server on the right, after uploading the build output.
  await win.click('[data-testid=tab-vault]')
  await win.locator('[data-testid=host-card]', { hasText: 'web-prod-01' }).click({ button: 'right' })
  await win.getByRole('menuitem', { name: '打开 SFTP' }).click()
  await win.waitForSelector('[data-testid=sftp-pane-right] [data-testid=sftp-row][data-name="docker-compose.yml"]')
  await win.locator('[data-testid=sftp-breadcrumbs-left] button').last().click()
  await win.fill('[data-testid=sftp-path-input]', localProject)
  await win.keyboard.press('Enter')
  const dist = win.locator('[data-testid=sftp-pane-left] [data-testid=sftp-row][data-name="dist"]')
  await dist.click()
  await dist.click({ button: 'right' })
  await win.click('[data-testid=sftp-menu-transfer]')
  await expect
    .poll(async () => {
      const list = await rpc<TransferInfo[]>(win, 'transfer.list')
      return list.length > 0 && list.every((t) => t.status === 'done')
    })
    .toBe(true)
  await win.waitForSelector('[data-testid=sftp-pane-right] [data-testid=sftp-row][data-name="dist"]')
  await capture(a, 'sftp')

  // Port forwarding: two rules running through web-prod-01.
  await rpc(win, 'forward.start', ids.pfDb)
  await rpc(win, 'forward.start', ids.pfGrafana)
  await expect
    .poll(async () => (await rpc<ForwardState[]>(win, 'forward.states')).filter((s) => s.status === 'running').length)
    .toBe(2)
  await win.click('[data-testid=tab-vault]')
  await win.click('[data-testid=nav-portForwarding]')
  await capture(a, 'port-forwarding')

  await win.click('[data-testid=nav-snippets]')
  await capture(a, 'snippets')
  await win.click('[data-testid=nav-keychain]')
  await win.locator('main').getByText('Office-PC', { exact: true }).click()
  await win.waitForSelector('[role=dialog]')
  await capture(a, 'keychain')
  await win.keyboard.press('Escape')
  await expect(win.locator('[role=dialog]')).toHaveCount(0)
  await win.click('[data-testid=nav-hosts]')
  await capture(a, 'hosts')

  // Sync: this device creates the vault in "your own" D1; a second device sees the setup wizard, then joins.
  const d1 = {
    kind: 'd1',
    accountId: mock.accountId,
    databaseId: mock.databaseId,
    apiToken: mock.token,
    tablePrefix: 'sshtool_',
    baseUrl: mock.baseUrl
  }
  await rpc(win, 'sync.create', d1, MASTER)
  const b = await launch('readme-b', 'Home-Laptop')
  await b.win.click('[data-testid=nav-settings]')
  await b.win.click('[data-testid=settings-nav-sync]')
  await b.win.waitForSelector('[data-testid=sync-wizard]')
  await capture(b, 'sync-setup')
  await rpc(b.win, 'sync.join', d1, MASTER)

  await win.click('[data-testid=nav-settings]')
  await win.click('[data-testid=settings-nav-sync]')
  await win.waitForSelector('[data-testid=sync-dashboard]')
  await win.click('[data-testid=sync-devices-refresh]')
  await expect(win.locator('[data-testid=sync-device]')).toHaveCount(2)
  await capture(a, 'sync')

  await rpc(win, 'settings.set', { theme: 'light' })
  await win.click('[data-testid=nav-hosts]')
  await capture(a, 'hosts-light')
})
