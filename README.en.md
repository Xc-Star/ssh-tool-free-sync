# SSH Tool — Free Self-Hosted Sync

[简体中文](README.md) | **English**

> A cross-platform SSH client that matches Termius feature-for-feature. Sync is free and never touches a vendor server: your data goes into your own PostgreSQL, MySQL / MariaDB, Cloudflare D1 or any WebDAV folder, end-to-end encrypted with your master password — the storage only sees ciphertext. Works offline and merges automatically. A built-in AI assistant with your own API turns tasks into commands on the remote host — and every command asks for your approval first.

Runs on Windows, macOS and Linux. The interface is available in Simplified Chinese and English; it starts in Chinese — switch it under **设置 → 通用 → 语言** (Settings → General → Language).

![Hosts](docs/screenshots/en/hosts.png)

<sub>This project is not affiliated with Termius and does not use any Termius trademarks, icons or other assets.</sub>

---

## Features

| Area | Features |
| --- | --- |
| Hosts | Nested groups (hosts inherit group defaults), tags, grid / list view, search and sorting, multi-select bulk actions, drag and drop into groups, context menus, quick connect with `user@host -p port`, automatic remote OS detection with distro icons |
| Terminal | Tabs with drag-and-drop reordering, horizontal / vertical split panes, broadcast input (type once, send to every pane), find in terminal, copy on select, right-click paste, zoom, clickable links, 18 color schemes, per-host color scheme and font size, command autocomplete (from history and snippets), save output |
| Connections | Password / private key (OpenSSH, PEM, PuTTY PPK, with passphrases) / SSH agent (Pageant, OpenSSH agent, `SSH_AUTH_SOCK`) / keyboard-interactive (2FA); host chains (multi-hop jump hosts), SOCKS4/5 and HTTP proxies, agent forwarding, keep-alive, environment variables, commands to run after login, character encodings such as GBK; host key verification on first connect and a prominent warning when a key changes; reconnect with one click or Enter |
| Other protocols | Local terminal (PowerShell / pwsh / cmd / WSL / Git Bash / zsh / bash…), Telnet, serial (baud rate, data bits, parity, flow control, local echo, line endings; saved profiles) |
| SFTP | Dual-pane file manager (local ⇄ remote, remote ⇄ remote), drag-and-drop upload and download (also from the system file manager), recursive transfers, transfer queue (concurrency, progress, speed, cancel, retry), conflict handling (overwrite / skip / keep both), permission editing, built-in editor, editing in an external app with automatic upload on save |
| Keychain | Generate Ed25519 / RSA / ECDSA keys, import key files or paste keys, view public keys and fingerprints, export a public key to a host's `authorized_keys` in one click, identities (reusable username + password / key), keys can be marked "Device only" so they are never synced |
| Port forwarding | Local, remote and dynamic forwarding (built-in SOCKS5); rule management, start / stop, auto-start, status and connection counts |
| Snippets | Snippet library (shell-highlighting editor, tags), run in the current terminal, run on several hosts at once, quick insert from the terminal sidebar |
| AI assistant | Bring your own API: OpenAI, Claude, Gemini, DeepSeek, Qwen, Zhipu GLM, MiniMax, Ollama (local) or any OpenAI-compatible / Anthropic-compatible gateway; multiple named configs with one-click switching, automatic model discovery and a connection test; chat with the current SSH session from the terminal sidebar — commands run through a separate exec channel with stdout / stderr / exit codes returned, and TTY-only situations (sudo, editors) ask to type into your terminal; every command asks for approval by default (per-chat or global auto mode available), API keys are encrypted with the OS keychain, requests go straight to the provider |
| Known hosts / Logs | Host key management (import from `~/.ssh/known_hosts`, synced between devices), connection history |
| Settings | Chinese and English UI (Chinese by default), dark / light / system theme, terminal appearance, customizable shortcuts, SFTP options, app lock (on start and after idle), import & export (`~/.ssh/config`, CSV, encrypted backups) |
| **Multi-device sync** | Your own storage: PostgreSQL (real-time push), MySQL / MariaDB, Cloudflare D1, WebDAV folder; end-to-end encrypted; works offline and merges automatically when back online; device list, master password change, vault key rotation |

---

## Screenshots

