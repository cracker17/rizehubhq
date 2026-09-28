// RizeHub Agent API contract (docs/12-RIZEHUB-INTEGRATION.md), shared by the typed client, the in-memory mock
// and the tests. The OpenAPI version for the RizeHub team lives in rizehub-agent-api/openapi.yaml; keep both in sync.

export const API_PREFIX = '/agent-api/v1';

/** One service key per agent group (docs/12 "Authentication & permissions"). */
export type KeyGroup = 'LEADS' | 'ONBOARDING' | 'REPORTS' | 'READONLY';
export const KEY_GROUPS: KeyGroup[] = ['LEADS', 'ONBOARDING', 'REPORTS', 'READONLY'];

/** Scopes each key carries. READONLY gets every `*:read`. */
export const GROUP_SCOPES: Record<KeyGroup, string[]> = {
  LEADS: ['leads:search', 'leads:read', 'leads:write_notes', 'leads:write_stage', 'lists:write', 'jobs:read'],
  ONBOARDING: ['accounts:create', 'accounts:read', 'workspaces:create', 'workspaces:configure', 'workspaces:read',
    'invites:draft', 'invites:send', 'templates:read', 'jobs:read'],
  REPORTS: ['reports:generate', 'reports:read', 'reports:write_notes', 'reports:publish', 'metrics:read', 'workspaces:read', 'jobs:read'],
  READONLY: ['*:read'],
};

export function hasScope(scopes: string[], needed: string): boolean {
  if (scopes.includes(needed)) return true;
  const [, action] = needed.split(':');
  return action === 'read' && scopes.includes('*:read');
}

export type Platform = 'shopify' | 'webflow' | 'wordpress' | 'other';
export const PLATFORMS: Platform[] = ['shopify', 'webflow', 'wordpress', 'other'];

/** RizeHub stages plus the two HQ uses on the board (drafted, proposal). */
export const LEAD_STAGES = ['new', 'researched', 'drafted', 'contacted', 'replied', 'proposal', 'won', 'lost'] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];
/** Stages that mean "we reached out" and may only be set after an approved send. */
export const GATED_STAGES: LeadStage[] = ['contacted', 'proposal'];

export const SIGNAL_KEYS = ['slow_site', 'no_ssl', 'hiring_dev', 'outdated_theme', 'broken_links', 'missing_meta', 'low_mobile_score', 'no_analytics'] as const;
export type SignalKey = (typeof SIGNAL_KEYS)[number];

export interface LeadSignal {
  key: SignalKey;
  label: string;                                  // "Slow mobile LCP"
  value?: string;                                 // "LCP 6.2 s"
  metric?: { name: string; value: number; unit: string };
  evidence_url?: string;
  detected_at: string;
}

export interface LeadNote { id: string; body: string; fit_score: number | null; angle: string | null; findings: string[]; author: string; created_at: string }

export interface Lead {
  id: string;
  company: string;
  website: string;
  platform: Platform;
  industry: string;
  location: { country: string; region?: string; city?: string };
  /** Business contact only (published company email / role inbox). */
  contact: { name?: string; role?: string; email?: string; source?: string } | null;
  signals: LeadSignal[];
  score: number;                                  // Lead Finder score 0–100
  stage: LeadStage;
  fit_score: number | null;                       // latest agent fit score
  angle: string | null;
  notes: LeadNote[];
  list_ids: string[];
  app_url: string;                                // open in RizeHub Lead Finder
  created_at: string;
  updated_at: string;
}

export interface LeadSearchParams {
  industry?: string;
  location?: string;
  platform?: Platform;
  signals?: SignalKey[];
  limit?: number;                                 // 1–100
}

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed';
export interface Job {
  id: string;
  type: 'lead_search' | 'report_generate';
  status: JobStatus;
  progress: number;
  result: { lead_ids?: string[]; total?: number; report_id?: string } | null;
  error: ApiErrorBody | null;
  created_at: string;
  completed_at: string | null;
}

export interface LeadList { id: string; name: string; lead_ids: string[]; created_at: string }

export interface Contact { name: string; email: string; role?: string }
export interface AccountInput {
  company: string;
  domain?: string;
  primary_contact: Contact;
  plan: string;
  country?: string;
  time_zone?: string;
  test?: boolean;
}
export interface Account extends Required<Pick<AccountInput, 'company' | 'primary_contact' | 'plan'>> {
  id: string;
  domain: string | null;
  country: string | null;
  time_zone: string | null;
  test: boolean;
  status: 'active' | 'paused';
  workspace_ids: string[];
  created_at: string;
}

export interface WorkspaceConfig {
  site_url?: string;
  platform?: Platform;
  services_enabled?: string[];
  report_schedule?: { type: ReportType; day_of_month: number; time_zone?: string } | null;
  branding?: 'rizehub';
}
export interface Project { id: string; name: string; status: 'open' | 'done'; created_at: string }
export interface WorkspaceInput { template: string; name: string }
export interface Workspace {
  id: string;
  account_id: string;
  name: string;
  template: string;
  config: WorkspaceConfig;
  projects: Project[];
  app_url: string;
  created_at: string;
}
export interface Template { id: string; name: string; services: string[]; projects: string[]; report_type: ReportType | null }

