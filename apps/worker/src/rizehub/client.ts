// Typed RizeHub Agent API client (docs/12). One method per endpoint; every call carries the HQ audit headers
// (X-HQ-Task-Id, X-HQ-Agent-Id), writes carry Idempotency-Key = `${taskId}:${step}` (dry runs get a ":dry_run"
// suffix so a later real call is never answered with the stored dry-run result), 429/5xx/network errors are
// retried with backoff (Retry-After wins), and every failure becomes a RizehubError {code, message, retryable}.
import {
  API_PREFIX, ENDPOINTS, fillPath,
  type Account, type AccountInput, type ApiErrorBody, type DryRunResult, type EndpointName, type Invite, type Job, type KeyGroup,
  type Lead, type LeadList, type LeadSearchParams, type LeadStage, type Metrics, type Project, type Report, type ReportNotes,
  type ReportType, type Template, type Workspace, type WorkspaceConfig, type WorkspaceInput,
} from './contract';

export class RizehubError extends Error implements ApiErrorBody {
  constructor(readonly code: string, message: string, readonly retryable: boolean, readonly status = 0) {
    super(message);
    this.name = 'RizehubError';
  }
  toJSON(): ApiErrorBody { return { code: this.code, message: this.message, retryable: this.retryable }; }
}

/** Who is calling, for RizeHub's audit log and idempotency keys. */
export interface CallCtx { taskId: string; agentId: string }

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ClientOptions {
  baseUrl: string;                                // e.g. http://rizehub-app:8080/agent-api/v1
  keys: Partial<Record<KeyGroup, string>>;
  fetch?: FetchLike;
  maxRetries?: number;                            // default 4
  retryBaseMs?: number;                           // default 500
  retryMaxMs?: number;                            // default 8000
  requestTimeoutMs?: number;                      // default 20000
  sleep?: (ms: number) => Promise<void>;
  onRateLimit?: (info: { remaining: number | null; resetSec: number | null }) => void;
}

interface CallOpts {
  group: KeyGroup;
  endpoint: EndpointName;
  params?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  ctx: CallCtx;
  step?: string;                                  // required for writes (idempotency)
  dryRun?: boolean;
}

export interface CallResult<T> { status: number; data: T }
export interface Accepted { job_id: string; status: 'queued' | 'running' }
export interface WaitOptions { timeoutMs?: number; pollMs?: number; maxPollMs?: number }

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export function idempotencyKey(taskId: string, step: string, dryRun = false): string {
  return `${taskId}:${step}${dryRun ? ':dry_run' : ''}`;
}

function parseRetryAfter(v: string | null): number | null {
  if (!v) return null;
  const s = Number(v);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : Math.max(0, t - Date.now());
}

export class RizehubClient {
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  readonly baseUrl: string;

  constructor(private readonly opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Low-level call with auth, audit headers, idempotency, retries and error mapping. */
  async call<T>(o: CallOpts): Promise<CallResult<T>> {
    const ep = ENDPOINTS[o.endpoint];
    const key = this.opts.keys[o.group];
    if (!key) throw new RizehubError('missing_key', `RIZEHUB_KEY_${o.group} is not set in the worker env`, false);
    if (!o.ctx.taskId || !o.ctx.agentId) throw new RizehubError('missing_context', 'taskId and agentId are required', false);
    if (ep.write && !o.step) throw new RizehubError('missing_step', `${o.endpoint} is a write and needs an idempotency step`, false);

    const url = new URL(this.baseUrl + fillPath(ep.path, o.params));
    for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    if (o.dryRun) url.searchParams.set('dry_run', 'true');

    const headers: Record<string, string> = {
      authorization: `Bearer ${key}`,
      accept: 'application/json',
      'x-hq-task-id': o.ctx.taskId,
      'x-hq-agent-id': o.ctx.agentId,
    };
    if (ep.write) headers['idempotency-key'] = idempotencyKey(o.ctx.taskId, o.step!, o.dryRun);
    const hasBody = ep.write && o.body !== undefined;
    if (hasBody) headers['content-type'] = 'application/json';

    const max = this.opts.maxRetries ?? 4;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url.toString(), {
          method: ep.method, headers, body: hasBody ? JSON.stringify(o.body) : undefined,
          signal: AbortSignal.timeout(this.opts.requestTimeoutMs ?? 20_000),
        });
      } catch (e) {
        const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
        const err = new RizehubError(timeout ? 'timeout' : 'network_error',
          `${ep.method} ${ep.path}: ${timeout ? 'timed out' : e instanceof Error ? e.message : String(e)}`, true);
        if (attempt < max) { await this.sleep(this.backoff(attempt, null)); continue; }
        throw err;
      }

