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
import { listApprovedGmailSends, startGmailSender } from './connectors/gmailSend';
import { executeApprovedMcpCalls, listApprovedMcpCalls } from './connectors/mcpExecute';
import { createMcpOpener } from './connectors/mcpClient';
import { createSupabaseConnectorStore } from './connectors/store';
import { loadKeyring } from './vault/crypto';
import { transcribeAudio } from './models/transcribe';
import { startVoiceNotes, supabaseVoiceNoteDeps } from './voiceNotes';
import { EXTRA_ROUTES } from './routes';
import { createSettingsRoutes } from './routes/settings';
import { createSupabaseProviderKeyStore } from './settings/store';
import { effectiveAi, loopDailyBudget, routerEnv, RuntimeSettings } from './settings/runtime';

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
  const envProfile = config.modelProfile ?? models.active_profile;
  if (!(MODEL_PROFILES as readonly string[]).includes(envProfile) || !models.profiles[envProfile]) {
    throw new Error(`MODEL_PROFILE "${envProfile}" is not one of ${MODEL_PROFILES.join(' | ')} (or missing from config/models.yaml)`);
  }
  for (const role of MODEL_ROLES) { // MODEL_ID_<ROLE> overrides must be provider:model, fail fast on typos
    const spec = workerEnv()[roleEnvVar(role)];
    if (spec) parseCandidate(spec.trim());
  }
  const sb = createServiceClient();
  const db = createSupabaseHqDb(sb);

  // Admin → API & AI (docs/14 "Dashboard settings"): provider keys + profile / budgets / per-role models the CEO sets in
  // the dashboard win over .env. Re-read every 60 s and on POST /settings/reload; no restart needed.
  const keyring = (() => {
    try { return loadKeyring(workerEnv()); } catch (e) { console.warn(`[settings] vault keyring unusable (${e instanceof Error ? e.message : 'error'}): dashboard keys are ignored`); return null; }
  })();
  let picker: ModelPicker | undefined;
  let loop: WorkerLoop | undefined;
  const runtime = new RuntimeSettings({
    store: createSupabaseProviderKeyStore(sb), keyring: () => keyring,
    onChange: (snap, changes) => {
      if (!picker) return;
      const next = effectiveAi(workerEnv(), snap, models);
      if (changes.length) for (const w of next.warnings) console.warn(`[settings] ${w}`);
      picker.configure({ profile: next.profile, monthlyBudgetUsd: next.monthlyBudgetUsd, env: routerEnv(workerEnv(), snap.dashboard) });
      loop?.globalBudget.invalidate();
    },
  });
  await runtime.refresh().catch((e) => console.warn(`[settings] dashboard settings not loaded at startup, .env values in use: ${e instanceof Error ? e.message.slice(0, 200) : 'error'}`));
  const ai = effectiveAi(workerEnv(), runtime.snapshot, models);
  for (const w of ai.warnings) console.warn(`[settings] ${w}`);
  const activePicker = new ModelPicker({
    cfg: models, profile: ai.profile, env: routerEnv(workerEnv(), runtime.snapshot?.dashboard), monthlyBudgetUsd: ai.monthlyBudgetUsd,
    spentThisMonthUsd: await db.monthSpendUsd().catch(() => 0),
    monthSpend: () => db.monthSpendUsd(),
    dailyBudgetUsd: loopDailyBudget(runtime.snapshot?.dashboard, config.dailyAiBudgetUsd),
  });
  picker = activePicker;
  const stopSettings = runtime.start(60_000);
  const deps: WorkerDeps = {
    db, brain: createBrain(), pickModel: activePicker.pick, loadRole: (id) => loadRole(id),
    agentsDir: config.agentsDir, qaThreshold: config.qaThreshold,
    get monthlyBudgetUsd() { return activePicker.settings.monthlyBudgetUsd; },
    onProviderQuota: (p, detail) => activePicker.markExhausted(p, detail),
  };
  setMcpDeps(deps); // HQ MCP tool server for Hermes agents (POST /mcp)
  const hermes = hermesStartupReport(roles, workerEnv());
  console.log(hermes.line);
  for (const w of hermes.warnings) console.warn(w);
  console.log(`[worker] ${roles.length} agents · profile "${ai.profile}" (${ai.profileSource}) · budget $${ai.monthlyBudgetUsd}/month (${ai.monthlySource})`
    + `${ai.dailyBudgetUsd !== null ? ` · $${ai.dailyBudgetUsd}/day (${ai.dailySource})` : ''}`
    + `${runtime.snapshot?.keys.length ? ` · ${runtime.snapshot.keys.length} dashboard key(s)` : ''}`
    + ` · spent $${activePicker.spentThisMonthUsd.toFixed(2)} · parallel ${config.maxParallelTasks} · QA ≥ ${config.qaThreshold}`);

  const activeLoop = new WorkerLoop(deps, {
    pollIntervalMs: config.pollIntervalMs, maxParallelTasks: config.maxParallelTasks, reportsEveryMs: config.reportsEveryMs,
    dailyBudgetUsd: () => loopDailyBudget(runtime.snapshot?.dashboard, config.dailyAiBudgetUsd),
    // At 100% of the daily budget paid providers stop; the free profile takes over when its keys exist (read live:
    // the CEO may add a free key in the dashboard).
    freeFallback: () => hasFreeProviderKey(workerEnv()) && !!models.profiles.free,
    onDailySpend: (g) => activePicker.setDailySpend(g),
  });
  loop = activeLoop;
  activeLoop.start();
  // Sales outreach (send approved emails, IMAP replies, daily batch, follow-ups): nothing starts unless OUTREACH_ENABLED=true,
  // and nothing is sent without SMTP + CAN-SPAM settings (sales/background.ts).
  const salesTimers = startSalesBackground(deps);

  // Emails the CEO approved from connected Gmail accounts (gmail_send → gmail.send approval → sent once, docs/15 §5).
  const gmailSender = startGmailSender({
    deps: {
      list: listApprovedGmailSends(sb),
      exec: async (id, phase, result = {}) => {
        const r = await sb.rpc('external_action_exec', { p_approval: id, p_phase: phase, p_result: result });
        if (r.error) throw new Error(`external_action_exec: ${r.error.message}`);
        return Boolean(r.data);
      },
      store: createSupabaseConnectorStore(sb), keyring: loadKeyring(workerEnv()),
      log: (m) => console.log(m),
    },
    paused: async () => { const v = (await db.getSettings().catch(() => ({} as Record<string, unknown>))).paused; return v === true || v === 'true'; },
  });
  // App tool calls the CEO approved (mcp.call, docs/15 §3), same cadence and pause rule.
  const execDb = async (id: string, phase: 'claim' | 'done' | 'failed', result: Record<string, unknown> = {}) => {
    const r = await sb.rpc('external_action_exec', { p_approval: id, p_phase: phase, p_result: result });
    if (r.error) throw new Error(`external_action_exec: ${r.error.message}`);
    return Boolean(r.data);
  };
  let mcpBusy = false;
  const mcpRunner = setInterval(() => {
    if (mcpBusy) return;
    mcpBusy = true;
    void (async () => {
      const v = (await db.getSettings().catch(() => ({} as Record<string, unknown>))).paused;
      if (v === true || v === 'true') return;
      await executeApprovedMcpCalls({
        list: listApprovedMcpCalls(sb), exec: execDb, store: createSupabaseConnectorStore(sb), keyring: loadKeyring(workerEnv()),
        open: createMcpOpener((workerEnv().DASHBOARD_URL ?? 'https://hq.rizehub.ph').replace(/\/+$/, '')), log: (m) => console.log(m),
      });
    })().catch((e) => console.error('[mcp] approved-call loop failed', e instanceof Error ? e.message : e)).finally(() => { mcpBusy = false; });
  }, 15_000);
  mcpRunner.unref?.();
  // Telegram voice notes: the bot queues clips in voice_notes; transcribed here with config/models.yaml `transcription:`.
  const voiceNotes = startVoiceNotes({
    ...supabaseVoiceNoteDeps(sb),
    transcribe: (audio, type) => transcribeAudio(audio, type, { cfg: loadModelsConfig(), env: workerEnv() }),
    warn: (m) => console.warn(m),
  });

  const settingsRoutes = createSettingsRoutes({
    store: () => createSupabaseProviderKeyStore(sb), keyring: () => keyring, runtime: () => runtime,
    aiStatus: () => {
      const now = effectiveAi(workerEnv(), runtime.snapshot, models);
      const empty = { profile: null, monthlyBudgetUsd: null, dailyBudgetUsd: null, modelIds: {} };
      const defaults = effectiveAi(workerEnv(), { dashboard: empty, legacyDaily: runtime.snapshot?.legacyDaily }, models);
      return {
        ai: { ...now, profile: activePicker.settings.profile },
        defaults: { profile: defaults.profile, monthlyBudgetUsd: defaults.monthlyBudgetUsd, dailyBudgetUsd: defaults.dailyBudgetUsd, modelIds: defaults.modelIds },
        models: Object.fromEntries(MODEL_ROLES.map((r) => [r, activePicker.preview(r)])),
        paidBlocked: activePicker.paidBlocked,
      };
    },
  });
  const server = createHttpServer({
    chat: (agentId, question) => answerChat(agentId, question, deps),
    health: () => ({ running: activeLoop.running.size, profile: activePicker.settings.profile }),
  }, config.internalSecret, [...EXTRA_ROUTES, ...settingsRoutes]);
  if (!config.internalSecret) console.warn('[worker] HQ_INTERNAL_SECRET not set: /chat and /health answer 503');
  server.listen(config.httpPort, '0.0.0.0', () => console.log(`[worker] internal API on :${config.httpPort}`));

  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worker] ${sig}: stopping (running tasks are re-queued)`);
    server.close();
    stopSalesBackground(salesTimers);
    clearInterval(gmailSender);
    clearInterval(mcpRunner);
    clearInterval(voiceNotes);
    stopSettings();
    await activeLoop.stop();
    process.exit(0);
  };
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { void shutdown(sig); });
}

main().catch((e) => { console.error('[worker] fatal', e); process.exit(1); });
