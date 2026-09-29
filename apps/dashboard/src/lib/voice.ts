// Voice input helpers shared by VoiceButton (browser) and tested on their own.

/** Longest clip the mic records before stopping by itself. */
export const MAX_RECORD_SECONDS = 120;

/** Recorder formats in order of preference: Chrome/Edge/Firefox record WebM/Opus, Safari MP4. */
const RECORDER_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];

export function pickRecorderType(isSupported: (t: string) => boolean): string | undefined {
  return RECORDER_TYPES.find((t) => { try { return isSupported(t); } catch { return false; } });
}

/** Appends spoken text to what is already typed ("fix the hero" + "and the footer" → one line). */
export function appendSpoken(current: string, spoken: string): string {
  const s = spoken.trim();
  if (!s) return current;
  const c = current.replace(/\s+$/, '');
  return c ? `${c} ${s}` : s;
}

export type TranscribeResult = { ok: true; text: string } | { ok: false; error: string };

/** Sends a recorded clip to /api/transcribe and returns the text or a readable error. */
export async function transcribeClip(clip: Blob, source: string, fetcher: typeof fetch = fetch): Promise<TranscribeResult> {
  if (clip.size < 1000) return { ok: false, error: 'That was too short. Hold on a little longer before stopping.' };
  try {
    const res = await fetcher('/api/transcribe', {
      method: 'POST', body: clip, cache: 'no-store',
      headers: { 'content-type': clip.type || 'audio/webm', 'x-hq-source': source },
    });
    const body = (await res.json().catch(() => null)) as { text?: string; error?: string } | null;
    if (res.ok && typeof body?.text === 'string') return { ok: true, text: body.text.trim() };
    if (res.status === 401 || (!body && res.redirected)) return { ok: false, error: 'Your session expired. Sign in again.' };
    return { ok: false, error: body?.error ?? `Voice input failed (${res.status}).` };
  } catch {
    return { ok: false, error: 'Couldn’t reach the server for voice input.' };
  }
}

/** Reads text aloud with the browser's built-in voice (free, on-device). Returns false when the browser can't. */
export function speakText(text: string): boolean {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return false;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.slice(0, 1500));
  u.rate = 1.02;
  window.speechSynthesis.speak(u);
  return true;
}

export function stopSpeaking() {
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
}

const VOICE_MODE_KEY = 'hq:voice-mode';
export function readVoiceMode(): boolean {
  try { return localStorage.getItem(VOICE_MODE_KEY) === '1'; } catch { return false; }
}
export function saveVoiceMode(on: boolean) {
  try { localStorage.setItem(VOICE_MODE_KEY, on ? '1' : '0'); } catch { /* storage blocked: stays for this visit */ }
}
