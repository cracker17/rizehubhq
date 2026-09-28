import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

// Protects every page in LIVE mode (Supabase env set): no session → /login.
// DEMO mode (no env) passes straight through. Also refreshes the Supabase session cookie.
// TODO(2FA): once Supabase MFA (TOTP) is enabled, also require aal2 here:
//   const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
//   if (data?.currentLevel !== 'aal2') redirect to /login?step=totp
// See apps/dashboard/README.md "Two-factor (TODO)".
function env(name: string) {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

const PUBLIC = ['/login', '/api/health', '/access'];

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

  const isPublic = PUBLIC.some((p) => path === p || path.startsWith(`${p}/`));
  if (!user && !isPublic) {
    const to = new URL('/login', request.url);
    if (path !== '/') to.searchParams.set('next', path + request.nextUrl.search);
    return NextResponse.redirect(to);
  }
  if (user && path === '/login') return NextResponse.redirect(new URL('/', request.url));
  return response;
}

export const config = {
  // Everything except Next internals and static files.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
};