<table>
  <tr>
    <td align="center"><img src="docs/screenshots/en/terminal.png" width="380" alt="Terminal"><br><sub>Terminal: tabs and split panes</sub></td>
    <td align="center"><img src="docs/screenshots/en/sftp.png" width="380" alt="SFTP"><br><sub>SFTP: local ⇄ remote panes and a transfer queue</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/screenshots/en/port-forwarding.png" width="380" alt="Port forwarding"><br><sub>Port forwarding: local / remote / dynamic SOCKS</sub></td>
    <td align="center"><img src="docs/screenshots/en/snippets.png" width="380" alt="Snippets"><br><sub>Snippets: filter by tag, run on many hosts</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/screenshots/en/keychain.png" width="380" alt="Keychain"><br><sub>Keychain: generate, import, export public keys to hosts</sub></td>
    <td align="center"><img src="docs/screenshots/en/hosts-light.png" width="380" alt="Light theme"><br><sub>Light theme</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/screenshots/en/ai.png" width="380" alt="AI assistant"><br><sub>AI assistant: drive the current SSH session by chat, approve every command</sub></td>
    <td align="center"><img src="docs/screenshots/en/ai-settings.png" width="380" alt="AI settings"><br><sub>AI settings: bring your own API, multiple named configs</sub></td>
  </tr>
</table>

---

## AI assistant

Click the robot icon in the terminal toolbar (or search "AI" in the command palette) to open the chat panel next to your terminal. It binds to the current SSH session: describe a task and the AI plans and runs the commands, then reports back.

- **Bring your own API**: configure your provider under Settings → AI Assistant — OpenAI, Claude, Gemini, DeepSeek, Qwen, Zhipu GLM, MiniMax, Ollama (local), or any OpenAI-compatible / Anthropic-compatible gateway (a bare domain gets `/v1` appended automatically). Keep multiple named configs, discover models automatically and test the connection in one click.
- **Two execution modes**: commands normally run through a separate exec channel on the remote host (`run_command`) with stdout / stderr / exit code returned — your interactive terminal is untouched. For TTY-only situations (sudo password prompts, vim, interactive wizards) the AI can ask to type into your terminal (`send_keys`).
- **Every command asks first**: each command shows an approve / decline prompt (no answer within 5 minutes counts as declined). "Auto-run for this chat" and a global auto mode are available; max turns and command timeout are configurable as a runaway guard.
- **Privacy**: API keys are encrypted with the OS keychain and never leave your device unencrypted; AI requests go straight from the app to the provider URL you configured. AI configs are device-local and are not part of multi-device sync.

> Note: agent mode requires a model with function-calling support. Some reverse-proxy models on gateways don't support it — the symptom is the AI replying with text but never running commands. Switch to a model that does (official `gpt-4o`, `deepseek-chat`, `claude-sonnet-4-5`, …).

---

## Multi-device sync

<table>
  <tr>
    <td align="center"><img src="docs/screenshots/en/sync-setup.png" width="380" alt="Sync setup"><br><sub>Sync setup: your data goes into your own database</sub></td>
    <td align="center"><img src="docs/screenshots/en/sync.png" width="380" alt="Sync status"><br><sub>Sync status and devices</sub></td>
  </tr>
</table>

### How it works

- **End-to-end encryption**: when you turn on sync you choose a **master password**. Argon2id derives a key from it that encrypts a randomly generated *vault key*, and every host, key, snippet and other item is encrypted on your device with that vault key (AES-256-GCM) before it is uploaded. The database only stores item IDs, ciphertext, timestamps, deletion markers and sequence numbers — it cannot even see host addresses or item types.
- **Conflict resolution**: every item carries a hybrid logical clock (HLC) timestamp and the last write wins per item; deletions sync as tombstones. Devices with inaccurate clocks are handled correctly.
- **Incremental sync plus full checks**: changes are pulled incrementally by sequence number, and a periodic full comparison repairs any divergence (for example after the database was restored from an old backup).
- **When it syncs**: local changes are pushed about 1.5 seconds after you make them; PostgreSQL receives other devices' changes in real time through `LISTEN/NOTIFY`; MySQL, D1 and WebDAV poll (every 30 / 60 seconds by default, adjustable). Sync also runs when the window gets focus and when the network comes back.
- **What syncs**: hosts, groups, tags, keys, identities, snippets, port forwarding rules, known hosts, terminal preferences and shortcuts. Not synced: the database connection settings, window state, language / theme, app lock settings, connection logs and serial profiles (port names differ between devices).

> ⚠️ **The master password cannot be recovered**, and changing it requires the current one. Devices that are already signed in keep working and syncing.
> If you forget it and need to add a new device: on any signed-in device, **Disconnect** sync, then create a new vault with a new master password in a new database (or with a different prefix under **Advanced → Table prefix**) — all local data is uploaded again — and join the new vault from your other devices.

### Adding another device

On the other device open **Settings → Sync**, choose the same database, enter the same connection details and your master password to **join** the vault.
Data that already exists on the new device is merged into the vault.

