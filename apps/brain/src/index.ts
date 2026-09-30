// Production entry (container hq-brain): Supabase store, OpenAI embeddings when BRAIN_OPENAI_API_KEY is set.
import { loadConfig } from './config';
import { createEmbedder } from './index/embed';
import { createSupabaseStore } from './store/supabase';
import { log, start } from './main';

const config = loadConfig();
for (const [key, val] of [['BRAIN_INTERNAL_SECRET', config.internalSecret], ['BRAIN_REPO_URL', config.repoUrl]] as const) {
  if (!val) log(`WARNING: ${key} is not set`);
}
const store = createSupabaseStore(config.supabaseUrl, config.supabaseServiceKey);
await start(config, store, createEmbedder(config.embedModel, config.openaiKey));
