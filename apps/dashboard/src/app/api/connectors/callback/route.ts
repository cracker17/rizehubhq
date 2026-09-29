import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServer } from '@/lib/supabase/server';
import { callWorker } from '@/lib/workerCall';

// Where an app sends the CEO back after "Sign in" (docs/15 §2). Only the signed-in CEO can finish a sign-in (the
// middleware sends anyone else to /login first, keeping this URL as `next`); the worker exchanges the code, lists the
// app's tools and stores the connection, then the CEO lands on Admin → Connectors with the tool review open.
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams;
  const back = (params: Record<string, string>) => {
    const u = new URL('/admin/connectors', request.url);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return NextResponse.redirect(u);
  };
  const db = await createSupabaseServer();
  if (!db) return back({ mcpError: 'Demo mode: sign-in needs the live dashboard.' });
  const { data: { user } } = await db.auth.getUser();
  const ceo = user ? await db.from('ceo_users').select('user_id').eq('user_id', user.id).maybeSingle() : null;
  if (!ceo?.data) return back({ mcpError: 'Only the CEO can connect apps.' });

  const denied = q.get('error');
  if (denied) return back({ mcpError: denied === 'access_denied' ? 'Sign-in was cancelled.' : `The app said: ${(q.get('error_description') ?? denied).slice(0, 200)}` });
  const state = q.get('state') ?? '';
  const code = q.get('code') ?? '';
  if (!state || !code) return back({ mcpError: 'The app did not send a sign-in code. Try again.' });

  const r = await callWorker<{ id: string; name?: string }>('/connectors/mcp/finish', { state, code }, 60_000);
  if (r.status !== 200 || !('id' in r.body)) return back({ mcpError: r.body.error ?? 'Could not finish the sign-in.' });
  return back({ connected: r.body.id });
}
