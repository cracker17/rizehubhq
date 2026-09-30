import type { NextRequest } from 'next/server';
import { metadataResponse, protectedResourceMetadata } from '@/lib/brainConnector';

// RFC 9728 protected-resource metadata for the Brain MCP connector (lib/brainConnector.ts). Public.
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return metadataResponse(protectedResourceMetadata(request));
}
