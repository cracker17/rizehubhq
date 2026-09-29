// Speech-to-text for the CEO's voice input (dashboard mic; Telegram voice notes use the same function).
// Models come from config/models.yaml `transcription:` (first usable wins, CLAUDE.md rule 8); keys from workerEnv().
// The provider model is called with the real media type: the AI SDK's transcribe() sniffs the format and doesn't know
// WebM (Chrome's recorder) or MP4 (Safari's), so it would label them audio/wav.
import type { TranscriptionModel } from 'ai';
import { isQuotaError, modelBlock } from './usage';
import { parseCandidate, type Candidate, type ModelsConfig } from './router';

export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
/** Formats browsers record and Whisper accepts. */
const AUDIO_TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/m4a', 'audio/x-m4a', 'audio/aac', 'audio/flac'];

/** 'audio/webm;codecs=opus' → 'audio/webm'; null when not a supported audio type. */
export function audioType(contentType: string | undefined | null): string | null {
  const base = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  return AUDIO_TYPES.includes(base) ? base : null;
}

const KEY_ENV: Record<string, string> = { groq: 'GROQ_API_KEY', openai: 'OPENAI_API_KEY' };

export type CreateTranscriber = (c: Candidate, apiKey: string) => Promise<TranscriptionModel>;

export const createTranscriber: CreateTranscriber = async (c, apiKey) => {
  if (c.provider === 'groq') { const { createGroq } = await import('@ai-sdk/groq'); return createGroq({ apiKey }).transcription(c.modelId); }
  if (c.provider === 'openai') { const { createOpenAI } = await import('@ai-sdk/openai'); return createOpenAI({ apiKey }).transcription(c.modelId); }
  throw new Error(`${c.provider} has no transcription model in the AI SDK`);
};

export interface Transcript { text: string; language: string | null; seconds: number | null; provider: string; modelId: string }

/** spec → epoch ms until which it is skipped after a quota/overload error (same rules as chat models). */
const blocked = new Map<string, number>();

export async function transcribeAudio(
  audio: Uint8Array, mediaType: string,
  o: { cfg: Pick<ModelsConfig, 'transcription'>; env: Readonly<Record<string, string | undefined>>; create?: CreateTranscriber; now?: () => number },
): Promise<Transcript> {
  const now = o.now ?? Date.now;
  const reasons: string[] = [];
  for (const spec of o.cfg.transcription) {
    const c = parseCandidate(spec);
    const key = KEY_ENV[c.provider] ? o.env[KEY_ENV[c.provider]!] : undefined;
    if (!key) { reasons.push(`${spec}: no key`); continue; }
    if ((blocked.get(spec) ?? 0) > now()) { reasons.push(`${spec}: unavailable for now`); continue; }
    try {
      const model = await (o.create ?? createTranscriber)(c, key);
      const r = await model.doGenerate({ audio, mediaType, abortSignal: AbortSignal.timeout(60_000) });
      return { text: r.text.trim(), language: r.language ?? null, seconds: r.durationInSeconds ?? null, provider: c.provider, modelId: c.modelId };
    } catch (e) {
      if (!isQuotaError(e)) throw e;
      const b = modelBlock(e);
      blocked.set(spec, b === 'day' ? now() + 6 * 3600_000 : now() + (typeof b === 'number' ? b : 60_000));
      reasons.push(`${spec}: ${e instanceof Error ? e.message.slice(0, 120) : 'quota'}`);
    }
  }
  throw new Error(`No speech-to-text model available (config/models.yaml transcription): ${reasons.join('; ') || 'none configured'}`);
}

/** Tests only. */
export function resetTranscribeBlocks() { blocked.clear(); }
