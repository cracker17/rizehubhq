import type { NextRequest } from 'next/server';
import { proxyToBrain } from '@/lib/brainConnector';

// Brain connector OAuth: /oauth/token → brain service /oauth/token (public; see lib/brainConnector.ts).
export const dynamic = 'force-dynamic';

export function POST(request: NextRequest) {
  return proxyToBrain(request, '/oauth/token');
}
