import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callbackData, parseCallback } from './callbacks';
import { approvalKeyboard, approvalUrl, decidedKeyboard, isPublicUrl } from './keyboard';
import { loadBotConfig, parseAllowed } from './env';

const ID = '5b3a9d0e-1c2f-4a7b-9e8d-0f1a2b3c4d5e';

test('callback data round-trips and stays under Telegram\'s 64-byte limit', () => {
  for (const a of ['approve', 'changes', 'reject'] as const) {
    const d = callbackData(ID, a);
    assert.ok(Buffer.byteLength(d) <= 64);
    assert.deepEqual(parseCallback(d), { approvalId: ID, action: a });
  }
});

test('bad callback data is ignored', () => {
  for (const d of [undefined, '', 'ap:123:approve', `ap:${ID}:delete`, `xx:${ID}:approve`, `ap:${ID}:approve:extra`]) assert.equal(parseCallback(d), null);
});

test('approval keyboard: Approve / Changes / Reject / Open with deep link', () => {
  const k = approvalKeyboard(ID, 'https://hq.rizehub.ph/');
  assert.deepEqual(k.inline_keyboard, [[
    { text: '✅ Approve', callback_data: `ap:${ID}:approve` },
    { text: '✏️ Changes', callback_data: `ap:${ID}:changes` },
    { text: '❌ Reject', callback_data: `ap:${ID}:reject` },
    { text: '🔗 Open', url: `https://hq.rizehub.ph/approvals?id=${ID}` },
  ]]);
  assert.equal(approvalKeyboard(ID, 'https://hq.rizehub.ph', { changesLabel: '✏️ Answer' }).inline_keyboard[0]![1]!.text, '✏️ Answer');
});

test('Open is dropped for localhost dashboards (Telegram rejects those URLs)', () => {
  assert.equal(isPublicUrl('http://localhost:3000/approvals'), false);
  assert.equal(isPublicUrl('http://127.0.0.1:3000'), false);
  assert.equal(isPublicUrl('https://hq.rizehub.ph'), true);
  assert.equal(approvalKeyboard(ID, 'http://localhost:3000').inline_keyboard[0]!.length, 3);
  assert.deepEqual(decidedKeyboard(ID, 'http://localhost:3000'), { inline_keyboard: [] });
  assert.deepEqual(decidedKeyboard(ID, 'https://hq.rizehub.ph'), { inline_keyboard: [[{ text: '🔗 Open', url: approvalUrl('https://hq.rizehub.ph', ID) }]] });
});

test('config: whitelist parsing, notify chat defaults to the first user', () => {
  assert.deepEqual(parseAllowed(' 123, abc, 456 ,,0'), [123, 456]);
  const c = loadBotConfig({ TELEGRAM_BOT_TOKEN: 't', TELEGRAM_ALLOWED_USER_IDS: '111,222', DASHBOARD_URL: 'https://hq.x.ph/' });
  assert.equal(c.notifyChatId, 111);
  assert.equal(c.dashboardUrl, 'https://hq.x.ph');
  assert.equal(c.pollMs, 5000);
  assert.equal(c.monthlyBudgetUsd, null);
  assert.equal(loadBotConfig({ TELEGRAM_BOT_TOKEN: 't', TELEGRAM_ALLOWED_USER_IDS: '111', TELEGRAM_NOTIFY_CHAT_ID: '-100200', MONTHLY_BUDGET_USD: '25' }).notifyChatId, -100200);
  assert.throws(() => loadBotConfig({ TELEGRAM_BOT_TOKEN: 't' }), /ALLOWED/);
  assert.throws(() => loadBotConfig({ TELEGRAM_ALLOWED_USER_IDS: '1' }), /TOKEN/);
});
