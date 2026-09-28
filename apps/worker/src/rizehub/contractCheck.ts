// Contract check (docs/12 "Testing safely" §3): calls every Agent API endpoint the way HQ does — reads for real,
// writes in dry_run only (plus lead notes/lists on a lead you name) — and prints pass/fail per endpoint.
//   pnpm --filter worker contract:rizehub                       → against the in-memory mock (proves the check itself)
//   RIZEHUB_API_URL=http://staging:8080/agent-api/v1 RIZEHUB_KEY_*=… RIZEHUB_CHECK_WORKSPACE=ws_… pnpm --filter worker contract:rizehub
// Never point it at production keys (CLAUDE.md rule 9). Exit code 1 when any check fails.
import { pathToFileURL } from 'node:url';
import { RizehubClient, isDryRun, toRizehubError, type CallCtx } from './client';
import { getRizehub } from './config';
import type { Job } from './contract';

export interface CheckResult { name: string; ok: boolean; detail: string }

export async function runContractCheck(client: RizehubClient, o: { workspaceId?: string; accountId?: string } = {}): Promise<CheckResult[]> {
  const ctx: CallCtx = { taskId: `contract-${new Date().toISOString().slice(0, 10)}`, agentId: 'hq-contract-check' };
  const results: CheckResult[] = [];
  const check = async <T>(name: string, fn: () => Promise<T>, verify: (v: T) => string | true = () => true): Promise<T | null> => {
    try {
      const v = await fn();
      const r = verify(v);
      results.push({ name, ok: r === true, detail: r === true ? 'ok' : r });
      return v;
    } catch (e) {
      const err = toRizehubError(e);
      results.push({ name, ok: false, detail: `${err.code}: ${err.message}` });
      return null;
    }
  };
  const dry = (v: unknown) => (isDryRun(v) ? true : 'expected a DryRunResult ({dry_run: true, …})');

  const acc = await check('POST /leads/search → 202 job_id', () => client.searchLeads(ctx, { platform: 'shopify', limit: 3 }, 'contract:leads_search'),
    (a) => (a.job_id ? true : 'no job_id'));
  let job: Job | null = null;
  if (acc) {
    job = await check('GET /jobs/{id} → completes', () => client.waitForJob(ctx, acc.job_id, 'LEADS', { timeoutMs: 60_000 }),
      (j) => (j.status === 'completed' ? true : `status ${j.status}`));
  }
  const leadId = job?.result?.lead_ids?.[0];
  if (leadId) {
    await check('GET /leads/{id}', () => client.getLead(ctx, leadId), (l) => (l.id === leadId && Array.isArray(l.signals) && l.app_url ? true : 'missing id/signals/app_url'));
    await check('POST /leads/{id}/notes (dry_run)', () => client.call({ group: 'LEADS', endpoint: 'leadNotes', params: { id: leadId }, body: { body: 'contract check' }, ctx, step: 'contract:notes', dryRun: true }).then((r) => r.data), dry);
    await check('PATCH /leads/{id} (dry_run)', () => client.call({ group: 'LEADS', endpoint: 'leadStage', params: { id: leadId }, body: { stage: 'researched' }, ctx, step: 'contract:stage', dryRun: true }).then((r) => r.data), dry);
    await check('POST /lists (dry_run)', () => client.call({ group: 'LEADS', endpoint: 'listCreate', body: { name: 'contract check', lead_ids: [leadId] }, ctx, step: 'contract:list', dryRun: true }).then((r) => r.data), dry);
  }
  await check('GET /workspace-templates', () => client.listTemplates(ctx), (t) => (t.templates.length ? true : 'no templates'));
  await check('GET /accounts?q=', () => client.searchAccounts(ctx, { q: 'contract-check-nobody' }), (r) => (Array.isArray(r.accounts) ? true : 'accounts[] missing'));
  const account = { company: `Contract Check ${Date.now()}`, primary_contact: { name: 'Check', email: 'check@example.com' }, plan: 'seo-retainer', test: true };
  await check('POST /accounts (dry_run)', () => client.createAccount(ctx, account, { dryRun: true, step: 'contract:account' }), dry);
  await check('POST /accounts/new/workspaces (dry_run)', () => client.createWorkspace(ctx, 'new', { template: 'seo-retainer', name: account.company }, { dryRun: true, step: 'contract:workspace' }), dry);
  await check('PUT /workspaces/new/config (dry_run)', () => client.configureWorkspace(ctx, 'new', { site_url: 'https://example.com', report_schedule: { type: 'seo-monthly', day_of_month: 1 } }, { dryRun: true, step: 'contract:config' }), dry);
  await check('POST /workspaces/new/projects (dry_run)', () => client.createProjects(ctx, 'new', ['Baseline audit'], { dryRun: true, step: 'contract:projects' }), dry);
  await check('validation error shape (422 {error:{code,message,retryable}})', async () => {
    try { await client.createAccount(ctx, { company: '', primary_contact: { name: '', email: 'x' }, plan: '' }, { dryRun: true, step: 'contract:bad' }); return 'accepted an invalid account'; }
    catch (e) { const r = toRizehubError(e); return r.status === 422 && r.code && typeof r.retryable === 'boolean' ? true : `got ${r.status} ${r.code}`; }
  }, (v) => v);
  if (o.accountId) await check('GET /accounts/{id}', () => client.getAccount(ctx, o.accountId!));
  if (o.workspaceId) {
    const ws = o.workspaceId;
    await check('GET /workspaces/{id}', () => client.getWorkspace(ctx, ws), (w) => (w.id === ws ? true : 'wrong id'));
    await check('GET /workspaces/{id}/metrics', () => client.getMetrics(ctx, ws, '2026-08-01', '2026-08-31'), (m) => (m.metrics && m.previous ? true : 'metrics/previous missing'));
    await check('POST /workspaces/{id}/reports (dry_run)', () => client.call({ group: 'REPORTS', endpoint: 'reportGenerate', params: { id: ws }, body: { type: 'seo-monthly', period: { from: '2026-08-01', to: '2026-08-31' } }, ctx, step: 'contract:report', dryRun: true }).then((r) => r.data), dry);
  } else {
    results.push({ name: 'workspace checks', ok: true, detail: 'skipped (set RIZEHUB_CHECK_WORKSPACE=ws_… to run metrics/report checks)' });
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { client, cfg } = getRizehub();
  console.log(`Contract check against ${cfg.mock ? 'the in-memory mock' : cfg.baseUrl}`);
  const ws = process.env.RIZEHUB_CHECK_WORKSPACE ?? (cfg.mock ? 'ws_vinylicons' : undefined);
  void runContractCheck(client, { workspaceId: ws, accountId: process.env.RIZEHUB_CHECK_ACCOUNT }).then((rs) => {
    for (const r of rs) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail === 'ok' ? '' : ` — ${r.detail}`}`);
    const failed = rs.filter((r) => !r.ok).length;
    console.log(failed ? `\n${failed} check(s) failed.` : `\nAll ${rs.length} checks passed.`);
    process.exit(failed ? 1 : 0);
  });
}
