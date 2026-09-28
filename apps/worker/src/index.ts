// RizeHub HQ worker (docs/05-ORCHESTRATION.md): COO planner, specialist runner, QA reviewer,
// stale-task requeue, idle shuffler and the internal chat/health endpoint.
import { config } from './config';
import { createBrain } from './brain';
import { createServiceClient } from './db';
import { createSupabaseHqDb } from './hqdb';
import { createHttpServer } from './http';
import { WorkerLoop } from './loop';
import { listRoleIds, loadRole } from './roles';
import { loadModelsConfig } from './models/router';
import { ModelPicker } from './models/usage';
import { answerChat } from './chat';
import type { WorkerDeps } from './deps';

async function main() {
  if (!config.supabaseUrl || !config.supabaseServiceKey) {
    console.log('[worker] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set: nothing to do. Fill .env (see .env.example) and restart.');
    process.exit(0);
  }

  const roles = listRoleIds().map((id) => loadRole(id));
  const models = loadModelsConfig();
  const profile = config.modelProfile ?? models.active_profile;
  const db = createSupabaseHqDb(createServiceClient());
  const picker = new ModelPicker({
    cfg: models, profile, env: process.env, monthlyBudgetUsd: config.monthlyBudgetUsd,
    spentThisMonthUsd: await db.monthSpendUsd().catch(() => 0),
  });
  const deps: WorkerDeps = {
    db, brain: createBrain(), pickModel: picker.pick, loadRole: (id) => loadRole(id),
    agentsDir: config.agentsDir, qaThreshold: config.qaThreshold,
    onProviderQuota: (p) => picker.markExhausted(p),
  };
  console.log(`[worker] ${roles.length} agents · profile "${profile}" · budget $${config.monthlyBudgetUsd}/month`
    + ` · spent $${picker.spentThisMonthUsd.toFixed(2)} · parallel ${config.maxParallelTasks} · QA ≥ ${config.qaThreshold}`);

  const loop = new WorkerLoop(deps, { pollIntervalMs: config.pollIntervalMs, maxParallelTasks: config.maxParallelTasks });
  loop.start();

  const server = createHttpServer({
    chat: (agentId, question) => answerChat(agentId, question, deps),
    health: () => ({ running: loop.running.size, profile }),
  }, config.internalSecret);
  if (!config.internalSecret) console.warn('[worker] HQ_INTERNAL_SECRET not set: /chat and /health answer 503');
  server.listen(config.httpPort, '0.0.0.0', () => console.log(`[worker] internal API on :${config.httpPort}`));

  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worker] ${sig}: stopping (running tasks are re-queued)`);
    server.close();
    await loop.stop();
    process.exit(0);
  };
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { void shutdown(sig); });
}

main().catch((e) => { console.error('[worker] fatal', e); process.exit(1); });
