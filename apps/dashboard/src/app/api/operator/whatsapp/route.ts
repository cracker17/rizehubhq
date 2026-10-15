// WhatsApp Business webhook (docs/17-OPERATOR.md "WhatsApp Business"). Public (middleware PUBLIC): Meta calls it.
// Passed straight to the operator's internal listener (OPERATOR_HOOK_URL, default http://hq-operator:4200), which
// checks Meta's X-Hub-Signature-256 with the app secret (the dashboard never holds it) and stores the messages.
// GET = Meta's verification handshake, answered by the operator too.
import { NextResponse, type NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';
const MAX = 1_000_000;

function hookBase(): string {
  return (process.env.OPERATOR_HOOK_URL?.trim() || 'http://hq-operator:4200').replace(/\/+$/, '');
}

async function relay(res: Response) {
  return new NextResponse(await res.text(), { status: res.status, headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });
}

export async function GET(req: NextRequest) {
  try {
    return await relay(await fetch(`${hookBase()}/hooks/whatsapp${req.nextUrl.search}`, { cache: 'no-store', signal: AbortSignal.timeout(10_000) }));
  } catch {
    return new NextResponse('the operator is not reachable', { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  if (Number(req.headers.get('content-length') ?? 0) > MAX) return new NextResponse('payload too large', { status: 413 });
  const body = Buffer.from(await req.arrayBuffer());
  if (body.length > MAX) return new NextResponse('payload too large', { status: 413 });
  const sig = req.headers.get('x-hub-signature-256');
  try {
    return await relay(await fetch(`${hookBase()}/hooks/whatsapp`, {
      method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(15_000), body,
      headers: { 'content-type': 'application/json', ...(sig ? { 'x-hub-signature-256': sig } : {}) },
    }));
  } catch {
    return new NextResponse('the operator is not reachable', { status: 502 }); // Meta retries
  }
}
