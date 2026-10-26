import path from 'node:path'
import chokidar from 'chokidar'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  powerMonitor,
  type Rectangle,
  safeStorage,
  shell
} from 'electron'
import type { Api, RpcResult } from '@shared/ipc'
import { AppContext } from './context'
import { createHandlers } from './ipc/handlers'
import type { Emitter } from './services/emitter'
import { createAdapter, describeDbConfig } from './sync/adapters'
import type { SecretProtector } from './vault/keystore'

// node:sqlite is still flagged experimental in Node; the warning is noise for users.
const originalEmitWarning = process.emitWarning.bind(process)
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const msg = typeof warning === 'string' ? warning : warning?.message
  if (msg && /SQLite is an experimental feature/.test(msg)) return
  return (originalEmitWarning as (...a: unknown[]) => void)(warning, ...rest)
}) as typeof process.emitWarning

if (process.env.SSHTOOL_USER_DATA) app.setPath('userData', process.env.SSHTOOL_USER_DATA)
app.setName('SSH Tool')
if (process.platform === 'win32') app.setAppUserModelId('com.sshtool.app')

const isDev = !app.isPackaged && !!process.env.ELECTRON_RENDERER_URL
let mainWindow: BrowserWindow | null = null
let ctx: AppContext | null = null
let quitting = false
/**
 * True from the moment `will-quit` starts tearing the services down. macOS keeps emitting `activate`
 * while an app quits, so window creation must be refused until the process actually exits.
 */
let shuttingDown = false

const TITLEBAR = {
  dark: { color: '#0d0f17', symbolColor: '#c3c7d6' },
  light: { color: '#e8eaf0', symbolColor: '#3b3f4f' }
}
let titleBarTheme: 'dark' | 'light' = 'dark'

const emitter: Emitter = {
  emit(event, payload) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('evt', event, payload)
  },
  sessionData(id, data) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('session.data', id, data)
  }
}

const protector: SecretProtector = {
  available: () => safeStorage.isEncryptionAvailable(),
  backend: () =>
    process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : process.platform === 'darwin' ? 'keychain' : 'dpapi',
  weak: () => process.platform === 'linux' && ['basic_text', 'unknown'].includes(safeStorage.getSelectedStorageBackend()),
  encrypt: (buf) => safeStorage.encryptString(buf.toString('base64')),
  decrypt: (buf) => Buffer.from(safeStorage.decryptString(buf), 'base64')
}

function isTrustedSender(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  if (!mainWindow || e.sender !== mainWindow.webContents) return false
  const url = e.senderFrame?.url ?? ''
  if (isDev) return url.startsWith(process.env.ELECTRON_RENDERER_URL!)
  return url.startsWith('file://')
}

function createWindow(): void {
  const c = ctx
  // Guarded: `activate` can arrive after the context was torn down during quit.
  if (!c) return
  const saved = c.db.kvGetJson<Rectangle & { maximized?: boolean }>('window.bounds')
  const isMac = process.platform === 'darwin'
  const win = (mainWindow = new BrowserWindow({
    width: saved?.width ?? 1280,
    height: saved?.height ?? 820,
    x: saved?.x,
    y: saved?.y,
    minWidth: 900,
    minHeight: 560,
    show: false,
    title: 'SSH Tool',
    backgroundColor: TITLEBAR[titleBarTheme].color,
    // macOS: inset traffic lights; Windows: frameless with native controls overlay; Linux: native frame
    // (window-controls overlays are not reliable across Linux window managers).
    ...(process.platform === 'linux'
      ? { icon: path.join(__dirname, '../../resources/icon.png') }
      : isMac
        ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 13 } }
        : { titleBarStyle: 'hidden' as const, titleBarOverlay: { ...TITLEBAR[titleBarTheme], height: 40 } }),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false
    }
  }))
  if (saved?.maximized) win.maximize()
  win.once('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault()
  })
  win.webContents.on('before-input-event', (_e, input) => {
    if (isDev && input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')))
      win.webContents.toggleDevTools()
  })

  let saveTimer: NodeJS.Timeout | null = null
  const saveBounds = (): void => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      if (win.isDestroyed()) return
      c.db.kvSetJson('window.bounds', { ...win.getNormalBounds(), maximized: win.isMaximized() })
    }, 400)
  }
  win.on('resize', saveBounds)
  win.on('move', saveBounds)
  win.on('focus', () => c.sync.onFocus())
  win.on('close', (e) => {
    if (quitting && !c.settings.get().confirmOnClose) return
    const active = c.sessions.list().filter((s) => s.status === 'connected').length
    if (active > 0 && c.settings.get().confirmOnClose) {
      const zh = c.settings.get().language === 'zh-CN'
      const choice = dialog.showMessageBoxSync(win, {
        type: 'question',
        buttons: zh ? ['退出', '取消'] : ['Quit', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        title: 'SSH Tool',
        message: zh ? `还有 ${active} 个活动会话，确定要退出吗？` : `${active} active session(s) will be closed. Quit anyway?`
      })
      if (choice !== 0) {
        e.preventDefault()
        quitting = false
        return
      }
    }
    c.db.kvSetJson('window.bounds', { ...win.getNormalBounds(), maximized: win.isMaximized() })
  })
  win.on('closed', () => {
    c.sessions.closeAll()
    c.prompts.cancelAll()
    mainWindow = null
  })

  if (isDev) void win.loadURL(process.env.ELECTRON_RENDERER_URL!)
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

function buildMenu(): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
    return
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { label: 'View', submenu: [{ role: 'togglefullscreen' }, ...(isDev ? [{ role: 'reload' as const }, { role: 'toggleDevTools' as const }] : [])] },
      { role: 'windowMenu' }
    ])
  )
}

