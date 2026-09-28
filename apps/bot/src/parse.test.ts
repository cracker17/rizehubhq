import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAssign } from './parse';

const MON = new Date(2026, 8, 28); // Mon 28 Sep 2026

test('plain text', () => {
  assert.deepEqual(parseAssign('Write a blog post', MON), { text: 'Write a blog post', priority: 'normal', clientSlug: null, dueDate: null });
});
test('flags anywhere in the message', () => {
  const r = parseAssign('!urgent @madam-muse Bundle page due:fri with 3 ads', MON);
  assert.equal(r.priority, 'urgent'); assert.equal(r.clientSlug, 'madam-muse');
  assert.equal(r.dueDate, '2026-10-02'); assert.equal(r.text, 'Bundle page with 3 ads');
});
test('same weekday means next week', () => {
  assert.equal(parseAssign('x due:mon', MON).dueDate, '2026-10-05');
});
test('tomorrow and ISO dates', () => {
  assert.equal(parseAssign('x due:tomorrow', MON).dueDate, '2026-09-29');
  assert.equal(parseAssign('x due:2026-12-01', MON).dueDate, '2026-12-01');
});
test('emails are not client tags', () => {
  assert.equal(parseAssign('email ceo@x.com', MON).clientSlug, null);
});
