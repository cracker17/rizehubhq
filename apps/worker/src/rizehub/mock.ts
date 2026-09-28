// In-memory RizeHub that implements the Agent API contract (docs/12). Used by the worker when RIZEHUB_API_URL is
// unset or "mock", by the tests, and by the standalone server (`pnpm --filter worker mock:rizehub`) so the RizeHub
// team can see every endpoint, header, error and webhook working end to end.
import { createHash, randomBytes } from 'node:crypto';
import {
  API_PREFIX, GROUP_SCOPES, LEAD_STAGES, PLATFORMS, REPORT_TYPES, SIGNAL_KEYS, hasScope,
  type Account, type ApiErrorBody, type Invite, type Job, type KeyGroup, type Lead, type LeadList, type LeadSearchParams,
  type LeadStage, type MetricSet, type Platform, type Report, type ReportType, type SignalKey, type WebhookEvent, type Workspace,
  type WorkspaceConfig,
} from './contract';
import { COUNTRY_ALIASES, SEED_ACCOUNTS, SEED_LEADS, SERVICES, TEMPLATES } from './mockData';

export interface MockRequest { method: string; path: string; query: URLSearchParams; headers: Record<string, string | undefined>; body: unknown }
export interface MockResponse { status: number; headers: Record<string, string>; body: unknown }
export interface AuditEntry { at: string; key_label: string; method: string; path: string; task_id: string | null; agent_id: string | null; status: number; dry_run: boolean }

export const MOCK_KEYS: Record<KeyGroup, string> = {
  LEADS: 'rzh_mock_leads', ONBOARDING: 'rzh_mock_onboarding', REPORTS: 'rzh_mock_reports', READONLY: 'rzh_mock_readonly',
};

export interface MockOptions {
  keys?: Partial<Record<KeyGroup, string>>;       // defaults to MOCK_KEYS (env keys are added when present)
  jobDelayMs?: number;                            // how long lead searches / report generation take (default 400)
  now?: () => number;
  appUrl?: string;                                // where "open in RizeHub" links point (default http://localhost:8080)
  rateLimitPerMin?: number;                       // default 300 per key
  onEvent?: (e: WebhookEvent) => void;            // webhook emission (the standalone server POSTs these to HQ)
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly retryable = false) { super(message); }
}
const bad = (message: string) => new HttpError(422, 'validation_failed', message);
const notFound = (what: string) => new HttpError(404, 'not_found', `${what} not found`);

function hashKey(k: string) { return createHash('sha256').update(k).digest('hex'); }
function iso(ms: number) { return new Date(ms).toISOString(); }
function seeded(seed: string) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909)) >>> 0) / 4294967296;
}
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 500) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

interface KeyRow { hash: string; label: string; group: KeyGroup; scopes: string[]; revoked: boolean; last_used_at: string | null }
interface JobRow extends Job { done_at_ms: number; owner: string; payload: Record<string, unknown> }

export class MockRizehub {
  readonly keys = new Map<string, KeyRow>();        // by sha256(key)
  readonly leads = new Map<string, Lead>();
  readonly jobs = new Map<string, JobRow>();
  readonly lists = new Map<string, LeadList>();
  readonly accounts = new Map<string, Account>();
  readonly workspaces = new Map<string, Workspace>();
  readonly invites = new Map<string, Invite>();
  readonly reports = new Map<string, Report>();
  readonly audit: AuditEntry[] = [];
  readonly events: WebhookEvent[] = [];
  private idem = new Map<string, { fp: string; res: MockResponse }>();
  private buckets = new Map<string, { windowStart: number; count: number }>();
  private faults: { status: number; code: string; retryable: boolean; retryAfter?: number; match?: RegExp }[] = [];
  private seq = 0;
  private readonly now: () => number;
  readonly appUrl: string;

  constructor(private readonly opts: MockOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.appUrl = (opts.appUrl ?? 'http://localhost:8080').replace(/\/+$/, '');
    for (const g of Object.keys(GROUP_SCOPES) as KeyGroup[]) {
      this.addKey(MOCK_KEYS[g], g);
      const extra = opts.keys?.[g];
      if (extra && extra !== MOCK_KEYS[g]) this.addKey(extra, g);
    }
    this.seed();
  }

  addKey(key: string, group: KeyGroup, label = `hq-${group.toLowerCase()}`) {
    this.keys.set(hashKey(key), { hash: hashKey(key), label, group, scopes: GROUP_SCOPES[group], revoked: false, last_used_at: null });
  }
  revokeKey(key: string) { const k = this.keys.get(hashKey(key)); if (k) k.revoked = true; }
  /** Test hook: the next `n` requests (optionally only matching paths) fail with this status. */
  failNext(n: number, status: number, code = status === 429 ? 'rate_limited' : 'unavailable', o: { retryAfter?: number; match?: RegExp; retryable?: boolean } = {}) {
    for (let i = 0; i < n; i++) this.faults.push({ status, code, retryable: o.retryable ?? (status === 429 || status >= 500), retryAfter: o.retryAfter, match: o.match });
  }

