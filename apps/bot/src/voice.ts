// Telegram voice notes (docs/08 "Voice notes"). The bot has no worker secret, so the clip goes through Supabase:
// download from Telegram → voice_notes row (service role) → the worker transcribes it (apps/worker/src/voiceNotes.ts)
// → we poll the row and then handle the text exactly like a typed message (intake.ts processText).
// Framework-free so it is testable; index.ts adapts grammY. Audio and transcripts are never logged.
import { processText, type ChatIO, type IntakeDeps } from './intake';
import type { VoiceNoteState } from './types';

export const MAX_VOICE_BYTES = 8 * 1024 * 1024;
export const MAX_VOICE_SECONDS = 120;

export interface VoiceClip {
  kind: 'voice' | 'audio';
  fileId: string;
  /** Bytes, when Telegram says. */
  fileSize?: number;
  /** Seconds, as Telegram reports it. */
  duration?: number;
  mimeType?: string;
}

export type VoiceCheck = { ok: true; mediaType: string } | { ok: false; reply: string };

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const minSec = (s: number) => `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;

/** Size / length / type guard before anything is downloaded. The worker has the final say on the format. */
export function checkVoice(c: VoiceClip): VoiceCheck {
  if ((c.fileSize ?? 0) > MAX_VOICE_BYTES) return { ok: false, reply: `That clip is ${mb(c.fileSize!)}. Voice notes up to 8 MB work; please send a shorter one or type it.` };
  if ((c.duration ?? 0) > MAX_VOICE_SECONDS) return { ok: false, reply: `That clip is ${minSec(c.duration!)} long. Keep voice notes under 2 minutes, or type it.` };
  const base = (c.mimeType || (c.kind === 'voice' ? 'audio/ogg' : '')).split(';')[0]!.trim().toLowerCase();
  if (!base.startsWith('audio/')) return { ok: false, reply: 'I can only transcribe audio (a voice note, mp3, m4a or ogg). Please type it instead.' };
  return { ok: true, mediaType: base };
}

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; arrayBuffer(): Promise<ArrayBuffer> }>;

/**
 * getFile + https://api.telegram.org/file/bot<token>/<file_path>. Errors never contain the URL (it holds the token).
 */
export function telegramDownloader(token: string, getFile: (fileId: string) => Promise<{ file_path?: string }>, fetchImpl: FetchLike = fetch as unknown as FetchLike) {
  return async (fileId: string): Promise<Uint8Array> => {
    const f = await getFile(fileId);
    if (!f.file_path) throw new Error('Telegram gave no file path');
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await fetchImpl(`https://api.telegram.org/file/bot${token}/${f.file_path}`, { signal: AbortSignal.timeout(30_000) });
    } catch {
      throw new Error('the download from Telegram failed');
    }
    if (!res.ok) throw new Error(`the download from Telegram failed (HTTP ${res.status})`);
    if (Number(res.headers.get('content-length') ?? 0) > MAX_VOICE_BYTES) throw new Error('the clip is larger than 8 MB');
    return new Uint8Array(await res.arrayBuffer());
  };
}

export type VoiceOutcome = { status: 'done'; text: string } | { status: 'failed'; error: string } | { status: 'timeout' };
export interface WaitOptions { intervalMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number }

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Polls the row every 1.5 s for up to 60 s. A failed read is retried; a missing row counts as failed. */
export async function waitForTranscript(get: () => Promise<VoiceNoteState | null>, o: WaitOptions = {}): Promise<VoiceOutcome> {
  const interval = o.intervalMs ?? 1500; const timeout = o.timeoutMs ?? 60_000;
  const sleep = o.sleep ?? realSleep; const now = o.now ?? Date.now;
  const start = now();
  for (;;) {
    await sleep(interval);
    let r: VoiceNoteState | null | undefined;
    try { r = await get(); } catch { r = undefined; }
    if (r === null) return { status: 'failed', error: 'the voice note was lost' };
    if (r?.status === 'done' && r.text?.trim()) return { status: 'done', text: r.text.trim() };
    if (r?.status === 'done' || r?.status === 'failed') return { status: 'failed', error: r.error || 'no words were recognised' };
    if (now() - start >= timeout) return { status: 'timeout' };
  }
}

export interface VoiceDeps extends IntakeDeps {
  download: (fileId: string) => Promise<Uint8Array>;
  wait?: WaitOptions;
}

/** A spoken one-time code comes back as "482 913." : keep only what a code can contain. */
const codeOnly = (text: string) => text.replace(/[^A-Za-z0-9\s-]/g, '');

export async function handleVoice(d: VoiceDeps, chatId: number, messageId: number, clip: VoiceClip, io: ChatIO): Promise<unknown> {
  const c = checkVoice(clip);
  if (!c.ok) return io.reply(c.reply);
  let audio: Uint8Array;
  try { audio = await d.download(clip.fileId); } catch (e) {
    return io.reply(`🎙 Couldn't get that voice note: ${e instanceof Error ? e.message : 'download failed'}. Please type it instead.`);
  }
  if (audio.length === 0) return io.reply('🎙 That voice note is empty. Please try again or type it.');
  if (audio.length > MAX_VOICE_BYTES) return io.reply(`That clip is ${mb(audio.length)}. Voice notes up to 8 MB work; please send a shorter one or type it.`);
  let id: string;
  try {
    id = await d.db.createVoiceNote({ chatId, messageId, audio, mediaType: c.mediaType, seconds: clip.duration ?? null });
  } catch (e) {
    return io.reply(`🎙 Couldn't queue that voice note: ${e instanceof Error ? e.message : String(e)}. Please type it instead.`);
  }
  await io.reply('🎙 Transcribing…');
  const out = await waitForTranscript(() => d.db.getVoiceNote(id), d.wait);
  if (out.status === 'timeout') {
    await d.db.abandonVoiceNote(id, 'the bot stopped waiting').catch(() => undefined);
    return io.reply('🎙 Transcription is taking too long (is the worker running?). Please type it instead.');
  }
  if (out.status === 'failed') return io.reply(`🎙 Couldn't transcribe that: ${out.error}. Please type it instead.`);
  // A pending Vault 2FA question: the transcript is the code, so it is never echoed and the voice note is deleted.
  const secret = d.decisions.pending.peek(chatId)?.decision === 'approve';
  await io.reply(secret ? '🎙 Heard your code (not shown).' : `🎙 Heard: ${out.text}`);
  return processText(d, chatId, secret ? codeOnly(out.text) : out.text, io);
}
