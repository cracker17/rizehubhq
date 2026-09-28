// RizeHub Agent API tools (docs/04 "RizeHub tools", docs/12, docs/13 §1–4): rizehub_leads, rizehub_reports,
// rizehub_readonly, rizehub_onboarding and job_tracker. Keys stay in the worker; agents see tool names and results.
// Rules enforced here, not left to the prompt:
// * lead stage "contacted"/"proposal" only after an approved send for that lead (external_action on this task)
// * report publish and invite send only through an approval; the worker executes them after "approved"
// * onboarding: always dry run first; the real create/configure runs only in a task resumed from an approved
//   external_action whose payload matches exactly, and only once (external_action_exec claim)
// * every RizeHub object touched is recorded in rizehub_refs (dashboard + office screen)
// Errors never throw into the agent loop: they come back as text {code, message, retryable}.
import { createHash } from 'node:crypto';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { ToolFactory } from './types';
import type { ToolContext } from '../runner';
import { getRizehub } from '../rizehub/config';
import { isDryRun, toRizehubError, type CallCtx, type RizehubClient } from '../rizehub/client';
import {
  GATED_STAGES, LEAD_STAGES, REPORT_TYPES, SIGNAL_KEYS,
  type AccountInput, type Job, type Lead, type LeadSignal, type MetricSet, type Report, type WorkspaceConfig,
} from '../rizehub/contract';
import { canonicalJobUrl, fetchJobFeeds, sourcesFromEnv, type FetchFeedsOptions } from '../rizehub/jobSources';
import { JOB_STATUSES, type ActionApprovalRow, type JobOppStatus, type JobOpportunityRow } from '../rizehub/store';

export interface RizehubToolDeps {
  client: RizehubClient;
  /** How long a tool waits for a Lead Finder / report job before parking the task until job.completed. */
  jobWaitMs: number;
  fetchFeeds?: (o: FetchFeedsOptions) => ReturnType<typeof fetchJobFeeds>;
}

// ---------- small helpers ----------
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}
const shortHash = (v: unknown) => createHash('sha1').update(stableStringify(v)).digest('hex').slice(0, 10);
const out = (v: unknown) => JSON.stringify(v);
const errText = (e: unknown) => {
  const r = toRizehubError(e);
  return `RizeHub error ${r.code}: ${r.message} (retryable: ${r.retryable ? 'yes' : 'no'})`;
};
const pct = (a: number, b: number) => (b ? Math.round(((a - b) / b) * 1000) / 10 : null);

const SIGNAL_PRIORITY = ['slow_site', 'low_mobile_score', 'no_ssl', 'hiring_dev', 'outdated_theme', 'broken_links', 'missing_meta', 'no_analytics'];
export function mainSignal(signals: LeadSignal[]): LeadSignal | undefined {
  return [...signals].sort((a, b) => SIGNAL_PRIORITY.indexOf(a.key) - SIGNAL_PRIORITY.indexOf(b.key))[0];
}
/** Small snapshot stored in rizehub_refs.summary for the dashboard board and the office screen. */
export function leadSummary(l: Lead): Record<string, unknown> {
  const m = mainSignal(l.signals);
  return {
    company: l.company, website: l.website, platform: l.platform, industry: l.industry, country: l.location.country,
    city: l.location.city ?? null, signal: m ? (m.value ?? m.label) : null, signal_key: m?.key ?? null,
    signals: l.signals.map((s) => s.value ?? s.label).slice(0, 4), score: l.score, fit_score: l.fit_score, angle: l.angle,
    stage: l.stage, app_url: l.app_url,
  };
}
function compactLead(l: Lead) {
  return {
    id: l.id, company: l.company, website: l.website, platform: l.platform, industry: l.industry,
    location: [l.location.city, l.location.region, l.location.country].filter(Boolean).join(', '),
    signals: l.signals.map((s) => s.value ? `${s.label}: ${s.value}` : s.label), score: l.score, stage: l.stage,
    fit_score: l.fit_score, contact: l.contact?.email ? `${l.contact.role ?? 'contact'} <${l.contact.email}> (${l.contact.source ?? 'business contact'})` : null,
  };
}
function reportView(r: Report) {
  const keys = Object.keys(r.data.metrics) as (keyof MetricSet)[];
  return {
    id: r.id, workspace_id: r.workspace_id, type: r.type, period: r.period, status: r.status, preview_url: r.preview_url, pdf_url: r.pdf_url,
    metrics: r.data.metrics, previous: r.data.previous,
    change_pct: Object.fromEntries(keys.map((k) => [k, pct(r.data.metrics[k], r.data.previous[k])])),
    top_pages: r.data.top_pages, top_queries: r.data.top_queries, notes: r.notes,
  };
}

/** Is there an approved send/outreach action on this task that names the lead? */
export function findApprovedSend(actions: ActionApprovalRow[], leadId: string, approvalId?: string): ActionApprovalRow | undefined {
  return actions.find((a) => a.status === 'approved'
    && (!approvalId || a.id === approvalId)
    && /send|email|outreach|dm|proposal|message/i.test(String(a.payload.action_type ?? ''))
    && JSON.stringify(a.payload).includes(leadId));
}