      const remaining = res.headers.get('x-ratelimit-remaining');
      if (remaining !== null || res.status === 429) {
        this.opts.onRateLimit?.({ remaining: remaining === null ? null : Number(remaining), resetSec: Number(res.headers.get('x-ratelimit-reset')) || null });
      }
      const text = await res.text();
      let json: unknown = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }

      if (res.ok) return { status: res.status, data: json as T };

      const body = (json as { error?: Partial<ApiErrorBody> } | null)?.error;
      const retryable = body?.retryable ?? RETRYABLE_STATUS.has(res.status);
      const err = new RizehubError(body?.code ?? `http_${res.status}`,
        body?.message ?? `${ep.method} ${ep.path} answered ${res.status}`, retryable, res.status);
      if (retryable && attempt < max) { await this.sleep(this.backoff(attempt, parseRetryAfter(res.headers.get('retry-after')))); continue; }
      throw err;
    }
  }

  private backoff(attempt: number, retryAfterMs: number | null): number {
    const cap = this.opts.retryMaxMs ?? 8_000;
    if (retryAfterMs !== null) return Math.min(retryAfterMs, cap * 4);
    const base = (this.opts.retryBaseMs ?? 500) * 2 ** attempt;
    return Math.min(cap, base + Math.floor(Math.random() * base * 0.25));
  }

  // ---------- jobs ----------
  async getJob(ctx: CallCtx, jobId: string, group: KeyGroup = 'READONLY'): Promise<Job> {
    return (await this.call<Job>({ group, endpoint: 'jobGet', params: { id: jobId }, ctx })).data;
  }

  /** Polls GET /jobs/{id} with backoff until completed/failed or the timeout; returns the last job state. */
  async waitForJob(ctx: CallCtx, jobId: string, group: KeyGroup, w: WaitOptions = {}): Promise<Job> {
    const deadline = Date.now() + (w.timeoutMs ?? 60_000);
    let delay = w.pollMs ?? 500;
    for (;;) {
      const job = await this.getJob(ctx, jobId, group);
      if (job.status === 'completed' || job.status === 'failed') return job;
      if (Date.now() + delay > deadline) return job;
      await this.sleep(delay);
      delay = Math.min(w.maxPollMs ?? 5_000, Math.round(delay * 1.6));
    }
  }

  // ---------- Lead Finder ----------
  async searchLeads(ctx: CallCtx, params: LeadSearchParams, step = 'leads_search'): Promise<Accepted> {
    return (await this.call<Accepted>({ group: 'LEADS', endpoint: 'leadsSearch', body: params, ctx, step })).data;
  }
  async getLead(ctx: CallCtx, id: string, group: KeyGroup = 'LEADS'): Promise<Lead> {
    return (await this.call<Lead>({ group, endpoint: 'leadGet', params: { id }, ctx })).data;
  }
  async addLeadNotes(ctx: CallCtx, id: string, note: { body: string; fit_score?: number; angle?: string; findings?: string[] }, step = `lead_notes:${id}`): Promise<Lead> {
    return (await this.call<Lead>({ group: 'LEADS', endpoint: 'leadNotes', params: { id }, body: note, ctx, step })).data;
  }
  async setLeadStage(ctx: CallCtx, id: string, stage: LeadStage, note?: string, step = `lead_stage:${id}:${stage}`): Promise<Lead> {
    return (await this.call<Lead>({ group: 'LEADS', endpoint: 'leadStage', params: { id }, body: { stage, note }, ctx, step })).data;
  }
  async createList(ctx: CallCtx, name: string, leadIds: string[] = [], step = `list_create:${name}`): Promise<LeadList> {
    return (await this.call<LeadList>({ group: 'LEADS', endpoint: 'listCreate', body: { name, lead_ids: leadIds }, ctx, step })).data;
  }
  async addLeadsToList(ctx: CallCtx, listId: string, leadIds: string[], step = `list_add:${listId}:${leadIds.join(',').slice(0, 120)}`): Promise<LeadList> {
    return (await this.call<LeadList>({ group: 'LEADS', endpoint: 'listAddLeads', params: { id: listId }, body: { lead_ids: leadIds }, ctx, step })).data;
  }

  // ---------- accounts & workspaces ----------
  async searchAccounts(ctx: CallCtx, q: { q?: string; domain?: string }, group: KeyGroup = 'READONLY'): Promise<{ accounts: Account[] }> {
    return (await this.call<{ accounts: Account[] }>({ group, endpoint: 'accountsSearch', query: q, ctx })).data;
  }
  async createAccount(ctx: CallCtx, input: AccountInput, o: { dryRun?: boolean; step?: string } = {}): Promise<Account | DryRunResult<Account>> {
    return (await this.call<Account | DryRunResult<Account>>({ group: 'ONBOARDING', endpoint: 'accountCreate', body: input, ctx, step: o.step ?? 'account', dryRun: o.dryRun })).data;
  }
  async getAccount(ctx: CallCtx, id: string, group: KeyGroup = 'READONLY'): Promise<Account> {
    return (await this.call<Account>({ group, endpoint: 'accountGet', params: { id }, ctx })).data;
  }
  /** In a dry run, accountId may be "new" (the account created by the same approval). */
  async createWorkspace(ctx: CallCtx, accountId: string, input: WorkspaceInput, o: { dryRun?: boolean; step?: string } = {}): Promise<Workspace | DryRunResult<Workspace>> {
    return (await this.call<Workspace | DryRunResult<Workspace>>({ group: 'ONBOARDING', endpoint: 'workspaceCreate', params: { id: accountId }, body: input, ctx, step: o.step ?? 'workspace', dryRun: o.dryRun })).data;
  }
  async getWorkspace(ctx: CallCtx, id: string, group: KeyGroup = 'READONLY'): Promise<Workspace> {
    return (await this.call<Workspace>({ group, endpoint: 'workspaceGet', params: { id }, ctx })).data;
  }
  async configureWorkspace(ctx: CallCtx, id: string, config: WorkspaceConfig, o: { dryRun?: boolean; step?: string } = {}): Promise<Workspace | DryRunResult<Workspace>> {
    return (await this.call<Workspace | DryRunResult<Workspace>>({ group: 'ONBOARDING', endpoint: 'workspaceConfig', params: { id }, body: config, ctx, step: o.step ?? 'config', dryRun: o.dryRun })).data;
  }
  async createProjects(ctx: CallCtx, id: string, names: string[], o: { dryRun?: boolean; step?: string } = {}): Promise<{ projects: Project[] } | DryRunResult<{ projects: Project[] }>> {
    return (await this.call<{ projects: Project[] } | DryRunResult<{ projects: Project[] }>>({ group: 'ONBOARDING', endpoint: 'workspaceProjects', params: { id }, body: { projects: names.map((name) => ({ name })) }, ctx, step: o.step ?? 'projects', dryRun: o.dryRun })).data;
  }
  async listTemplates(ctx: CallCtx, group: KeyGroup = 'ONBOARDING'): Promise<{ templates: Template[] }> {
    return (await this.call<{ templates: Template[] }>({ group, endpoint: 'templatesList', ctx })).data;
  }
  /** Prepares the invite only (send=false); sending is a separate, approved call. */
  async draftInvite(ctx: CallCtx, accountId: string, input: { email: string; role?: string }, step = `invite_draft:${accountId}`): Promise<Invite> {
    return (await this.call<Invite>({ group: 'ONBOARDING', endpoint: 'inviteDraft', params: { id: accountId }, query: { send: false }, body: input, ctx, step })).data;
  }
  async sendInvite(ctx: CallCtx, inviteId: string, o: { dryRun?: boolean; step?: string } = {}): Promise<Invite | DryRunResult<Invite>> {
    return (await this.call<Invite | DryRunResult<Invite>>({ group: 'ONBOARDING', endpoint: 'inviteSend', params: { id: inviteId }, body: {}, ctx, step: o.step ?? `invite_send:${inviteId}`, dryRun: o.dryRun })).data;
  }

  // ---------- reports ----------
  async getMetrics(ctx: CallCtx, workspaceId: string, from: string, to: string, group: KeyGroup = 'REPORTS'): Promise<Metrics> {
    return (await this.call<Metrics>({ group, endpoint: 'metricsGet', params: { id: workspaceId }, query: { from, to }, ctx })).data;
  }
  async generateReport(ctx: CallCtx, workspaceId: string, input: { type: ReportType; period: { from: string; to: string } }, step = `report_generate:${workspaceId}:${input.type}:${input.period.from}`): Promise<Accepted> {
    return (await this.call<Accepted>({ group: 'REPORTS', endpoint: 'reportGenerate', params: { id: workspaceId }, body: input, ctx, step })).data;
  }
  async getReport(ctx: CallCtx, id: string, group: KeyGroup = 'REPORTS'): Promise<Report> {
    return (await this.call<Report>({ group, endpoint: 'reportGet', params: { id }, ctx })).data;
  }
  async addReportNotes(ctx: CallCtx, id: string, notes: Pick<ReportNotes, 'summary' | 'insights' | 'next_steps'>, step = `report_notes:${id}`): Promise<Report> {
    return (await this.call<Report>({ group: 'REPORTS', endpoint: 'reportNotes', params: { id }, body: notes, ctx, step })).data;
  }
  async publishReport(ctx: CallCtx, id: string, input: { notify_client: boolean }, o: { dryRun?: boolean; step?: string } = {}): Promise<Report | DryRunResult<Report>> {
    return (await this.call<Report | DryRunResult<Report>>({ group: 'REPORTS', endpoint: 'reportPublish', params: { id }, body: input, ctx, step: o.step ?? `report_publish:${id}`, dryRun: o.dryRun })).data;
  }
}

export function isDryRun<T>(x: T | DryRunResult<T>): x is DryRunResult<T> {
  return typeof x === 'object' && x !== null && (x as { dry_run?: unknown }).dry_run === true;
}

export function toRizehubError(e: unknown): RizehubError {
  if (e instanceof RizehubError) return e;
  return new RizehubError('internal', e instanceof Error ? e.message : String(e), false);
}

export { API_PREFIX };
