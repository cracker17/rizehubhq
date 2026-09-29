// Admin → API & AI, worker side: dashboard keys overlay .env (dashboard wins), refresh without restart, the model
// picker re-reads profile / budgets, bootstrap secrets can never be overridden, and no key value reaches a log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { budgetLoosened, effectiveDailyBudget, effectiveMonthlyBudget, parseDashboardAi, providerKeyContext } from '@rizehubhq/shared';
import { baseEnvValue, providerKeyOverlayNames, resetWorkerEnvForTests, scrubProcessEnv, setProviderKeyOverlay, workerEnv } from '../config';
import { loadKeyring, seal } from '../vault/crypto';
import { ModelPicker } from '../models/usage';
import { GlobalDailyBudget } from '../budget';
import { FakeHqDb } from '../fakeHqDb';
import { FakeProviderKeyStore } from './store';
import { describeChanges, effectiveAi, loopDailyBudget, routerEnv, RuntimeSettings } from './runtime';

const kr = loadKeyring({ VAULT_MASTER_KEY: randomBytes(32).toString('base64') })!;
const DASH_GROQ = 'gsk_dashboard_value_1234567890';
const DASH_ANTHROPIC = 'sk-ant-dashboard-value-abcdef';
const put = (store: FakeProviderKeyStore, name: string, value: string, keyring = kr) =>
  store.rows.set(name, { sealed: seal(value, keyring, providerKeyContext(name)), last4: value.slice(-4), test: null });

const specs = (list: string[]) => ({ lead: list, specialist: list, dev: list, reports: list, qa: list, light: list });
const cfg = {
  active_profile: 'free', transcription: [], daily_request_caps: {},
  profiles: { free: specs(['google:gemini-flash', 'groq:llama']), claude: specs(['anthropic:claude-sonnet-5']) },
};

test('workerEnv(): dashboard keys win over .env, stay out of process.env, and removing one brings the .env value back', async () => {
  const env: NodeJS.ProcessEnv = { GROQ_API_KEY: 'gsk_env_value', SUPABASE_SERVICE_ROLE_KEY: 'svc', PATH: '/bin' };
  const logs: string[] = [];
  try {
    scrubProcessEnv(env);
    const store = new FakeProviderKeyStore();
    put(store, 'GROQ_API_KEY', DASH_GROQ);
    put(store, 'ANTHROPIC_API_KEY', DASH_ANTHROPIC);
    const rt = new RuntimeSettings({ store, keyring: () => kr, log: (m) => logs.push(m) });
    const snap = await rt.refresh();
    assert.deepEqual(snap.keys, ['ANTHROPIC_API_KEY', 'GROQ_API_KEY']);
    assert.equal(workerEnv().GROQ_API_KEY, DASH_GROQ, 'dashboard wins');
    assert.equal(workerEnv().ANTHROPIC_API_KEY, DASH_ANTHROPIC);
    assert.equal(baseEnvValue('GROQ_API_KEY'), 'gsk_env_value', 'the .env value is still known (shown as "also in .env")');
    assert.equal(workerEnv().SUPABASE_SERVICE_ROLE_KEY, 'svc');
    assert.ok(Object.isFrozen(workerEnv()));
    assert.equal(env.GROQ_API_KEY, undefined, 'scrubbed');
    assert.ok(!Object.values(process.env).includes(DASH_GROQ), 'never in process.env');
    assert.deepEqual(providerKeyOverlayNames(), ['ANTHROPIC_API_KEY', 'GROQ_API_KEY']);

    store.rows.delete('GROQ_API_KEY');
    await rt.refresh();
    assert.equal(workerEnv().GROQ_API_KEY, 'gsk_env_value', 'back to the .env value');
    assert.equal(workerEnv().ANTHROPIC_API_KEY, DASH_ANTHROPIC);
    assert.ok(logs.some((l) => l.includes('GROQ_API_KEY') && l.includes('removed')));
    assert.ok(!logs.join('\n').includes(DASH_GROQ) && !logs.join('\n').includes(DASH_ANTHROPIC), 'no key value in any log');
  } finally { resetWorkerEnvForTests(); }
});