  clearFaults() { this.faults = []; }

  private id(prefix: string) { this.seq++; return `${prefix}_${(this.now() % 1e8).toString(36)}${this.seq.toString(36)}${randomBytes(2).toString('hex')}`; }

  private seed() {
    const t = iso(this.now() - 3 * 86_400_000);
    for (const s of SEED_LEADS) {
      this.leads.set(s.id, {
        id: s.id, company: s.company, website: s.website, platform: s.platform, industry: s.industry, location: s.location,
        contact: s.contact, signals: s.signals.map((x) => ({ ...x, evidence_url: s.website, detected_at: t })), score: s.score,
        stage: 'new', fit_score: null, angle: null, notes: [], list_ids: [], app_url: `${this.appUrl}/app/lead-finder/leads/${s.id}`,
        created_at: t, updated_at: t,
      });
    }
    for (const a of SEED_ACCOUNTS) {
      this.accounts.set(a.id, {
        id: a.id, company: a.company, domain: a.domain, primary_contact: a.contact, plan: a.plan, country: a.country, time_zone: a.time_zone,
        test: false, status: 'active', workspace_ids: [a.workspace.id], created_at: t,
      });
      const tpl = TEMPLATES.find((x) => x.id === a.workspace.template)!;
      this.workspaces.set(a.workspace.id, {
        id: a.workspace.id, account_id: a.id, name: a.company, template: tpl.id,
        config: { site_url: a.workspace.site, platform: a.workspace.platform, services_enabled: tpl.services,
          report_schedule: tpl.report_type ? { type: tpl.report_type, day_of_month: 1, time_zone: a.time_zone } : null, branding: 'rizehub' },
        projects: tpl.projects.map((name, i) => ({ id: `pr_${a.workspace.id}_${i}`, name, status: i === 0 ? 'done' : 'open', created_at: t })),
        app_url: `${this.appUrl}/app/workspaces/${a.workspace.id}`, created_at: t,
      });
    }
  }

  private emit(event: WebhookEvent['event'], data: Record<string, unknown>): WebhookEvent {
    const e: WebhookEvent = { id: this.id('evt'), event, created_at: iso(this.now()), data };
    this.events.push(e);
    this.opts.onEvent?.(e);
    return e;
  }
  /** Admin hook for demos: emit any webhook event (client.signed_up, payment.received, lead.replied…). */
  simulate(event: string, data: Record<string, unknown>): WebhookEvent { return this.emit(event, data); }

  /** Finishes jobs whose time has come (called on every request and by the standalone server's timer). */
  completeDueJobs(): void {
    for (const j of this.jobs.values()) {
      if (j.status === 'completed' || j.status === 'failed') continue;
      if (this.now() < j.done_at_ms) { j.status = 'running'; j.progress = 50; continue; }
      try {
        if (j.type === 'lead_search') this.finishLeadSearch(j); else this.finishReport(j);
      } catch (e) {
        (j as Job).status = 'failed';
        j.error = { code: 'job_failed', message: e instanceof Error ? e.message : String(e), retryable: true };
      }
      j.completed_at = iso(this.now());
      j.progress = 100;
      const done = (j as Job).status === 'completed';
      this.emit(done ? 'job.completed' : 'job.failed',
        { job_id: j.id, type: j.type, status: j.status, result: j.result, error: j.error });
    }
  }

