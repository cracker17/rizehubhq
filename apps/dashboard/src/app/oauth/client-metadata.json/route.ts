import { NextResponse } from 'next/server';
import { MCP_CALLBACK_PATH, MCP_CLIENT_METADATA_PATH } from '@rizehubhq/shared';

// OAuth Client ID Metadata Document (MCP authorization, docs/15 §4): apps that support CIMD (Notion, ElevenLabs, …)
// identify RizeHub HQ by this URL instead of a registration. Public; describes HQ only (no secrets).
export const dynamic = 'force-dynamic';

export function GET() {
  const base = (process.env.DASHBOARD_URL?.trim() || 'https://hq.rizehub.ph').replace(/\/+$/, '');
  return NextResponse.json({
    client_id: `${base}${MCP_CLIENT_METADATA_PATH}`,
    client_name: 'RizeHub HQ',
    client_uri: base,
    redirect_uris: [`${base}${MCP_CALLBACK_PATH}`],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  }, { headers: { 'cache-control': 'public, max-age=300' } });
}
