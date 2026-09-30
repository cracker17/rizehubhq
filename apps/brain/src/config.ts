// Brain service config (docs/16-BRAIN.md). Read once from the environment; secrets never leave this object.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

export interface BrainConfig {
  httpPort: number;
  /** dashboard → brain: header x-brain-secret */
  internalSecret: string;
  /** GitHub webhook HMAC secret (X-Hub-Signature-256) */
  webhookSecret: string;
  /** git remote of the vault (git@github.com:… on the VPS, a local path in dev) */
  repoUrl: string;
  branch: string;
  vaultDir: string;
  /** SSH private key with access to the vault repo (deploy key); empty = plain git (local paths, dev) */
  deployKeyPath: string;
  /** known_hosts with GitHub's host keys (pinned at deploy time); empty = ~/.ssh/known_hosts */
  knownHostsPath: string;
  pollSeconds: number;
  supabaseUrl: string;
  supabaseServiceKey: string;
  /** OpenAI key for embeddings only (separate from the worker's OPENAI_API_KEY); empty = keyword-only index */
  openaiKey: string;
  /** provider:model, e.g. openai:text-embedding-3-small */
  embedModel: string;
  /** extra https hosts OAuth clients may redirect to, besides claude.ai / claude.com and loopback (comma-separated) */
  oauthRedirectHosts: string[];
  /** IANA zone for dates written into the vault (session file names, "updated:", decisions) */
  timeZone: string;
}

export const DEFAULT_EMBED_MODEL = 'openai:text-embedding-3-small';

/** First entry of `embeddings:` in config/models.yaml (models never hard-coded in code: CLAUDE.md rule 8). */
export function embedModelFromFile(file: string): string | null {
  try {
    const cfg = YAML.parse(fs.readFileSync(file, 'utf8')) as { embeddings?: unknown };
    const first = Array.isArray(cfg?.embeddings) ? cfg.embeddings[0] : null;
    return typeof first === 'string' && first.includes(':') ? first : null;
  } catch {
    return null;
  }
}

const int = (v: string | undefined, def: number, min: number, max: number) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : def;
};

const validZone = (z: string | undefined) => {
  if (!z) return null;
  try { new Intl.DateTimeFormat('en-CA', { timeZone: z }); return z; } catch { return null; }
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BrainConfig {
  const modelsFile = env.MODELS_FILE || path.resolve(process.cwd(), '../../config/models.yaml');
  return {
    httpPort: int(env.BRAIN_HTTP_PORT, 4100, 1, 65535),
    internalSecret: env.BRAIN_INTERNAL_SECRET ?? '',
    webhookSecret: env.BRAIN_WEBHOOK_SECRET ?? '',
    repoUrl: env.BRAIN_REPO_URL ?? '',
    branch: env.BRAIN_REPO_BRANCH || 'main',
    vaultDir: env.BRAIN_VAULT_DIR || '/data/vault',
    deployKeyPath: env.BRAIN_DEPLOY_KEY_PATH ?? '',
    knownHostsPath: env.BRAIN_KNOWN_HOSTS_PATH ?? '',
    pollSeconds: int(env.BRAIN_POLL_SECONDS, 300, 30, 86_400),
    supabaseUrl: env.SUPABASE_URL ?? '',
    supabaseServiceKey: env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    openaiKey: env.BRAIN_OPENAI_API_KEY ?? '',
    embedModel: env.BRAIN_EMBED_MODEL || embedModelFromFile(modelsFile) || DEFAULT_EMBED_MODEL,
    oauthRedirectHosts: (env.BRAIN_OAUTH_REDIRECT_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase())
      .filter((h) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h)),
    timeZone: validZone(env.BRAIN_TIMEZONE) ?? 'Asia/Manila',
  };
}
