import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkVoice, handleVoice, MAX_VOICE_BYTES, telegramDownloader, waitForTranscript, type FetchLike, type VoiceDeps } from './voice';
import { processText, type ChatIO, type IntakeDeps } from './intake';
import { onButton, type DecisionDeps } from './decisions';
import { PendingNotes } from './pending';
import { approval, FakeBotDb } from './fakeBotDb';
import type { VoiceNoteState } from './types';

const names = () => new Map([['writer', 'Content Writer']]);
const noSleep = async () => {};

function setup(o: { download?: (id: string) => Promise<Uint8Array> } = {}) {
  const db = new FakeBotDb();
  const decisions: DecisionDeps = { db, pending: new PendingNotes(), names, dashboardUrl: 'https://hq.rizehub.ph', tz: () => 'Asia/Manila' };
  const edits: { chatId: number; messageId: number; text: string }[] = [];
  const intake: IntakeDeps = { decisions, db, tz: () => 'Asia/Manila', edit: async (chatId, messageId, text) => { edits.push({ chatId, messageId, text }); } };
  const downloads: string[] = [];
  const d: VoiceDeps = {
    ...intake,
    download: o.download ?? (async (id) => { downloads.push(id); return new Uint8Array(4000).fill(7); }),
    wait: { intervalMs: 1500, timeoutMs: 60_000, sleep: noSleep },
  };
  const replies: string[] = [];
  let deleted = 0;
  const io: ChatIO = { reply: async (t) => { replies.push(t); }, deleteMine: async () => { deleted++; } };
  return { db, d, intake, io, replies, edits, downloads, deleted: () => deleted };
}

/** Plays the worker: finish the (only) voice note on the given poll. */
function workerFinishes(db: FakeBotDb, onPoll: number, outcome: Partial<VoiceNoteState>) {
  db.onVoicePoll = (id, poll) => {
    const v = db.voiceNotes.get(id)!;
    if (poll === 1) v.status = 'working';
    if (poll === onPoll) Object.assign(v, { status: 'done', text: null, error: null, audioCleared: true }, outcome);
  };
}

// ---------- guard ----------
test('voice guard: size, length and type are checked before anything is downloaded', () => {
  assert.deepEqual(checkVoice({ kind: 'voice', fileId: 'f', fileSize: 30_000, duration: 12, mimeType: 'audio/ogg' }), { ok: true, mediaType: 'audio/ogg' });
  assert.deepEqual(checkVoice({ kind: 'voice', fileId: 'f' }), { ok: true, mediaType: 'audio/ogg' }, 'voice notes default to ogg/opus');
  assert.deepEqual(checkVoice({ kind: 'audio', fileId: 'f', mimeType: 'Audio/MPEG; charset=x', duration: 120 }), { ok: true, mediaType: 'audio/mpeg' }, 'exactly 2 minutes is fine');
  const big = checkVoice({ kind: 'audio', fileId: 'f', fileSize: MAX_VOICE_BYTES + 1 });
  assert.equal(big.ok, false);
  assert.match(!big.ok ? big.reply : '', /8\.0 MB.*up to 8 MB/);
  const long = checkVoice({ kind: 'voice', fileId: 'f', duration: 150 });
  assert.match(!long.ok ? long.reply : '', /2 min 30 s long.*under 2 minutes/);
  assert.equal(checkVoice({ kind: 'audio', fileId: 'f', mimeType: 'video/mp4' }).ok, false);
  assert.equal(checkVoice({ kind: 'audio', fileId: 'f' }).ok, false, 'an audio file with no type is refused');
});

// ---------- polling ----------
test('polling: returns the transcript once the worker is done', async () => {
  const states: (VoiceNoteState | Error)[] = [
    { status: 'pending', text: null, error: null }, new Error('network blip'), { status: 'working', text: null, error: null },
    { status: 'done', text: '  Write a blog post  ', error: null }];
  let i = 0; const sleeps: number[] = [];
  const out = await waitForTranscript(async () => { const s = states[i++]!; if (s instanceof Error) throw s; return s; },
    { sleep: async (ms) => { sleeps.push(ms); } });
  assert.deepEqual(out, { status: 'done', text: 'Write a blog post' });
  assert.deepEqual(sleeps, [1500, 1500, 1500, 1500], 'every 1.5 s; a failed read is retried');
});