### PostgreSQL (recommended, real-time sync)

Use your own server (see [`deploy/docker-compose.postgres.yml`](deploy/docker-compose.postgres.yml)) or a hosted PostgreSQL with a free tier such as Supabase, Neon or Aiven. A dedicated database and user are recommended:

```sql
CREATE USER sshtool WITH PASSWORD 'a-long-random-password';
CREATE DATABASE sshtool OWNER sshtool;
```

In SSH Tool, enter a connection URL such as `postgres://sshtool:password@db.example.com:5432/sshtool` and choose SSL mode `require`
(always use TLS when the database is reachable over the internet; for a self-signed certificate choose `verify-ca` and paste the CA certificate).

### MySQL / MariaDB

For a self-hosted server see [`deploy/docker-compose.mysql.yml`](deploy/docker-compose.mysql.yml). A least-privilege user:

```sql
CREATE DATABASE sshtool CHARACTER SET utf8mb4;
CREATE USER 'sshtool'@'%' IDENTIFIED BY 'a-long-random-password';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, INDEX ON sshtool.* TO 'sshtool'@'%';
```

Example connection URL: `mysql://sshtool:password@db.example.com:3306/sshtool`. Local tests cover MySQL 8.0 and 9.x; CI also runs the same conformance suite against MySQL 8.4 and MariaDB 11.

### Cloudflare D1

D1 is Cloudflare's serverless SQLite. Its free tier is more than enough for personal sync and there is no server to maintain. SSH Tool talks to the official Cloudflare HTTP API directly — no Worker to deploy.

1. In the Cloudflare dashboard, open **Workers & Pages → D1 SQL Database → Create** to create a database (or run `npx wrangler d1 create sshtool`).
2. Under **My Profile → API Tokens → Create Token → Create Custom Token**, create a token with the permission **Account → D1 → Edit** for your account
   (you can also restrict it to your client IP addresses).
3. In SSH Tool, enter the **Account ID** (on the right of the dashboard home page, or in the URL), the **Database ID** (on the D1 database page) and the **API Token**.

> Note: a token with D1 Edit permission can access **every** D1 database in the account, so consider a dedicated Cloudflare account for sync.
> A leaked token only exposes ciphertext, but it could be used to delete your data — export an encrypted backup regularly under **Settings → Import & export → Encrypted backup**.
> The Cloudflare API has a global rate limit (about 1,200 requests per 5 minutes); SSH Tool polls every 60 seconds by default and backs off when limited, so normal use stays far below it.

### WebDAV folder

Any WebDAV-compatible storage works: Nextcloud, ownCloud, Synology DiskStation, a managed WebDAV service, or a plain Apache / nginx server with WebDAV enabled. No database and no server-side component to deploy.

1. Create a folder on your storage, for example `sshtool` (SSH Tool also creates it automatically when it is missing).
2. Copy the full URL of that folder from your provider's “WebDAV” or “Connect via WebDAV” page, e.g.
   `https://cloud.example.com/remote.php/dav/files/username/sshtool/`.
3. Paste the URL into SSH Tool and enter your user name and password — use an **app password** where your provider offers one.

The vault is stored as a single JSON file (default `sshtool_sync.json`) inside that folder. Every update uses an ETag-conditional request (`If-Match`) for optimistic concurrency control, so devices writing at the same time never clobber each other; servers that do not expose ETags fall back to verifying a revision token after the upload.

> Note: a leaked password still only exposes ciphertext, but it could be used to delete that file — export an encrypted backup regularly under **Settings → Import & export → Encrypted backup**.
> HTTPS is recommended; if the server uses a self-signed certificate, trust that certificate in your operating system first.

### Security tips

- Enable TLS on the database, use a strong password and a dedicated low-privilege user, and restrict access by IP where you can.
- If a device is lost, **Rotate vault key** on another device (Settings → Sync): everything is re-encrypted with a new key and the lost device can no longer decrypt new data.
- The local database is encrypted as well; its vault key is protected by the operating system keychain (Windows DPAPI / macOS Keychain / Linux Secret Service).
  On Linux without a keychain service, set an app lock password under **Settings → Security**.
- If the system keychain can no longer return the key (for example after switching the Linux desktop or keyring, denying macOS keychain access, or copying the data directory to another computer),
  the app shows **"Can't open the local vault"** on start. Try again, or reset local data and then rejoin under **Settings → Sync** with your master password to get your data back.
  If you forget the app lock password, use **"Forgot password?"** on the lock screen for the same reset.

---

## Installation

Download the package for your platform from [Releases](../../releases):

