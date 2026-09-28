// RizeHub HQ worker (docs/05-ORCHESTRATION.md). M0 skeleton: validates config and roles,
// then runs the scheduler loop. Planning, task running and QA arrive in M5–M6.
import { config } from './config';
import { listRoleIds, loadRole } from './roles';
import { loadModelsConfig } from './models/router';

const roles = listRoleIds().map((id) => loadRole(id));
const models = loadModelsConfig();
const profile = config.modelProfile ?? models.active_profile;
console.log(`[worker] ${roles.length} agents loaded · model profile "${profile}" · budget $${config.monthlyBudgetUsd}/month`);

let stopping = false;
async function tick() {
  // M5: planStagedRequests(); M6: claim_next_task() → runTask(); reviewQaPending(); executeApprovedActions()
  // M8: idle shuffler (./idle.ts) writes agents.idle_activity every 90 s
}

async function loop() {
  while (!stopping) {
    try { await tick(); } catch (e) { console.error('[worker] tick failed', e); }
    await new Promise((r) => setTimeout(r, config.pollIntervalMs));
  }
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { stopping = true; console.log('[worker] stopping'); });
loop();