  // ---------- entry point ----------
  async handle(req: MockRequest): Promise<MockResponse> {
    this.completeDueJobs();
    const path = req.path.startsWith(API_PREFIX) ? req.path.slice(API_PREFIX.length) || '/' : req.path;
    const dryRun = req.query.get('dry_run') === 'true';
    const taskId = req.headers['x-hq-task-id'] ?? null;
    const agentId = req.headers['x-hq-agent-id'] ?? null;
    let label = 'anonymous';
    const rl: Record<string, string> = {};
    const finish = (res: MockResponse): MockResponse => {
      this.audit.push({ at: iso(this.now()), key_label: label, method: req.method, path, task_id: taskId, agent_id: agentId, status: res.status, dry_run: dryRun });
      return { ...res, headers: { 'content-type': 'application/json', ...rl, ...res.headers } };
    };
    try {
      // auth
      const auth = req.headers.authorization ?? '';
      const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      const row = key ? this.keys.get(hashKey(key)) : undefined;
      if (!row || row.revoked) throw new HttpError(401, 'unauthorized', row?.revoked ? 'This key was revoked' : 'Missing or unknown API key');
      label = row.label;
      row.last_used_at = iso(this.now());
      if (!taskId || !agentId) throw new HttpError(400, 'missing_hq_headers', 'X-HQ-Task-Id and X-HQ-Agent-Id are required');

      // rate limit (fixed window per key)
      const limit = this.opts.rateLimitPerMin ?? 300;
      const b = this.buckets.get(row.hash) ?? { windowStart: this.now(), count: 0 };
      if (this.now() - b.windowStart >= 60_000) { b.windowStart = this.now(); b.count = 0; }
      b.count++;
      this.buckets.set(row.hash, b);
      const reset = Math.ceil((b.windowStart + 60_000 - this.now()) / 1000);
      Object.assign(rl, { 'x-ratelimit-limit': String(limit), 'x-ratelimit-remaining': String(Math.max(0, limit - b.count)), 'x-ratelimit-reset': String(reset) });
      if (b.count > limit) return finish(this.error(new HttpError(429, 'rate_limited', 'Too many requests', true), { 'retry-after': String(reset) }));

      // injected faults (tests)
      const fi = this.faults.findIndex((f) => !f.match || f.match.test(path));
      if (fi >= 0) {
        const f = this.faults.splice(fi, 1)[0]!;
        return finish(this.error(new HttpError(f.status, f.code, `Injected ${f.status}`, f.retryable), f.retryAfter !== undefined ? { 'retry-after': String(f.retryAfter) } : {}));
      }

      const route = this.route(req.method, path);
      if (!route) throw new HttpError(404, 'not_found', `No route ${req.method} ${path}`);
      if (!hasScope(row.scopes, route.scope)) throw new HttpError(403, 'forbidden', `Key "${row.label}" lacks scope ${route.scope}`);

      const isWrite = req.method !== 'GET';
      const idemKey = req.headers['idempotency-key'];
      if (isWrite && !idemKey) throw new HttpError(400, 'missing_idempotency_key', 'Idempotency-Key header is required on writes');
      const fp = createHash('sha256').update(`${req.method} ${path} ${dryRun} ${JSON.stringify(req.body ?? null)}`).digest('hex');
      const slot = `${row.hash}|${idemKey}`;
      if (isWrite) {
        const prev = this.idem.get(slot);
        if (prev && prev.fp !== fp) throw new HttpError(409, 'idempotency_conflict', 'This Idempotency-Key was used with a different request');
        if (prev) return finish({ ...prev.res, headers: { ...prev.res.headers, 'idempotent-replayed': 'true' } });
      }
      const [status, body] = route.run({ body: req.body, query: req.query, dryRun, owner: row.label });
      const res: MockResponse = { status, headers: {}, body };
      if (isWrite && status < 500) this.idem.set(slot, { fp, res });
      return finish(res);
    } catch (e) {
      if (e instanceof HttpError) return finish(this.error(e));
      return finish(this.error(new HttpError(500, 'internal', e instanceof Error ? e.message : String(e), true)));
    }
  }

  private error(e: HttpError, headers: Record<string, string> = {}): MockResponse {
    const body: { error: ApiErrorBody } = { error: { code: e.code, message: e.message, retryable: e.retryable } };
    return { status: e.status, headers, body };
  }

