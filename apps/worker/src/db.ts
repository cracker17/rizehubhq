import { createClient } from '@supabase/supabase-js';
import { config } from './config';

export function createServiceClient() {
  if (!config.supabaseUrl || !config.supabaseServiceKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (see .env.example)');
  }
  return createClient(config.supabaseUrl, config.supabaseServiceKey, { auth: { persistSession: false } });
}
