// RizeHub HQ Operator (docs/17-OPERATOR.md): watches client chats through the workspace browsers, drafts replies with
// Claude and the HQ Brain, and sends only what the tiers / the CEO approved. Its own container (hq-operator): the only
// HQ process that can reach the workspace browsers over CDP, and it holds no Telegram token.
// Worker mode (phase 2, jobs/): tasks run by a Claude agent with the client's browser + tools, QA'd, outside-world
// changes only after the CEO's ✅, client updates through the tiers, memories to the Brain, login checks.
import { workerEnv, scrubProcessEnv, config } from 'worker/src/config';
import { createServiceClient } from 'worker/src/db';
import { manilaDayStartIso } from 'worker/src/budget';
import { loadModelsConfig } from 'worker/src/models/router';
import { createSupabaseProviderKeyStore } from 'worker/src/settings/store';
import { effectiveAi, routerEnv, RuntimeSettings } from 'worker/src/settings/runtime';
import { loadKeyring } from 'worker/src/vault/crypto';
import { sandboxStatus } from 'worker/src/dev/agentUser';
import { defaultDevEnv } from 'worker/src/dev/env';
import { openJail } from 'worker/src/dev/jail';
import { BASE_ALLOWED_HOSTS, runSandboxed, ShellRefusal } from 'worker/src/dev/shell';
import { defaultNetEnv } from 'worker/src/research/net';
import { gate, operatorModel } from './ai';
import { classifyMessage } from './classify';
import { cdpEndpointFor, loadOperatorConfig } from './config';
import { createSupabaseOperatorDb } from './db';
import { BrowserPool, chatPage } from './browser/cdp';
import { selectors } from './browser/chatDom';
import { readChat, sendReply } from './browser/googleChat';
import { Operator, type ChatDriver } from './operator';
import { createSupabaseJobDb } from './jobs/db';
import { JobLoop } from './jobs/loop';
import { runQa } from './jobs/qa';
import { runJobAgent } from './jobs/runner';
import { dailyDue, jailName, terminalAllowed, tokenSource } from './jobs/wire';
import { checkLogins } from './logins';

