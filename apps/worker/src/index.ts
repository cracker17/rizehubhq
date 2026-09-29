// RizeHub HQ worker (docs/05-ORCHESTRATION.md): COO planner, specialist runner, QA reviewer,
// stale-task requeue, idle shuffler, scheduled reports (M7), sales outreach jobs and the internal chat/health endpoint.
import { config, scrubProcessEnv, workerEnv } from './config';
import { sandboxStatus } from './dev/agentUser';
import { createBrain } from './brain';
import { createServiceClient } from './db';
import { createSupabaseHqDb } from './hqdb';
import { createHttpServer } from './http';
import { WorkerLoop } from './loop';
import { listRoleIds, loadRole } from './roles';
import { hasFreeProviderKey, loadModelsConfig, MODEL_PROFILES, parseCandidate, roleEnvVar } from './models/router';
import { MODEL_ROLES } from '@rizehubhq/shared';
import { ModelPicker } from './models/usage';
import { answerChat } from './chat';
import type { WorkerDeps } from './deps';
import { setMcpDeps } from './hermes/mcp';
import { hermesStartupReport } from './hermes/config';
import { startSalesBackground, stopSalesBackground } from './sales/background';

async function main() {
  if (!config.supabaseUrl || !config.supabaseServiceKey) {
    console.log('[worker] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set: nothing to do. Fill .env (see .env.example) and restart.');
    process.exit(0);
  }

  // Secrets leave process.env (kept in the frozen workerEnv() snapshot) so later helpers don't inherit them.
  const scrubbed = scrubProcessEnv();
  const shell = sandboxStatus(workerEnv());
  if (shell.warning) console.warn(shell.warning);
  else console.log(`[worker] agent commands isolated: ${shell.privilegeDrop ? `uid ${workerEnv().AGENT_UID}` : ''}${shell.privilegeDrop && shell.osSandbox ? ' + ' : ''}${shell.osSandbox ? 'DEV_SANDBOX_PREFIX' : ''}`);
  console.log(`[worker] ${scrubbed.length} secret variable(s) removed from process.env`);

  const roles = listRoleIds().map((id) => loadRole(id));
  const models = loadModelsConfig();
  const profile = config.modelProfile ?? models.active_profile;
  if (!(MODEL_PROFILES as readonly string[]).includes(profile) || !models.profiles[profile]) {
    throw new Error(`MODEL_PROFILE "${profile}" is not one of ${MODEL_PROFILES.join(' | ')} (or missing from config/models.yaml)`);
  }
  for (const role of MODEL_ROLES) { // MODEL_ID_<ROLE> overrides must be provider:model, fail fast on typos
    const spec = workerEnv()[roleEnvVar(role)];
    if (spec) parseCandidate(spec.trim());
  }
  const db = createSupabaseHqDb(createServiceClient());
  const picker = new ModelPicker({
    cfg: models, profile, env: workerEnv(), monthlyBudgetUsd: config.monthlyBudgetUsd,
    spentThisMonthUsd: await db.monthSpendUsd().catch(() => 0),
    monthSpend: () => db.monthSpendUsd(),
    dailyBudgetUsd: config.dailyAiBudgetUsd,
  });
  const deps: WorkerDeps = {
    db, brain: createBrain(), pickModel: picker.pick, loadRole: (id) => loadRole(id),
    agentsDir: config.agentsDir, qaThreshold: config.qaThreshold, monthlyBudgetUsd: config.monthlyBudgetUsd,
    onProviderQuota: (p, detail) => picker.markExhausted(p, detail),
  };
  setMcpDeps(deps); // HQ MCP tool server for Hermes agents (POST /mcp)
  const hermes = hermesStartupReport(roles, workerEnv());
  console.log(hermes.line);
  for (const w of hermes.warnings) console.warn(w);
  console.log(`[worker] ${roles.length} agents · profile "${profile}" · budget $${config.monthlyBudgetUsd}/month`
    + `${config.dailyAiBudgetUsd !== null ? ` · $${config.dailyAiBudgetUsd}/day` : ''}`
    + ` · spent $${picker.spentThisMonthUsd.toFixed(2)} · parallel ${config.maxParallelTasks} · QA ≥ ${config.qaThreshold}`);

  const loop = new WorkerLoop(deps, {
    pollIntervalMs: config.pollIntervalMs, maxParallelTasks: config.maxParallelTasks, reportsEveryMs: config.reportsEveryMs,
    dailyBudgetUsd: config.dailyAiBudgetUsd,
    // At 100% of the daily budget paid providers stop; the free profile takes over when its keys exist.
    freeFallback: hasFreeProviderKey(workerEnv()) && !!models.profiles.free,
    onDailySpend: (g) => picker.setDailySpend(g),
  });
  loop.start();
  // Sales outreach (send approved emails, IMAP replies, daily batch, follow-ups): nothing starts unless OUTREACH_ENABLED=true,
  // and nothing is sent without SMTP + CAN-SPAM settings (sales/background.ts).
  const salesTimers = startSalesBackground(deps);

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
    stopSalesBackground(salesTimers);
    await loop.stop();
    process.exit(0);
  };
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { void shutdown(sig); });
}

main().catch((e) => { console.error('[worker] fatal', e); process.exit(1); });
