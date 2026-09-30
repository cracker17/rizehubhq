import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findSecret } from './secretScan';

// Built at runtime so this file itself never looks like it holds a secret.
const r = (n: number, c = 'a1B2') => c.repeat(Math.ceil(n / c.length)).slice(0, n);

test('every vault sync pattern is caught', () => {
  const samples: Array<[string, string]> = [
    ['anthropic-key', `key sk-ant-${r(30)}`],
    ['openai-key', `sk-proj-${r(40)}`],
    ['github-token', `ghp_${r(36)}`],
    ['github-pat', `github_pat_${r(40)}`],
    ['github-oauth', `gho_${r(36)}`],
    ['aws-key', `AKIA${'ABCDEFGHIJKLMNOP'}`],
    ['slack-token', `xoxb-${r(20)}`],
    ['private-key', `-----BEGIN OPENSSH ${'PRIVATE'} KEY-----`],
    ['jwt', `eyJhbGciOi${r(24)}.${r(24)}.sig`],
    ['google-api-key', `AIza${r(35)}`],
    ['telegram-bot-token', `123456789:${r(35)}`],
    ['assigned-secret', `api_key = "${r(24)}"`],
    ['assigned-secret', `PASSWORD: ${r(20)}`],
  ];
  for (const [name, text] of samples) assert.equal(findSecret(text), name, text);
});

test('pointers to secrets and ordinary prose pass', () => {
  for (const text of [
    'Supabase service key: in Hostinger /home/rizehq/rizehub-hq/.env',
    'VAULT_MASTER_KEY lives in /home/rizehq/rizehub-hq/.env - keep it in a password manager, never in this vault.',
    'Admin nav, /admin/security password change + turn-off 2FA, forgot-password flow',
    'OPENAI_API_KEY lives in the VPS .env / HQ API & AI panel, never here.',
    'secret: in the HQ Vault',
    'commit 871899d and ref vkhpjofrpesdpwpemkga',
  ]) assert.equal(findSecret(text), null, text);
});
