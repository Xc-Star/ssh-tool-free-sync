import fs from 'node:fs'
import os from 'node:os'
import type { Api, DialogFilter } from '@shared/ipc'
import { type Item, type ItemKind, ITEM_KINDS } from '@shared/schemas'
import type { AppInfo } from '@shared/types'
import type { AppContext } from '../context'
import { applySshConfig, readSshConfig } from '../importers/ssh-config'
import { exportBackup, exportHostsCsv, importBackup, importHostsCsv, importKnownHosts } from '../importers/data-io'
import { defaultSerialProfile, listSerialPorts } from '../sessions/serial-session'
import { detectShells } from '../sessions/local-session'
import { connectEndpoint } from '../ssh/connect'
import { generateKey, inspectKey, KeyParseError, parsePrivateKey, publicKeyLine } from '../ssh/keys'
import { resolveHostById } from '../ssh/resolve'
import { maskItem } from '../vault/secrets'
import { WrongPasswordError } from '../vault/keystore'

export interface PlatformBridge {
  appInfo(): Omit<AppInfo, 'deviceId' | 'deviceName' | 'userData' | 'homeDir'> & { userData: string }
  openExternal(url: string): Promise<void>
  showItemInFolder(path: string): void
  openFileDialog(opts: { title?: string; filters?: DialogFilter[]; directory?: boolean; multi?: boolean; defaultPath?: string }): Promise<string[]>
  saveFileDialog(opts: { title?: string; defaultPath?: string; filters?: DialogFilter[] }): Promise<string | null>
  setTitleBarTheme(theme: 'dark' | 'light'): void
  openPath(p: string): Promise<string>
}

type Handlers = { [K in keyof Api]: (...args: Parameters<Api[K]>) => ReturnType<Api[K]> | Promise<ReturnType<Api[K]>> }

function assertKind(kind: unknown): asserts kind is ItemKind {
  if (typeof kind !== 'string' || !(ITEM_KINDS as readonly string[]).includes(kind)) throw new Error('Invalid item kind')
}

function assertString(v: unknown, name: string): asserts v is string {
  if (typeof v !== 'string') throw new Error(`${name} must be a string`)
}

const MAX_TEXT_FILE = 2 * 1024 * 1024

