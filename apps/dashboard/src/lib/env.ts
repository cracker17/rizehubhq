// Runtime env helpers. `process.env[name]` with a variable name is never inlined at build time,
// so a single build works in DEMO (no env) and LIVE (env provided when the server starts).
function readEnv(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

export function supabaseEnv(): { url: string; anonKey: string } | null {
  const url = readEnv('NEXT_PUBLIC_SUPABASE_URL');
  const anonKey = readEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  return url && anonKey ? { url, anonKey } : null;
}

/** LIVE when Supabase is configured, DEMO (mock data, in-memory actions) otherwise. */
export function isLive(): boolean {
  return supabaseEnv() !== null;
}

/** Worker chat endpoint (server-only; the secret never reaches the browser). */
export function workerEnv(): { url: string; secret: string } | null {
  const url = readEnv('HQ_WORKER_URL');
  const secret = readEnv('HQ_INTERNAL_SECRET');
  return url && secret ? { url: url.replace(/\/+$/, ''), secret } : null;
}

/** Brain service internal API (server-only; docs/16-BRAIN.md). */
export function brainEnv(): { url: string; secret: string } | null {
  const url = readEnv('BRAIN_URL');
  const secret = readEnv('BRAIN_INTERNAL_SECRET');
  return url && secret ? { url: url.replace(/\/+$/, ''), secret } : null;
}

/** Brain service base URL alone: enough to pass the GitHub webhook through (the brain checks GitHub's signature). */
export function brainUrl(): string | null {
  return readEnv('BRAIN_URL')?.replace(/\/+$/, '') ?? null;
}
