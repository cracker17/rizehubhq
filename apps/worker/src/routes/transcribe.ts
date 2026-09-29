// POST /transcribe: raw audio in, { text } out (dashboard mic → docs/06 "Voice input"). Needs x-hq-secret like every
// dashboard → worker call; 'self' only so the body may be up to MAX_AUDIO_BYTES instead of 16 KB. The audio is never
// stored; the activity log gets provider, model and duration (no text).
import type http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { Route } from './types';
import { workerEnv } from '../config';
import { loadModelsConfig } from '../models/router';
import { MAX_AUDIO_BYTES, audioType, transcribeAudio, type Transcript } from '../models/transcribe';
import { createServiceClient } from '../db';

function same(given: string | undefined, expected: string) {
  if (!given || !expected) return false;
  const a = Buffer.from(given); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Small per-process limiter: voice clips are cheap but the free Whisper quota is shared with Telegram. */
function limiter(max: number, windowMs: number) {
  let hits: number[] = [];
  return (now = Date.now()) => { hits = hits.filter((t) => t > now - windowMs); if (hits.length >= max) return false; hits.push(now); return true; };
}

export function createTranscribeRoutes(o: {
  secret: () => string;
  transcribe: (audio: Uint8Array, mediaType: string) => Promise<Transcript>;
  log?: (t: Transcript, source: string) => Promise<void>;
  allow?: () => boolean;
}): Route[] {
  const allow = o.allow ?? limiter(30, 10 * 60_000);
  return [{
    method: 'POST', path: '/transcribe', auth: 'self', maxBody: MAX_AUDIO_BYTES,
    handle: async (req: http.IncomingMessage, raw) => {
      const secret = o.secret();
      if (!secret) return [503, { error: 'HQ_INTERNAL_SECRET is not configured' }];
      const given = req.headers['x-hq-secret'];
      if (!same(Array.isArray(given) ? given[0] : given, secret)) return [401, { error: 'unauthorized' }];
      const type = audioType(req.headers['content-type']);
      if (!type) return [415, { error: 'Send audio (webm, ogg, mp4, mp3, wav, m4a).' }];
      if (raw.length < 1000) return [400, { error: 'That recording is empty. Hold the mic a little longer.' }];
      if (!allow()) return [429, { error: 'Too many voice messages in a row. Wait a few minutes.' }];
      const source = String(req.headers['x-hq-source'] ?? 'dashboard').slice(0, 40);
      try {
        const t = await o.transcribe(new Uint8Array(raw), type);
        await o.log?.(t, source).catch(() => undefined);
        return [200, { text: t.text, language: t.language, seconds: t.seconds }];
      } catch (e) {
        return [502, { error: e instanceof Error ? e.message.slice(0, 300) : 'Transcription failed.' }];
      }
    },
  }];
}

export const transcribeRoutes: Route[] = createTranscribeRoutes({
  secret: () => workerEnv().HQ_INTERNAL_SECRET ?? '',
  transcribe: (audio, type) => transcribeAudio(audio, type, { cfg: loadModelsConfig(), env: workerEnv() }),
  log: async (t, source) => {
    await createServiceClient().from('activity_log').insert({
      actor: 'ceo', action: 'usage.transcribe',
      detail: { provider: t.provider, model: t.modelId, seconds: t.seconds, language: t.language, source },
    });
  },
});
