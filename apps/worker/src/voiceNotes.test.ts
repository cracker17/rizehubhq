import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeBytea, startVoiceNotes, voiceMediaType, voiceNotesTick, type VoiceNoteDeps, type VoiceNoteJob } from './voiceNotes';
import type { Transcript } from './models/transcribe';

const clip = (id: string, mediaType = 'audio/ogg', bytes = 3000): VoiceNoteJob => ({ id, audio: new Uint8Array(bytes).fill(1), mediaType });
const transcript = (text: string): Transcript => ({ text, language: 'en', seconds: 4.2, provider: 'groq', modelId: 'whisper-large-v3-turbo' });

function fake(queue: VoiceNoteJob[], transcribe: VoiceNoteDeps['transcribe']) {
  const finished: { id: string; text: string | null; error: string | null; seconds: number | null }[] = [];
  const logged: Transcript[] = [];
  const seen: string[] = [];
  const warnings: string[] = [];
  const d: VoiceNoteDeps = {
    claim: async () => queue.shift() ?? null,
    finish: async (id, r) => { finished.push({ id, ...r }); },
    transcribe: async (audio, type) => { seen.push(type); return transcribe(audio, type); },
    log: async (t) => { logged.push(t); },
    warn: (m) => warnings.push(m),
  };
  return { d, finished, logged, seen, warnings };
}

test('voiceMediaType: Telegram voice (ogg/opus) and common audio-file types map to what the transcriber accepts', () => {
  assert.equal(voiceMediaType('audio/ogg'), 'audio/ogg');
  assert.equal(voiceMediaType('audio/ogg; codecs=opus'), 'audio/ogg');
  assert.equal(voiceMediaType('audio/opus'), 'audio/ogg');
  assert.equal(voiceMediaType('audio/mpeg'), 'audio/mpeg');
  assert.equal(voiceMediaType('audio/mp3'), 'audio/mpeg');
  assert.equal(voiceMediaType('audio/mp4'), 'audio/mp4');
  assert.equal(voiceMediaType('audio/x-m4a'), 'audio/x-m4a');
  assert.equal(voiceMediaType('AUDIO/AAC'), 'audio/aac');
  assert.equal(voiceMediaType('audio/midi'), null);
  assert.equal(voiceMediaType('video/mp4'), null);
  assert.equal(voiceMediaType(null), null);
});

test('tick: claims each waiting clip, transcribes it with its media type, finishes it and logs usage (no text)', async () => {
  const f = fake([clip('a'), clip('b', 'audio/mp3')], async () => transcript('Write a blog post'));
  assert.equal(await voiceNotesTick(f.d), 2);
  assert.deepEqual(f.seen, ['audio/ogg', 'audio/mpeg']);
  assert.deepEqual(f.finished, [
    { id: 'a', text: 'Write a blog post', error: null, seconds: 4.2 },
    { id: 'b', text: 'Write a blog post', error: null, seconds: 4.2 }]);
  assert.equal(f.logged.length, 2);
  assert.equal(await voiceNotesTick(f.d), 0, 'nothing left');
});

test('tick: a transcription error, an empty transcript and an unsupported type finish the clip as failed', async () => {
  let n = 0;
  const f = fake([clip('boom'), clip('silent'), clip('midi', 'audio/midi'), clip('empty', 'audio/ogg', 0)], async () => {
    if (n++ === 0) throw new Error('No speech-to-text model available (config/models.yaml transcription): groq:whisper-large-v3-turbo: no key');
    return transcript('');
  });
  assert.equal(await voiceNotesTick(f.d), 4);
  assert.match(f.finished[0]!.error!, /No speech-to-text model available/);
  assert.equal(f.finished[0]!.text, null);
  assert.deepEqual(f.finished[1], { id: 'silent', text: null, error: 'no words were recognised', seconds: 4.2 });
  assert.match(f.finished[2]!.error!, /unsupported audio format \(audio\/midi\)/);
  assert.match(f.finished[3]!.error!, /empty or larger than 8 MB/);
  assert.deepEqual(f.seen, ['audio/ogg', 'audio/ogg'], 'unsupported / empty clips never reach the model');
  assert.equal(f.logged.length, 1, 'only real transcriptions are logged');
  assert.equal(f.warnings.length, 1);
});

test('tick: at most `max` clips per tick; a failing log never blocks finishing', async () => {
  const f = fake([clip('1'), clip('2'), clip('3')], async () => transcript('hi'));
  f.d.log = async () => { throw new Error('db down'); };
  assert.equal(await voiceNotesTick(f.d, 2), 2);
  assert.equal(f.finished.length, 2);
  assert.equal(await voiceNotesTick(f.d, 2), 1);
});

test('poller: runs every interval, never overlaps, and stops when cleared', async () => {
  let claims = 0; let inFlight = 0; let maxInFlight = 0;
  const t = startVoiceNotes({
    claim: async () => { claims++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise((r) => setTimeout(r, 25)); inFlight--; return null; },
    finish: async () => {}, transcribe: async () => transcript('x'),
  }, 5);
  await new Promise((r) => setTimeout(r, 80));
  clearInterval(t);
  const after = claims;
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(after >= 2, `polled ${after} times`);
  assert.equal(maxInFlight, 1);
  assert.ok(claims <= after + 1);
});

test('decodeBytea: PostgREST hex and base64', () => {
  assert.deepEqual([...decodeBytea('\\x010203')], [1, 2, 3]);
  assert.deepEqual([...decodeBytea(Buffer.from([4, 5]).toString('base64'))], [4, 5]);
  assert.equal(decodeBytea(null).length, 0);
});