test('setProviderKeyOverlay: only allowlisted provider names; bootstrap secrets can never be overridden', () => {
  try {
    scrubProcessEnv({ SUPABASE_SERVICE_ROLE_KEY: 'real', VAULT_MASTER_KEY: 'vk', HQ_INTERNAL_SECRET: 'hs' });
    const applied = setProviderKeyOverlay({
      SUPABASE_SERVICE_ROLE_KEY: 'evil', VAULT_MASTER_KEY: 'evil', HQ_INTERNAL_SECRET: 'evil', TELEGRAM_BOT_TOKEN: 'evil',
      HQ_MCP_TOKEN_WEB_DEV: 'evil', PATH: 'evil', FIGMA_TOKEN: 'figd_ok_value',
    });
    assert.deepEqual(applied, ['FIGMA_TOKEN']);
    assert.equal(workerEnv().SUPABASE_SERVICE_ROLE_KEY, 'real');
    assert.equal(workerEnv().VAULT_MASTER_KEY, 'vk');
    assert.equal(workerEnv().HQ_INTERNAL_SECRET, 'hs');
    assert.equal(workerEnv().TELEGRAM_BOT_TOKEN, undefined);
    assert.equal(workerEnv().FIGMA_TOKEN, 'figd_ok_value');
  } finally { resetWorkerEnvForTests(); }
});

test('RuntimeSettings: an undecryptable row is skipped (name logged, never a value) and the .env value stays in use', async () => {
  const logs: string[] = [];
  try {
    scrubProcessEnv({ OPENAI_API_KEY: 'sk-env' });
    const store = new FakeProviderKeyStore();
    const other = loadKeyring({ VAULT_MASTER_KEY: randomBytes(32).toString('base64') })!;
    put(store, 'OPENAI_API_KEY', 'sk-sealed-with-another-master-key', other);
    put(store, 'GROQ_API_KEY', DASH_GROQ);
    const snap = await new RuntimeSettings({ store, keyring: () => kr, log: (m) => logs.push(m) }).refresh();
    assert.deepEqual(snap.keys, ['GROQ_API_KEY']);
    assert.deepEqual(snap.unreadable, ['OPENAI_API_KEY']);
    assert.equal(workerEnv().OPENAI_API_KEY, 'sk-env');
    assert.ok(logs.some((l) => l.includes('OPENAI_API_KEY')));
    assert.ok(!logs.join('\n').includes('sk-sealed-with-another-master-key'));

    // No VAULT_MASTER_KEY at all: every dashboard key is ignored, .env values apply.
    const none = await new RuntimeSettings({ store, keyring: () => null, log: (m) => logs.push(m) }).refresh();
    assert.deepEqual(none.keys, []);
    assert.equal(workerEnv().GROQ_API_KEY, undefined);
    assert.match(logs.at(-1) ?? '', /VAULT_MASTER_KEY is not set/);
  } finally { resetWorkerEnvForTests(); }
});