  // ---------- routing ----------
  private route(method: string, path: string): { scope: string; run: (c: Ctx) => [number, unknown] } | null {
    const m = (re: RegExp) => path.match(re);
    let x: RegExpMatchArray | null;
    const seg = '([A-Za-z0-9_\\-]+)';
    if (method === 'POST' && path === '/leads/search') return { scope: 'leads:search', run: (c) => this.leadsSearch(c) };
    if (method === 'GET' && (x = m(new RegExp(`^/jobs/${seg}$`)))) return { scope: 'jobs:read', run: () => [200, this.publicJob(this.mustJob(x![1]!))] };
    if (method === 'GET' && (x = m(new RegExp(`^/leads/${seg}$`)))) return { scope: 'leads:read', run: () => [200, this.mustLead(x![1]!)] };
    if (method === 'PATCH' && (x = m(new RegExp(`^/leads/${seg}$`)))) return { scope: 'leads:write_stage', run: (c) => this.leadStage(x![1]!, c) };
    if (method === 'POST' && (x = m(new RegExp(`^/leads/${seg}/notes$`)))) return { scope: 'leads:write_notes', run: (c) => this.leadNotes(x![1]!, c) };
    if (method === 'POST' && path === '/lists') return { scope: 'lists:write', run: (c) => this.listCreate(c) };
    if (method === 'POST' && (x = m(new RegExp(`^/lists/${seg}/leads$`)))) return { scope: 'lists:write', run: (c) => this.listAdd(x![1]!, c) };
    if (method === 'GET' && path === '/accounts') return { scope: 'accounts:read', run: (c) => this.accountsSearch(c) };
    if (method === 'POST' && path === '/accounts') return { scope: 'accounts:create', run: (c) => this.accountCreate(c) };
    if (method === 'GET' && (x = m(new RegExp(`^/accounts/${seg}$`)))) return { scope: 'accounts:read', run: () => [200, this.mustAccount(x![1]!)] };
    if (method === 'POST' && (x = m(new RegExp(`^/accounts/${seg}/workspaces$`)))) return { scope: 'workspaces:create', run: (c) => this.workspaceCreate(x![1]!, c) };
    if (method === 'POST' && (x = m(new RegExp(`^/accounts/${seg}/invites$`)))) return { scope: 'invites:draft', run: (c) => this.inviteDraft(x![1]!, c) };
    if (method === 'POST' && (x = m(new RegExp(`^/invites/${seg}/send$`)))) return { scope: 'invites:send', run: (c) => this.inviteSend(x![1]!, c) };
    if (method === 'GET' && (x = m(new RegExp(`^/workspaces/${seg}$`)))) return { scope: 'workspaces:read', run: () => [200, this.mustWorkspace(x![1]!)] };
    if (method === 'PUT' && (x = m(new RegExp(`^/workspaces/${seg}/config$`)))) return { scope: 'workspaces:configure', run: (c) => this.workspaceConfig(x![1]!, c) };
    if (method === 'POST' && (x = m(new RegExp(`^/workspaces/${seg}/projects$`)))) return { scope: 'workspaces:configure', run: (c) => this.workspaceProjects(x![1]!, c) };
    if (method === 'GET' && (x = m(new RegExp(`^/workspaces/${seg}/metrics$`)))) return { scope: 'metrics:read', run: (c) => [200, this.metrics(x![1]!, c)] };
    if (method === 'POST' && (x = m(new RegExp(`^/workspaces/${seg}/reports$`)))) return { scope: 'reports:generate', run: (c) => this.reportGenerate(x![1]!, c) };
    if (method === 'GET' && path === '/workspace-templates') return { scope: 'templates:read', run: () => [200, { templates: TEMPLATES }] };
    if (method === 'GET' && (x = m(new RegExp(`^/reports/${seg}$`)))) return { scope: 'reports:read', run: () => [200, this.mustReport(x![1]!)] };
    if (method === 'POST' && (x = m(new RegExp(`^/reports/${seg}/notes$`)))) return { scope: 'reports:write_notes', run: (c) => this.reportNotes(x![1]!, c) };
    if (method === 'POST' && (x = m(new RegExp(`^/reports/${seg}/publish$`)))) return { scope: 'reports:publish', run: (c) => this.reportPublish(x![1]!, c) };
    return null;
  }

  private must<T>(map: Map<string, T>, id: string, what: string): T { const v = map.get(id); if (!v) throw notFound(`${what} ${id}`); return v; }
  mustLead(id: string) { return this.must(this.leads, id, 'Lead'); }
  mustJob(id: string) { return this.must(this.jobs, id, 'Job'); }
  mustAccount(id: string) { return this.must(this.accounts, id, 'Account'); }
  mustWorkspace(id: string) { return this.must(this.workspaces, id, 'Workspace'); }
  mustReport(id: string) { return this.must(this.reports, id, 'Report'); }
  private publicJob(j: JobRow): Job {
    const { done_at_ms: _d, owner: _o, payload: _p, ...pub } = j;
    return pub;
  }
  private newJob(type: Job['type'], owner: string, payload: Record<string, unknown>): JobRow {
    const j: JobRow = { id: this.id('job'), type, status: 'queued', progress: 0, result: null, error: null, created_at: iso(this.now()), completed_at: null,
      done_at_ms: this.now() + (this.opts.jobDelayMs ?? 400), owner, payload };
    this.jobs.set(j.id, j);
    if ((this.opts.jobDelayMs ?? 400) <= 0) this.completeDueJobs();
    return j;
  }
  private dry<T>(would: T, warnings: string[] = []): [number, unknown] { return [200, { dry_run: true, valid: true, would, warnings }]; }

  // ---------- Lead Finder ----------
  private leadsSearch(c: Ctx): [number, unknown] {
    const b = isObj(c.body) ? c.body : {};
    const p: LeadSearchParams = {
      industry: str(b.industry, 120), location: str(b.location, 120),
      platform: b.platform === undefined ? undefined : (PLATFORMS.includes(b.platform as Platform) ? b.platform as Platform : (() => { throw bad(`platform must be one of ${PLATFORMS.join(', ')}`); })()),
      signals: Array.isArray(b.signals) ? b.signals.map((s) => { if (!SIGNAL_KEYS.includes(s as SignalKey)) throw bad(`unknown signal "${String(s)}" (use ${SIGNAL_KEYS.join(', ')})`); return s as SignalKey; }) : undefined,
      limit: b.limit === undefined ? 25 : Number(b.limit),
    };
    if (!Number.isInteger(p.limit) || p.limit! < 1 || p.limit! > 100) throw bad('limit must be an integer 1–100');
    if (c.dryRun) return this.dry({ type: 'lead_search', params: p });
    const j = this.newJob('lead_search', c.owner, p as Record<string, unknown>);
    return [202, { job_id: j.id, status: j.status }];
  }

