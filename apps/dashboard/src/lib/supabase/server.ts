import 'server-only';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { supabaseEnv } from '@/lib/env';

/**
 * Supabase client for Server Components and Server Actions, acting as the signed-in user
 * (anon key + session cookie), so RLS (`is_ceo()`) applies. Never uses the service-role key.
 * Returns null in DEMO mode.
 */
export async function createSupabaseServer() {
  const env = supabaseEnv();
  if (!env) return null;
  const store = await cookies();
  return createServerClient(env.url, env.anonKey, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) store.set(name, value, options);
        } catch {
          // Called from a Server Component: cookies are read-only there. The middleware refreshes the session.
        }
      },
    },
  });
}
