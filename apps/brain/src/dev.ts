// Local run against the real vault, no Supabase or Docker needed: PGlite (+ pgvector) with the real migrations, a fresh
// clone of the vault (BRAIN_REPO_URL, default ../../../claude-memory-vault next to the HQ repo) into a temp dir.
//   pnpm dev:brain                      keyword-only (or real OpenAI embeddings if apps/brain/.env.local has the key)
//   BRAIN_FAKE_EMBEDDINGS=1 pnpm dev:brain   exercise the vector path with deterministic fake embeddings
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './config';
import { createEmbedder, fakeEmbedder } from './index/embed';
import { createPgliteStore, defaultMigrationsDir } from './store/pglite';
import { log, start } from './main';

const envLocal = path.resolve(import.meta.dirname, '../.env.local'); // gitignored (.env.*)
if (fs.existsSync(envLocal)) process.loadEnvFile(envLocal);

const guessVault = path.resolve(import.meta.dirname, '../../../../claude-memory-vault');
const env = {
  ...process.env,
  BRAIN_REPO_URL: process.env.BRAIN_REPO_URL || (fs.existsSync(guessVault) ? guessVault : ''),
  BRAIN_VAULT_DIR: process.env.BRAIN_VAULT_DIR || path.join(os.tmpdir(), `hq-brain-dev-${process.pid}`, 'vault'),
  BRAIN_INTERNAL_SECRET: process.env.BRAIN_INTERNAL_SECRET || 'dev-brain-secret',
  BRAIN_WEBHOOK_SECRET: process.env.BRAIN_WEBHOOK_SECRET || 'dev-webhook-secret',
};
const config = loadConfig(env);
if (!config.repoUrl) {
  log(`no vault found: set BRAIN_REPO_URL to the vault folder (looked at ${guessVault})`);
  process.exit(0);
}
const store = await createPgliteStore(defaultMigrationsDir());
const embedder = process.env.BRAIN_FAKE_EMBEDDINGS === '1' ? fakeEmbedder() : createEmbedder(config.embedModel, config.openaiKey);
log(`DEV: PGlite in memory · internal secret "${config.internalSecret}" · clone in ${config.vaultDir}`);
await start(config, store, embedder);