export function createHandlers(ctx: AppContext, platform: PlatformBridge): Handlers {
  const { vault } = ctx
  const mask = <T extends Item>(i: T): T => maskItem(i)

  const keyItemFromPem = (label: string, privateKey: string, passphrase?: string, certificate?: string): Item<'key'> => {
    const info = inspectKey(privateKey, passphrase)
    return vault.upsert('key', {
      label: label || info.comment || info.keyType,
      privateKey: privateKey.trim() + '\n',
      passphrase: passphrase || undefined,
      keyType: info.keyType,
      publicKey: info.publicKey,
      fingerprint: info.fingerprint,
      certificate: certificate?.trim() || undefined
    })
  }

  return {
    // ---------------------------------------------------------------- app
    'app.info': () => {
      const base = platform.appInfo()
      return { ...base, deviceId: ctx.deviceId, deviceName: os.hostname(), homeDir: os.homedir() }
    },
    'app.openExternal': async (url) => {
      assertString(url, 'url')
      if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) links can be opened')
      await platform.openExternal(url)
    },
    'app.showItemInFolder': (p) => platform.showItemInFolder(p),
    'app.openFileDialog': (opts) => platform.openFileDialog(opts ?? {}),
    'app.saveFileDialog': (opts) => platform.saveFileDialog(opts ?? {}),
    'app.readTextFile': async (p, maxBytes) => {
      assertString(p, 'path')
      const st = await fs.promises.stat(p)
      if (st.size > Math.min(maxBytes ?? MAX_TEXT_FILE, MAX_TEXT_FILE)) throw new Error('File is too large')
      return fs.promises.readFile(p, 'utf8')
    },
    'app.setTitleBarTheme': (theme) => platform.setTitleBarTheme(theme === 'light' ? 'light' : 'dark'),

    // ---------------------------------------------------------------- lock
    'lock.status': () => ctx.lockStatus(),
    'lock.unlock': (password) => ctx.unlock(String(password)),
    'lock.lock': async () => {
      await ctx.lock()
    },
    'lock.enablePassword': async (password) => {
      if (String(password).length < 4) throw new Error('The password must be at least 4 characters')
      await ctx.keystore.enablePassword(String(password))
      ctx.emitter.emit('lock.changed', ctx.lockStatus())
    },
    'lock.disablePassword': async (password) => {
      try {
        await ctx.keystore.disablePassword(String(password))
      } catch (err) {
        if (err instanceof WrongPasswordError) throw new Error('Wrong password', { cause: err })
        throw err
      }
      ctx.emitter.emit('lock.changed', ctx.lockStatus())
    },
    'lock.changePassword': async (oldPassword, newPassword) => {
      if (String(newPassword).length < 4) throw new Error('The password must be at least 4 characters')
      try {
        await ctx.keystore.changePassword(String(oldPassword), String(newPassword))
      } catch (err) {
        if (err instanceof WrongPasswordError) throw new Error('Wrong password', { cause: err })
        throw err
      }
    },
    'lock.retryKeystore': async () => {
      await ctx.retryKeystore()
      return ctx.lockStatus()
    },
    'lock.resetLocal': async () => {
      // Only offered while the vault cannot be opened (keychain failure or forgotten app lock password).
      if (ctx.keystore.unlocked) throw new Error('The vault is unlocked')
      await ctx.resetLocalVault()
      return ctx.lockStatus()
    },

    // ---------------------------------------------------------------- vault
    'vault.list': (kind) => {
      if (kind !== undefined) assertKind(kind)
      return vault.list(kind).map(mask)
    },
    'vault.get': (id) => {
      const it = vault.get(id)
      return it ? mask(it) : null
    },
    'vault.reveal': (id) => vault.get(id) ?? null,
    'vault.upsert': ((kind: ItemKind, data: unknown, opts?: { id?: string; localOnly?: boolean }) => {
      assertKind(kind)
      return mask(vault.upsert(kind, data as never, { id: opts?.id, localOnly: opts?.localOnly }))
    }) as Handlers['vault.upsert'],
    'vault.patch': (id, patch) => mask(vault.patch(id, patch ?? {})),
    'vault.remove': (ids) => {
      if (!Array.isArray(ids)) throw new Error('ids must be an array')
      const toRemove = new Set(ids)
      // Removing a group also removes its sub-groups; hosts are moved to the parent group.
      for (const id of ids) {
        const g = vault.get(id, 'group')
        if (!g) continue
        const walk = (gid: string): void => {
          for (const child of vault.list('group').filter((c) => c.data.parentId === gid)) {
            if (toRemove.has(child.id)) continue
            toRemove.add(child.id)
            walk(child.id)
          }
        }
        walk(id)
      }
      for (const h of vault.list('host')) {
        if (h.data.groupId && toRemove.has(h.data.groupId) && !toRemove.has(h.id)) {
          let parent = vault.get(h.data.groupId, 'group')?.data.parentId
          while (parent && toRemove.has(parent)) parent = vault.get(parent, 'group')?.data.parentId
          vault.patch(h.id, { groupId: parent })
        }
      }
      vault.remove([...toRemove])
    },
    'vault.duplicate': (id) => mask(vault.duplicate(id)),
    'vault.setLocalOnly': (id, localOnly) => mask(vault.setLocalOnly(id, !!localOnly)),

    // ---------------------------------------------------------------- keys
    'keys.generate': (opts) => {
      const { privateKey } = generateKey({ type: opts.type, bits: opts.bits, passphrase: opts.passphrase, comment: opts.comment })
      return mask(keyItemFromPem(opts.label, privateKey, opts.passphrase)) as Item<'key'>
    },
    'keys.inspect': (privateKey, passphrase) => {
      try {
        return inspectKey(privateKey, passphrase)
      } catch (err) {
        if (err instanceof KeyParseError) throw Object.assign(new Error(err.message), { code: err.needsPassphrase ? 'NEEDS_PASSPHRASE' : 'INVALID_KEY' })
        throw err
      }
    },
    'keys.import': (opts) => {
      try {
        return mask(keyItemFromPem(opts.label, opts.privateKey, opts.passphrase, opts.certificate)) as Item<'key'>
      } catch (err) {
        if (err instanceof KeyParseError) throw Object.assign(new Error(err.message), { code: err.needsPassphrase ? 'NEEDS_PASSPHRASE' : 'INVALID_KEY' })
        throw err
      }
    },
    'keys.importFile': async (p, label, passphrase) => {
      const st = await fs.promises.stat(p)
      if (st.size > 64 * 1024) throw new Error('This does not look like a private key file (too large)')
      const pem = await fs.promises.readFile(p, 'utf8')
      try {
        return mask(keyItemFromPem(label || p.split(/[\\/]/).pop() || 'key', pem, passphrase)) as Item<'key'>
      } catch (err) {
        if (err instanceof KeyParseError) throw Object.assign(new Error(err.message), { code: err.needsPassphrase ? 'NEEDS_PASSPHRASE' : 'INVALID_KEY' })
        throw err
      }
    },
    'keys.exportToHost': async (keyId, hostId) => {
      const key = vault.get(keyId, 'key')
      if (!key) throw new Error('Key not found')
      let line = key.data.publicKey?.trim()
      if (!line) line = publicKeyLine(parsePrivateKey(key.data.privateKey, key.data.passphrase))
      if (!/^[\w@.-]+ [A-Za-z0-9+/=]+( [^\r\n'"\\]*)?$/.test(line)) throw new Error('Invalid public key')
      const ep = resolveHostById(vault, hostId, { keepAliveSec: 0 })
      const conn = await connectEndpoint(ep, { vault, prompts: ctx.prompts, knownHosts: ctx.knownHosts, defaultKeepAliveSec: 0 })
      try {
        const quoted = `'${line.replace(/'/g, `'\\''`)}'`
        const cmd =
          'umask 077; mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && ' +
          `if grep -qxF ${quoted} ~/.ssh/authorized_keys; then echo SSHTOOL_EXISTS; else echo ${quoted} >> ~/.ssh/authorized_keys && echo SSHTOOL_ADDED; fi`
        const res = await conn.exec(cmd)
        if (res.stdout.includes('SSHTOOL_EXISTS')) return { added: false, message: 'The key is already authorized on this host' }
        if (res.stdout.includes('SSHTOOL_ADDED')) return { added: true, message: 'Public key added to ~/.ssh/authorized_keys' }
        throw new Error(res.stderr.trim() || `Remote command failed (exit ${res.code})`)
      } finally {
        conn.close()
      }
    },
    'keys.savePrivateKey': async (keyId, p) => {
      const key = vault.get(keyId, 'key')
      if (!key) throw new Error('Key not found')
      await fs.promises.writeFile(p, key.data.privateKey, { mode: 0o600 })
    },

    // ---------------------------------------------------------------- sessions
    'session.openSsh': (params) => ctx.sessions.openSsh(params),
    'session.openLocal': (params) => ctx.sessions.openLocal(params),
    'session.openTelnet': (params) => ctx.sessions.openTelnet(params),
    'session.openSerial': (params) => ctx.sessions.openSerial(params),
    'session.close': (id) => ctx.sessions.close(id),
    'session.reconnect': (id) => ctx.sessions.reconnect(id),
    'session.list': () => ctx.sessions.list(),
    'session.shells': () => detectShells(),
    'session.serialPorts': () => listSerialPorts(),
    'session.exec': async (hostId, command) => {
      const lease = await ctx.pool.acquire(hostId)
      try {
        return await lease.conn.exec(command, { timeoutMs: 60_000 })
      } finally {
        lease.release()
      }
    },

    // ---------------------------------------------------------------- prompts
    'prompt.respond': (id, response) => ctx.prompts.respond(id, response),

    // ---------------------------------------------------------------- filesystem
    'fs.openLocal': () => ctx.fs.openLocal(),
    'fs.openSftp': (hostId, sessionId) => ctx.fs.openSftp(hostId, sessionId),
    'fs.close': (fsId) => ctx.fs.close(fsId),
    'fs.list': (fsId, p) => ctx.fs.list(fsId, p),
    'fs.stat': (fsId, p) => ctx.fs.stat(fsId, p),
    'fs.realpath': (fsId, p) => ctx.fs.realpath(fsId, p),
    'fs.mkdir': (fsId, p) => ctx.fs.mkdir(fsId, p),
    'fs.newFile': (fsId, p) => ctx.fs.newFile(fsId, p),
    'fs.rename': (fsId, from, to) => ctx.fs.rename(fsId, from, to),
    'fs.remove': (fsId, paths) => ctx.fs.remove(fsId, paths),
    'fs.chmod': (fsId, p, mode, recursive) => ctx.fs.chmod(fsId, p, mode, recursive),
    'fs.readText': (fsId, p) => ctx.fs.readText(fsId, p),
    'fs.writeText': (fsId, p, content) => ctx.fs.writeText(fsId, p, content),
    'fs.editExternal': (fsId, p) => ctx.fs.editExternal(fsId, p),
    'fs.openLocalPath': async (p) => {
      const err = await platform.openPath(p)
      if (err) throw new Error(err)
    },

    // ---------------------------------------------------------------- transfers
    'transfer.enqueue': (req) => ctx.transfers.enqueue(req),
    'transfer.list': () => ctx.transfers.list(),
    'transfer.cancel': (id) => ctx.transfers.cancel(id),
    'transfer.retry': (id) => ctx.transfers.retry(id),
    'transfer.clear': () => ctx.transfers.clear(),

    // ---------------------------------------------------------------- port forwarding
    'forward.start': (ruleId) => ctx.forwards.start(ruleId),
    'forward.stop': (ruleId) => ctx.forwards.stop(ruleId),
    'forward.states': () => ctx.forwards.states(),

    // ---------------------------------------------------------------- history / known hosts
    'history.list': (limit) => ctx.history.list(limit),
    'history.clear': () => ctx.history.clear(),
    'knownHosts.importFile': async (p) => {
      const file = p || `${os.homedir()}/.ssh/known_hosts`
      if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`)
      return importKnownHosts(await fs.promises.readFile(file, 'utf8'), vault)
    },

    // ---------------------------------------------------------------- settings
    'settings.get': () => ctx.settings.get(),
    'settings.set': (patch) => ctx.settings.set(patch ?? {}),

    // ---------------------------------------------------------------- sync
    'sync.status': () => ctx.sync.getStatus(),
    'sync.getConfig': () => ctx.sync.getConfigMasked(),
    'sync.test': (cfg) => ctx.sync.test(cfg),
    'sync.create': (cfg, pw) => ctx.sync.create(cfg, String(pw)),
    'sync.join': (cfg, pw) => ctx.sync.join(cfg, String(pw)),
    'sync.unlock': (pw) => ctx.sync.unlock(String(pw)),
    'sync.now': () => ctx.sync.syncNow(),
    'sync.disconnect': () => ctx.sync.disconnect(),
    'sync.changePassword': (o, n) => ctx.sync.changePassword(String(o), String(n)),
    'sync.rotateKey': (pw) => ctx.sync.rotateKey(String(pw)),
    'sync.devices': () => ctx.sync.devices(),
    'sync.setIntervals': (iv) => ctx.sync.setIntervals(iv),

    // ---------------------------------------------------------------- import / export
    'import.sshConfigPreview': (p) => readSshConfig(p, vault),
    'import.sshConfigApply': (entries, groupName) => applySshConfig(entries, vault, groupName),
    'import.csv': async (p) => importHostsCsv(await fs.promises.readFile(p, 'utf8'), vault),
    'backup.export': (p, password) => exportBackup(vault, p, String(password)),
    'backup.import': (p, password) => importBackup(vault, p, String(password)),
    'export.hostsCsv': async (p) => {
      await fs.promises.writeFile(p, exportHostsCsv(vault), 'utf8')
      return vault.list('host').length
    },

    // ---------------------------------------------------------------- serial
    'serial.defaultProfile': () => defaultSerialProfile(),

    // ---------------------------------------------------------------- updates
    'update.check': () => ctx.updater.checkNow(),

    // ---------------------------------------------------------------- ai
    'ai.getConfigs': () => ctx.aiStore.summaries(),
    'ai.saveConfig': (config) => ctx.aiStore.save(config),
    'ai.removeConfig': (id) => ctx.aiStore.remove(id),
    'ai.testConfig': (config) => ctx.ai.testConfig(config),
    'ai.listModels': (config) => ctx.ai.listModels(config),
    'ai.chat': (req) => ctx.ai.chat(req),
    'ai.resolveConfirm': (confirmId, approve, autoRest) => ctx.ai.resolveConfirm(confirmId, approve, autoRest),
    'ai.abort': (conversationId) => ctx.ai.abort(conversationId)
  }
}