// ---------- onboarding payload ----------
const contactSchema = z.object({ name: z.string().min(1), email: z.string().email(), role: z.string().optional() });
const onboardingPayloadSchema = z.object({
  account: z.object({
    company: z.string().min(1), domain: z.string().optional(), primary_contact: contactSchema, plan: z.string().min(1),
    country: z.string().optional(), time_zone: z.string().optional(), test: z.boolean().optional(),
  }),
  workspace: z.object({ template: z.string().min(1), name: z.string().min(1) }),
  config: z.object({
    site_url: z.string().url().optional(), platform: z.enum(['shopify', 'webflow', 'wordpress', 'other']).optional(),
    services_enabled: z.array(z.string()).optional(),
    report_schedule: z.object({ type: z.enum(REPORT_TYPES), day_of_month: z.number().int().min(1).max(28), time_zone: z.string().optional() }).nullable().optional(),
    branding: z.literal('rizehub').optional(),
  }).optional(),
  projects: z.array(z.string().min(1)).max(20).optional(),
});
export type OnboardingPayload = z.infer<typeof onboardingPayloadSchema>;

export function onboardingSpec(approval: ActionApprovalRow): { payload: OnboardingPayload } | null {
  const spec = approval.payload.spec as { rizehub?: { op?: string; payload?: OnboardingPayload } } | undefined;
  return spec?.rizehub?.op === 'onboarding' && spec.rizehub.payload ? { payload: spec.rizehub.payload } : null;
}

