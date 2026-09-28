// Auto-approve rules for low-risk COO plans (docs/05 "[3] Auto-approve rules", M12).
// The DATABASE is the authority: submit_plan() → auto_approve_plan() in
// supabase/migrations/20260929000000_totp_auto_approve.sql applies the rules. This module mirrors the same checks for
// the dashboard (rule form validation, "why not" explanations) and tests. The two constants below are compared with
// their SQL twins by scripts/db-tests/110-totp-auto-approve.mjs, so keep them byte-identical.
import { z } from 'zod';

/**
 * Work types whose output stays inside HQ (drafts, docs, designs, research). Only plans made entirely of these can
 * ever be auto-approved. Everything else (all Web Developer work, RizeHub onboarding/workspaces/client reports, access
 * checklists, lead-finder searches, outreach/follow-up emails, proposals) touches a client system or leads to an
 * external_action, so the CEO always approves those plans by hand.
 */
export const AUTO_APPROVE_INTERNAL_WORK_TYPES = [
  'seo-article', 'landing-copy', 'meta-tags', 'keyword-research', 'content-calendar', 'social-captions', 'short-video-script',
  'wireframe', 'ui-mockup', 'ux-audit', 'ad-creative', 'social-graphic', 'brand-asset',
  'lead-report', 'lead-qualification', 'dm-reply-draft', 'job-search', 'job-application',
  'weekly-summary', 'daily-report', 'inbox-triage', 'meeting-prep',
] as const;

/**
 * Wording that means the plan wants to change the outside world (publish / send / merge / deploy / spend / delete).
 * Matched case-insensitively as whole words against the plan title, summary and every task's title, instructions and
 * acceptance criteria. Any hit blocks auto-approval (false positives only mean the CEO is asked, as before).
 */
export const EXTERNAL_WORDING = String.raw`publish\w*|deploy\w*|merg(e|es|ed|ing)|send\w*|sent|go live|goes live|going live|spend\w*|purchas\w*|buy|buys|buying|bought|pay|pays|paid|payment\w*|invoic\w*|refund\w*|delet\w*|email(s|ed|ing)? (it |them )?to|post(s|ed|ing)? (it |them )?(on|to)`;

const EXTERNAL_RE = new RegExp(`\\b(${EXTERNAL_WORDING})\\b`, 'i');

export const CLIENT_SCOPES = ['any', 'none', 'listed'] as const;
export type ClientScope = (typeof CLIENT_SCOPES)[number];

const SLUG = /^[a-z0-9-]{1,80}$/;

/** What the CEO edits in Settings → Auto-approve rules (validated again by save_auto_approve_rule in SQL). */
export const AutoApproveRuleInput = z.object({
  id: z.string().uuid().nullable().default(null),
  name: z.string().trim().min(1, 'Give the rule a name').max(80),
  enabled: z.boolean().default(true),
  max_cost_usd: z.number().min(0).max(100),
  max_tasks: z.number().int().min(1).max(20).nullable().default(null),
  /** Empty = any internal-only work type. */
  work_types: z.array(z.enum(AUTO_APPROVE_INTERNAL_WORK_TYPES)).max(AUTO_APPROVE_INTERNAL_WORK_TYPES.length).default([]),
  /** any = every client and internal requests; none = only requests without a client; listed = only client_slugs. */
  client_scope: z.enum(CLIENT_SCOPES).default('any'),
  client_slugs: z.array(z.string().regex(SLUG, 'Client slugs are lowercase letters, digits and dashes')).max(50).default([]),
}).superRefine((r, ctx) => {
  if (r.client_scope === 'listed' && r.client_slugs.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['client_slugs'], message: 'Pick at least one client' });
  }
});
export type AutoApproveRuleInput = z.infer<typeof AutoApproveRuleInput>;

/** A stored rule (plan_auto_approve_rules row). */
export interface AutoApproveRule {
  id: string;
  name: string;
  enabled: boolean;
  max_cost_usd: number | string;
  max_tasks: number | null;
  work_types: string[];
  client_scope: ClientScope;
  client_slugs: string[];
  created_at?: string;
}

/** The plan fields the rules look at (approvals.payload for kind = 'plan'). */
export interface PlanForRules {
  title?: string | null;
  summary?: string | null;
  questions_for_ceo?: string[] | null;
  estimated_cost_usd?: number | null;
  tasks?: { key?: string; work_type?: string; title?: string; instructions?: string; acceptance_criteria?: string[] }[] | null;
}

