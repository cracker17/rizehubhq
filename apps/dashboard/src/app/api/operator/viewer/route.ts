// GET /api/operator/viewer?client=<slug>  (or ?host=<viewer host>, used by the viewer's nginx when its cookie is gone)
// Opens a client's workspace viewer for the signed-in CEO (docs/17-OPERATOR.md "Viewer login"): the middleware already
// required the HQ login + 2FA; here we check the CEO, sign a 12 h token for that viewer host and hand it to the
// viewer's /__hq/login, which stores it as a cookie. Without OPERATOR_VIEWER_SECRET it falls back to the plain address
// (the viewer's own basic auth, phase 1).
import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServer } from '@/lib/supabase/server';
import { supabaseEnv } from '@/lib/env';
import { signViewerToken, viewerHost, viewerLoginUrl, viewerSecret } from '@/lib/viewerToken';

export const dynamic = 'force-dynamic';

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

function page(req: NextRequest, msg: string, status = 403) {
  return new NextResponse(`<!doctype html><meta charset="utf-8"><title>Live screen</title><body style="font:14px system-ui;padding:24px;background:#0f0d1f;color:#e7e5ff">${msg}</body>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

export async function GET(req: NextRequest) {
  if (!supabaseEnv()) return NextResponse.redirect(new URL('/operator', req.url));
  const db = await createSupabaseServer();
  if (!db) return page(req, 'Supabase is not configured.', 500);
  const { data: { user } } = await db.auth.getUser();
  if (!user) return NextResponse.redirect(new URL('/login', req.url));
  const ceo = await db.from('ceo_users').select('user_id').eq('user_id', user.id).maybeSingle();
  if (!ceo.data) return page(req, 'Only the CEO can open the client browsers.');

  const slug = req.nextUrl.searchParams.get('client') ?? '';
  const host = (req.nextUrl.searchParams.get('host') ?? '').toLowerCase();
  const { data: clients, error } = await db.from('operator_clients').select('slug,viewer_url').not('viewer_url', 'is', null);
  if (error) return page(req, `Could not read the operator clients: ${error.message}`, 500);
  const c = (clients ?? []).find((x) => (SLUG.test(slug) && x.slug === slug) || (host && viewerHost(x.viewer_url) === host));
  if (!c?.viewer_url) return page(req, 'No live screen address is set for this client (Operator → Add live screen address).', 404);

  const secret = viewerSecret(process.env);
  if (!secret) return NextResponse.redirect(c.viewer_url); // phase 1 behaviour: the viewer's own basic auth
  const vh = viewerHost(c.viewer_url);
  if (!vh) return page(req, 'The live screen address must start with https://', 400);
  const token = signViewerToken({ host: vh, client: c.slug }, secret);
  const res = NextResponse.redirect(viewerLoginUrl(c.viewer_url, token));
  res.headers.set('cache-control', 'no-store');
  res.headers.set('referrer-policy', 'no-referrer');
  return res;
}
