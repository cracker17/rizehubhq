'use client';
import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

/** Browser client (used for Realtime only). Config comes from the server so one build serves both modes. */
export function getSupabaseBrowser(cfg: { url: string; anonKey: string }): SupabaseClient {
  if (!client) client = createBrowserClient(cfg.url, cfg.anonKey);
  return client;
}
