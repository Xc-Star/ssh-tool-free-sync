import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { IPty } from 'node-pty'
import type { OpenLocalParams, ShellInfo } from '@shared/types'
import type { Emitter } from '../services/emitter'
import { BaseSession } from './base'

function findInPath(exe: string): string | undefined {
  const dirs = (process.env.PATH ?? '').split(path.delimiter)
  for (const d of dirs) {
    if (!d) continue
    const p = path.join(d, exe)
    try {
      if (fs.statSync(p).isFile()) return p
    } catch {
      // continue
    }
  }
  return undefined
}

function exists(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/** Shells available on this machine for local terminal tabs. */
export function detectShells(): ShellInfo[] {
  const out: ShellInfo[] = []
  if (process.platform === 'win32') {
    const sysRoot = process.env.SystemRoot ?? 'C:\\Windows'
    const pwsh = findInPath('pwsh.exe') ?? ['C:\\Program Files\\PowerShell\\7\\pwsh.exe'].find(exists)
    if (pwsh) out.push({ id: 'pwsh', label: 'PowerShell 7', path: pwsh, args: ['-NoLogo'] })
    const ps = path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    if (exists(ps)) out.push({ id: 'powershell', label: 'Windows PowerShell', path: ps, args: ['-NoLogo'] })
    const cmd = process.env.ComSpec ?? path.join(sysRoot, 'System32', 'cmd.exe')
    if (exists(cmd)) out.push({ id: 'cmd', label: 'Command Prompt', path: cmd, args: [] })
    const wsl = path.join(sysRoot, 'System32', 'wsl.exe')
    if (exists(wsl)) out.push({ id: 'wsl', label: 'WSL', path: wsl, args: [] })
    const gitBash = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'].find(exists)
    if (gitBash) out.push({ id: 'gitbash', label: 'Git Bash', path: gitBash, args: ['--login', '-i'] })
  } else {
    const loginArgs = process.platform === 'darwin' ? ['-l'] : []
    const candidates = [process.env.SHELL, '/bin/zsh', '/bin/bash', '/usr/bin/zsh', '/usr/bin/bash', '/usr/bin/fish', '/opt/homebrew/bin/fish', '/bin/sh']
    const seen = new Set<string>()
    for (const c of candidates) {
      if (!c || seen.has(c) || !exists(c)) continue
      seen.add(c)
      const name = path.basename(c)
      out.push({ id: name === path.basename(process.env.SHELL ?? '') && c === process.env.SHELL ? 'default' : name, label: name, path: c, args: name === 'sh' ? [] : loginArgs })
    }
  }
  return out
}

export class LocalSession extends BaseSession {
  private pty?: IPty

  constructor(
    id: string,
    private readonly params: OpenLocalParams,
    private readonly defaultShellId: string | undefined,
    emitter: Emitter
  ) {
    super(id, 'local', 'Local', emitter)
  }

  async start(): Promise<void> {
    this.setStatus('connecting')
    const shells = detectShells()
    const wanted = this.params.shellId ?? this.defaultShellId
    const shell = shells.find((s) => s.id === wanted) ?? shells[0]
    if (!shell) {
      this.setStatus('error', 'No shell found on this system')
      return
    }
    this.info.title = shell.label
    try {
      const pty = await import('node-pty')
      const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>
      delete env.ELECTRON_RUN_AS_NODE
      this.pty = pty.spawn(shell.path, shell.args, {
        name: 'xterm-256color',
        cols: this.params.cols,
        rows: this.params.rows,
        cwd: this.params.cwd && fs.existsSync(this.params.cwd) ? this.params.cwd : os.homedir(),
        env
      })
      this.pty.onData((d) => this.pump.push(d))
      this.pty.onExit(() => {
        if (this.disposed) return
        this.pump.flush()
        this.setStatus('disconnected')
      })
      this.setStatus('connected')
    } catch (err) {
      this.setStatus('error', `Failed to start ${shell.label}: ${(err as Error).message}`)
    }
  }

  write(data: string): void {
    if (this.info.status === 'connected') this.pty?.write(data)
  }

  resize(cols: number, rows: number): void {
    try {
      this.pty?.resize(Math.max(1, cols), Math.max(1, rows))
    } catch {
      // pty already exited
    }
  }

  protected pauseSource(): void {
    this.pty?.pause()
  }

  protected resumeSource(): void {
    this.pty?.resume()
  }

  protected teardown(): void {
    try {
      this.pty?.kill()
    } catch {
      // ignore
    }
    this.pty = undefined
  }
}
