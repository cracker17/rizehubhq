import { NextResponse, type NextRequest } from 'next/server';
import { proxyToBrain, resourceMetadataUrl } from '@/lib/brainConnector';

// The Brain MCP connector endpoint (Streamable HTTP, stateless, JSON only). Public: the brain service checks the OAuth
// access token. A 401 carries WWW-Authenticate with the protected-resource metadata URL, which is how Claude finds
// the sign-in (MCP authorization spec).
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const res = await proxyToBrain(request, '/mcp', { passAuth: true });
  if (res.status !== 401) return res;
  const headers = new Headers(res.headers);
  headers.set('www-authenticate', `Bearer realm="HQ Brain", resource_metadata="${resourceMetadataUrl(request)}"`);
  return new Response(res.body, { status: 401, headers });
}

const noStream = () => NextResponse.json({ error: 'no server-initiated stream; POST JSON-RPC to this URL' }, { status: 405, headers: { allow: 'POST' } });
export const GET = noStream;
export const DELETE = noStream;