function registerIpc(c: AppContext): void {
  const handlers = createHandlers(c, {
    appInfo: () => ({
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      node: process.versions.node,
      userData: app.getPath('userData')
    }),
    openExternal: (url) => shell.openExternal(url),
    showItemInFolder: (p) => shell.showItemInFolder(p),
    openFileDialog: async (opts) => {
      const props: ('openFile' | 'openDirectory' | 'multiSelections' | 'showHiddenFiles')[] = [opts.directory ? 'openDirectory' : 'openFile', 'showHiddenFiles']
      if (opts.multi) props.push('multiSelections')
      const r = await dialog.showOpenDialog(mainWindow!, { title: opts.title, filters: opts.filters, defaultPath: opts.defaultPath, properties: props })
      return r.canceled ? [] : r.filePaths
    },
    saveFileDialog: async (opts) => {
      const r = await dialog.showSaveDialog(mainWindow!, { title: opts.title, defaultPath: opts.defaultPath, filters: opts.filters })
      return r.canceled || !r.filePath ? null : r.filePath
    },
    setTitleBarTheme: (theme) => {
      titleBarTheme = theme
      if (mainWindow && process.platform === 'win32') {
        try {
          mainWindow.setTitleBarOverlay({ ...TITLEBAR[theme], height: 40 })
        } catch {
          // not supported on this platform/window manager
        }
        mainWindow.setBackgroundColor(TITLEBAR[theme].color)
      }
    },
    openPath: (p) => shell.openPath(p)
  })

  ipcMain.handle('rpc', async (e, method: string, ...args: unknown[]): Promise<RpcResult> => {
    if (!isTrustedSender(e)) return { ok: false, error: { message: 'Untrusted sender' } }
    const fn = (handlers as Record<string, ((...a: unknown[]) => unknown) | undefined>)[method]
    if (!fn) return { ok: false, error: { message: `Unknown method: ${method}` } }
    try {
      return { ok: true, value: await fn(...args) }
    } catch (err) {
      const e2 = err as Error & { code?: string }
      return { ok: false, error: { message: e2?.message ?? String(err), code: typeof e2?.code === 'string' ? e2.code : undefined } }
    }
  })
  ipcMain.on('session.write', (e, id: unknown, data: unknown) => {
    if (isTrustedSender(e) && typeof id === 'string' && typeof data === 'string') c.sessions.write(id, data)
  })
  ipcMain.on('session.resize', (e, id: unknown, cols: unknown, rows: unknown) => {
    if (isTrustedSender(e) && typeof id === 'string') c.sessions.resize(id, Number(cols), Number(rows))
  })
  ipcMain.on('session.ack', (e, id: unknown, bytes: unknown) => {
    if (isTrustedSender(e) && typeof id === 'string') c.sessions.ack(id, Number(bytes) || 0)
  })
}

function startAutoLock(c: AppContext): void {
  const check = (): void => {
    // The interval keeps ticking until the process exits, but the context is already torn down then
    // (its database is closed), so nothing may touch it any more.
    if (shuttingDown) return
    const minutes = c.settings.get().autoLockMinutes
    if (minutes > 0 && c.keystore.passwordEnabled && c.keystore.unlocked && powerMonitor.getSystemIdleTime() >= minutes * 60) void c.lock()
  }
  setInterval(check, 30_000)
  const lockNow = (): void => {
    if (shuttingDown) return
    if (c.settings.get().autoLockMinutes > 0) void c.lock()
  }
  powerMonitor.on('lock-screen', lockNow)
  powerMonitor.on('suspend', lockNow)
  powerMonitor.on('resume', () => {
    if (!shuttingDown) c.sync.onFocus()
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    ctx = new AppContext({
      userData: app.getPath('userData'),
      emitter,
      protector,
      appVersion: app.getVersion(),
      createAdapter,
      describeDb: describeDbConfig,
      openPath: (p) => shell.openPath(p),
      watchFile: (p, onChange) => {
        const w = chokidar.watch(p, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 } })
        w.on('change', onChange)
        return () => void w.close()
      },
      // net.fetch respects the system proxy, unlike Node's bundled fetch.
      fetchImpl: (url, init) => net.fetch(url, init)
    })
    titleBarTheme = ctx.settings.get().theme === 'light' ? 'light' : 'dark'
    registerIpc(ctx)
    buildMenu()
    await ctx.init()
    startAutoLock(ctx)
    ctx.updater.start()
    createWindow()
    app.on('activate', () => {
      // macOS emits `activate` (dock icon / Cmd-Tab) during and right after a quit; never resurrect a window then.
      if (quitting || shuttingDown) return
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('before-quit', () => {
    quitting = true
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('will-quit', (e) => {
    if (!ctx || shuttingDown) return
    shuttingDown = true
    // Cancel this quit so the services (sessions, transfers, sync, database) can be torn down first.
    e.preventDefault()
    const c = ctx
    void c
      .shutdown()
      .catch(() => {})
      .finally(() => {
        ctx = null
        // Must run outside the `will-quit` dispatch: `app.quit()` issued while the event is still
        // being emitted is silently ignored, which left the app running with no window after ⌘Q.
        setImmediate(() => app.quit())
      })
  })
}

export type { Api }
