import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendSpoken, pickRecorderType, transcribeClip } from './voice';

test('pickRecorderType: WebM/Opus first, Safari falls back to MP4, a throwing check is skipped', () => {
  assert.equal(pickRecorderType(() => true), 'audio/webm;codecs=opus');
  assert.equal(pickRecorderType((t) => t === 'audio/mp4'), 'audio/mp4');
  assert.equal(pickRecorderType(() => { throw new Error('no'); }), undefined);
});

test('appendSpoken: joins spoken text onto what is typed, ignores silence', () => {
  assert.equal(appendSpoken('', ' fix the hero '), 'fix the hero');
  assert.equal(appendSpoken('Madam Muse:  ', 'fix the hero'), 'Madam Muse: fix the hero');
  assert.equal(appendSpoken('keep this', '   '), 'keep this');
});

test('transcribeClip: text on success; readable errors for short clips, expired sessions and server errors', async () => {
  const clip = new Blob([new Uint8Array(5000)], { type: 'audio/webm' });
  const reply = (status: number, body: unknown, redirected = false) =>
    (async () => ({ ok: status < 300, status, redirected, json: async () => { if (body === null) throw new Error('html'); return body; } })) as unknown as typeof fetch;
  assert.deepEqual(await transcribeClip(clip, 'test', reply(200, { text: ' hello ' })), { ok: true, text: 'hello' });
  assert.match((await transcribeClip(new Blob([new Uint8Array(10)]), 'test', reply(200, { text: 'x' })) as { error: string }).error, /too short/);
  assert.match((await transcribeClip(clip, 'test', reply(200, null, true)) as { error: string }).error, /session expired/);
  assert.match((await transcribeClip(clip, 'test', reply(502, { error: 'No speech-to-text model available' })) as { error: string }).error, /No speech-to-text/);
  const offline = (async () => { throw new TypeError('network'); }) as unknown as typeof fetch;
  assert.match((await transcribeClip(clip, 'test', offline) as { error: string }).error, /Couldn’t reach/);
});
