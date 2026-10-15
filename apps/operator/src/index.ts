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
import { isSignedOut, readWatched, watchSelectors, WatchSignedOutError } from './browser/watchers';
import { listSelectors, readUnreadList } from './browser/discover';
import { composeSelectors, composeSend, composeUrl, sendTestText, testSeen } from './browser/compose';
import { SignedOutError } from './browser/googleChat';
import type { BrowserContext, Page } from 'playwright-core';
import type { OperatorAccount, OperatorChannel, OperatorClient } from './db';
import { startHookServer } from './hooks';
import { sendWhatsApp } from './whatsapp';
import { MaybeSentError } from './browser/googleChat';
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

  // Unread sweep: one tab per app account, reused (opened again when the browser reconnected).
  const sweepTabs = new Map<string, Page>();
  const sweepPage = async (ctx: BrowserContext, acc: OperatorAccount): Promise<Page> => {
    const p = sweepTabs.get(acc.id);
    if (p && !p.isClosed() && p.context() === ctx) return p;
    const np = await ctx.newPage();
    sweepTabs.set(acc.id, np);
    return np;
  };
  const signedOut = (kind: OperatorAccount['kind'], url: string) => {
    if (kind === 'google_chat') { if (/accounts\.google\.com|\/ServiceLogin/i.test(url)) throw new SignedOutError(); return; }
    if (isSignedOut(kind, url)) throw new WatchSignedOutError(kind);
  };
  const readPage = (page: Page, client: OperatorClient, ch: OperatorChannel) => {
    const kind = ch.kind;
    if (kind === 'google_chat') return readChat(page, sel, client.my_names);
    if (kind === 'whatsapp') return Promise.resolve({ title: ch.name, messages: [] });
    return readWatched(page, kind, watchSelectors(kind, cfg.watchOverrides[kind]), client.my_names);
  };

  const chat: ChatDriver = {
    sweep: (client, acc) => pool.with(client.profile, async (ctx) => {
      if (acc.kind === 'gmail') return [];
      const page = await sweepPage(ctx, acc);
      await page.goto(acc.home_url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      signedOut(acc.kind, page.url());
      await page.waitForTimeout(3000);
      signedOut(acc.kind, page.url());
      return readUnreadList(page, acc.kind, listSelectors(acc.kind, cfg.discoverOverrides[acc.kind]));
    }),
    readAt: (client, acc, ch) => pool.with(client.profile, async (ctx) => {
      const page = await sweepPage(ctx, acc);
      await page.goto(ch.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForTimeout(2500);
      return readPage(page, client, ch);
    }),
    read: (client, ch) => (ch.kind === 'whatsapp' ? Promise.resolve({ title: ch.name, messages: [] }) : pool.with(client.profile, async (ctx) => {
      const { page } = await chatPage(ctx, ch.url);
      return readPage(page, client, ch);
    })),
    send: (client, ch, input, steps) => (ch.kind === 'whatsapp'
      // WhatsApp Business: the Cloud API, not the browser (whatsapp.ts). threadKey = the customer, externalId = their wamid.
      ? sendWhatsApp({
        env: workerEnv(), client: client.slug, phoneId: ch.wa_phone_id ?? '', to: input.threadKey, text: input.text,
        replyTo: input.quote ? input.externalId : null, fetch: (...a) => fetch(...a), maySent: (m) => new MaybeSentError(m),
        lastCheck: steps.lastCheck,
        lastInbound: async () => {
          const { data, error } = await sb.rpc('operator_whatsapp_last_inbound', { p_channel: ch.id, p_wa: input.threadKey });
          if (error) throw new Error(error.message);
          return (data as string | null) ?? null;
        },
      })
      : pool.with(client.profile, async (ctx) => {
      // SQL hands out Slack / Teams / Gmail rows only with a passed send test + posting on (operator_channel_posts).
      const kind = ch.kind;
      if (kind === 'whatsapp') throw new Error('WhatsApp is sent by the API');
      if (kind === 'google_chat') {
        const { page } = await chatPage(ctx, ch.url);
        await steps.step?.('browser.open', { channel: ch.name });
        return sendReply(page, sel, input, steps);
      }
      const url = composeUrl(kind, ch.url, input.threadKey);
      if (!url) throw new Error(`no ${kind} thread to reply in (the message has no thread id): post it yourself`);
      const page = await ctx.newPage();
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        if (isSignedOut(kind, page.url())) throw new WatchSignedOutError(kind);
        await page.waitForTimeout(3000);
        await steps.step?.('browser.open', { channel: ch.name, kind });
        return await composeSend(page, kind, composeSelectors(kind, cfg.watchOverrides[kind]), input, steps);
      } finally { await page.close().catch(() => undefined); }
    })),
    sendTest: (client, kind, url) => pool.with(client.profile, async (ctx) => {
      const page = await ctx.newPage();
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        if (isSignedOut(kind, page.url())) return { ok: false, detail: `signed out of ${kind}: log in through the viewer` };
        await page.waitForTimeout(3000);
        const text = sendTestText();
        const r = await composeSend(page, kind, composeSelectors(kind, cfg.watchOverrides[kind]), { text }, { lastCheck: async () => null });
        if (!r.sent) return { ok: false, detail: 'not sent' };
        await page.waitForTimeout(4000);
        if (kind === 'gmail') return { ok: true, detail: 'sent from the Gmail composer (check the thread)' };
        const back = await readWatched(page, kind, watchSelectors(kind, cfg.watchOverrides[kind]), client.my_names, 4);
        return testSeen(back.messages, text) ? { ok: true, detail: 'posted and read back' } : { ok: false, detail: 'sent, but the reader did not find it: tune the reader selectors' };
      } finally { await page.close().catch(() => undefined); }
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

  // ---------- WhatsApp Business webhook (internal listener; the dashboard forwards Meta's calls) ----------
  const waSecret = workerEnv().OPERATOR_WHATSAPP_APP_SECRET?.trim();
  const hookServer = waSecret ? startHookServer({
    appSecret: waSecret,
    verifyToken: workerEnv().OPERATOR_WHATSAPP_VERIFY_TOKEN?.trim() || null,
    ingest: async (m) => {
      const { data, error } = await sb.rpc('operator_whatsapp_ingest', { p_phone_id: m.phoneId, p_msg: m.msg });
      if (error) throw new Error(error.message);
      return (data as string | null) ?? null;
    },
    log: console.log,
  }, cfg.hookPort) : null;
  if (hookServer) console.log(`[operator] WhatsApp webhook listening on :${cfg.hookPort} (internal; Meta → dashboard /api/operator/whatsapp → here)`);

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
    loop('sweep', Math.min(cfg.pollMs, 15_000), () => op.sweepTick()),
    loop('classify', cfg.tickMs, () => op.classifyTick()),
    loop('send', cfg.tickMs, () => op.sendTick()),
    loop('send-test', cfg.tickMs, () => op.sendTestTick()),
    ...(cfg.jobs ? [
      loop('job', cfg.jobTickMs, () => jobs.jobTick()),
      loop('action', cfg.tickMs, () => jobs.actionTick()),
      loop('update', cfg.tickMs, () => jobs.updateTick()),
      loop('verify', 60_000, () => jobs.verifyStaleTick()),
      loop('logins', cfg.loginCheckMs, loginCheck),
      loop('daily', 3600_000, daily),
    ] : []),
    // Morning / evening digests (phase 3): SQL decides whether one is due and saves it once; the bot sends it.
    loop('digest', 60_000, async () => {
      const { data, error } = await sb.rpc('operator_digest_tick');
      if (error) { if (!/operator_digest_tick/.test(error.message)) throw new Error(error.message); return; } // migration not applied yet: quiet
      if (Array.isArray(data) && data.length) console.log(`[operator] digest saved: ${data.join(', ')}`);
    }),
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
      hookServer?.close();
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