- **Windows**: `ssh-tool-<version>-win-x64-setup.exe` (installer) or `-portable.exe` (portable). Unsigned builds may trigger a SmartScreen prompt — click **More info → Run anyway**.
- **macOS**: `ssh-tool-<version>-mac-arm64.dmg` (Apple silicon) / `-mac-x64.dmg` (Intel). The app is not notarized by Apple; if macOS blocks it on first launch,
  open **System Settings → Privacy & Security** and click **Open Anyway**, or run `xattr -dr com.apple.quarantine "/Applications/SSH Tool.app"`.
- **Linux**: `AppImage`, `deb`, `rpm`, for x64 and arm64. On Ubuntu / Debian the `.deb` is recommended: it sets up Chromium's sandbox and AppArmor profile and adds a menu entry.
  The AppImage needs FUSE 2, which Ubuntu 22.04+ doesn't install by default (24.04: `sudo apt install libfuse2t64`; 22.04: `sudo apt install libfuse2`); then `chmod +x` it and run it.

Data directory: Windows `%APPDATA%\SSH Tool`, macOS `~/Library/Application Support/SSH Tool`, Linux `~/.config/SSH Tool`.

---

## Building from source

Requires Node.js 22+.

```bash
npm ci
npm run dev          # development mode with hot reload
npm test             # unit + integration tests (built-in SSH test server, D1 / WebDAV mocks, embedded PostgreSQL)
npm run test:e2e     # end-to-end tests (Playwright drives the real app: host → SSH terminal, sync wizard, two-device sync, sync after restart, dialogs, keychain recovery)
npm run screenshots  # regenerate the README screenshots (docs/screenshots, one set per language)
npx electron-builder --dir && npm run test:package   # package for this platform and smoke-test it (archive contents, signing, native modules)
npm run typecheck
npm run dist:win     # package for Windows (run on Windows)
npm run dist:mac     # package for macOS (run on macOS)
npm run dist:linux   # package for Linux (run on Linux)
```

The native modules (node-pty, serialport) ship N-API prebuilt binaries, so Windows and macOS need no build tools; on Linux node-pty is compiled during `npm ci` (requires `build-essential` and `python3`).
Packages must be built on their own platform — pushing a `v*` tag makes GitHub Actions ([`.github/workflows/release.yml`](.github/workflows/release.yml)) build every platform and publish a release.

Optional test environment variables: `SSHTOOL_TEST_MYSQL=1` (downloads and starts a temporary MySQL to test the sync adapter), `SSHTOOL_TEST_PG_URL` / `SSHTOOL_TEST_MYSQL_URL` (use an external database),
`CF_ACCOUNT_ID` + `CF_D1_DATABASE_ID` + `CF_API_TOKEN` (use a real Cloudflare D1).

---

## Keyboard shortcuts

| Action | Windows / Linux | macOS |
| --- | --- | --- |
| Command palette / quick connect | `Ctrl+Shift+K` or `Ctrl+Shift+T` | `⌘K` / `⌘T` |
| Close tab | `Ctrl+Shift+W` | `⌘W` |
| Switch tabs | `Ctrl+Tab` / `Alt+1…9` | `⌃Tab` / `⌘1…9` |
| Local terminal | ``Ctrl+Shift+` `` | `⌘⇧T` |
| Split right / down | `Ctrl+Shift+D` / `Ctrl+Shift+E` | `⌘D` / `⌘⇧D` |
| Broadcast input | `Ctrl+Shift+B` | `⌘⇧B` |
| Find in terminal | `Ctrl+Shift+F` | `⌘F` |
| Copy / paste | `Ctrl+Shift+C` / `Ctrl+Shift+V` | `⌘C` / `⌘V` |
| Open SFTP | `Ctrl+Shift+O` | `⌘⇧O` |
| Settings | `Ctrl+,` | `⌘,` |

Every shortcut can be changed under **Settings → Shortcuts** (and syncs to your devices on the same kind of platform). On Windows / Linux the defaults use `Ctrl+Shift` so they don't clash with shell keys such as `Ctrl+W` and `Ctrl+K`.

---

## Known limitations

- No Mosh support (there is no official mosh-client for Windows).
- OpenSSH user certificate authentication is not supported by the SSH library (ssh2) yet; the certificate field is stored but not used for authentication.
- MySQL, D1 and WebDAV have no push notifications and rely on polling (the interval is adjustable in the sync settings).
- Command autocomplete uses locally recorded command history and cannot see the remote shell's own completions (it can be turned off in settings).

## Tech stack

Electron · React · TypeScript · Tailwind CSS · Radix UI · xterm.js · ssh2 · node-pty · serialport · CodeMirror · node:sqlite · pg · mysql2

## License

[MIT](LICENSE)