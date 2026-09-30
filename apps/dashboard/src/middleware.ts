import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { authGate, needsTotpAtSignIn } from '@/lib/auth/stepUp';

// Protects every page in LIVE mode (Supabase env set): no session → /login; password OK but TOTP 2FA still open
// (a verified factor exists and the session is not aal2) → /login?step=totp. DEMO mode (no env) passes straight
// through. Also refreshes the Supabase session cookie. The database enforces aal2 too (is_ceo(), docs/09).
function env(name: string) {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

// /auth/confirm turns an emailed reset link into a session (then the normal gate applies to /reset-password).
// /oauth/client-metadata.json identifies HQ to MCP apps (public, no secrets).
// /api/brain/github is GitHub's push webhook for the memory vault: the brain service verifies its HMAC signature.
const PUBLIC = ['/login', '/api/health', '/access', '/auth', '/oauth', '/api/brain/github'];

export async function middleware(request: NextRequest) {
  const url = env('NEXT_PUBLIC_SUPABASE_URL');
  const anonKey = env('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  const path = request.nextUrl.pathname;

  if (!url || !anonKey) {
    // DEMO: there is nothing to sign in to.
    if (path === '/login') return NextResponse.redirect(new URL('/', request.url));
    return NextResponse.next();
  }

  let response = NextResponse.next({ request });
  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        for (const { name, value } of list) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of list) response.cookies.set(name, value, options);
      },
    },
  });
  // getUser() validates the JWT with Supabase Auth (don't trust getSession() on the server).
  const { data: { user } } = await supabase.auth.getUser();

  let totpPending = false;
  if (user) {
    // Factors come from the validated user; the level from the (validated) access token.
    const hasVerifiedFactor = (user.factors ?? []).some((f) => f.status === 'verified' && f.factor_type === 'totp');
    if (hasVerifiedFactor) {
      const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      totpPending = needsTotpAtSignIn({ currentLevel: data?.currentLevel ?? null, hasVerifiedFactor });
    }
  }

  const isPublic = PUBLIC.some((p) => path === p || path.startsWith(`${p}/`));
  const gate = authGate({ signedIn: Boolean(user), totpPending, path, isPublic, step: request.nextUrl.searchParams.get('step') });
  const redirect = (to: URL) => {
    const res = NextResponse.redirect(to);
    for (const c of response.cookies.getAll()) res.cookies.set(c); // keep refreshed session cookies
    return res;
  };
  if (gate === 'to_login' || gate === 'to_totp') {
    const to = new URL('/login', request.url);
    if (gate === 'to_totp') to.searchParams.set('step', 'totp');
    const next = path === '/login' ? request.nextUrl.searchParams.get('next') : path !== '/' ? path + request.nextUrl.search : null;
    if (next) to.searchParams.set('next', next);
    return redirect(to);
  }
  if (gate === 'to_home') return redirect(new URL('/', request.url));
  return response;
}

export const config = {
  // Everything except Next internals and static files.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
};
