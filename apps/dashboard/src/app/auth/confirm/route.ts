import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServer } from '@/lib/supabase/server';
import { safeNext } from '@/lib/auth/stepUp';

// Landing URL of the password-reset email (docs/09 "CEO password"). Supports both Supabase link styles:
// ?code=… (PKCE, the default template; open it in the browser that asked) and ?token_hash=…&type=recovery
// (a custom template, works in any browser). On success the session is a 'recovery' sign-in; the middleware then
// asks for the 2FA code (when on) before /reset-password.
export async function GET(request: NextRequest) {
  const db = await createSupabaseServer();
  if (!db) return NextResponse.redirect(new URL('/', request.url));
  const q = request.nextUrl.searchParams;
  const next = safeNext(q.get('next') ?? '/reset-password');
  const code = q.get('code');
  const tokenHash = q.get('token_hash');
  let ok = false;
  if (code) ok = !(await db.auth.exchangeCodeForSession(code)).error;
  else if (tokenHash && q.get('type') === 'recovery') ok = !(await db.auth.verifyOtp({ type: 'recovery', token_hash: tokenHash })).error;
  return NextResponse.redirect(new URL(ok ? next : '/login?step=reset&reset=expired', request.url));
}
