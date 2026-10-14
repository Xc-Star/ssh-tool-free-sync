import { createHash } from 'node:crypto'
import { type ParsedKey, utils } from 'ssh2'
import type { KeyInfo } from '@shared/types'

export type KeyAlgorithm = 'ed25519' | 'rsa' | 'ecdsa'

export class KeyParseError extends Error {
  constructor(
    message: string,
    readonly needsPassphrase: boolean
  ) {
    super(message)
    this.name = 'KeyParseError'
  }
}

/** SHA256 fingerprint in OpenSSH format of a raw public key blob. */
export function fingerprintOf(blob: Buffer): string {
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`
}

/** Reads the key type (first SSH string) from a raw public key blob. */
export function keyTypeOf(blob: Buffer): string {
  if (blob.length < 4) return 'unknown'
  const len = blob.readUInt32BE(0)
  if (len <= 0 || len > 64 || blob.length < 4 + len) return 'unknown'
  return blob.subarray(4, 4 + len).toString('ascii')
}

function looksEncrypted(pem: string): boolean {
  if (/Proc-Type:\s*4,ENCRYPTED/i.test(pem) || /BEGIN ENCRYPTED PRIVATE KEY/.test(pem)) return true
  if (/Encryption:\s*(?!none)/i.test(pem)) return true
  const m = /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]+?)-----END OPENSSH PRIVATE KEY-----/.exec(pem)
  if (m) {
    try {
      const raw = Buffer.from(m[1].replace(/\s+/g, ''), 'base64')
      const magic = 'openssh-key-v1\0'
      if (raw.subarray(0, magic.length).toString('latin1') === magic) {
        const len = raw.readUInt32BE(magic.length)
        const cipher = raw.subarray(magic.length + 4, magic.length + 4 + len).toString('ascii')
        return cipher !== 'none'
      }
    } catch {
      return false
    }
  }
  return false
}

/** Parses a private key (OpenSSH, PEM or PuTTY PPK). Throws KeyParseError. */
export function parsePrivateKey(privateKey: string, passphrase?: string): ParsedKey {
  const text = privateKey.trim()
  if (!text) throw new KeyParseError('Empty private key', false)
  const encrypted = looksEncrypted(text)
  if (encrypted && !passphrase) throw new KeyParseError('The private key is encrypted. A passphrase is required.', true)
  const res = utils.parseKey(text, passphrase || undefined)
  const key = Array.isArray(res) ? res[0] : res
  if (key instanceof Error) {
    const msg = key.message || 'Invalid private key'
    const needs = /passphrase|decrypt|bad decrypt|encrypted/i.test(msg)
    throw new KeyParseError(needs ? 'Wrong passphrase or encrypted key.' : `Unsupported or invalid private key: ${msg}`, needs)
  }
  if (!key.isPrivateKey()) throw new KeyParseError('This is a public key. Paste the PRIVATE key instead.', false)
  return key
}

export function publicKeyLine(key: ParsedKey, comment?: string): string {
  const line = `${key.type} ${key.getPublicSSH().toString('base64')}`
  const c = comment ?? key.comment
  return c ? `${line} ${c}` : line
}

export function inspectKey(privateKey: string, passphrase?: string): KeyInfo {
  const encrypted = looksEncrypted(privateKey.trim())
  const key = parsePrivateKey(privateKey, passphrase)
  return {
    keyType: key.type,
    publicKey: publicKeyLine(key),
    fingerprint: fingerprintOf(key.getPublicSSH()),
    encrypted,
    comment: key.comment || undefined
  }
}

export function generateKey(opts: {
  type: KeyAlgorithm
  bits?: number
  passphrase?: string
  comment?: string
}): { privateKey: string; publicKey: string } {
  const common = {
    comment: opts.comment ?? '',
    ...(opts.passphrase ? { passphrase: opts.passphrase, cipher: 'aes256-ctr', rounds: 16 } : {})
  }
  let pair: { private: string; public: string }
  if (opts.type === 'rsa') {
    const bits = opts.bits && [2048, 3072, 4096].includes(opts.bits) ? opts.bits : 4096
    pair = utils.generateKeyPairSync('rsa', { bits, ...common })
  } else if (opts.type === 'ecdsa') {
    const bits = (opts.bits && [256, 384, 521].includes(opts.bits) ? opts.bits : 256) as 256 | 384 | 521
    pair = utils.generateKeyPairSync('ecdsa', { bits, ...common })
  } else {
    // ssh2 strips a leading 0x00 byte from the 32-byte Ed25519 public key (1 key in 256), producing a key
    // that neither ssh2 nor OpenSSH can load. Generate such keys again.
    pair = utils.generateKeyPairSync('ed25519', common)
    for (let i = 0; i < 16 && !isValidEd25519Public(pair.public); i++) pair = utils.generateKeyPairSync('ed25519', common)
    if (!isValidEd25519Public(pair.public)) throw new Error('Failed to generate an Ed25519 key')
  }
  return { privateKey: pair.private, publicKey: pair.public.trim() }
}

/** string "ssh-ed25519" + string <32-byte key> = 51 bytes. */
function isValidEd25519Public(line: string): boolean {
  return Buffer.from(line.trim().split(/\s+/)[1] ?? '', 'base64').length === 51
}

/** Parses an OpenSSH public key line ("type base64 [comment]"). */
export function parsePublicKeyLine(line: string): { type: string; blob: Buffer; comment: string } | null {
  const m = /^\s*(\S+)\s+([A-Za-z0-9+/=]+)(?:\s+(.*))?$/.exec(line)
  if (!m) return null
  return { type: m[1], blob: Buffer.from(m[2], 'base64'), comment: (m[3] ?? '').trim() }
}
