import { createClient } from '@supabase/supabase-js';
import type { Store } from './types';

export function createSupabaseStore(url: string, serviceKey: string): Store {
  if (!url || !serviceKey) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (see .env.example)');
  const client = createClient(url, serviceKey, { auth: { persistSession: false } });
  return {
    async rpc<T>(fn: string, args: Record<string, unknown> = {}) {
      const { data, error } = await client.rpc(fn, args);
      if (error) throw new Error(`${fn}: ${error.message}`);
      return data as T;
    },
  };
}