  /** Match criteria against the pool; relax industry, then location, when too few match. */
  searchPool(p: LeadSearchParams): Lead[] {
    const norm = (s: string) => s.toLowerCase().trim();
    const loc = p.location ? norm(p.location).split(/[,/]/).map((s) => COUNTRY_ALIASES[s.trim()] ?? s.trim()).filter(Boolean) : [];
    const words = p.industry ? norm(p.industry).split(/[^a-z0-9]+/).filter((w) => w.length > 2) : [];
    const all = [...this.leads.values()];
    const pass = (l: Lead, useIndustry: boolean, useLocation: boolean) =>
      (!p.platform || l.platform === p.platform)
      && (!useLocation || !loc.length || loc.some((x) => [l.location.country, l.location.region ?? '', l.location.city ?? ''].some((v) => norm(v) === x || norm(v).includes(x))))
      && (!useIndustry || !words.length || words.some((w) => norm(l.industry).includes(w)))
      && (!p.signals?.length || l.signals.some((s) => p.signals!.includes(s.key)));
    let hits = all.filter((l) => pass(l, true, true));
    if (hits.length < 3) hits = all.filter((l) => pass(l, false, true));
    if (hits.length < 3) hits = all.filter((l) => pass(l, false, false));
    return hits.sort((a, b) => b.score - a.score).slice(0, p.limit ?? 25);
  }
  private finishLeadSearch(j: JobRow) {
    const hits = this.searchPool(j.payload as LeadSearchParams);
    j.status = 'completed';
    j.result = { lead_ids: hits.map((l) => l.id), total: hits.length };
  }

  private leadNotes(id: string, c: Ctx): [number, unknown] {
    const lead = this.mustLead(id);
    const b = isObj(c.body) ? c.body : {};
    const body = str(b.body, 4000);
    if (!body) throw bad('body is required');
    const fit = b.fit_score === undefined || b.fit_score === null ? null : Number(b.fit_score);
    if (fit !== null && (!Number.isInteger(fit) || fit < 0 || fit > 100)) throw bad('fit_score must be an integer 0–100');
    const findings = Array.isArray(b.findings) ? b.findings.map((f) => String(f).slice(0, 500)).slice(0, 10) : [];
    if (c.dryRun) return this.dry({ lead_id: id, note: { body, fit_score: fit, angle: str(b.angle, 500) ?? null, findings } });
    lead.notes.push({ id: this.id('note'), body, fit_score: fit, angle: str(b.angle, 500) ?? null, findings, author: c.owner, created_at: iso(this.now()) });
    if (fit !== null) lead.fit_score = fit;
    if (str(b.angle)) lead.angle = str(b.angle, 500)!;
    if (lead.stage === 'new') lead.stage = 'researched';
    lead.updated_at = iso(this.now());
    return [200, lead];
  }

  private leadStage(id: string, c: Ctx): [number, unknown] {
    const lead = this.mustLead(id);
    const b = isObj(c.body) ? c.body : {};
    const stage = b.stage as LeadStage;
    if (!LEAD_STAGES.includes(stage)) throw bad(`stage must be one of ${LEAD_STAGES.join(', ')}`);
    if (stage === 'new' && lead.stage !== 'new') throw new HttpError(409, 'invalid_stage', 'A lead cannot move back to "new"');
    if (c.dryRun) return this.dry({ lead_id: id, from: lead.stage, to: stage });
    lead.stage = stage;
    lead.updated_at = iso(this.now());
    return [200, lead];
  }

  private listCreate(c: Ctx): [number, unknown] {
    const b = isObj(c.body) ? c.body : {};
    const name = str(b.name, 120);
    if (!name) throw bad('name is required');
    const ids = Array.isArray(b.lead_ids) ? b.lead_ids.map(String) : [];
    for (const id of ids) this.mustLead(id);
    if (c.dryRun) return this.dry({ name, lead_ids: ids });
    const existing = [...this.lists.values()].find((l) => l.name.toLowerCase() === name.toLowerCase());
    const list = existing ?? { id: this.id('lst'), name, lead_ids: [], created_at: iso(this.now()) };
    this.lists.set(list.id, list);
    this.addToList(list, ids);
    return [existing ? 200 : 201, list];
  }
  private listAdd(id: string, c: Ctx): [number, unknown] {
    const list = this.must(this.lists, id, 'List');
    const b = isObj(c.body) ? c.body : {};
    const ids = Array.isArray(b.lead_ids) ? b.lead_ids.map(String) : [];
    if (!ids.length) throw bad('lead_ids is required');
    for (const x of ids) this.mustLead(x);
    if (c.dryRun) return this.dry({ list_id: id, add: ids });
    this.addToList(list, ids);
    return [200, list];
  }
  private addToList(list: LeadList, ids: string[]) {
    for (const id of ids) {
      if (!list.lead_ids.includes(id)) list.lead_ids.push(id);
      const l = this.leads.get(id)!;
      if (!l.list_ids.includes(list.id)) l.list_ids.push(list.id);
    }
  }

