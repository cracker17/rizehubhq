// Client Vault encryption (docs/09 "Client Vault"). AES-256-GCM envelope encryption:
// every secret gets a fresh random data key (DEK); the DEK is wrapped with the master key (KEK)
// VAULT_MASTER_KEY, which exists only in the worker's env. The database only ever sees ciphertext.
//
// Stored layout (client_credentials):
//   secret_cipher = FORMAT(1) | wrappedDek(32) | wrapTag(16) | dataCipher(n) | dataTag(16)
//   secret_iv     = wrapIv(12) | dataIv(12)
//   key_version   = which master key wrapped the DEK (rotation: add a new key, keep old ones for reading)
// Both layers are bound to the credential id (AAD), so ciphertext can't be swapped between rows.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const FORMAT = 1;
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;

export interface Keyring {
  /** Version used for new encryptions. */
  current: number;
  keys: ReadonlyMap<number, Buffer>;
}

export interface Sealed { cipher: Buffer; iv: Buffer; keyVersion: number }

export class VaultConfigError extends Error {}
export class VaultDecryptError extends Error {
  constructor() { super('vault: could not decrypt (wrong key or tampered ciphertext)'); }
}

function decodeKey(b64: string, what: string): Buffer {
  const key = Buffer.from(b64.trim(), 'base64');
  if (key.length !== KEY_LEN) throw new VaultConfigError(`${what} must be base64 of exactly 32 bytes (openssl rand -base64 32)`);
  return key;
}

/**
 * VAULT_MASTER_KEY (current key, version VAULT_KEY_VERSION, default 1) and optionally
 * VAULT_PREVIOUS_KEYS="1:<base64>,2:<base64>" so rows wrapped with an older key stay readable after rotation.
 * Returns null when VAULT_MASTER_KEY is not set.
 */
export function loadKeyring(env: Record<string, string | undefined> = process.env): Keyring | null {
  const master = env.VAULT_MASTER_KEY?.trim();
  if (!master) return null;
  const current = env.VAULT_KEY_VERSION?.trim() ? Number(env.VAULT_KEY_VERSION) : 1;
  if (!Number.isInteger(current) || current < 1) throw new VaultConfigError('VAULT_KEY_VERSION must be a positive integer');
  const keys = new Map<number, Buffer>();
  for (const part of (env.VAULT_PREVIOUS_KEYS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = part.indexOf(':');
    const v = Number(part.slice(0, i));
    if (i < 1 || !Number.isInteger(v) || v < 1) throw new VaultConfigError('VAULT_PREVIOUS_KEYS must look like "1:<base64>,2:<base64>"');
    keys.set(v, decodeKey(part.slice(i + 1), `VAULT_PREVIOUS_KEYS version ${v}`));
  }
  keys.set(current, decodeKey(master, 'VAULT_MASTER_KEY'));
  return { current, keys };
}

function aadFor(context: string, version: number): Buffer {
  return Buffer.from(`rizehub-vault|f${FORMAT}|k${version}|${context}`, 'utf8');
}

function gcmEncrypt(key: Buffer, iv: Buffer, plain: Buffer, aad: Buffer): { ct: Buffer; tag: Buffer } {
  const c = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN });
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return { ct, tag: c.getAuthTag() };
}

function gcmDecrypt(key: Buffer, iv: Buffer, ct: Buffer, tag: Buffer, aad: Buffer): Buffer {
  const d = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN });
  d.setAAD(aad);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

/** Encrypts `plaintext` for the credential identified by `context` (its id). */
export function seal(plaintext: string, kr: Keyring, context: string): Sealed {
  if (!context) throw new Error('vault: seal needs a context (credential id)');
  const kek = kr.keys.get(kr.current);
  if (!kek) throw new VaultConfigError(`no key for version ${kr.current}`);
  const aad = aadFor(context, kr.current);
  const dek = randomBytes(KEY_LEN);
  const wrapIv = randomBytes(IV_LEN);
  const dataIv = randomBytes(IV_LEN);
  const plain = Buffer.from(plaintext, 'utf8');
  try {
    const wrapped = gcmEncrypt(kek, wrapIv, dek, aad);
    const data = gcmEncrypt(dek, dataIv, plain, aad);
    return {
      cipher: Buffer.concat([Buffer.from([FORMAT]), wrapped.ct, wrapped.tag, data.ct, data.tag]),
      iv: Buffer.concat([wrapIv, dataIv]),
      keyVersion: kr.current,
    };
  } finally {
    dek.fill(0);
    plain.fill(0);
  }
}

/** Decrypts; throws VaultDecryptError on a wrong key, wrong context or any tampering. */
export function open(s: Sealed, kr: Keyring, context: string): string {
  const kek = kr.keys.get(s.keyVersion);
  if (!kek) throw new VaultConfigError(`vault: no master key for key_version ${s.keyVersion} (set VAULT_PREVIOUS_KEYS)`);
  const min = 1 + KEY_LEN + TAG_LEN + TAG_LEN;
  if (s.cipher.length < min || s.cipher[0] !== FORMAT || s.iv.length !== IV_LEN * 2) throw new VaultDecryptError();
  const aad = aadFor(context, s.keyVersion);
  let dek: Buffer | null = null;
  try {
    dek = gcmDecrypt(kek, s.iv.subarray(0, IV_LEN), s.cipher.subarray(1, 1 + KEY_LEN), s.cipher.subarray(1 + KEY_LEN, 1 + KEY_LEN + TAG_LEN), aad);
    const body = s.cipher.subarray(1 + KEY_LEN + TAG_LEN);
    const plain = gcmDecrypt(dek, s.iv.subarray(IV_LEN), body.subarray(0, body.length - TAG_LEN), body.subarray(body.length - TAG_LEN), aad);
    const out = plain.toString('utf8');
    plain.fill(0);
    return out;
  } catch (e) {
    if (e instanceof VaultConfigError) throw e;
    throw new VaultDecryptError();
  } finally {
    dek?.fill(0);
  }
}

/** Postgres bytea over PostgREST: '\x0a0b…' hex strings in both directions. */
export function toPgBytea(b: Buffer): string {
  return `\\x${b.toString('hex')}`;
}
export function fromPgBytea(v: unknown): Buffer {
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (typeof v === 'string' && v.startsWith('\\x')) return Buffer.from(v.slice(2), 'hex');
  throw new Error('vault: unexpected bytea value');
}
