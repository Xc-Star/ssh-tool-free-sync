import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { argon2id } from 'hash-wasm'

/** Argon2id parameters; m is in KiB. Stored next to every wrapped key so they can be raised later. */
export interface KdfParams {
  alg: 'argon2id'
  m: number
  t: number
  p: number
}

export const DEFAULT_KDF: KdfParams = { alg: 'argon2id', m: 65536, t: 3, p: 1 }

/** Fast parameters for unit tests only. */
export const TEST_KDF: KdfParams = { alg: 'argon2id', m: 1024, t: 1, p: 1 }

const FORMAT_VERSION = 1
const NONCE_LEN = 12
const TAG_LEN = 16
const KEYID_LEN = 4
const HEADER_LEN = 1 + KEYID_LEN + NONCE_LEN

export type DecryptFailure = 'wrong-key' | 'corrupt' | 'auth'

export class DecryptError extends Error {
  constructor(readonly reason: DecryptFailure) {
    super(`decrypt failed: ${reason}`)
    this.name = 'DecryptError'
  }
}

export function randomKey(): Buffer {
  return randomBytes(32)
}

/** 4-byte key identifier so payloads encrypted with another key are detected without trial decryption. */
export function keyId(key: Buffer): Buffer {
  return createHash('sha256').update('sshtool:key-id:').update(key).digest().subarray(0, KEYID_LEN)
}

/** AES-256-GCM. Layout: [version:1][keyId:4][nonce:12][ciphertext][tag:16]. */
export function encrypt(key: Buffer, plaintext: Buffer, aad: string): Buffer {
  const nonce = randomBytes(NONCE_LEN)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([Buffer.from([FORMAT_VERSION]), keyId(key), nonce, ct, cipher.getAuthTag()])
}

export function decrypt(key: Buffer, blob: Buffer, aad: string): Buffer {
  if (blob.length < HEADER_LEN + TAG_LEN || blob[0] !== FORMAT_VERSION) throw new DecryptError('corrupt')
  if (!blob.subarray(1, 1 + KEYID_LEN).equals(keyId(key))) throw new DecryptError('wrong-key')
  const nonce = blob.subarray(1 + KEYID_LEN, HEADER_LEN)
  const tag = blob.subarray(blob.length - TAG_LEN)
  const ct = blob.subarray(HEADER_LEN, blob.length - TAG_LEN)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAAD(Buffer.from(aad, 'utf8'))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ct), decipher.final()])
  } catch {
    throw new DecryptError('auth')
  }
}

export function encryptJson(key: Buffer, value: unknown, aad: string): Buffer {
  return encrypt(key, Buffer.from(JSON.stringify(value), 'utf8'), aad)
}

export function decryptJson<T>(key: Buffer, blob: Buffer, aad: string): T {
  const buf = decrypt(key, blob, aad)
  try {
    return JSON.parse(buf.toString('utf8')) as T
  } catch {
    throw new DecryptError('corrupt')
  }
}

export function isWrongKey(blob: Buffer, key: Buffer): boolean {
  return blob.length > 1 + KEYID_LEN && !blob.subarray(1, 1 + KEYID_LEN).equals(keyId(key))
}

export async function deriveKey(password: string, salt: Buffer, params: KdfParams = DEFAULT_KDF): Promise<Buffer> {
  if (params.alg !== 'argon2id') throw new Error(`Unsupported KDF: ${params.alg}`)
  const out = await argon2id({
    password: password.normalize('NFKC'),
    salt,
    parallelism: params.p,
    iterations: params.t,
    memorySize: params.m,
    hashLength: 32,
    outputType: 'binary'
  })
  return Buffer.from(out)
}

export interface WrappedKey {
  kdf: KdfParams
  /** base64 */
  salt: string
  /** base64 of encrypt(KEK, key) */
  wrapped: string
}

const WRAP_AAD = 'sshtool:wrapped-key:v1'

export async function wrapKey(key: Buffer, password: string, params: KdfParams = DEFAULT_KDF): Promise<WrappedKey> {
  const salt = randomBytes(16)
  const kek = await deriveKey(password, salt, params)
  return { kdf: params, salt: salt.toString('base64'), wrapped: encrypt(kek, key, WRAP_AAD).toString('base64') }
}

export function wrapKeyWithKek(key: Buffer, kek: Buffer, kdf: KdfParams, salt: string): WrappedKey {
  return { kdf, salt, wrapped: encrypt(kek, key, WRAP_AAD).toString('base64') }
}

/** Returns the key and the derived KEK; throws DecryptError when the password is wrong. */
export async function unwrapKey(w: WrappedKey, password: string): Promise<{ key: Buffer; kek: Buffer }> {
  const kek = await deriveKey(password, Buffer.from(w.salt, 'base64'), w.kdf)
  const key = decrypt(kek, Buffer.from(w.wrapped, 'base64'), WRAP_AAD)
  return { key, kek }
}
