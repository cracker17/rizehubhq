import 'server-only';
// Server helpers shared by the Vault and Admin → Security actions.
import { headers } from 'next/headers';
import { createClient } from '@supabase/supabase-js';
import { supabaseEnv } from '@/lib/env';

/**
 * Checks the CEO's password on a throwaway client (no cookies), then drops that extra session locally.
 * The caller's own session is untouched. Never logs the password.
 */
export async function passwordMatches(email: string, password: string, userId: string): Promise<boolean> {
  const env = supabaseEnv();
  if (!env || !password) return false;
  const check = createClient(env.url, env.anonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const { data, error } = await check.auth.signInWithPassword({ email, password });
  const ok = !error && data.user?.id === userId;
  if (!error) await check.auth.signOut({ scope: 'local' }).catch(() => undefined);
  return ok;
}

/** Public URL of the dashboard (DASHBOARD_URL, else the forwarded host), for links in emails. */
export async function dashboardOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host');
  const proto = h.get('x-forwarded-proto') ?? (host?.startsWith('localhost') || host?.startsWith('127.') ? 'http' : 'https');
  const fromEnv = process.env.DASHBOARD_URL?.trim().replace(/\/+$/, '');
  return fromEnv || (host ? `${proto}://${host}` : '');
}

/** The caller's IP as the proxy reports it (for rate limits only). */
export async function clientIp(): Promise<string> {
  const h = await headers();
  return (h.get('x-forwarded-for')?.split(',')[0] ?? h.get('x-real-ip') ?? 'unknown').trim().slice(0, 64);
}
