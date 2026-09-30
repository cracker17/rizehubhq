import type { NextRequest } from 'next/server';
import { authorizationServerMetadata, metadataResponse } from '@/lib/brainConnector';

// RFC 8414 authorization-server metadata for the Brain MCP connector (lib/brainConnector.ts). Public.
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return metadataResponse(authorizationServerMetadata(request));
}