function externalWord(text: string | null | undefined): string | null {
  const m = EXTERNAL_RE.exec(text ?? '');
  return m ? m[0] : null;
}

/**
 * Hard guards that no rule can override. Returns why the plan can never be auto-approved, or null when rules may be
 * considered. Mirrors plan_auto_approve_blocker() in SQL.
 */
export function planAutoApproveBlocker(plan: PlanForRules): string | null {
  const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
  if (!tasks.length) return 'the plan has no tasks';
  if ((plan.questions_for_ceo ?? []).length > 0) return 'the plan has questions for the CEO';
  if (typeof plan.estimated_cost_usd !== 'number' || !Number.isFinite(plan.estimated_cost_usd)) return 'the plan has no cost estimate';
  const internal = AUTO_APPROVE_INTERNAL_WORK_TYPES as readonly string[];
  for (const t of tasks) {
    if (!internal.includes(t.work_type ?? '')) return `task ${t.key ?? '?'} (${t.work_type ?? 'no work type'}) is not internal-only work`;
  }
  const planWord = externalWord(plan.title) ?? externalWord(plan.summary);
  if (planWord) return `the plan mentions "${planWord}" (an external action)`;
  for (const t of tasks) {
    const w = externalWord(t.title) ?? externalWord(t.instructions) ?? (t.acceptance_criteria ?? []).map(externalWord).find(Boolean) ?? null;
    if (w) return `task ${t.key ?? '?'} mentions "${w}" (an external action)`;
  }
  return null;
}

/** Why `rule` does not cover the plan (null = it does). Mirrors plan_auto_approve_rule_miss() in SQL. */
export function ruleMiss(rule: AutoApproveRule, plan: PlanForRules, clientSlug: string | null): string | null {
  if (!rule.enabled) return 'rule is off';
  const cost = plan.estimated_cost_usd ?? Number.POSITIVE_INFINITY;
  if (cost > Number(rule.max_cost_usd)) return `estimated $${cost} is over $${Number(rule.max_cost_usd)}`;
  const tasks = plan.tasks ?? [];
  if (rule.max_tasks != null && tasks.length > rule.max_tasks) return `${tasks.length} tasks is over ${rule.max_tasks}`;
  if (rule.work_types.length) {
    const other = tasks.find((t) => !rule.work_types.includes(t.work_type ?? ''));
    if (other) return `work type ${other.work_type} is not in the rule`;
  }
  if (rule.client_scope === 'none' && clientSlug) return 'rule is for internal requests only';
  if (rule.client_scope === 'listed' && (!clientSlug || !rule.client_slugs.includes(clientSlug))) return 'client is not in the rule';
  return null;
}

export type AutoApproveVerdict =
  | { approve: true; rule: AutoApproveRule }
  | { approve: false; reason: string };

/**
 * The first enabled rule (oldest first) that covers the plan, after the hard guards. No rules → never approves.
 * Only ever used for kind = 'plan' approvals; external actions are never auto-approved.
 */
export function evaluateAutoApprove(rules: AutoApproveRule[], plan: PlanForRules, clientSlug: string | null): AutoApproveVerdict {
  const enabled = rules.filter((r) => r.enabled);
  if (!enabled.length) return { approve: false, reason: 'no auto-approve rules are on' };
  const blocker = planAutoApproveBlocker(plan);
  if (blocker) return { approve: false, reason: blocker };
  const ordered = [...enabled].sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? '') || a.id.localeCompare(b.id));
  const misses: string[] = [];
  for (const r of ordered) {
    const miss = ruleMiss(r, plan, clientSlug);
    if (!miss) return { approve: true, rule: r };
    misses.push(`${r.name}: ${miss}`);
  }
  return { approve: false, reason: misses.join('; ') };
}

/** One-line description of a rule for lists ("Internal work · ≤ $2.00 · ≤ 3 tasks · seo-article, meta-tags"). */
export function describeRule(r: Pick<AutoApproveRule, 'max_cost_usd' | 'max_tasks' | 'work_types' | 'client_scope' | 'client_slugs'>): string {
  const parts = [`≤ $${Number(r.max_cost_usd).toFixed(2)} est.`];
  if (r.max_tasks != null) parts.push(`≤ ${r.max_tasks} task${r.max_tasks === 1 ? '' : 's'}`);
  parts.push(r.work_types.length ? r.work_types.join(', ') : 'any internal work type');
  parts.push(r.client_scope === 'any' ? 'any client' : r.client_scope === 'none' ? 'no client (internal)' : `clients: ${r.client_slugs.join(', ')}`);
  return parts.join(' · ');
}