  // ---------- accounts & workspaces ----------
  private accountsSearch(c: Ctx): [number, unknown] {
    const q = (c.query.get('q') ?? '').toLowerCase().trim();
    const domain = (c.query.get('domain') ?? '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    const hits = [...this.accounts.values()].filter((a) =>
      (q && a.company.toLowerCase().includes(q)) || (domain && (a.domain ?? '').toLowerCase().replace(/^www\./, '') === domain));
    return [200, { accounts: hits }];
  }

  private accountCreate(c: Ctx): [number, unknown] {
    const b = isObj(c.body) ? c.body : {};
    const company = str(b.company, 120);
    const pc = isObj(b.primary_contact) ? b.primary_contact : {};
    const plan = str(b.plan, 60);
    const errors: string[] = [];
    if (!company) errors.push('company is required');
    if (!str(pc.name)) errors.push('primary_contact.name is required');
    if (!str(pc.email) || !EMAIL.test(String(pc.email))) errors.push('primary_contact.email must be a valid email');
    if (!plan) errors.push('plan is required');
    if (errors.length) throw bad(errors.join('; '));
    const domain = str(b.domain, 200)?.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '') ?? null;
    const dup = [...this.accounts.values()].find((a) => a.company.toLowerCase() === company!.toLowerCase() || (domain && a.domain?.replace(/^www\./, '') === domain));
    if (dup) throw new HttpError(409, 'account_exists', `An account for ${dup.company} already exists (${dup.id})`);
    const acc: Account = {
      id: c.dryRun ? 'acc_dry_run' : this.id('acc'), company: company!, domain, plan: plan!,
      primary_contact: { name: str(pc.name, 120)!, email: String(pc.email).trim(), role: str(pc.role, 80) },
      country: str(b.country, 60) ?? null, time_zone: str(b.time_zone, 60) ?? null, test: b.test === true, status: 'active', workspace_ids: [],
      created_at: iso(this.now()),
    };
    if (c.dryRun) return this.dry(acc, acc.test ? [] : ['test is false: this creates a real client account']);
    this.accounts.set(acc.id, acc);
    this.emit('account.created', { account_id: acc.id, company: acc.company });
    return [201, acc];
  }

  private workspaceCreate(accountId: string, c: Ctx): [number, unknown] {
    const acc = accountId === 'new' && c.dryRun ? null : this.mustAccount(accountId);
    const b = isObj(c.body) ? c.body : {};
    const tpl = TEMPLATES.find((t) => t.id === b.template);
    if (!tpl) throw bad(`template must be one of ${TEMPLATES.map((t) => t.id).join(', ')}`);
    const name = str(b.name, 120) ?? acc?.company;
    if (!name) throw bad('name is required');
    if (acc && acc.workspace_ids.some((w) => this.workspaces.get(w)?.template === tpl.id)) {
      throw new HttpError(409, 'workspace_exists', `${acc.company} already has a ${tpl.id} workspace`);
    }
    const ws: Workspace = {
      id: c.dryRun ? 'ws_dry_run' : this.id('ws'), account_id: acc?.id ?? 'new', name, template: tpl.id,
      config: { services_enabled: tpl.services, report_schedule: tpl.report_type ? { type: tpl.report_type, day_of_month: 1 } : null, branding: 'rizehub' },
      projects: tpl.projects.map((p, i) => ({ id: `pr_tpl_${i}`, name: p, status: 'open' as const, created_at: iso(this.now()) })),
      app_url: '', created_at: iso(this.now()),
    };
    if (c.dryRun) return this.dry(ws);
    ws.app_url = `${this.appUrl}/app/workspaces/${ws.id}`;
    ws.projects = ws.projects.map((p, i) => ({ ...p, id: `${ws.id}_pr${i}` }));
    this.workspaces.set(ws.id, ws);
    acc!.workspace_ids.push(ws.id);
    this.emit('workspace.ready', { workspace_id: ws.id, account_id: acc!.id, template: tpl.id });
    return [201, ws];
  }

  private validateConfig(b: Record<string, unknown>): WorkspaceConfig {
    const errors: string[] = [];
    const cfg: WorkspaceConfig = {};
    if (b.site_url !== undefined) {
      try { const u = new URL(String(b.site_url)); if (!/^https?:$/.test(u.protocol)) throw new Error(); cfg.site_url = u.toString().replace(/\/$/, ''); } catch { errors.push('site_url must be an http(s) URL'); }
    }
    if (b.platform !== undefined) { if (PLATFORMS.includes(b.platform as Platform)) cfg.platform = b.platform as Platform; else errors.push(`platform must be one of ${PLATFORMS.join(', ')}`); }
    if (b.services_enabled !== undefined) {
      const s = Array.isArray(b.services_enabled) ? b.services_enabled.map(String) : [];
      const unknown = s.filter((x) => !SERVICES.includes(x));
      if (!Array.isArray(b.services_enabled) || unknown.length) errors.push(`services_enabled has unknown services: ${unknown.join(', ') || '(not a list)'}`);
      else cfg.services_enabled = s;
    }
    if (b.report_schedule !== undefined && b.report_schedule !== null) {
      const r = isObj(b.report_schedule) ? b.report_schedule : {};
      const day = Number(r.day_of_month);
      if (!REPORT_TYPES.includes(r.type as ReportType)) errors.push(`report_schedule.type must be one of ${REPORT_TYPES.join(', ')}`);
      if (!Number.isInteger(day) || day < 1 || day > 28) errors.push('report_schedule.day_of_month must be 1–28');
      cfg.report_schedule = { type: r.type as ReportType, day_of_month: day, time_zone: str(r.time_zone, 60) };
    } else if (b.report_schedule === null) cfg.report_schedule = null;
    if (b.branding !== undefined && b.branding !== 'rizehub') errors.push('branding must be "rizehub"');
    if (errors.length) throw bad(errors.join('; '));
    return cfg;
  }
  private workspaceConfig(id: string, c: Ctx): [number, unknown] {
    const ws = id === 'new' && c.dryRun ? null : this.mustWorkspace(id);
    const cfg = this.validateConfig(isObj(c.body) ? c.body : {});
    if (c.dryRun) return this.dry({ workspace_id: id, config: { ...(ws?.config ?? {}), ...cfg } });
    ws!.config = { ...ws!.config, ...cfg };
    return [200, ws];
  }
  private workspaceProjects(id: string, c: Ctx): [number, unknown] {
    const ws = id === 'new' && c.dryRun ? null : this.mustWorkspace(id);
    const b = isObj(c.body) ? c.body : {};
    const names = Array.isArray(b.projects) ? b.projects.map((p) => (isObj(p) ? str(p.name, 120) : str(p, 120))) : [];
    if (!names.length || names.some((n) => !n) || names.length > 20) throw bad('projects must be 1–20 items with a name');
    const projects = names.map((name, i) => ({ id: `${ws?.id ?? 'new'}_prx${(ws?.projects.length ?? 0) + i}`, name: name!, status: 'open' as const, created_at: iso(this.now()) }));
    if (c.dryRun) return this.dry({ projects });
    const fresh = projects.filter((p) => !ws!.projects.some((x) => x.name.toLowerCase() === p.name.toLowerCase()));
    ws!.projects.push(...fresh);
    return [201, { projects: ws!.projects }];
  }

  private inviteDraft(accountId: string, c: Ctx): [number, unknown] {
    const acc = this.mustAccount(accountId);
    if (c.query.get('send') !== 'false') throw bad('Invites are prepared with ?send=false; send them with POST /invites/{id}/send');
    const b = isObj(c.body) ? c.body : {};
    const email = str(b.email, 200) ?? acc.primary_contact.email;
    if (!EMAIL.test(email)) throw bad('email must be a valid email');
    const inv: Invite = {
      id: c.dryRun ? 'inv_dry_run' : this.id('inv'), account_id: acc.id, email, role: str(b.role, 40) ?? 'owner', status: 'draft', sent_at: null,
      preview: { subject: `You're invited to your RizeHub workspace, ${acc.company}`, body: `Hi ${acc.primary_contact.name}, your RizeHub workspace is ready. Accept the invite to see your projects, reports and approvals.` },
    };
    if (c.dryRun) return this.dry(inv);
    this.invites.set(inv.id, inv);
    return [201, inv];
  }
  private inviteSend(id: string, c: Ctx): [number, unknown] {
    const inv = this.must(this.invites, id, 'Invite');
    if (inv.status === 'sent') throw new HttpError(409, 'invite_already_sent', `Invite ${id} was already sent`);
    if (c.dryRun) return this.dry({ ...inv, status: 'sent' });
    inv.status = 'sent';
    inv.sent_at = iso(this.now());
    return [200, inv];
  }

  // ---------- reports ----------
  metricSet(seed: string): MetricSet {
    const r = seeded(seed);
    const sessions = Math.round(4000 + r() * 20000);
    const clicks = Math.round(sessions * (0.35 + r() * 0.2));
    const impressions = Math.round(clicks * (18 + r() * 20));
    return {
      sessions, users: Math.round(sessions * 0.78), conversions: Math.round(sessions * (0.012 + r() * 0.02)),
      revenue: Math.round(sessions * (1.1 + r() * 2.4)), organic_clicks: clicks, impressions,
      ctr: Math.round((clicks / impressions) * 1000) / 10, avg_position: Math.round((8 + r() * 14) * 10) / 10,
    };
  }
  private metrics(wsId: string, c: Ctx) {
    this.mustWorkspace(wsId);
    const from = c.query.get('from') ?? '';
    const to = c.query.get('to') ?? '';
    if (!DATE.test(from) || !DATE.test(to) || from > to) throw bad('from and to must be YYYY-MM-DD with from ≤ to');
    const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
    const prevTo = new Date(Date.parse(from) - 86_400_000).toISOString().slice(0, 10);
    const prevFrom = new Date(Date.parse(prevTo) - (days - 1) * 86_400_000).toISOString().slice(0, 10);
    return { workspace_id: wsId, from, to, metrics: this.metricSet(`${wsId}:${from}:${to}`), previous: this.metricSet(`${wsId}:${prevFrom}:${prevTo}`), currency: 'USD' };
  }
  private reportGenerate(wsId: string, c: Ctx): [number, unknown] {
    this.mustWorkspace(wsId);
    const b = isObj(c.body) ? c.body : {};
    const p = isObj(b.period) ? b.period : {};
    if (!REPORT_TYPES.includes(b.type as ReportType)) throw bad(`type must be one of ${REPORT_TYPES.join(', ')}`);
    if (!DATE.test(String(p.from)) || !DATE.test(String(p.to)) || String(p.from) > String(p.to)) throw bad('period.from and period.to must be YYYY-MM-DD with from ≤ to');
    if (c.dryRun) return this.dry({ type: 'report_generate', workspace_id: wsId, report_type: b.type, period: p });
    const j = this.newJob('report_generate', c.owner, { workspace_id: wsId, type: b.type, from: p.from, to: p.to });
    return [202, { job_id: j.id, status: j.status }];
  }
  private finishReport(j: JobRow) {
    const { workspace_id, type, from, to } = j.payload as { workspace_id: string; type: ReportType; from: string; to: string };
    const m = this.metrics(workspace_id, { query: new URLSearchParams({ from, to }), body: null, dryRun: false, owner: j.owner });
    const r = seeded(`${workspace_id}${from}`);
    const id = this.id('rpt');
    const token = randomBytes(8).toString('hex');
    this.reports.set(id, {
      id, workspace_id, type, period: { from, to }, status: 'draft',
      data: {
        metrics: m.metrics, previous: m.previous,
        top_pages: ['/', '/collections/all', '/products/bestseller', '/blogs/news/guide', '/pages/about'].map((path) => ({ path, clicks: Math.round(r() * 900) + 50 })).sort((a, b) => b.clicks - a.clicks),
        top_queries: ['brand name', 'best vinyl records online', 'buy records australia', 'record store near me', 'rare vinyl'].map((query) => ({ query, clicks: Math.round(r() * 400) + 10, position: Math.round((1 + r() * 20) * 10) / 10 })),
      },
      notes: null, preview_url: `${this.appUrl}/preview/reports/${id}?t=${token}`, pdf_url: `${this.appUrl}/preview/reports/${id}.pdf?t=${token}`,
      published_at: null, created_at: iso(this.now()),
    });
    j.status = 'completed';
    j.result = { report_id: id };
  }
  private reportNotes(id: string, c: Ctx): [number, unknown] {
    const rep = this.mustReport(id);
    if (rep.status === 'published') throw new HttpError(409, 'report_published', 'Published reports cannot be edited');
    const b = isObj(c.body) ? c.body : {};
    const summary = str(b.summary, 4000);
    if (!summary) throw bad('summary is required');
    const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).slice(0, 500)).slice(0, 12) : []);
    const notes = { summary, insights: list(b.insights), next_steps: list(b.next_steps), author: c.owner, updated_at: iso(this.now()) };
    if (c.dryRun) return this.dry({ report_id: id, notes });
    rep.notes = notes;
    return [200, rep];
  }
  private reportPublish(id: string, c: Ctx): [number, unknown] {
    const rep = this.mustReport(id);
    if (rep.status === 'published') throw new HttpError(409, 'report_published', 'Report is already published');
    if (!rep.notes) throw bad('Add notes (summary, insights, next steps) before publishing');
    const b = isObj(c.body) ? c.body : {};
    if (c.dryRun) return this.dry({ report_id: id, visible_to_client: true, notify_client: b.notify_client === true, preview_url: rep.preview_url });
    rep.status = 'published';
    rep.published_at = iso(this.now());
    return [200, rep];
  }
}

interface Ctx { body: unknown; query: URLSearchParams; dryRun: boolean; owner: string }

/** A fetch() that answers from the mock (for the client in mock mode and in tests). */
export function mockFetch(mock: MockRizehub) {
  return async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => { headers[k.toLowerCase()] = v; });
    let body: unknown = null;
    if (typeof init.body === 'string' && init.body) {
      try { body = JSON.parse(init.body); } catch { return new Response(JSON.stringify({ error: { code: 'invalid_json', message: 'Body is not JSON', retryable: false } }), { status: 400 }); }
    }
    const res = await mock.handle({ method: (init.method ?? 'GET').toUpperCase(), path: u.pathname, query: u.searchParams, headers, body });
    return new Response(res.status === 204 ? null : JSON.stringify(res.body), { status: res.status, headers: res.headers });
  };
}
