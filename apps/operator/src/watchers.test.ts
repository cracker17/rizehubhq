import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMe, normalizeMessages, parseTimestamp } from './browser/chatDom';
import { isSignedOut, watchSelectors, WATCH_SELECTORS } from './browser/watchers';
import { loadOperatorConfig } from './config';

test('watchers: per-kind selectors with env overrides (known keys, non-empty only)', () => {
  const s = watchSelectors('slack', { message: ' .msg ', bogus: 'x', text: '' } as Record<string, string>);
  assert.equal(s.message, '.msg');
  assert.equal(s.text, WATCH_SELECTORS.slack.text);
  assert.equal((s as unknown as Record<string, string>).bogus, undefined);
  assert.equal(watchSelectors('gmail').newestFirst, '1', 'Gmail lists newest first; the extractor reverses it');
  const cfg = loadOperatorConfig({ OPERATOR_SLACK_SELECTORS: '{"message":"div.m"}' });
  assert.deepEqual(cfg.watchOverrides.slack, { message: 'div.m' });
  assert.deepEqual(cfg.watchOverrides.gmail, {});
  assert.throws(() => loadOperatorConfig({ OPERATOR_TEAMS_SELECTORS: '[1]' }), /OPERATOR_TEAMS_SELECTORS must be a JSON object/);
});

test('watchers: signed-out pages per app', () => {
  assert.equal(isSignedOut('slack', 'https://lvlup.slack.com/signin?redir=%2Fclient'), true);
  assert.equal(isSignedOut('slack', 'https://app.slack.com/client/T01/C02'), false);
  assert.equal(isSignedOut('teams', 'https://login.microsoftonline.com/common/oauth2/authorize'), true);
  assert.equal(isSignedOut('teams', 'https://teams.microsoft.com/v2/'), false);
  assert.equal(isSignedOut('gmail', 'https://accounts.google.com/v3/signin/identifier'), true);
  assert.equal(isSignedOut('gmail', 'https://mail.google.com/mail/u/0/#label/LvlUp'), false);
});

test('watchers: Slack timestamps, Gmail "me", Gmail rows keyed by last message id', () => {
  assert.equal(parseTimestamp('1760500000.123456'), new Date(1760500000123).toISOString());
  assert.equal(parseTimestamp('1760500000'), new Date(1760500000000).toISOString(), 'plain seconds unchanged');
  assert.equal(isMe('me', ['Julev']), true);
  const msgs = normalizeMessages([
    { id: '18f1a', sender: 'Alex Kim', ts: 'Oct 15, 2026, 9:12 AM', text: 'Team page - Can you add Sam?', thread: '' },
    { id: '18f1b', sender: 'me', ts: 'Oct 15, 2026, 9:20 AM', text: 'Re: Team page - On it', thread: '' },
  ], ['Julev']);
  assert.deepEqual(msgs.map((m) => [m.external_id, m.from_me]), [['18f1a', false], ['18f1b', true]]);
  assert.ok(msgs[0]!.sent_at?.startsWith('2026-10-15'));
});

test('gmail rows carry the sender address for the email target list', () => {
  const [m] = normalizeMessages([{ id: '18a', sender: 'Alex Kim', ts: '', text: 'Invoice', thread: 't1', senderEmail: ' Alex@LvlUp.vc ' }], ['Julev']);
  assert.equal(m!.sender_email, 'alex@lvlup.vc');
  assert.equal(watchSelectors('gmail').senderEmailAttr, 'email');
});
