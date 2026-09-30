import { NextResponse, type NextRequest } from 'next/server';
import { brainUrl } from '@/lib/env';
import { BRAIN_HOOK_MAX_BYTES, githubHookHeaders } from '@/lib/brainHook';

// GitHub push webhook of the memory vault (public, see middleware PUBLIC). Passed straight to the brain service, which
// verifies X-Hub-Signature-256 and pulls + re-indexes the vault (docs/16-BRAIN.md).
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const base = brainUrl();
  if (!base) return NextResponse.json({ error: 'The brain is not configured (BRAIN_URL).' }, { status: 503 });
  if (Number(request.headers.get('content-length') ?? 0) > BRAIN_HOOK_MAX_BYTES) return NextResponse.json({ error: 'payload too large' }, { status: 413 });
  const body = Buffer.from(await request.arrayBuffer());
  if (body.length > BRAIN_HOOK_MAX_BYTES) return NextResponse.json({ error: 'payload too large' }, { status: 413 });
  try {
    const res = await fetch(`${base}/hooks/github`, {
      method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(10_000), headers: githubHookHeaders(request.headers), body,
    });
    return NextResponse.json(await res.json().catch(() => ({ error: `brain answered ${res.status}` })), { status: res.status });
  } catch {
    return NextResponse.json({ error: 'Could not reach the brain service.' }, { status: 502 });
  }
}
