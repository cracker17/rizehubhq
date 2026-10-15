// RizeHub HQ Operator (docs/17-OPERATOR.md): watches client chats through the workspace browsers, drafts replies with
// Claude and the HQ Brain, and sends only what the tiers / the CEO approved. Its own container (hq-operator): the only
// HQ process that can reach the workspace browsers over CDP, and it holds no Telegram token.
import { workerEnv, scrubProcessEnv, config } from 'worker/src/config';
import { createServiceClient } from 'worker/src/db';
import { manilaDayStartIso } from 'worker/src/budget';
import { loadModelsConfig } from 'worker/src/models/router';
import { createSupabaseProviderKeyStore } from 'worker/src/settings/store';
import { effectiveAi, routerEnv, RuntimeSettings } from 'worker/src/settings/runtime';
import { loadKeyring } from 'worker/src/vault/crypto';
import { gate, operatorModel } from './ai';
import { classifyMessage } from './classify';
import { cdpEndpointFor, loadOperatorConfig } from './config';
import { createSupabaseOperatorDb } from './db';
import { BrowserPool, chatPage } from './browser/cdp';
import { selectors } from './browser/chatDom';
import { readChat, sendReply } from './browser/googleChat';
import { Operator, type ChatDriver } from './operator';

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

  const op = new Operator({
    db, chat, pollMs: cfg.pollMs, sends: cfg.sends,
    gate: async () => {
      const env = workerEnv();
      const ai = effectiveAi(env, runtime.snapshot, models);
      const model = operatorModel(cfg.modelRole, models, routerEnv(env, runtime.snapshot?.dashboard), ai.profile);
      const [monthUsd, dayUsd] = await Promise.all([db.monthSpendUsd(), db.spendSinceUsd(manilaDayStartIso())]);
      return gate({ env, ai, spend: { monthUsd, dayUsd }, model, maxUsdPerMessage: cfg.maxUsdPerMessage });
    },
    classify: (o) => classifyMessage({ ...o, env: workerEnv() }),
  });

  console.log(`[operator] running: poll every ${cfg.pollMs / 1000}s, sends ${cfg.sends ? 'on' : 'OFF (OPERATOR_SENDS)'}, model role ${cfg.modelRole}`);
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
    // Heartbeat for /operator and /status: the dashboard shows "offline" when it is older than 3 minutes.
    loop('heartbeat', 60_000, async () => {
      await sb.from('settings').upsert({ key: 'operator_heartbeat', value: { at: new Date().toISOString(), sends: cfg.sends, poll_ms: cfg.pollMs } });
    }),
  ];
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
