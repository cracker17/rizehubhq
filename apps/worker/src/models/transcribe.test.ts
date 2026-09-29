import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { APICallError } from 'ai';
import { audioType, resetTranscribeBlocks, transcribeAudio, type CreateTranscriber } from './transcribe';
import { createTranscribeRoutes } from '../routes/transcribe';
import { createHttpServer } from '../http';

const cfg = { transcription: ['groq:whisper-large-v3-turbo', 'groq:whisper-large-v3'] };
const env = { GROQ_API_KEY: 'g' };
const audio = new Uint8Array(4000).fill(1);

function fakeCreate(behaviour: Record<string, 'ok' | 429 | 400>, seen: { model: string; mediaType: string }[]): CreateTranscriber {
  return async (c) => ({
    specificationVersion: 'v2', provider: c.provider, modelId: c.modelId,
    doGenerate: async (o: { mediaType: string }) => {
      seen.push({ model: c.modelId, mediaType: o.mediaType });
      const b = behaviour[c.modelId] ?? 'ok';
      if (b !== 'ok') throw new APICallError({ message: `HTTP ${b}`, url: 'x', requestBodyValues: {}, statusCode: b });
      return { text: ` hello from ${c.modelId} `, segments: [], language: 'en', durationInSeconds: 3, warnings: [], response: { timestamp: new Date(), modelId: c.modelId } };
    },
  }) as never;
}

test('audioType: browser recorder types with codecs are accepted, anything else refused', () => {
  assert.equal(audioType('audio/webm;codecs=opus'), 'audio/webm');
  assert.equal(audioType('audio/mp4'), 'audio/mp4');
  assert.equal(audioType('AUDIO/OGG; codecs=opus'), 'audio/ogg');
  assert.equal(audioType('video/webm'), null);
  assert.equal(audioType('application/json'), null);
  assert.equal(audioType(undefined), null);
});

test('transcribeAudio: passes the real media type; falls back when the first model is rate-limited', async () => {
  resetTranscribeBlocks();
  const seen: { model: string; mediaType: string }[] = [];
  const t = await transcribeAudio(audio, 'audio/webm', { cfg, env, create: fakeCreate({ 'whisper-large-v3-turbo': 429 }, seen) });
  assert.equal(t.text, 'hello from whisper-large-v3');
  assert.deepEqual(seen.map((s) => s.mediaType), ['audio/webm', 'audio/webm'], 'never relabelled as audio/wav');
  // The rate-limited model is skipped on the next call.
  seen.length = 0;
  await transcribeAudio(audio, 'audio/mp4', { cfg, env, create: fakeCreate({}, seen) });
  assert.deepEqual(seen.map((s) => s.model), ['whisper-large-v3']);
  resetTranscribeBlocks();
});

test('transcribeAudio: a non-quota error is reported, no key means a clear message', async () => {
  resetTranscribeBlocks();
  await assert.rejects(transcribeAudio(audio, 'audio/webm', { cfg, env, create: fakeCreate({ 'whisper-large-v3-turbo': 400 }, []) }), /HTTP 400/);
  await assert.rejects(transcribeAudio(audio, 'audio/webm', { cfg, env: {}, create: fakeCreate({}, []) }), /No speech-to-text model available.*no key/);
});

test('POST /transcribe: secret, audio type, size and limiter checks; returns the text and logs without it', async () => {
  const logged: unknown[] = [];
  let allowed = true;
  const routes = createTranscribeRoutes({
    secret: () => 's'.repeat(32),
    transcribe: async (_a, type) => ({ text: `ok ${type}`, language: 'en', seconds: 2, provider: 'groq', modelId: 'whisper-large-v3-turbo' }),
    log: async (t, source) => { logged.push({ model: t.modelId, source }); },
    allow: () => allowed,
  });
  const server = createHttpServer({ chat: async () => ({ answer: '' }), health: () => ({}) }, 's'.repeat(32), routes);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const post = (headers: Record<string, string>, body: Buffer) => new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const req = http.request({ port, host: '127.0.0.1', path: '/transcribe', method: 'POST', headers }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(d) }));
    });
    req.on('error', reject); req.end(body);
  });
  try {
    const clip = Buffer.alloc(200_000, 1); // bigger than the 16 KB limit of 'secret' routes
    assert.equal((await post({ 'content-type': 'audio/webm' }, clip)).status, 401);
    assert.equal((await post({ 'content-type': 'text/plain', 'x-hq-secret': 's'.repeat(32) }, clip)).status, 415);
    assert.equal((await post({ 'content-type': 'audio/webm', 'x-hq-secret': 's'.repeat(32) }, Buffer.alloc(10))).status, 400);
    const ok = await post({ 'content-type': 'audio/webm;codecs=opus', 'x-hq-secret': 's'.repeat(32), 'x-hq-source': 'agent-chat' }, clip);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.text, 'ok audio/webm');
    assert.deepEqual(logged, [{ model: 'whisper-large-v3-turbo', source: 'agent-chat' }]);
    allowed = false;
    assert.equal((await post({ 'content-type': 'audio/webm', 'x-hq-secret': 's'.repeat(32) }, clip)).status, 429);
  } finally {
    server.close();
  }
});
