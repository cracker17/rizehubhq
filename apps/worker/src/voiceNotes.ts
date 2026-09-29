// Telegram voice notes (docs/08 "Voice notes"): the bot queues clips in `voice_notes` (it has no worker secret, so
// Supabase is the hand-off, CLAUDE.md rule 2); every 3 s this claims the oldest (voice_note_claim, skip locked),
// transcribes it with the same function as the dashboard mic (models/transcribe.ts) and finishes it (voice_note_finish
// clears the audio, done or failed). The activity log gets usage.transcribe with source 'telegram'; never the text.
import type { SupabaseClient } from '@supabase/supabase-js';
import { audioType, MAX_AUDIO_BYTES, type Transcript } from './models/transcribe';

export interface VoiceNoteJob { id: string; audio: Uint8Array; mediaType: string }

export interface VoiceNoteDeps {
  /** The oldest pending clip ('pending' → 'working'), or null. */
  claim: () => Promise<VoiceNoteJob | null>;
  finish: (id: string, r: { text: string | null; error: string | null; seconds: number | null }) => Promise<void>;
  transcribe: (audio: Uint8Array, mediaType: string) => Promise<Transcript>;
  log?: (t: Transcript) => Promise<void>;
  warn?: (msg: string) => void;
}

/** Aliases Telegram / phones use → a type models/transcribe.ts audioType() accepts. */
const ALIASES: Record<string, string> = {
  'audio/opus': 'audio/ogg', 'audio/oga': 'audio/ogg', 'audio/x-opus+ogg': 'audio/ogg', 'application/ogg': 'audio/ogg',
  'audio/mp3': 'audio/mpeg', 'audio/x-mp3': 'audio/mpeg', 'audio/mpeg3': 'audio/mpeg', 'audio/x-mpeg': 'audio/mpeg',
  'audio/x-aac': 'audio/aac', 'audio/x-flac': 'audio/flac', 'audio/wave': 'audio/wav', 'audio/vnd.wave': 'audio/wav',
};

/** Telegram voice = audio/ogg (Opus); audio files may be audio/mpeg, audio/mp4, audio/x-m4a… null = unsupported. */
export function voiceMediaType(t: string | null | undefined): string | null {
  const base = (t ?? '').split(';')[0]!.trim().toLowerCase();
  return audioType(ALIASES[base] ?? base);
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/** Transcribes every waiting clip (at most `max` per tick). Returns how many were finished. */
export async function voiceNotesTick(d: VoiceNoteDeps, max = 5): Promise<number> {
  let n = 0;
  for (; n < max; n++) {
    const job = await d.claim();
    if (!job) break;
    const type = voiceMediaType(job.mediaType);
    if (!type) { await d.finish(job.id, { text: null, error: `unsupported audio format (${job.mediaType.slice(0, 40)}); send a voice note, mp3 or m4a`, seconds: null }); continue; }
    if (job.audio.length === 0 || job.audio.length > MAX_AUDIO_BYTES) { await d.finish(job.id, { text: null, error: 'the clip is empty or larger than 8 MB', seconds: null }); continue; }
    try {
      const t = await d.transcribe(job.audio, type);
      await d.finish(job.id, t.text ? { text: t.text, error: null, seconds: t.seconds } : { text: null, error: 'no words were recognised', seconds: t.seconds });
      await d.log?.(t).catch(() => undefined);
    } catch (e) {
      d.warn?.(`[voice] transcription failed for ${job.id}: ${errText(e)}`);
      await d.finish(job.id, { text: null, error: errText(e), seconds: null });
    }
  }
  return n;
}

export function startVoiceNotes(d: VoiceNoteDeps, everyMs = 3000): NodeJS.Timeout {
  let busy = false;
  const t = setInterval(() => {
    if (busy) return;
    busy = true;
    void voiceNotesTick(d)
      .catch((e) => d.warn?.(`[voice] poll failed: ${errText(e)}`))
      .finally(() => { busy = false; });
  }, everyMs);
  t.unref?.();
  return t;
}

/** PostgREST returns bytea as '\x…' hex (base64 accepted as a fallback). */
export function decodeBytea(v: unknown): Uint8Array {
  if (typeof v !== 'string') return new Uint8Array(0);
  return v.startsWith('\\x') ? new Uint8Array(Buffer.from(v.slice(2), 'hex')) : new Uint8Array(Buffer.from(v, 'base64'));
}

export function supabaseVoiceNoteDeps(sb: SupabaseClient): Pick<VoiceNoteDeps, 'claim' | 'finish' | 'log'> {
  return {
    claim: async () => {
      const r = await sb.rpc('voice_note_claim');
      if (r.error) throw new Error(`voice_note_claim: ${r.error.message}`);
      const row = r.data as { id: string | null; audio: unknown; media_type: string | null } | null;
      return row?.id ? { id: row.id, audio: decodeBytea(row.audio), mediaType: row.media_type ?? '' } : null;
    },
    finish: async (id, f) => {
      const r = await sb.rpc('voice_note_finish', { p_id: id, p_text: f.text, p_error: f.error, p_seconds: f.seconds });
      if (r.error) throw new Error(`voice_note_finish: ${r.error.message}`);
    },
    log: async (t) => {
      await sb.from('activity_log').insert({
        actor: 'ceo', action: 'usage.transcribe',
        detail: { provider: t.provider, model: t.modelId, seconds: t.seconds, language: t.language, source: 'telegram' },
      });
    },
  };
}
