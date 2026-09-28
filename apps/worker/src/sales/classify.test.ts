import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyReply, heuristicClassify, isAutoReply, parseClassification, stripQuoted } from './classify';
import { mockModel, textResponse } from '../testing';
import type { PickModel, PickedModel } from '../models/usage';

function picker(model: ReturnType<typeof mockModel>): { pickModel: PickModel; roles: string[] } {
  const roles: string[] = [];
  const picked: PickedModel = { model, provider: 'google', modelId: 'mock-light', recordCall: () => 0.0001 };
  return { roles, pickModel: async (role) => { roles.push(role); return picked; } };
}

test('stripQuoted: drops quoted history, "On … wrote:", signatures and our own footer', () => {
  const text = [
    'Sounds good, can you send the list?',
    '',
    '--',
    'Ana, Biz 1',
    'On Mon, 28 Sep 2026 at 10:00, Julev <julev@getrizehub.test> wrote:',
    '> Hi Ana, your product page takes 6 s',
  ].join('\n');
  assert.equal(stripQuoted(text), 'Sounds good, can you send the list?');
  assert.equal(stripQuoted('Thanks!\nNot relevant? Reply "unsubscribe" and we won\'t email you again.'), 'Thanks!');
  assert.equal(stripQuoted('Yes\n> unsubscribe'), 'Yes', 'a quoted opt-out line is not theirs');
});

test('heuristic: opt-outs are "sure" (never need a model); other classes are guesses', () => {
  for (const s of ['Please unsubscribe me', 'remove us from your list', 'Stop emailing me', 'No', 'no thanks.', 'Do not contact us again']) {
    assert.deepEqual(heuristicClassify('Re: your site', s), { classification: 'unsubscribe', sure: true }, s);
  }
  assert.deepEqual(heuristicClassify('unsubscribe', ''), { classification: 'unsubscribe', sure: true }, 'subject alone');
  assert.deepEqual(heuristicClassify('Re', 'We already have an agency, not a fit for us.'), { classification: 'not_interested', sure: false });
  assert.deepEqual(heuristicClassify('Re', 'Maybe later, after the holidays.'), { classification: 'not_now', sure: false });
  assert.deepEqual(heuristicClassify('Re', 'How much would that cost?'), { classification: 'question', sure: false });
  assert.deepEqual(heuristicClassify('Re', 'Sounds good, let\'s talk'), { classification: 'interested', sure: false });
  assert.equal(heuristicClassify('Re', 'Received.'), null);
  // a quoted "unsubscribe" in our footer does not count as their opt-out
  assert.notEqual(heuristicClassify('Re', 'Keen to chat\n> Not relevant? Reply "unsubscribe"')?.classification, 'unsubscribe');
});

test('auto-replies: headers (Auto-Submitted, X-Autoreply, Precedence) and out-of-office subjects', () => {
  assert.equal(isAutoReply('Re: hi', { 'auto-submitted': 'auto-replied' }), true);
  assert.equal(isAutoReply('Re: hi', { 'auto-submitted': 'no' }), false);
  assert.equal(isAutoReply('Re: hi', { precedence: 'bulk' }), true);
  assert.equal(isAutoReply('Out of Office: back Monday'), true);
  assert.equal(isAutoReply('Automatic reply: Ana'), true);
  assert.equal(isAutoReply('Re: your mobile product page'), false);
});

test('parseClassification: JSON anywhere in the text, only known classes', () => {
  assert.deepEqual(parseClassification('```json\n{"classification":"Interested","reason":"wants a call"}\n```'), { classification: 'interested', reason: 'wants a call' });
  assert.equal(parseClassification('{"classification":"maybe"}'), null);
  assert.equal(parseClassification('not json'), null);
  assert.equal(parseClassification('{broken'), null);
});

test('classifyReply: an opt-out is decided without calling the model', async () => {
  const model = mockModel([textResponse('{"classification":"interested"}')]);
  const p = picker(model);
  const r = await classifyReply('Re: site', 'Please remove me from your list', { pickModel: p.pickModel });
  assert.deepEqual(r, { classification: 'unsubscribe', by: 'heuristic' });
  assert.equal(model.doGenerateCalls.length, 0);
});

test('classifyReply: other replies go to the "light" model through the router; usage is reported', async () => {
  const model = mockModel([textResponse('{"classification":"not_now","reason":"busy until Q1"}')]);
  const p = picker(model);
  const usage: unknown[] = [];
  const r = await classifyReply('Re: site', 'Busy right now, ping me in January?', { pickModel: p.pickModel, onUsage: (u) => usage.push(u) });
  assert.deepEqual(r, { classification: 'not_now', by: 'model', reason: 'busy until Q1' });
  assert.deepEqual(p.roles, ['light']);
  assert.equal(usage.length, 1);
  assert.equal((usage[0] as { modelId: string }).modelId, 'mock-light');
});

test('classifyReply: model failure or junk → keyword guess; nothing at all → "question" so a human looks', async () => {
  const logs: string[] = [];
  const down = picker(mockModel({ error: new Error('provider down') }));
  assert.deepEqual(await classifyReply('Re', 'How long would it take?', { pickModel: down.pickModel, log: (m) => logs.push(m) }), { classification: 'question', by: 'heuristic' });
  assert.match(logs.join(), /classifier model failed/);
  const junk = picker(mockModel([textResponse('I think they are interested')]));
  assert.deepEqual(await classifyReply('Re', 'Sounds good', { pickModel: junk.pickModel }), { classification: 'interested', by: 'heuristic' });
  assert.deepEqual(await classifyReply('Re', 'Received.'), { classification: 'question', by: 'heuristic' }, 'no model configured');
});
