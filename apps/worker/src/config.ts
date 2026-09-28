import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../../..');

function num(name: string, fallback: number) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : Number(v);
}

export const config = {
  root,
  agentsDir: process.env.AGENTS_DIR ?? path.join(root, 'agents'),
  brainDir: process.env.BRAIN_DIR ?? path.join(root, 'brain'),
  workspacesDir: process.env.WORKSPACES_DIR ?? path.join(root, 'workspaces'),
  modelsFile: process.env.MODELS_FILE ?? path.join(root, 'config', 'models.yaml'),
  supabaseUrl: process.env.SUPABASE_URL ?? '',
  supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  pollIntervalMs: num('POLL_INTERVAL_MS', 3000),
  reportsEveryMs: num('REPORTS_CHECK_MS', 60_000),
  maxParallelTasks: num('MAX_PARALLEL_TASKS', 2),
  monthlyBudgetUsd: num('MONTHLY_BUDGET_USD', 0),
  modelProfile: process.env.MODEL_PROFILE,
  qaThreshold: num('QA_THRESHOLD', 85),
  httpPort: num('WORKER_HTTP_PORT', 4000),
  internalSecret: process.env.HQ_INTERNAL_SECRET ?? '',
};

// ---------- secret env (docs/09 "Env scrubbing") ----------
// The worker keeps every secret in ONE frozen snapshot and removes them from process.env at startup
// (scrubProcessEnv, called by index.ts), so helpers that inherit process.env (ffmpeg, lighthouse, Chromium,
// anything spawned later) never carry them. Note: /proc/<pid>/environ always shows the ORIGINAL environment of
// a process (it is the initial stack copy, not the live `environ`), so scrubbing is hygiene, not a boundary.
// The boundary is the privilege drop in dev/agentUser.ts (agent commands run under another uid).

/** Names that hold secrets. */
export const SECRET_ENV = /(^|_)(KEY|KEYS|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PAT)(_|$)|^SUPABASE_DB_URL$/;
/**
 * Secret names still read from process.env by code outside this module's control (vault/crypto.ts
 * loadKeyring() default, used by tools/vault.ts). Kept until those readers take workerEnv().
 */
export const SCRUB_KEEP = new Set<string>(); // every secret reader uses workerEnv()

let snapshot: Readonly<Record<string, string | undefined>> | null = null;

/** The worker's configuration env: the frozen startup snapshot after scrubProcessEnv(), process.env before. */
export function workerEnv(): Readonly<Record<string, string | undefined>> {
  return snapshot ?? process.env;
}

/** Freezes a copy of env as workerEnv() and deletes secret-looking names from env. Returns the removed names. */
export function scrubProcessEnv(env: NodeJS.ProcessEnv = process.env, keep: ReadonlySet<string> = SCRUB_KEEP): string[] {
  snapshot = Object.freeze({ ...env });
  const removed: string[] = [];
  for (const k of Object.keys(env)) {
    if (SECRET_ENV.test(k) && !keep.has(k)) { delete env[k]; removed.push(k); }
  }
  return removed;
}

/** Test hook: forget the snapshot (workerEnv() reads process.env again). */
export function resetWorkerEnvForTests(): void { snapshot = null; }

/** env without secret names (for helpers like Chromium, lighthouse, ffmpeg). */
export function publicEnv(env: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !SECRET_ENV.test(k)) out[k] = v;
  return out;
}
