// GET /api/operator/viewer-check: nginx auth_request on the viewer host (deploy/workspace/nginx-ws.rizehub.ph.conf)
// asks this before every request to the client browser. 204 = the token in X-HQ-Viewer-Token is genuine, unexpired and
// for the host in X-HQ-Viewer-Host; 401 otherwise (nginx then sends the browser to /api/operator/viewer to get a new one
// through the HQ login). Public route (middleware PUBLIC): it only verifies the HMAC; it reads no session and no data.
import { NextResponse, type NextRequest } from 'next/server';
import { verifyViewerToken, viewerSecret } from '@/lib/viewerToken';

export const dynamic = 'force-dynamic';

export function GET(req: NextRequest) {
  const secret = viewerSecret(process.env);
  const ok = !!secret && !!verifyViewerToken(req.headers.get('x-hq-viewer-token'), req.headers.get('x-hq-viewer-host'), secret);
  return new NextResponse(null, { status: ok ? 204 : 401, headers: { 'cache-control': 'no-store' } });
}