test('polling: gives up after 60 s', async () => {
  let t = 0; let polls = 0;
  const out = await waitForTranscript(async () => { polls++; return { status: 'pending', text: null, error: null }; },
    { sleep: async (ms) => { t += ms; }, now: () => t });
  assert.deepEqual(out, { status: 'timeout' });
  assert.equal(polls, 40, '60 s / 1.5 s');
});

test('polling: a failed row, an empty transcript and a missing row are failures', async () => {
  assert.deepEqual(await waitForTranscript(async () => ({ status: 'failed', text: null, error: 'No speech-to-text model available' }), { sleep: noSleep }),
    { status: 'failed', error: 'No speech-to-text model available' });
  assert.deepEqual(await waitForTranscript(async () => ({ status: 'done', text: '  ', error: null }), { sleep: noSleep }),
    { status: 'failed', error: 'no words were recognised' });
  assert.equal((await waitForTranscript(async () => null, { sleep: noSleep })).status, 'failed');
});

// ---------- downloader ----------
test('downloader: getFile → file URL with the token; errors never contain the URL', async () => {
  const urls: string[] = [];
  const ok: FetchLike = async (url) => { urls.push(url); return { ok: true, status: 200, headers: { get: () => '3' }, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }; };
  const dl = telegramDownloader('123:SECRET', async (id) => ({ file_path: `voice/${id}.oga` }), ok);
  assert.deepEqual([...await dl('abc')], [1, 2, 3]);
  assert.deepEqual(urls, ['https://api.telegram.org/file/bot123:SECRET/voice/abc.oga']);

  const boom = telegramDownloader('123:SECRET', async () => ({ file_path: 'x' }), async () => { throw new Error('connect to https://api.telegram.org/file/bot123:SECRET/x failed'); });
  await assert.rejects(boom('a'), (e: Error) => !e.message.includes('SECRET'));
  const huge = telegramDownloader('t', async () => ({ file_path: 'x' }), async () => ({ ok: true, status: 200, headers: { get: () => String(MAX_VOICE_BYTES + 1) }, arrayBuffer: async () => new ArrayBuffer(0) }));
  await assert.rejects(huge('a'), /larger than 8 MB/);
  const http404 = telegramDownloader('t', async () => ({ file_path: 'x' }), async () => ({ ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) }));
  await assert.rejects(http404('a'), /HTTP 404/);
  await assert.rejects(telegramDownloader('t', async () => ({}))('a'), /no file path/);
});

// ---------- the whole flow ----------
test('voice note → queued with its audio → transcribed → "Heard" → staged as a request like typed text', async () => {
  const s = setup();
  workerFinishes(s.db, 3, { text: 'Write a blog post about solar !urgent' });
  await handleVoice(s.d, 42, 900, { kind: 'voice', fileId: 'file-1', duration: 7, mimeType: 'audio/ogg', fileSize: 4000 }, s.io);
  assert.deepEqual(s.downloads, ['file-1']);
  const [v] = [...s.db.voiceNotes.values()];
  assert.equal(v!.chatId, 42); assert.equal(v!.messageId, 900); assert.equal(v!.mediaType, 'audio/ogg'); assert.equal(v!.seconds, 7);
  assert.equal(v!.audio.length, 4000);
  assert.deepEqual(s.replies, ['🎙 Transcribing…', '🎙 Heard: Write a blog post about solar !urgent',
    'Staged. The COO is planning it; the plan will come here for approval.']);
  assert.equal(s.db.requests.length, 1);
  assert.equal(s.db.requests[0]!.text, 'Write a blog post about solar');
  assert.equal(s.db.requests[0]!.priority, 'urgent');
});

