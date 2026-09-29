// The dashboard's public origin for redirects built in route handlers. Behind Caddy, `request.url` in a route handler
// is the container's own address (e.g. https://0.0.0.0:3000), so redirects use DASHBOARD_URL, else the forwarded host.
export function publicOrigin(request: { url: string; headers: { get(name: string): string | null } }, env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env.DASHBOARD_URL?.trim().replace(/\/+$/, '');
  if (fromEnv && /^https?:\/\//.test(fromEnv)) return fromEnv;
  const host = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  if (host) {
    const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || 'https';
    return `${proto}://${host}`;
  }
  return new URL(request.url).origin;
}

/** Absolute URL for `path` on the public origin (path must be same-site, starting with a single '/'). */
export function publicUrl(request: Parameters<typeof publicOrigin>[0], path: string, env?: Record<string, string | undefined>): URL {
  const safe = path.startsWith('/') && !path.startsWith('//') ? path : '/';
  return new URL(safe, publicOrigin(request, env));
}