export interface Invite { id: string; account_id: string; email: string; role: string; status: 'draft' | 'sent'; preview: { subject: string; body: string }; sent_at: string | null }

export const REPORT_TYPES = ['seo-monthly', 'site-audit', 'ads-performance', 'lead-report'] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

export interface MetricSet {
  sessions: number; users: number; conversions: number; revenue: number;
  organic_clicks: number; impressions: number; ctr: number; avg_position: number;
}
export interface Metrics { workspace_id: string; from: string; to: string; metrics: MetricSet; previous: MetricSet; currency: string }

export interface ReportNotes { summary: string; insights: string[]; next_steps: string[]; author: string; updated_at: string }
export interface Report {
  id: string;
  workspace_id: string;
  type: ReportType;
  period: { from: string; to: string };
  status: 'draft' | 'published';
  data: { metrics: MetricSet; previous: MetricSet; top_pages: { path: string; clicks: number }[]; top_queries: { query: string; clicks: number; position: number }[] };
  notes: ReportNotes | null;
  preview_url: string;
  pdf_url: string;
  published_at: string | null;
  created_at: string;
}

export interface ApiErrorBody { code: string; message: string; retryable: boolean }
export interface DryRunResult<T = unknown> { dry_run: true; valid: boolean; would: T; warnings: string[] }

export const WEBHOOK_EVENTS = [
  'job.completed', 'job.failed', 'account.created', 'workspace.ready', 'client.signed_up', 'payment.received', 'lead.replied', 'report.viewed',
] as const;
export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number];
export interface WebhookEvent { id: string; event: WebhookEventName | string; created_at: string; data: Record<string, unknown> }

/** Every endpoint HQ calls: method, path template, scope, and whether it writes. */
export interface EndpointDef { method: 'GET' | 'POST' | 'PUT' | 'PATCH'; path: string; scope: string; write: boolean }
export const ENDPOINTS = {
  leadsSearch: { method: 'POST', path: '/leads/search', scope: 'leads:search', write: true },
  jobGet: { method: 'GET', path: '/jobs/:id', scope: 'jobs:read', write: false },
  leadGet: { method: 'GET', path: '/leads/:id', scope: 'leads:read', write: false },
  leadNotes: { method: 'POST', path: '/leads/:id/notes', scope: 'leads:write_notes', write: true },
  leadStage: { method: 'PATCH', path: '/leads/:id', scope: 'leads:write_stage', write: true },
  listCreate: { method: 'POST', path: '/lists', scope: 'lists:write', write: true },
  listAddLeads: { method: 'POST', path: '/lists/:id/leads', scope: 'lists:write', write: true },
  accountsSearch: { method: 'GET', path: '/accounts', scope: 'accounts:read', write: false },
  accountCreate: { method: 'POST', path: '/accounts', scope: 'accounts:create', write: true },
  accountGet: { method: 'GET', path: '/accounts/:id', scope: 'accounts:read', write: false },
  workspaceCreate: { method: 'POST', path: '/accounts/:id/workspaces', scope: 'workspaces:create', write: true },
  workspaceGet: { method: 'GET', path: '/workspaces/:id', scope: 'workspaces:read', write: false },
  workspaceConfig: { method: 'PUT', path: '/workspaces/:id/config', scope: 'workspaces:configure', write: true },
  workspaceProjects: { method: 'POST', path: '/workspaces/:id/projects', scope: 'workspaces:configure', write: true },
  templatesList: { method: 'GET', path: '/workspace-templates', scope: 'templates:read', write: false },
  inviteDraft: { method: 'POST', path: '/accounts/:id/invites', scope: 'invites:draft', write: true },
  inviteSend: { method: 'POST', path: '/invites/:id/send', scope: 'invites:send', write: true },
  metricsGet: { method: 'GET', path: '/workspaces/:id/metrics', scope: 'metrics:read', write: false },
  reportGenerate: { method: 'POST', path: '/workspaces/:id/reports', scope: 'reports:generate', write: true },
  reportGet: { method: 'GET', path: '/reports/:id', scope: 'reports:read', write: false },
  reportNotes: { method: 'POST', path: '/reports/:id/notes', scope: 'reports:write_notes', write: true },
  reportPublish: { method: 'POST', path: '/reports/:id/publish', scope: 'reports:publish', write: true },
} as const satisfies Record<string, EndpointDef>;
export type EndpointName = keyof typeof ENDPOINTS;

/** "/leads/:id" + {id: "ld_1"} → "/leads/ld_1" (ids are URL-encoded). */
export function fillPath(path: string, params: Record<string, string> = {}): string {
  return path.replace(/:([a-z_]+)/g, (_, k: string) => {
    const v = params[k];
    if (!v) throw new Error(`missing path param ${k}`);
    return encodeURIComponent(v);
  });
}