export function createRizehubTools(d: RizehubToolDeps): ToolFactory {
  return (ctx: ToolContext): ToolSet => {
    const { task, deps, state } = ctx;
    const db = deps.db;
    const client = d.client;
    const cc: CallCtx = { taskId: task.id, agentId: task.agent_id };

    /** report_progress-style screen update that keeps the current progress. */
    const screen = async (app: 'leads' | 'doc' | 'sheet' | 'browser', note: string, title?: string, content?: string) => {
      try {
        const cur = await db.getAgentScreen(task.agent_id);
        const progress = cur?.task_id === task.id && cur.progress != null ? cur.progress : 10;
        await db.reportProgress(task.id, progress, note.slice(0, 200), { app, title, content: content?.slice(0, 4000) });
      } catch { /* the screen is cosmetic */ }
    };
    const ref = (kind: Parameters<typeof db.recordRizehubRef>[0]['kind'], rizehubId: string, summary: Record<string, unknown>, own = true) =>
      db.recordRizehubRef({ taskId: own ? task.id : null, kind, rizehubId, summary }).catch(() => '');
    const leadsTable = (leads: Lead[]) => leads.map((l) => `${l.company} · ${l.platform} · ${mainSignal(l.signals)?.value ?? '-'} · score ${l.score}`).join('\n');

    /** Wait for a job; park the task (and end this turn) if it is still running. */
    async function waitOrPark(jobId: string, group: 'LEADS' | 'REPORTS', toolName: string, type: Job['type']): Promise<Job | string> {
      const job = await client.waitForJob(cc, jobId, group, { timeoutMs: d.jobWaitMs });
      if (job.status === 'completed' || job.status === 'failed') return job;
      await db.parkTaskForJob(task.id, jobId, { type, tool: toolName });
      state.ended = 'asked';
      return `RizeHub job ${jobId} is still running (${job.progress}%). This task is paused and resumes automatically when RizeHub `
        + 'reports job.completed. Stop now.';
    }

    async function leadJobResult(job: Job): Promise<string> {
      if (job.status === 'failed') {
        await db.rizehubJobFinished(job.id, 'failed', { error: job.error ?? null }).catch(() => '');
        return `Lead Finder job ${job.id} failed: ${job.error?.message ?? 'unknown error'}. Per the SOP, retry the search once with the same `
          + 'criteria; if it fails again, ask_ceo.';
      }
      const ids = (job.result?.lead_ids ?? []).slice(0, 50);
      const leads: Lead[] = [];
      for (const id of ids) {
        try { leads.push(await client.getLead(cc, id)); } catch { /* skip unreadable lead */ }
      }
      for (const l of leads) await ref('lead', l.id, { ...leadSummary(l), found_at: new Date().toISOString(), search_job_id: job.id });
      await db.rizehubJobFinished(job.id, 'completed', { lead_count: leads.length }).catch(() => '');
      await screen('leads', `Lead Finder returned ${leads.length} leads`, 'RizeHub Lead Finder', leadsTable(leads));
      return out({ job_id: job.id, total: job.result?.total ?? leads.length, returned: leads.length, leads: leads.map(compactLead),
        next: 'Verify each lead (web_fetch/pagespeed), then add_notes with fit_score + angle; save the keepers with create_list.' });
    }

    async function reportJobResult(job: Job): Promise<string> {
      if (job.status === 'failed') {
        await db.rizehubJobFinished(job.id, 'failed', { error: job.error ?? null }).catch(() => '');
        return `Report job ${job.id} failed: ${job.error?.message ?? 'unknown error'}. Retry generate once, then ask_ceo.`;
      }
      const id = job.result?.report_id;
      if (!id) return `Report job ${job.id} completed without a report id; ask_ceo.`;
      const r = await client.getReport(cc, id);
      await ref('report', r.id, { workspace_id: r.workspace_id, type: r.type, period: r.period, status: r.status, preview_url: r.preview_url });
      await db.rizehubJobFinished(job.id, 'completed', { report_id: id }).catch(() => '');
      await screen('doc', `Report ${r.type} ${r.period.from}…${r.period.to} generated`, `Report ${r.id}`, JSON.stringify(r.data.metrics, null, 1));
      return out(reportView(r));
    }

    // ======================= rizehub_leads =======================
    const rizehub_leads = tool({
      description: 'RizeHub Lead Finder. Actions: search (industry, location, platform, signals, limit → waits for the job and returns '
        + 'leads), job (job_id: check/load a search), get (lead_id), add_notes (lead_id, notes, fit_score, angle, findings), create_list '
        + '(list_name, lead_ids), add_to_list (list_id, lead_ids), set_stage (lead_id, stage). Stages contacted/proposal need an approved '
        + 'send for that lead first (pass its approval_id). Business contact data only.',
      inputSchema: z.object({
        action: z.enum(['search', 'job', 'get', 'add_notes', 'create_list', 'add_to_list', 'set_stage']),
        industry: z.string().max(120).optional().describe('Niche, e.g. "skincare DTC"'),
        location: z.string().max(120).optional().describe('Country and optional state/city, e.g. "Australia"'),
        platform: z.enum(['shopify', 'webflow', 'wordpress', 'other']).optional(),
        signals: z.array(z.enum(SIGNAL_KEYS)).max(4).optional().describe('Buying triggers to match'),
        limit: z.number().int().min(1).max(100).optional(),
        job_id: z.string().optional(),
        lead_id: z.string().optional(),
        lead_ids: z.array(z.string()).max(100).optional(),
        notes: z.string().max(4000).optional().describe('Research notes with evidence (URL + metric + date)'),
        fit_score: z.number().int().min(0).max(100).optional(),
        angle: z.string().max(500).optional().describe('Recommended outreach angle'),
        findings: z.array(z.string().max(500)).max(10).optional(),
        list_name: z.string().max(120).optional(),
        list_id: z.string().optional(),
        stage: z.enum(LEAD_STAGES).optional(),
        approval_id: z.string().optional().describe('For contacted/proposal: the approved send action'),
      }),
      execute: async (i) => {
        try {
          switch (i.action) {
            case 'search': {
              const params = { industry: i.industry, location: i.location, platform: i.platform, signals: i.signals, limit: i.limit ?? 25 };
              await screen('leads', `Lead Finder: searching ${[i.platform, i.industry, i.location].filter(Boolean).join(' · ') || 'all'}`, 'RizeHub Lead Finder');
              const acc = await client.searchLeads(cc, params, `leads_search:${shortHash(params)}`);
              await ref('job', acc.job_id, { type: 'lead_search', tool: 'rizehub_leads', status: 'pending', criteria: params });
              const job = await waitOrPark(acc.job_id, 'LEADS', 'rizehub_leads', 'lead_search');
              return typeof job === 'string' ? job : await leadJobResult(job);
            }
            case 'job': {
              if (!i.job_id) return 'job_id is required.';
              const job = await waitOrPark(i.job_id, 'LEADS', 'rizehub_leads', 'lead_search');
              return typeof job === 'string' ? job : await leadJobResult(job);
            }
            case 'get': {
              if (!i.lead_id) return 'lead_id is required.';
              const l = await client.getLead(cc, i.lead_id);
              await ref('lead', l.id, leadSummary(l));
              return out({ ...compactLead(l), angle: l.angle, notes: l.notes.slice(-5).map((n) => ({ at: n.created_at, body: n.body.slice(0, 600), fit_score: n.fit_score })), app_url: l.app_url });
            }
            case 'add_notes': {
              if (!i.lead_id || !i.notes) return 'lead_id and notes are required.';
              const note = { body: i.notes, fit_score: i.fit_score, angle: i.angle, findings: i.findings };
              const l = await client.addLeadNotes(cc, i.lead_id, note, `lead_notes:${i.lead_id}:${shortHash(note)}`);
              await ref('lead', l.id, { ...leadSummary(l), researched_at: new Date().toISOString() });
              await screen('leads', `Notes saved: ${l.company} (fit ${l.fit_score ?? '-'})`, l.company, `${l.website}\n${i.notes.slice(0, 600)}`);
              return out({ ok: true, lead_id: l.id, stage: l.stage, fit_score: l.fit_score, angle: l.angle });
            }
            case 'create_list': {
              if (!i.list_name) return 'list_name is required (e.g. "2026-10 skincare AU shopify").';
              const ids = i.lead_ids ?? [];
              const list = await client.createList(cc, i.list_name, ids, `list_create:${shortHash([i.list_name, ids])}`);
              await ref('lead_list', list.id, { name: list.name, count: list.lead_ids.length });
              for (const id of ids) await ref('lead', id, { list: list.name }, false);
              return out({ ok: true, list_id: list.id, name: list.name, count: list.lead_ids.length });
            }
            case 'add_to_list': {
              if (!i.list_id || !i.lead_ids?.length) return 'list_id and lead_ids are required.';
              const list = await client.addLeadsToList(cc, i.list_id, i.lead_ids, `list_add:${i.list_id}:${shortHash(i.lead_ids)}`);
              await ref('lead_list', list.id, { name: list.name, count: list.lead_ids.length });
              for (const id of i.lead_ids) await ref('lead', id, { list: list.name }, false);
              return out({ ok: true, list_id: list.id, count: list.lead_ids.length });
            }
            case 'set_stage': {
              if (!i.lead_id || !i.stage) return 'lead_id and stage are required.';
              let approval: ActionApprovalRow | undefined;
              if (GATED_STAGES.includes(i.stage)) {
                approval = findApprovedSend(await db.listTaskActions(task.id), i.lead_id, i.approval_id);
                if (!approval) {
                  return `Refused: stage "${i.stage}" is set only after the CEO approved the send for lead ${i.lead_id} and it was sent. `
                    + 'Propose it with request_external_action (include the lead id), wait for approval, then call set_stage with approval_id.';
                }
              }
              const l = await client.setLeadStage(cc, i.lead_id, i.stage, approval ? `Approved send ${approval.id}` : undefined);
              await ref('lead', l.id, { ...leadSummary(l), [`${i.stage}_at`]: new Date().toISOString(), ...(approval ? { approval_id: approval.id } : {}) });
              return out({ ok: true, lead_id: l.id, stage: l.stage });
            }
          }
        } catch (e) { return errText(e); }
      },
    });

    // ======================= rizehub_reports =======================
    const canGenerate = ctx.role.id === 'coo'; // the COO owns client reports
    const rizehub_reports = tool({
      description: 'RizeHub report tools. Actions: metrics (workspace_id, from, to), generate (workspace_id, type, from, to → waits for '
        + 'the job), job (job_id), get (report_id), add_notes (report_id, summary, insights, next_steps), publish (report_id, '
        + 'notify_client: creates a CEO approval; the worker publishes after approval). Dates are YYYY-MM-DD.',
      inputSchema: z.object({
        action: z.enum(['metrics', 'generate', 'job', 'get', 'add_notes', 'publish']),
        workspace_id: z.string().optional(),
        type: z.enum(REPORT_TYPES).optional(),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        job_id: z.string().optional(),
        report_id: z.string().optional(),
        summary: z.string().max(4000).optional(),
        insights: z.array(z.string().max(500)).max(12).optional(),
        next_steps: z.array(z.string().max(500)).max(12).optional(),
        notify_client: z.boolean().optional().describe('publish: also email the client'),
      }),
      execute: async (i) => {
        try {
          switch (i.action) {
            case 'metrics': {
              if (!i.workspace_id || !i.from || !i.to) return 'workspace_id, from and to are required.';
              const m = await client.getMetrics(cc, i.workspace_id, i.from, i.to);
              const keys = Object.keys(m.metrics) as (keyof MetricSet)[];
              return out({ ...m, change_pct: Object.fromEntries(keys.map((k) => [k, pct(m.metrics[k], m.previous[k])])) });
            }
            case 'generate': {
              if (!canGenerate) return 'Only the COO generates reports; you can read metrics/reports and add notes.';
              if (!i.workspace_id || !i.type || !i.from || !i.to) return 'workspace_id, type, from and to are required.';
              await screen('doc', `Generating ${i.type} report ${i.from}…${i.to}`, 'RizeHub report');
              const acc = await client.generateReport(cc, i.workspace_id, { type: i.type, period: { from: i.from, to: i.to } });
              await ref('job', acc.job_id, { type: 'report_generate', tool: 'rizehub_reports', status: 'pending', workspace_id: i.workspace_id, report_type: i.type, period: { from: i.from, to: i.to } });
              const job = await waitOrPark(acc.job_id, 'REPORTS', 'rizehub_reports', 'report_generate');
              return typeof job === 'string' ? job : await reportJobResult(job);
            }
            case 'job': {
              if (!i.job_id) return 'job_id is required.';
              const job = await waitOrPark(i.job_id, 'REPORTS', 'rizehub_reports', 'report_generate');
              return typeof job === 'string' ? job : await reportJobResult(job);
            }
            case 'get': {
              if (!i.report_id) return 'report_id is required.';
              const r = await client.getReport(cc, i.report_id);
              await ref('report', r.id, { workspace_id: r.workspace_id, type: r.type, period: r.period, status: r.status, preview_url: r.preview_url });
              return out(reportView(r));
            }
            case 'add_notes': {
              if (!i.report_id || !i.summary) return 'report_id and summary are required.';
              const notes = { summary: i.summary, insights: i.insights ?? [], next_steps: i.next_steps ?? [] };
              const r = await client.addReportNotes(cc, i.report_id, notes, `report_notes:${i.report_id}:${shortHash(notes)}`);
              await ref('report', r.id, { notes_added_at: new Date().toISOString(), status: r.status });
              await screen('doc', 'Report notes saved', `Report ${r.id}`, i.summary);
              return out({ ok: true, report_id: r.id, preview_url: r.preview_url });
            }
            case 'publish': {
              if (!canGenerate) return 'Only the COO requests report publishing.';
              if (!i.report_id) return 'report_id is required.';
              const r = await client.getReport(cc, i.report_id);
              const dry = await client.publishReport(cc, i.report_id, { notify_client: i.notify_client === true }, { dryRun: true });
              const aid = await db.requestExternalAction(task.id, 'rizehub.report_publish', {
                description: `Publish the ${r.type} report (${r.period.from} to ${r.period.to}) for workspace ${r.workspace_id} in RizeHub`
                  + `${i.notify_client ? ' and email it to the client' : ''}. Preview: ${r.preview_url}`,
                rizehub: { op: 'report_publish', report_id: r.id, notify_client: i.notify_client === true, preview_url: r.preview_url, dry_run: isDryRun(dry) ? dry.would : dry },
              });
              await ref('report', r.id, { publish_approval_id: aid, status: r.status });
              return `Publish queued for CEO approval (approval ${aid}); the worker publishes after approval. Do not publish yourself; continue.`;
            }
          }
        } catch (e) { return errText(e); }
      },
    });

    // ======================= rizehub_readonly =======================
    const rizehub_readonly = tool({
      description: 'Read-only RizeHub access (READONLY key). Actions: lead (id), job (id), account (id), accounts_search (q and/or domain: '
        + 'duplicate check), workspace (id: services, config, projects), report (id), templates, metrics (id=workspace, from, to).',
      inputSchema: z.object({
        action: z.enum(['lead', 'job', 'account', 'accounts_search', 'workspace', 'report', 'templates', 'metrics']),
        id: z.string().optional(),
        q: z.string().max(120).optional(),
        domain: z.string().max(200).optional(),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      }),
      execute: async (i) => {
        try {
          if (i.action === 'templates') return out(await client.listTemplates(cc, 'READONLY'));
          if (i.action === 'accounts_search') {
            if (!i.q && !i.domain) return 'q or domain is required.';
            return out(await client.searchAccounts(cc, { q: i.q, domain: i.domain }, 'READONLY'));
          }
          if (!i.id) return 'id is required.';
          switch (i.action) {
            case 'lead': { const l = await client.getLead(cc, i.id, 'READONLY'); await ref('lead', l.id, leadSummary(l), false); return out({ ...compactLead(l), angle: l.angle, notes: l.notes.slice(-5) }); }
            case 'job': return out(await client.getJob(cc, i.id, 'READONLY'));
            case 'account': { const a = await client.getAccount(cc, i.id, 'READONLY'); await ref('account', a.id, { company: a.company, plan: a.plan, domain: a.domain }, false); return out(a); }
            case 'workspace': { const w = await client.getWorkspace(cc, i.id, 'READONLY'); await ref('workspace', w.id, { name: w.name, template: w.template, account_id: w.account_id }, false); return out(w); }
            case 'report': { const r = await client.getReport(cc, i.id, 'READONLY'); await ref('report', r.id, { status: r.status, preview_url: r.preview_url }, false); return out(reportView(r)); }
            case 'metrics': {
              if (!i.from || !i.to) return 'from and to are required.';
              return out(await client.getMetrics(cc, i.id, i.from, i.to, 'READONLY'));
            }
          }
          return 'Unknown action.';
        } catch (e) { return errText(e); }
      },
    });

    // ======================= rizehub_onboarding =======================
    async function dryRun(p: OnboardingPayload) {
      const steps: { step: string; ok: boolean; would?: unknown; error?: unknown; warnings?: string[] }[] = [];
      const run = async (step: string, fn: () => Promise<unknown>) => {
        try {
          const r = await fn();
          steps.push({ step, ok: true, would: isDryRun(r) ? r.would : r, warnings: isDryRun(r) ? r.warnings : [] });
        } catch (e) { steps.push({ step, ok: false, error: toRizehubError(e).toJSON() }); }
      };
      const dup = await client.searchAccounts(cc, { q: p.account.company, domain: p.account.domain }, 'ONBOARDING').catch(() => ({ accounts: [] }));
      await run('account', () => client.createAccount(cc, p.account as AccountInput, { dryRun: true, step: 'onboarding:account' }));
      await run('workspace', () => client.createWorkspace(cc, 'new', p.workspace, { dryRun: true, step: 'onboarding:workspace' }));
      if (p.config) await run('config', () => client.configureWorkspace(cc, 'new', p.config as WorkspaceConfig, { dryRun: true, step: 'onboarding:config' }));
      if (p.projects?.length) await run('projects', () => client.createProjects(cc, 'new', p.projects!, { dryRun: true, step: 'onboarding:projects' }));
      const duplicates = dup.accounts.map((a) => ({ id: a.id, company: a.company, domain: a.domain }));
      return { valid: steps.every((s) => s.ok) && !duplicates.length, duplicates, steps };
    }
    const onboardingActions = async () => (await db.listTaskActions(task.id)).filter((a) => a.payload.action_type === 'rizehub.onboarding');

    const rizehub_onboarding = tool({
      description: 'RizeHub client onboarding (writes are external). Actions: templates; dry_run (payload: account, workspace, config, '
        + 'projects → validates everything, changes nothing); request_approval (same payload: dry run + CEO approval, pauses the task); '
        + 'status; execute (after approval: runs exactly the approved payload once; omit payload or pass the identical one); '
        + 'draft_invite (account_id, invite_email: prepared, not sent); request_invite_send (invite_id: CEO approval, worker sends).',
      inputSchema: z.object({
        action: z.enum(['templates', 'dry_run', 'request_approval', 'status', 'execute', 'draft_invite', 'request_invite_send']),
        payload: onboardingPayloadSchema.optional(),
        approval_id: z.string().optional(),
        account_id: z.string().optional(),
        invite_email: z.string().email().optional(),
        invite_role: z.string().max(40).optional(),
        invite_id: z.string().optional(),
      }),
      execute: async (i) => {
        try {
          switch (i.action) {
            case 'templates': return out(await client.listTemplates(cc));
            case 'dry_run': {
              if (!i.payload) return 'payload is required.';
              const r = await dryRun(i.payload);
              await screen('doc', `Onboarding dry run: ${r.valid ? 'clean' : 'needs fixes'}`, `Onboard ${i.payload.account.company}`, out(r.steps.map((s) => ({ step: s.step, ok: s.ok }))));
              return out(r);
            }
            case 'request_approval': {
              if (!i.payload) return 'payload is required.';
              const r = await dryRun(i.payload);
              if (r.duplicates.length) return out({ refused: 'Possible duplicate account in RizeHub. Stop and ask_ceo (SOP client-onboarding §2).', ...r });
              if (!r.valid) return out({ refused: 'The dry run has errors. Fix the payload and try again.', ...r });
              const p = i.payload;
              const sched = p.config?.report_schedule ? `, ${p.config.report_schedule.type} report on day ${p.config.report_schedule.day_of_month}` : '';
              const aid = await db.requestRizehubAction(task.id, 'rizehub.onboarding', {
                description: `Create RizeHub account + workspace for ${p.account.company} (${p.workspace.template})`
                  + `${p.config?.site_url ? `, site ${p.config.site_url}` : ''}${sched}${p.account.test ? ' [test account]' : ''}`,
                rizehub: { op: 'onboarding', payload: JSON.parse(stableStringify(p)), payload_hash: shortHash(p), dry_run: r.steps },
              }, true);
              state.ended = 'asked';
              await screen('doc', 'Waiting for the CEO to approve the onboarding', `Onboard ${p.account.company}`);
              return `Approval ${aid} requested with the dry-run preview. This task is paused until the CEO decides; when it resumes, call `
                + 'rizehub_onboarding with action "execute". Stop now.';
            }
            case 'status': {
              return out((await onboardingActions()).map((a) => ({
                approval_id: a.id, status: a.status, executed_at: a.payload.executed_at ?? null, execution: a.payload.execution ?? null,
                last_error: a.payload.last_error ?? null, company: onboardingSpec(a)?.payload.account.company,
              })));
            }
            case 'execute': {
              const all = await onboardingActions();
              const approved = all.filter((a) => a.status === 'approved' && (!i.approval_id || a.id === i.approval_id));
              const ready = approved.filter((a) => !('executed_at' in a.payload));
              if (!approved.length) {
                const pending = all.find((a) => a.status === 'pending');
                if (pending) return `Approval ${pending.id} is still pending. Nothing was created. Stop and wait for the CEO.`;
                if (all.some((a) => a.status === 'rejected' || a.status === 'changes_requested')) return 'The CEO did not approve the onboarding. Nothing was created; read the CEO note and ask_ceo if unclear.';
                return 'No approved onboarding on this task. Run request_approval first; nothing was created.';
              }
              if (!ready.length) return out({ already_executed: true, results: approved.map((a) => ({ approval_id: a.id, execution: a.payload.execution })) });
              if (ready.length > 1) return `Several approved onboardings (${ready.map((a) => a.id).join(', ')}); pass approval_id.`;
              const ap = ready[0]!;
              const spec = onboardingSpec(ap);
              if (!spec) return `Approval ${ap.id} has no onboarding payload; ask_ceo.`;
              if (i.payload && stableStringify(i.payload) !== stableStringify(spec.payload)) {
                return 'Refused: this payload differs from what the CEO approved; nothing was executed. Call execute without payload to run '
                  + 'exactly the approved one, or request_approval again for the new payload.';
              }
              if (!(await db.externalActionExec(ap.id, 'claim'))) return `Approval ${ap.id} is already being executed or done. Check status.`;
              const p = spec.payload;
              try {
                await screen('doc', `Creating RizeHub account for ${p.account.company}`, `Onboard ${p.account.company}`);
                const acc = await client.createAccount(cc, p.account as AccountInput, { step: 'onboarding:account' });
                if (isDryRun(acc)) throw new Error('unexpected dry-run response');
                await ref('account', acc.id, { company: acc.company, plan: acc.plan, domain: acc.domain, test: acc.test, approval_id: ap.id });
                const ws = await client.createWorkspace(cc, acc.id, p.workspace, { step: 'onboarding:workspace' });
                if (isDryRun(ws)) throw new Error('unexpected dry-run response');
                await ref('workspace', ws.id, { name: ws.name, template: ws.template, account_id: acc.id, app_url: ws.app_url, approval_id: ap.id });
                if (p.config) await client.configureWorkspace(cc, ws.id, p.config as WorkspaceConfig, { step: 'onboarding:config' });
                if (p.projects?.length) await client.createProjects(cc, ws.id, p.projects, { step: 'onboarding:projects' });
                const result = { account_id: acc.id, workspace_id: ws.id, workspace_url: ws.app_url, projects: p.projects ?? [] };
                await db.externalActionExec(ap.id, 'done', result);
                await screen('doc', `Account ${acc.id} + workspace ${ws.id} created`, `Onboard ${p.account.company}`, out(result));
                return out({ ok: true, approval_id: ap.id, ...result, next: 'Read both back with rizehub_readonly and compare every field to the intake.' });
              } catch (e) {
                const err = toRizehubError(e);
                await db.externalActionExec(ap.id, 'failed', { ...err.toJSON() }).catch(() => false);
                const hint = /exists/.test(err.code) ? ' It already exists: read it back with rizehub_readonly; never create a second one.' : '';
                return `${errText(err)}. Execution stopped; calls are idempotent, so a retry continues where it failed.${hint}`;
              }
            }
            case 'draft_invite': {
              if (!i.account_id || !i.invite_email) return 'account_id and invite_email are required.';
              const inv = await client.draftInvite(cc, i.account_id, { email: i.invite_email, role: i.invite_role });
              await ref('invite', inv.id, { account_id: inv.account_id, email: inv.email, status: inv.status, subject: inv.preview.subject });
              return out({ ok: true, invite_id: inv.id, status: inv.status, preview: inv.preview, next: 'Sending needs request_invite_send (CEO approval).' });
            }
            case 'request_invite_send': {
              if (!i.invite_id) return 'invite_id is required.';
              const dry = await client.sendInvite(cc, i.invite_id, { dryRun: true });
              const inv = isDryRun(dry) ? dry.would : dry;
              const aid = await db.requestExternalAction(task.id, 'rizehub.invite_send', {
                description: `Send the RizeHub workspace invite to ${inv.email} (account ${inv.account_id}).`,
                rizehub: { op: 'invite_send', invite_id: i.invite_id, email: inv.email, account_id: inv.account_id },
              });
              await ref('invite', i.invite_id, { send_approval_id: aid });
              return `Invite send queued for CEO approval (approval ${aid}); the worker sends it after approval. Continue.`;
            }
          }
        } catch (e) { return errText(e); }
      },
    });

    // ======================= job_tracker =======================
    const AGENT_STATUSES = JOB_STATUSES.filter((s) => s !== 'applied' && s !== 'approved') as [JobOppStatus, ...JobOppStatus[]];
    const compactJob = (j: JobOpportunityRow) => ({
      id: j.id, url: j.url, title: j.title, company: j.company, source: j.source, status: j.status, fit_score: j.fit_score,
      platform_tags: j.platform_tags, rate: j.rate, posted_at: j.posted_at, applied_at: j.applied_at, follow_up_at: j.follow_up_at,
      has_draft: Boolean(j.draft),
    });
    async function findJob(id?: string, url?: string): Promise<JobOpportunityRow | null> {
      if (id) return (await db.listJobOpportunities({ limit: 500 })).find((j) => j.id === id) ?? null;
      const u = url ? canonicalJobUrl(url) : null;
      return u ? (await db.listJobOpportunities({ urls: [u], limit: 1 }))[0] ?? null : null;
    }
    const job_tracker = tool({
      description: 'Track job opportunities (HQ job_opportunities). Actions: list (statuses, search: dedupe before adding), upsert (url, '
        + 'title, company, source, platform_tags, rate, posted_at, fit_score, fit_reasons, red_flags, draft, status), set_status (id or url, '
        + 'status, notes), add_link (url a CEO pasted, optional title), fetch_feeds (public remote-board feeds: terms, since_days, sources; '
        + 'returns candidates, saves nothing), schedule_follow_up (id or url, follow_up_days). "applied" is set only by the CEO.',
      inputSchema: z.object({
        action: z.enum(['list', 'upsert', 'set_status', 'add_link', 'fetch_feeds', 'schedule_follow_up']),
        id: z.string().optional(),
        url: z.string().max(2000).optional(),
        title: z.string().max(300).optional(),
        company: z.string().max(200).optional(),
        source: z.string().max(40).optional().describe('onlinejobs, indeed, linkedin, upwork, seek, weworkremotely, remotive, pasted…'),
        platform_tags: z.array(z.string().max(30)).max(10).optional(),
        rate: z.string().max(120).optional(),
        posted_at: z.string().optional().describe('ISO date'),
        fit_score: z.number().int().min(0).max(100).optional(),
        fit_reasons: z.array(z.string().max(300)).max(10).optional(),
        red_flags: z.array(z.string().max(300)).max(10).optional(),
        draft: z.string().max(6000).optional(),
        status: z.enum(AGENT_STATUSES).optional(),
        notes: z.string().max(2000).optional(),
        statuses: z.array(z.enum(JOB_STATUSES)).optional(),
        search: z.string().max(100).optional(),
        terms: z.array(z.string().max(40)).max(20).optional(),
        since_days: z.number().int().min(1).max(60).optional(),
        sources: z.array(z.string().max(40)).max(10).optional().describe('Feed ids to use (default: all)'),
        follow_up_days: z.number().int().min(1).max(30).optional(),
      }),
      execute: async (i) => {
        try {
          switch (i.action) {
            case 'list': {
              const rows = await db.listJobOpportunities({ status: i.statuses, search: i.search, limit: 100 });
              return out({ count: rows.length, jobs: rows.map(compactJob) });
            }
            case 'upsert': case 'add_link': {
              const url = i.url ? canonicalJobUrl(i.url) : null;
              if (!url) return 'A valid http(s) url is required.';
              const pasted = i.action === 'add_link';
              const title = i.title ?? (pasted ? `Pasted link: ${new URL(url).hostname}${new URL(url).pathname}`.slice(0, 300) : undefined);
              if (!title) return 'title is required.';
              const r = await db.upsertJobOpportunity({
                url, title, source: i.source ?? (pasted ? 'pasted' : undefined), company: i.company, platform_tags: i.platform_tags?.map((t) => t.toLowerCase()),
                rate: i.rate, posted_at: i.posted_at, fit_score: i.fit_score, fit_reasons: i.fit_reasons, red_flags: i.red_flags, draft: i.draft,
                status: i.status ?? (pasted ? 'found' : undefined), notes: i.notes ?? (pasted ? 'Link pasted by the CEO' : undefined),
              }, task.id);
              await screen('sheet', `${r.created ? 'Tracked' : 'Updated'}: ${title}`, 'Job tracker', `${title}\n${url}\nstatus ${r.status}${i.fit_score != null ? ` · score ${i.fit_score}` : ''}`);
              return out({ ok: true, ...r, url });
            }
            case 'set_status': case 'schedule_follow_up': {
              const j = await findJob(i.id, i.url);
              if (!j) return 'Job not found in the tracker (use id or the exact url).';
              if (i.action === 'set_status' && !i.status) return 'status is required.';
              const followUp = i.follow_up_days ? new Date(Date.now() + i.follow_up_days * 86_400_000).toISOString() : null;
              if (i.action === 'schedule_follow_up' && !followUp) return 'follow_up_days is required.';
              const row = await db.setJobStatus(j.id, i.action === 'set_status' ? i.status! : j.status, followUp, i.notes ?? null);
              return out({ ok: true, job: compactJob(row) });
            }
            case 'fetch_feeds': {
              await screen('browser', 'Checking public remote job feeds', 'Remote job boards');
              const f = d.fetchFeeds ?? fetchJobFeeds;
              const res = await f({ terms: i.terms, sinceDays: i.since_days, limit: 60,
                sources: i.sources?.length ? sourcesFromEnv().filter((s) => i.sources!.includes(s.id)) : undefined });
              const tracked = res.items.length ? await db.listJobOpportunities({ urls: res.items.map((x) => x.url), limit: 500 }) : [];
              const status = new Map(tracked.map((t) => [t.url, t.status]));
              await screen('sheet', `Feeds: ${res.items.length} candidates`, 'Remote job boards', res.items.slice(0, 20).map((x) => `${x.title} · ${x.company ?? '?'} · ${x.source}`).join('\n'));
              return out({
                sources: res.sources, count: res.items.length,
                items: res.items.map((x) => ({ ...x, tracked_status: status.get(x.url) ?? null })),
                next: 'Skip tracked ones that are applied/skipped/rejected; web_fetch each promising post to confirm it is live, then upsert with a score.',
              });
            }
          }
        } catch (e) { return errText(e); }
      },
    });

    return { rizehub_leads, rizehub_reports, rizehub_readonly, rizehub_onboarding, job_tracker };
  };
}

/** Registered in tools/index.ts: uses the process-wide client (mock when RIZEHUB_API_URL is unset or "mock"). */
export const rizehubTools: ToolFactory = (ctx) => {
  const r = getRizehub();
  return createRizehubTools({ client: r.client, jobWaitMs: r.cfg.jobWaitMs })(ctx);
};