async function main() {
  if (!config.supabaseUrl || !config.supabaseServiceKey) {
    console.log('[operator] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set: nothing to do.');
    return idle();
  }
  // Secrets leave process.env (kept in the frozen workerEnv() snapshot) so the Claude Code child never inherits them.
  scrubProcessEnv();
  const cfg = loadOperatorConfig(workerEnv());
  if (!cfg.enabled) {
    console.log('[operator] OPERATOR_ENABLED is off: idle. Set it to true in .env.operator and restart the container.');
    return idle();
  }

  const sb = createServiceClient();
  const db = createSupabaseOperatorDb(sb);
  const runtime = new RuntimeSettings({ store: createSupabaseProviderKeyStore(sb), keyring: () => loadKeyring(workerEnv()) });
  await runtime.refresh().catch((e) => console.log(`[operator] dashboard settings not read yet: ${e instanceof Error ? e.message : e}`));
  runtime.start();
  const models = loadModelsConfig();
  const sel = selectors(cfg.selectorOverrides);
  const pool = new BrowserPool((profile) => cdpEndpointFor(profile, workerEnv()));

  const chat: ChatDriver = {
    read: (client, ch) => pool.with(client.profile, async (ctx) => readChat((await chatPage(ctx, ch.url)).page, sel, client.my_names)),
    send: (client, ch, input, steps) => pool.with(client.profile, async (ctx) => {
      const { page } = await chatPage(ctx, ch.url);
      await steps.step?.('browser.open', { channel: ch.name });
      return sendReply(page, sel, input, steps);
    }),
  };

  // One gate for both paid paths; only the per-call cap differs (a message vs a run of a job).
  const gateFor = (capUsd: number) => async () => {
    const env = workerEnv();
    const ai = effectiveAi(env, runtime.snapshot, models);
    const model = operatorModel(cfg.modelRole, models, routerEnv(env, runtime.snapshot?.dashboard), ai.profile);
    const [monthUsd, dayUsd] = await Promise.all([db.monthSpendUsd(), db.spendSinceUsd(manilaDayStartIso())]);
    return gate({ env, ai, spend: { monthUsd, dayUsd }, model, maxUsdPerMessage: capUsd });
  };

  const op = new Operator({
    db, chat, pollMs: cfg.pollMs, sends: cfg.sends,
    gate: gateFor(cfg.maxUsdPerMessage),
    classify: (o) => classifyMessage({ ...o, env: workerEnv() }),
  });

  // ---------- worker mode (jobs) ----------
  const jobDb = createSupabaseJobDb(sb);
  const withProfile = (profile: string) => <T>(fn: (ctx: import('playwright-core').BrowserContext) => Promise<T>) => pool.with(profile, fn);
  const net = defaultNetEnv();
  const sandbox = sandboxStatus(workerEnv());
  const devEnv = terminalAllowed(sandbox)
    ? { ...defaultDevEnv({ store: () => { throw new Error('the vault is not available to job commands'); }, keyring: () => null }), workspacesDir: cfg.workspacesDir }
    : null;
  const jobs = new JobLoop({
    db: jobDb, op: db, withProfile,
    gate: gateFor(cfg.maxUsdPerJobRun),
    runAgent: (c) => runJobAgent({ ...c, env: workerEnv() }),
    qa: (urls, withCtx) => runQa(urls, { withCtx, net }),
    api: {
      http: { fetch: (...a) => fetch(...a), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
      tokens: tokenSource({ vaultToken: (c, p, k) => jobDb.vaultToken(c, p, k), keyring: () => loadKeyring(workerEnv()), env: workerEnv, log: console.log }),
      env: workerEnv(),
    },
    net, chat, sends: cfg.sends,
    terminal: devEnv
      ? (jobId) => async (command, cwd, timeoutS) => {
        try { return await runSandboxed(devEnv, openJail(devEnv.workspacesDir, jailName(jobId)), BASE_ALLOWED_HOSTS, { command, cwd, timeout_s: timeoutS }); }
        catch (e) { if (e instanceof ShellRefusal) return `Refused: ${e.message}`; throw e; }
      }
      : undefined,
  });
  const loginCheck = () => checkLogins({
    logins: () => jobDb.logins(),
    profileOf: async (slug) => (await db.clients()).find((c) => c.slug === slug)?.profile ?? null,
    withProfile,
    record: (c, s, st, d) => jobDb.loginChecked(c, s, st, d),
    log: console.log,
  });
  let lastDaily: string | null = null;
  const daily = async () => {
    if (!dailyDue(lastDaily, Date.now())) return;
    lastDaily = new Date().toISOString();
    const pruned = await jobDb.pruneEvidence(30).catch((e) => { console.error(`[operator] evidence prune: ${e instanceof Error ? e.message : e}`); return 0; });
    const promoted = await jobDb.promoteMemory().catch(() => 0);
    console.log(`[operator] daily: ${pruned} old screenshot(s) pruned, ${promoted} memory note(s) promoted`);
  };

  console.log(`[operator] running: poll every ${cfg.pollMs / 1000}s, sends ${cfg.sends ? 'on' : 'OFF (OPERATOR_SENDS)'}, model role ${cfg.modelRole}`);
  console.log(cfg.jobs
    ? `[operator] worker mode on: ≤ $${cfg.maxUsdPerJobRun} per job run, login checks every ${Math.round(cfg.loginCheckMs / 60_000)} min, terminal ${devEnv ? 'on (isolated)' : 'off (agent commands are not isolated here)'}`
    : '[operator] worker mode OFF (OPERATOR_JOBS)');
  let stopping = false;
  const loop = (name: string, everyMs: number, fn: () => Promise<unknown>) => {
    let busy = false;
    const t = setInterval(() => {
      if (busy || stopping) return;
      busy = true;
      fn().catch((e) => console.error(`[operator] ${name} tick failed: ${e instanceof Error ? e.message : e}`)).finally(() => { busy = false; });
    }, everyMs);
    return () => clearInterval(t);
  };
  const stops = [
    loop('watch', Math.min(cfg.pollMs, 15_000), () => op.watchTick()),
    loop('classify', cfg.tickMs, () => op.classifyTick()),
    loop('send', cfg.tickMs, () => op.sendTick()),
    ...(cfg.jobs ? [
      loop('job', cfg.jobTickMs, () => jobs.jobTick()),
      loop('action', cfg.tickMs, () => jobs.actionTick()),
      loop('update', cfg.tickMs, () => jobs.updateTick()),
      loop('verify', 60_000, () => jobs.verifyStaleTick()),
      loop('logins', cfg.loginCheckMs, loginCheck),
      loop('daily', 3600_000, daily),
    ] : []),
    // Heartbeat for /operator and /status: the dashboard shows "offline" when it is older than 3 minutes.
    loop('heartbeat', 60_000, async () => {
      await sb.from('settings').upsert({ key: 'operator_heartbeat', value: { at: new Date().toISOString(), sends: cfg.sends, poll_ms: cfg.pollMs } });
    }),
  ];
  if (cfg.jobs) {
    // Once at start (after a restart is exactly when a login may be gone), then on the loops above.
    setTimeout(() => { loginCheck().catch((e) => console.error(`[operator] login check: ${e instanceof Error ? e.message : e}`)); }, 15_000).unref();
    daily().catch(() => undefined);
  }
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      stopping = true;
      for (const s of stops) s();
      pool.forgetAll();
      setTimeout(() => process.exit(0), 500).unref();
    });
  }
}

/** Keeps the container up without doing anything (restart: unless-stopped would otherwise loop). */
function idle() {
  setInterval(() => undefined, 3600_000);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => process.exit(0));
}

main().catch((e) => { console.error('[operator] fatal', e); process.exit(1); });