test('RuntimeSettings: a database error keeps the last keys and settings; the interval refreshes on its own', async () => {
  const logs: string[] = [];
  try {
    scrubProcessEnv({});
    const store = new FakeProviderKeyStore();
    put(store, 'GROQ_API_KEY', DASH_GROQ);
    store.settingsRows = { ai_model_profile: 'claude' };
    let changes = 0;
    const rt = new RuntimeSettings({ store, keyring: () => kr, log: (m) => logs.push(m), onChange: () => { changes++; } });
    await rt.refresh();
    store.failReads = true;
    await assert.rejects(rt.refresh(), /db down/);
    assert.equal(workerEnv().GROQ_API_KEY, DASH_GROQ);
    assert.equal(rt.snapshot?.dashboard.profile, 'claude');

    store.failReads = false;
    store.settingsRows = { ai_model_profile: 'hybrid', ai_monthly_budget_usd: 40 };
    const stop = rt.start(15);
    const until = Date.now() + 2000;
    const profile = (): string | null | undefined => rt.snapshot?.dashboard.profile;
    while (profile() !== 'hybrid' && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
    stop();
    assert.equal(rt.snapshot?.dashboard.profile, 'hybrid', 'picked up without a restart');
    assert.equal(rt.snapshot?.dashboard.monthlyBudgetUsd, 40);
    assert.ok(changes >= 2);
    assert.ok(logs.some((l) => /model profile: claude → hybrid/.test(l)));
  } finally { resetWorkerEnvForTests(); }
});

test('effectiveAi: dashboard value → .env → default, for profile, budgets and per-role models', () => {
  const env = { MODEL_PROFILE: 'claude', MONTHLY_BUDGET_USD: '25', DAILY_AI_BUDGET_USD: '4', MODEL_ID_QA: 'openai:gpt-5.5', MODEL_ID_LEAD: 'anthropic:claude-opus-5-5' };
  const none = effectiveAi(env, null, cfg);
  assert.deepEqual([none.profile, none.profileSource, none.monthlyBudgetUsd, none.monthlySource, none.dailyBudgetUsd, none.dailySource],
    ['claude', 'env', 25, 'env', 4, 'env']);
  assert.deepEqual(none.modelIds.qa, { spec: 'openai:gpt-5.5', source: 'env' });

  const dashboard = parseDashboardAi({
    ai_model_profile: 'free', ai_monthly_budget_usd: 0, ai_daily_budget_usd: 2, ai_model_ids: { qa: 'anthropic:claude-sonnet-5', boss: 'x:y', dev: 'not a spec' },
  });
  const set = effectiveAi(env, { dashboard, legacyDaily: 10 }, cfg);
  assert.deepEqual([set.profile, set.profileSource, set.monthlyBudgetUsd, set.monthlySource, set.dailyBudgetUsd, set.dailySource],
    ['free', 'dashboard', 0, 'dashboard', 2, 'dashboard'], 'dashboard wins, even when lower');
  assert.deepEqual(set.modelIds.qa, { spec: 'anthropic:claude-sonnet-5', source: 'dashboard' });
  assert.deepEqual(set.modelIds.lead, { spec: 'anthropic:claude-opus-5-5', source: 'env' }, 'roles without a dashboard value keep .env');
  assert.equal(set.modelIds.dev, undefined, 'invalid dashboard values are ignored');

  const bare = effectiveAi({}, { dashboard: parseDashboardAi({}), legacyDaily: 10 }, cfg);
  assert.deepEqual([bare.profile, bare.profileSource, bare.monthlyBudgetUsd, bare.dailyBudgetUsd, bare.dailySource], ['free', 'default', 0, 10, 'settings'],
    'older settings.daily_budget_usd still applies after .env');
  const kimi = effectiveAi({}, { dashboard: parseDashboardAi({ ai_model_profile: 'kimi' }), legacyDaily: null }, cfg);
  assert.equal(kimi.profile, 'free', 'a profile missing from models.yaml is ignored');
  assert.equal(kimi.warnings.length, 1);
  assert.equal(effectiveAi({ DAILY_AI_BUDGET_USD: '0' }, { dashboard: parseDashboardAi({}), legacyDaily: 10 }, cfg).dailyBudgetUsd, null, '.env 0 = no cap (settings ignored)');
  assert.equal(effectiveAi({ DAILY_AI_BUDGET_USD: '5' }, { dashboard: parseDashboardAi({ ai_daily_budget_usd: 0 }), legacyDaily: 10 }, cfg).dailyBudgetUsd, null, 'dashboard 0 = no cap');
});

test('shared precedence helpers and the 2FA rule (budgetLoosened) match the SQL function', () => {
  assert.deepEqual(effectiveMonthlyBudget(null, 'abc'), { usd: 0, source: 'default' }, 'garbage in .env = no paid models');
  assert.deepEqual(effectiveMonthlyBudget(12, '50'), { usd: 12, source: 'dashboard' });
  assert.deepEqual(effectiveDailyBudget(null, undefined, '7'), { usd: 7, source: 'settings' });
  assert.equal(loopDailyBudget(parseDashboardAi({ ai_daily_budget_usd: 3 }), 9), 3);
  assert.equal(loopDailyBudget(parseDashboardAi({}), 9), 9);
  assert.equal(loopDailyBudget(null, null), null);
  const L = (bm: number | null, bd: number | null, am: number | null, ad: number | null) => budgetLoosened({ monthly: bm, daily: bd }, { monthly: am, daily: ad });
  assert.equal(L(20, 2, 10, 1), false, 'lowering');
  assert.equal(L(20, 2, 20, 2), false, 'unchanged');
  assert.equal(L(20, 2, 30, 2), true, 'higher monthly');
  assert.equal(L(20, 2, 20, 0), true, 'daily 0 = no cap');
  assert.equal(L(20, 0, 20, 50), false, 'from no cap to a cap');
  assert.equal(L(null, null, 0, null), false, 'monthly 0 is the floor');
  assert.equal(L(null, null, 5, null), true, 'the .env value is unknown');
  assert.equal(L(5, null, null, null), true, 'clearing → the .env value may be higher');
});

test('ModelPicker re-reads the profile, budget and per-role models from the dashboard without a restart', async () => {
  const picker = new ModelPicker({
    cfg, profile: 'free', env: { GOOGLE_GENERATIVE_AI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' }, monthlyBudgetUsd: 0, create: async () => ({}) as never,
  });
  assert.equal((await picker.pick('lead')).provider, 'google');
  const dashboard = parseDashboardAi({ ai_model_profile: 'claude', ai_monthly_budget_usd: 0 });
  const env = { GOOGLE_GENERATIVE_AI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' };
  let ai = effectiveAi(env, { dashboard, legacyDaily: null }, cfg);
  picker.configure({ profile: ai.profile, monthlyBudgetUsd: ai.monthlyBudgetUsd, env: routerEnv(env, dashboard) });
  await assert.rejects(picker.pick('lead'), /monthly budget reached/, 'claude profile but a $0 budget: paid models stay off');
  assert.deepEqual(picker.settings, { profile: 'claude', monthlyBudgetUsd: 0 });

  const raised = parseDashboardAi({ ai_model_profile: 'claude', ai_monthly_budget_usd: 30, ai_model_ids: { qa: 'google:gemini-pro' } });
  ai = effectiveAi(env, { dashboard: raised, legacyDaily: null }, cfg);
  picker.configure({ profile: ai.profile, monthlyBudgetUsd: ai.monthlyBudgetUsd, env: routerEnv({ ...env, MODEL_ID_QA: 'openai:gpt-5.5' }, raised) });
  const m = await picker.pick('lead');
  assert.deepEqual([m.provider, m.modelId], ['anthropic', 'claude-sonnet-5']);
  assert.deepEqual(picker.preview('qa'), { provider: 'google', modelId: 'gemini-pro' }, 'dashboard role model wins over MODEL_ID_QA');
  assert.throws(() => picker.configure({ profile: 'nope' }), /Unknown model profile/);

  // A key added in the dashboard later: the router sees it on the next refresh.
  const p2 = new ModelPicker({ cfg, profile: 'free', env: {}, monthlyBudgetUsd: 0, create: async () => ({}) as never });
  assert.match(JSON.stringify(p2.preview('lead')), /no GOOGLE_GENERATIVE_AI_API_KEY/);
  p2.configure({ env: { GROQ_API_KEY: 'from-dashboard' } });
  assert.deepEqual(p2.preview('lead'), { provider: 'groq', modelId: 'llama' });
});

test('GlobalDailyBudget reads a changing daily cap (dashboard) on each check', async () => {
  const db = new FakeHqDb(['coo']);
  db.activity.push({ actor: 'coo', action: 'usage.task', cost_usd: 3, created_at: new Date().toISOString() } as never);
  let cap: number | null = 10;
  const g = new GlobalDailyBudget(db, { budgetUsd: () => cap, cacheMs: 60_000 });
  const first = await g.check();
  assert.deepEqual([first.budgetUsd, first.spentUsd, first.over], [10, 3, false]);
  cap = 2;
  g.invalidate();
  const second = await g.check();
  assert.deepEqual([second.budgetUsd, second.over], [2, true], 'lowering the cap in the dashboard stops paid work at the next check');
  cap = 0;
  g.invalidate();
  assert.equal((await g.check()).budgetUsd, null, '0 = no cap');
});

test('describeChanges names keys and settings, never values', () => {
  const a = { keys: ['GROQ_API_KEY'], unreadable: [], dashboard: parseDashboardAi({}), legacyDaily: null, loadedAt: 0 };
  const b = { keys: ['ANTHROPIC_API_KEY'], unreadable: [], dashboard: parseDashboardAi({ ai_daily_budget_usd: 5, ai_model_ids: { qa: 'openai:gpt-5.5' } }), legacyDaily: null, loadedAt: 1 };
  const out = describeChanges(a, b).join('\n');
  assert.match(out, /ANTHROPIC_API_KEY/);
  assert.match(out, /removed.*GROQ_API_KEY/);
  assert.match(out, /daily AI budget: \.env default → 5/);
  assert.match(out, /qa model: \.env default → openai:gpt-5\.5/);
});
