import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fromPgBytea, loadKeyring, open, seal, toPgBytea, VaultConfigError, VaultDecryptError, type Keyring } from './crypto';

const K1 = randomBytes(32).toString('base64');
const K2 = randomBytes(32).toString('base64');
const ID = '6f1c2d3e-0000-4000-8000-000000000001';
const kr = (env: Record<string, string>) => loadKeyring(env) as Keyring;

test('seal → open round-trips; ciphertext never contains the plaintext; every seal is unique', () => {
  const k = kr({ VAULT_MASTER_KEY: K1 });
  const secret = 'shpat_demo_not_a_real_token_1234';
  const a = seal(secret, k, ID);
  const b = seal(secret, k, ID);
  assert.equal(open(a, k, ID), secret);
  assert.equal(a.keyVersion, 1);
  assert.equal(a.iv.length, 24);
  assert.ok(!a.cipher.includes(Buffer.from(secret)));
  assert.ok(!a.cipher.equals(b.cipher));
  assert.ok(!a.iv.equals(b.iv));
  assert.equal(open(seal('ünïcødé 🔐', k, ID), k, ID), 'ünïcødé 🔐');
});

test('any tampering is detected (every byte region of cipher and iv)', () => {
  const k = kr({ VAULT_MASTER_KEY: K1 });
  const s = seal('hunter2-demo', k, ID);
  for (const i of [0, 1, 20, 40, 49, s.cipher.length - 20, s.cipher.length - 1]) {
    const c = Buffer.from(s.cipher);
    c[i] = c[i]! ^ 0x01;
    assert.throws(() => open({ ...s, cipher: c }, k, ID), i === 0 ? VaultDecryptError : VaultDecryptError, `byte ${i}`);
  }
  for (const i of [0, 11, 12, 23]) {
    const iv = Buffer.from(s.iv);
    iv[i] = iv[i]! ^ 0x80;
    assert.throws(() => open({ ...s, iv }, k, ID), VaultDecryptError);
  }
  assert.throws(() => open({ ...s, cipher: s.cipher.subarray(0, 30) }, k, ID), VaultDecryptError);
});

test('wrong key, wrong credential id (row swap) and wrong key version all fail', () => {
  const s = seal('pw-demo', kr({ VAULT_MASTER_KEY: K1 }), ID);
  assert.throws(() => open(s, kr({ VAULT_MASTER_KEY: K2 }), ID), VaultDecryptError);
  assert.throws(() => open(s, kr({ VAULT_MASTER_KEY: K1 }), '6f1c2d3e-0000-4000-8000-000000000002'), VaultDecryptError);
  assert.throws(() => open({ ...s, keyVersion: 7 }, kr({ VAULT_MASTER_KEY: K1 }), ID), VaultConfigError);
});

test('rotation: new master key version seals new rows, old rows stay readable via VAULT_PREVIOUS_KEYS', () => {
  const old = seal('old-secret', kr({ VAULT_MASTER_KEY: K1 }), ID);
  const k2 = kr({ VAULT_MASTER_KEY: K2, VAULT_KEY_VERSION: '2', VAULT_PREVIOUS_KEYS: `1:${K1}` });
  assert.equal(open(old, k2, ID), 'old-secret');
  const fresh = seal('new-secret', k2, ID);
  assert.equal(fresh.keyVersion, 2);
  assert.throws(() => open(fresh, kr({ VAULT_MASTER_KEY: K1 }), ID), VaultConfigError);
  // a key re-labelled with the wrong version can't open it either (version is bound in the AAD)
  assert.throws(() => open({ ...old, keyVersion: 2 }, kr({ VAULT_MASTER_KEY: K1, VAULT_KEY_VERSION: '2' }), ID), VaultDecryptError);
});

test('loadKeyring: missing key → null, malformed keys are refused', () => {
  assert.equal(loadKeyring({}), null);
  assert.throws(() => loadKeyring({ VAULT_MASTER_KEY: 'too-short' }), VaultConfigError);
  assert.throws(() => loadKeyring({ VAULT_MASTER_KEY: K1, VAULT_KEY_VERSION: '0' }), VaultConfigError);
  assert.throws(() => loadKeyring({ VAULT_MASTER_KEY: K1, VAULT_PREVIOUS_KEYS: 'nope' }), VaultConfigError);
});

test('bytea helpers round-trip PostgREST hex strings', () => {
  const b = randomBytes(40);
  assert.ok(fromPgBytea(toPgBytea(b)).equals(b));
  assert.ok(fromPgBytea(new Uint8Array(b)).equals(b));
  assert.throws(() => fromPgBytea('plain'));
});
