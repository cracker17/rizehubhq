import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServer } from '@/lib/supabase/server';
import { workerEnv } from '@/lib/env';

// Voice input (docs/06 "Voice input"): the browser posts the recorded clip here; only the signed-in CEO may use it.
// The clip is forwarded to the worker's /transcribe (which holds the Whisper key) and never stored.
export const dynamic = 'force-dynamic';
const MAX_BYTES = 8 * 1024 * 1024;

export async function POST(request: NextRequest) {
  const db = await createSupabaseServer();
  if (!db) return NextResponse.json({ error: 'Voice input needs the live dashboard (demo mode).' }, { status: 503 });
  const { data: { user } } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Your session expired. Sign in again.' }, { status: 401 });
  const ceo = await db.from('ceo_users').select('user_id').eq('user_id', user.id).maybeSingle();
  if (!ceo.data) return NextResponse.json({ error: 'This account is not the CEO.' }, { status: 403 });

  const worker = workerEnv();
  if (!worker) return NextResponse.json({ error: 'The worker is not configured (HQ_WORKER_URL / HQ_INTERNAL_SECRET).' }, { status: 503 });
  const type = request.headers.get('content-type') ?? '';
  if (!type.startsWith('audio/')) return NextResponse.json({ error: 'Send an audio recording.' }, { status: 415 });
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BYTES) return NextResponse.json({ error: 'That recording is too long.' }, { status: 413 });
  const audio = Buffer.from(await request.arrayBuffer());
  if (audio.length > MAX_BYTES) return NextResponse.json({ error: 'That recording is too long.' }, { status: 413 });

  try {
    const res = await fetch(`${worker.url}/transcribe`, {
      method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(75_000), body: audio,
      headers: { 'content-type': type, 'x-hq-secret': worker.secret, 'x-hq-source': (request.headers.get('x-hq-source') ?? 'dashboard').slice(0, 40) },
    });
    const body = (await res.json().catch(() => ({ error: `The worker answered ${res.status}.` }))) as Record<string, unknown>;
    return NextResponse.json(body, { status: res.status });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error && e.name === 'TimeoutError' ? 'Transcription took too long. Try a shorter clip.' : 'Could not reach the worker.' }, { status: 502 });
  }
}