test('the transcript goes through the same function as typed text: a pending change note wins over a new request', async () => {
  const s = setup();
  const ap = approval(); s.db.approvals.push(ap);
  await onButton(s.d.decisions, 42, 500, ap.id, 'changes');
  workerFinishes(s.db, 2, { text: 'Make the hero shorter.' });
  await handleVoice(s.d, 42, 901, { kind: 'voice', fileId: 'f' }, s.io);
  assert.deepEqual(s.db.decisions, [{ id: ap.id, decision: 'changes', note: 'Make the hero shorter.' }]);
  assert.equal(s.db.requests.length, 0);
  assert.equal(s.edits[0]!.messageId, 500);
  assert.deepEqual(s.replies, ['🎙 Transcribing…', '🎙 Heard: Make the hero shorter.', '✏️ Sent back for changes.']);

  // Typed text takes exactly the same path.
  const t = setup();
  const ap2 = approval(); t.db.approvals.push(ap2);
  await onButton(t.d.decisions, 42, 500, ap2.id, 'changes');
  await processText(t.intake, 42, 'Make the hero shorter.', t.io);
  assert.deepEqual(t.db.decisions, [{ id: ap2.id, decision: 'changes', note: 'Make the hero shorter.' }]);
  assert.deepEqual(t.replies, ['✏️ Sent back for changes.']);
});

test('a spoken 2FA code is never echoed, is cleaned to the code, and the voice message is deleted', async () => {
  const s = setup();
  const ap = approval({ kind: 'external_action', title: '2FA code needed', payload: { type: 'question', question: 'code?', vault: { kind: '2fa', credential_id: 'c1' } } });
  s.db.approvals.push(ap);
  await onButton(s.d.decisions, 42, 500, ap.id, 'approve');
  workerFinishes(s.db, 1, { text: '482 913.' });
  await handleVoice(s.d, 42, 902, { kind: 'voice', fileId: 'f' }, s.io);
  assert.deepEqual(s.db.decisions, [{ id: ap.id, decision: 'approve', note: '482913' }]);
  assert.equal(s.replies[1], '🎙 Heard your code (not shown).');
  assert.ok(!s.replies.some((r) => r.includes('482')));
  assert.equal(s.deleted(), 1);
});

test('too long / too big: a friendly reply, nothing downloaded or queued', async () => {
  const s = setup();
  await handleVoice(s.d, 42, 1, { kind: 'voice', fileId: 'f', duration: 121 }, s.io);
  await handleVoice(s.d, 42, 2, { kind: 'audio', fileId: 'f', fileSize: 9 * 1024 * 1024, mimeType: 'audio/mpeg' }, s.io);
  assert.equal(s.downloads.length, 0);
  assert.equal(s.db.voiceNotes.size, 0);
  assert.match(s.replies[0]!, /under 2 minutes/);
  assert.match(s.replies[1]!, /up to 8 MB/);
  // Telegram sometimes omits file_size: the downloaded bytes are checked too.
  const b = setup({ download: async () => new Uint8Array(MAX_VOICE_BYTES + 1) });
  await handleVoice(b.d, 42, 3, { kind: 'voice', fileId: 'f' }, b.io);
  assert.equal(b.db.voiceNotes.size, 0);
  assert.match(b.replies[0]!, /up to 8 MB/);
});

test('failure and timeout: the error is shown, the CEO is asked to type it, nothing is staged', async () => {
  const s = setup();
  workerFinishes(s.db, 2, { status: 'failed', error: 'No speech-to-text model available (config/models.yaml transcription): groq:whisper: no key' });
  await handleVoice(s.d, 42, 1, { kind: 'voice', fileId: 'f' }, s.io);
  assert.match(s.replies[1]!, /^🎙 Couldn't transcribe that: No speech-to-text model available.*Please type it instead\.$/);
  assert.equal(s.db.requests.length, 0);

  let t = 0;
  const w = setup();
  w.d.wait = { sleep: async (ms) => { t += ms; }, now: () => t };
  await handleVoice(w.d, 42, 2, { kind: 'voice', fileId: 'f' }, w.io);
  assert.match(w.replies[1]!, /taking too long.*type it instead/);
  const [v] = [...w.db.voiceNotes.values()];
  assert.equal(v!.status, 'failed', 'the bot marks it failed so the worker never transcribes a clip nobody waits for');
  assert.ok(v!.audioCleared);
  assert.equal(w.db.requests.length, 0);

  const dl = setup({ download: async () => { throw new Error('the download from Telegram failed (HTTP 400)'); } });
  await handleVoice(dl.d, 42, 3, { kind: 'voice', fileId: 'f' }, dl.io);
  assert.deepEqual(dl.replies, ['🎙 Couldn\'t get that voice note: the download from Telegram failed (HTTP 400). Please type it instead.']);
});
