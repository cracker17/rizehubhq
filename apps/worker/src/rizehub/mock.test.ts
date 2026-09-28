import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MOCK_KEYS, MockRizehub, type MockRequest } from './mock';
import type { Account, Job, Lead, Report, Workspace } from './contract';

const H = (key: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${key}`, 'x-hq-task-id': 't1', 'x-hq-agent-id': 'test', ...extra });
function req(method: string, path: string, key: string, body: unknown = null, o: { idem?: string; query?: string } = {}): MockRequest {
  return { method, path: `/agent-api/v1${path}`, query: new URLSearchParams(o.query ?? ''), headers: H(key, o.idem ? { 'idempotency-key': o.idem } : {}), body };
}

test('auth: unknown key 401, missing HQ headers 400, missing scope 403, revoked key 401', async () => {
  const m = new MockRizehub();
  assert.equal((await m.handle(req('GET', '/leads/ld_1001', 'nope'))).status, 401);
  const noHdr = await m.handle({ method: 'GET', path: '/agent-api/v1/leads/ld_1001', query: new URLSearchParams(), headers: { authorization: `Bearer ${MOCK_KEYS.LEADS}` }, body: null });
  assert.equal(noHdr.status, 400);
  const forbidden = await m.handle(req('POST', '/accounts', MOCK_KEYS.LEADS, {}, { idem: 'x' }));
  assert.equal(forbidden.status, 403);
  assert.equal((forbidden.body as { error: { code: string } }).error.code, 'forbidden');
  assert.equal((await m.handle(req('GET', '/leads/ld_1001', MOCK_KEYS.READONLY))).status, 200); // *:read
  m.revokeKey(MOCK_KEYS.READONLY);
  assert.equal((await m.handle(req('GET', '/leads/ld_1001', MOCK_KEYS.READONLY))).status, 401);
  assert.ok(m.audit.some((a) => a.task_id === 't1' && a.agent_id === 'test' && a.key_label === 'hq-leads'));
});

test('writes need Idempotency-Key; replays return the first result; a different body is a conflict', async () => {
  const m = new MockRizehub();
  assert.equal((await m.handle(req('POST', '/lists', MOCK_KEYS.LEADS, { name: 'A' }))).status, 400);
  const a = await m.handle(req('POST', '/lists', MOCK_KEYS.LEADS, { name: 'AU skincare', lead_ids: ['ld_1001'] }, { idem: 't1:list' }));
  const b = await m.handle(req('POST', '/lists', MOCK_KEYS.LEADS, { name: 'AU skincare', lead_ids: ['ld_1001'] }, { idem: 't1:list' }));
  assert.equal(a.status, 201);
  assert.deepEqual(b.body, a.body);
  assert.equal(b.headers['idempotent-replayed'], 'true');
  const c = await m.handle(req('POST', '/lists', MOCK_KEYS.LEADS, { name: 'Other' }, { idem: 't1:list' }));
  assert.equal(c.status, 409);
  assert.equal(m.lists.size, 1);
});

test('lead search: 202 + job, the job completes with matching leads, sorted by score', async () => {
  let now = 0;
  const m = new MockRizehub({ jobDelayMs: 1000, now: () => now });
  const r = await m.handle(req('POST', '/leads/search', MOCK_KEYS.LEADS, { platform: 'shopify', location: 'AU', industry: 'skincare', signals: ['slow_site'], limit: 10 }, { idem: 'a' }));
  assert.equal(r.status, 202);
  const jobId = (r.body as { job_id: string }).job_id;
  assert.equal(((await m.handle(req('GET', `/jobs/${jobId}`, MOCK_KEYS.LEADS))).body as Job).status, 'running');
  now = 1500;
  const job = (await m.handle(req('GET', `/jobs/${jobId}`, MOCK_KEYS.LEADS))).body as Job;
  assert.equal(job.status, 'completed');
  const leads = job.result!.lead_ids!.map((id) => m.leads.get(id)!);
  assert.ok(leads.length >= 3);
  assert.ok(leads.every((l) => l.platform === 'shopify' && l.location.country === 'Australia'));
  assert.deepEqual(leads.map((l) => l.score), [...leads.map((l) => l.score)].sort((a, b) => b - a));
  assert.ok(m.events.some((e) => e.event === 'job.completed' && e.data.job_id === jobId));
  // validation
  const bad = await m.handle(req('POST', '/leads/search', MOCK_KEYS.LEADS, { signals: ['psychic'] }, { idem: 'b' }));
  assert.equal(bad.status, 422);
});

test('notes move a lead to researched; stage can not go back to new', async () => {
  const m = new MockRizehub();
  const n = await m.handle(req('POST', '/leads/ld_1001/notes', MOCK_KEYS.LEADS, { body: 'LCP 6.2 s on mobile (PSI 2026-09-28)', fit_score: 82, angle: 'Speed' }, { idem: 'n' }));
  assert.equal(n.status, 200);
  assert.equal((n.body as Lead).stage, 'researched');
  assert.equal((n.body as Lead).fit_score, 82);
  const back = await m.handle(req('PATCH', '/leads/ld_1001', MOCK_KEYS.LEADS, { stage: 'new' }, { idem: 's' }));
  assert.equal(back.status, 409);
});

test('dry run validates and changes nothing; onboarding creates account → workspace → config → projects', async () => {
  const m = new MockRizehub();
  const acct = { company: 'Saltbush Skin Co.', domain: 'saltbushskin.com.au', primary_contact: { name: 'Mia', email: 'mia@saltbushskin.com.au' }, plan: 'seo-retainer', test: true };
  const before = m.accounts.size;
  const dry = await m.handle(req('POST', '/accounts', MOCK_KEYS.ONBOARDING, acct, { idem: 'd', query: 'dry_run=true' }));
  assert.equal(dry.status, 200);
  assert.equal((dry.body as { dry_run: boolean }).dry_run, true);
  assert.equal(m.accounts.size, before);
  const wsDry = await m.handle(req('POST', '/accounts/new/workspaces', MOCK_KEYS.ONBOARDING, { template: 'seo-retainer', name: 'Saltbush' }, { idem: 'wd', query: 'dry_run=true' }));
  assert.equal(wsDry.status, 200);
  assert.equal((await m.handle(req('POST', '/accounts/new/workspaces', MOCK_KEYS.ONBOARDING, { template: 'seo-retainer', name: 'x' }, { idem: 'wn' }))).status, 404);

  const a = (await m.handle(req('POST', '/accounts', MOCK_KEYS.ONBOARDING, acct, { idem: 'a' }))).body as Account;
  const ws = (await m.handle(req('POST', `/accounts/${a.id}/workspaces`, MOCK_KEYS.ONBOARDING, { template: 'seo-retainer', name: 'Saltbush' }, { idem: 'w' }))).body as Workspace;
  const cfg = await m.handle(req('PUT', `/workspaces/${ws.id}/config`, MOCK_KEYS.ONBOARDING, { site_url: 'https://saltbushskin.com.au', platform: 'shopify', report_schedule: { type: 'seo-monthly', day_of_month: 1 } }, { idem: 'c' }));
  assert.equal(cfg.status, 200);
  assert.equal((cfg.body as Workspace).config.site_url, 'https://saltbushskin.com.au');
  const pr = await m.handle(req('POST', `/workspaces/${ws.id}/projects`, MOCK_KEYS.ONBOARDING, { projects: [{ name: 'Baseline SEO audit' }, { name: 'Kickoff' }] }, { idem: 'p' }));
  assert.equal(pr.status, 201);
  // duplicates are refused with clear codes
  assert.equal(((await m.handle(req('POST', '/accounts', MOCK_KEYS.ONBOARDING, acct, { idem: 'a2' }))).body as { error: { code: string } }).error.code, 'account_exists');
  assert.equal(((await m.handle(req('POST', `/accounts/${a.id}/workspaces`, MOCK_KEYS.ONBOARDING, { template: 'seo-retainer', name: 'again' }, { idem: 'w2' }))).body as { error: { code: string } }).error.code, 'workspace_exists');
  assert.deepEqual(m.events.map((e) => e.event), ['account.created', 'workspace.ready']);
  // bad config
  const badCfg = await m.handle(req('PUT', `/workspaces/${ws.id}/config`, MOCK_KEYS.ONBOARDING, { site_url: 'ftp://x', report_schedule: { type: 'seo-monthly', day_of_month: 31 } }, { idem: 'c2' }));
  assert.equal(badCfg.status, 422);
  assert.match((badCfg.body as { error: { message: string } }).error.message, /site_url.*day_of_month/);
});

test('invites are prepared with send=false and sent separately, once', async () => {
  const m = new MockRizehub();
  assert.equal((await m.handle(req('POST', '/accounts/acc_madammuse/invites', MOCK_KEYS.ONBOARDING, { email: 'hello@madammuse.co' }, { idem: 'i0' }))).status, 422);
  const inv = await m.handle(req('POST', '/accounts/acc_madammuse/invites', MOCK_KEYS.ONBOARDING, { email: 'hello@madammuse.co' }, { idem: 'i1', query: 'send=false' }));
  assert.equal(inv.status, 201);
  const id = (inv.body as { id: string }).id;
  assert.equal((await m.handle(req('POST', `/invites/${id}/send`, MOCK_KEYS.ONBOARDING, {}, { idem: 's1' }))).status, 200);
  assert.equal((await m.handle(req('POST', `/invites/${id}/send`, MOCK_KEYS.ONBOARDING, {}, { idem: 's2' }))).status, 409);
});

test('reports: metrics, generate job → draft report, notes required before publish', async () => {
  const m = new MockRizehub({ jobDelayMs: 0 });
  const met = await m.handle(req('GET', '/workspaces/ws_vinylicons/metrics', MOCK_KEYS.REPORTS, null, { query: 'from=2026-09-01&to=2026-09-30' }));
  assert.equal(met.status, 200);
  const g = await m.handle(req('POST', '/workspaces/ws_vinylicons/reports', MOCK_KEYS.REPORTS, { type: 'seo-monthly', period: { from: '2026-09-01', to: '2026-09-30' } }, { idem: 'g' }));
  assert.equal(g.status, 202);
  const job = (await m.handle(req('GET', `/jobs/${(g.body as { job_id: string }).job_id}`, MOCK_KEYS.REPORTS))).body as Job;
  const rid = job.result!.report_id!;
  const rep = (await m.handle(req('GET', `/reports/${rid}`, MOCK_KEYS.REPORTS))).body as Report;
  assert.equal(rep.status, 'draft');
  assert.deepEqual(rep.data.metrics, (met.body as { metrics: unknown }).metrics);
  assert.equal((await m.handle(req('POST', `/reports/${rid}/publish`, MOCK_KEYS.REPORTS, { notify_client: false }, { idem: 'p0' }))).status, 422);
  assert.equal((await m.handle(req('POST', `/reports/${rid}/notes`, MOCK_KEYS.REPORTS, { summary: 'Clicks up.' }, { idem: 'n' }))).status, 200);
  const dry = await m.handle(req('POST', `/reports/${rid}/publish`, MOCK_KEYS.REPORTS, { notify_client: true }, { idem: 'p1', query: 'dry_run=true' }));
  assert.equal(dry.status, 200);
  assert.equal(m.reports.get(rid)!.status, 'draft');
  assert.equal((await m.handle(req('POST', `/reports/${rid}/publish`, MOCK_KEYS.REPORTS, { notify_client: true }, { idem: 'p2' }))).status, 200);
  assert.equal(m.reports.get(rid)!.status, 'published');
});

test('rate limit: 429 with Retry-After and X-RateLimit headers', async () => {
  const m = new MockRizehub({ rateLimitPerMin: 2 });
  const ok = await m.handle(req('GET', '/leads/ld_1001', MOCK_KEYS.LEADS));
  assert.equal(ok.headers['x-ratelimit-limit'], '2');
  await m.handle(req('GET', '/leads/ld_1001', MOCK_KEYS.LEADS));
  const limited = await m.handle(req('GET', '/leads/ld_1001', MOCK_KEYS.LEADS));
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers['retry-after']) > 0);
  assert.equal((limited.body as { error: { retryable: boolean } }).error.retryable, true);
});

test('contract check (docs/12 §Testing) passes end to end against the mock', async () => {
  const { runContractCheck } = await import('./contractCheck');
  const { RizehubClient } = await import('./client');
  const { mockFetch } = await import('./mock');
  const m = new MockRizehub({ jobDelayMs: 0 });
  const client = new RizehubClient({ baseUrl: 'http://rizehub.mock/agent-api/v1', keys: MOCK_KEYS, fetch: mockFetch(m), sleep: async () => {} });
  const rs = await runContractCheck(client, { workspaceId: 'ws_vinylicons', accountId: 'acc_vinylicons' });
  assert.deepEqual(rs.filter((r) => !r.ok), []);
  assert.ok(rs.length >= 15);
  assert.equal(m.accounts.size, 2); // dry runs created nothing
});
