import { NextResponse, type NextRequest } from 'next/server';
import { workerUrl } from '@/lib/env';

// Alerts from other apps (Hushdesk first; public, see middleware PUBLIC). Passed straight to the worker's
// /hooks/notify, which verifies X-HQ-Signature (HQ_NOTIFY_SECRET) and stores the alert once.
export const dynamic = 'force-dynamic';

const MAX_BYTES = 16 * 1024;
const PASS = ['content-type', 'x-hq-signature', 'x-hq-timestamp'];

export async function POST(request: NextRequest) {
  const base = workerUrl();
  if (!base) return NextResponse.json({ error: 'HQ is not configured (HQ_WORKER_URL).' }, { status: 503 });
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BYTES) return NextResponse.json({ error: 'payload too large' }, { status: 413 });
  const body = Buffer.from(await request.arrayBuffer());
  if (body.length > MAX_BYTES) return NextResponse.json({ error: 'payload too large' }, { status: 413 });
  const headers: Record<string, string> = {};
  for (const h of PASS) { const v = request.headers.get(h); if (v) headers[h] = v; }
  try {
    const res = await fetch(`${base}/hooks/notify`, { method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(10_000), headers, body });
    return NextResponse.json(await res.json().catch(() => ({ error: `worker answered ${res.status}` })), { status: res.status });
  } catch {
    return NextResponse.json({ error: 'Could not reach the HQ worker.' }, { status: 502 });
  }
}
