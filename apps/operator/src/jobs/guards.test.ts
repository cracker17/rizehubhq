import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkBrowseUrl, isMessagingUrl, needsApproval, riskyClick, riskyKey, secretField, submitAllowed } from './guards';

test('risky clicks: publish / send / delete / submit need the CEO; navigation and drafts do not', () => {
  for (const label of ['Publish', 'Publish to selected domains', 'Send', 'Delete item', 'Remove member', 'Place order', 'Invite people', 'Archive', 'Confirm', 'Go live'])
    assert.ok(riskyClick({ label, tag: 'button' }), label);
  for (const label of ['Edit', 'Preview', 'Cancel', 'Search', 'Save draft', 'Pages', 'Open settings', 'Team bios', 'Next'])
    assert.equal(riskyClick({ label, tag: 'button', type: 'button' }), null, label);
  assert.match(riskyClick({ label: '', tag: 'button', type: 'submit' })!, /no label/);
  assert.match(riskyClick({ label: 'Go', tag: 'button', inForm: true })!, /form submit/);
  assert.equal(riskyClick({ label: 'Go', tag: 'button', type: 'button', inForm: true }), null, 'type=button never submits');
  assert.ok(riskyClick({ label: '', tag: 'input', type: 'submit' }));
  assert.equal(riskyClick({ label: 'Collections', tag: 'a' }), null);
});

test('Enter is risky only where it posts a message', () => {
  assert.ok(riskyKey('https://chat.google.com/room/AAQA', 'Enter'));
  assert.ok(riskyKey('https://mail.google.com/mail/u/0/#inbox', 'Control+Enter'));
  assert.ok(riskyKey('https://app.slack.com/client/T1', 'Enter'));
  assert.equal(riskyKey('https://webflow.com/design/site', 'Enter'), null);
  assert.equal(riskyKey('https://chat.google.com/room/AAQA', 'Escape'), null);
  assert.equal(isMessagingUrl('https://lvlup.example/chat'), false);
});

test('password and code fields are never typed into; Enter only submits search boxes', () => {
  assert.equal(secretField({ tag: 'input', type: 'password' }), true);
  assert.equal(secretField({ tag: 'input', type: 'text', autocomplete: 'one-time-code' }), true);
  assert.equal(secretField({ tag: 'input', type: 'text', placeholder: 'Enter your API key' }), true);
  assert.equal(secretField({ tag: 'input', type: 'text', name: 'bio' }), false);
  assert.equal(submitAllowed({ tag: 'input', type: 'search' }), true);
  assert.equal(submitAllowed({ tag: 'input', type: 'text', placeholder: 'Search items' }), true);
  assert.equal(submitAllowed({ tag: 'input', type: 'email', name: 'email' }), false);
});

test('browse URLs: public http(s) only', () => {
  assert.equal(checkBrowseUrl('https://lvlup.example/team').hostname, 'lvlup.example');
  for (const bad of ['http://ws-lvlup:9223/json', 'http://127.0.0.1:3000', 'http://169.254.169.254/latest', 'file:///etc/passwd',
    'javascript:alert(1)', 'https://user:pw@example.com', 'http://supabase-kong:8000'])
    assert.throws(() => checkBrowseUrl(bad), bad);
});

test('the refusal tells the model exactly what to propose', () => {
  const t = needsApproval('"Publish" (publish)', { url: 'https://webflow.com/design/x', selector: 'button', text: 'Publish' });
  assert.match(t, /request_action\(\{ kind: "browser_click"/);
  assert.match(t, /"text":"Publish"/);
});
