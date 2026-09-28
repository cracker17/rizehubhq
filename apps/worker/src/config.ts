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
  maxParallelTasks: num('MAX_PARALLEL_TASKS', 2),
  monthlyBudgetUsd: num('MONTHLY_BUDGET_USD', 0),
  modelProfile: process.env.MODEL_PROFILE,
  qaThreshold: num('QA_THRESHOLD', 85),
  httpPort: num('WORKER_HTTP_PORT', 4000),
  internalSecret: process.env.HQ_INTERNAL_SECRET ?? '',
};
