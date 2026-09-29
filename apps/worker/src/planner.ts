// COO planning (docs/05 [2]): staged request → validated Plan → submit_plan (CEO approval).
// Invalid output is retried once with the validation error; a second failure → planning_failed.
import { generateObject, NoObjectGeneratedError } from 'ai';
import { Plan } from '@rizehubhq/shared';
import type { ClientRow, RequestRow } from './hqdb';
import { errMsg, log, manilaToday, readRoster, readRosterText, usageDetail, type WorkerDeps } from './deps';
import { addUsage, isQuotaError, normalizeUsage, type PickedModel, type TokenUsage } from './models/usage';
import { cachedPrompt } from './models/cache';
import { HANDOFF_DESIGN_WORK_TYPES } from './handoff';

const PLAYBOOK_RULES: [string, RegExp][] = [
  ['onboarding', /\bonboard/i],
  ['lead-gen', /\b(leads?|prospect\w*|outreach)\b/i],
  ['job-hunt', /\b(jobs?|job hunt|applications?|apply)\b/i],
  ['monthly-report', /\b(monthly|month'?s?)\b.*\breport\b|\breport\b.*\b(monthly|for (january|february|march|april|may|june|july|august|september|october|november|december))\b/i],
  ['proposal', /\b(proposal|quote|pricing)\b/i],
];

/** Picks the obvious playbook for a request; client delivery work is the default. */
export function matchPlaybook(text: string): string {
  for (const [name, re] of PLAYBOOK_RULES) if (re.test(text)) return name;
  return 'client-work';
}

/** Finds the client when the request has no client_id: slug or name mentioned in the text. */
export function guessClientSlug(text: string, slugs: string[]): string | null {
  const t = text.toLowerCase();
  for (const slug of slugs) {
    if (t.includes(slug) || t.includes(slug.replace(/-/g, ' '))) return slug;
  }
  return null;
}

export interface PlanContext { enabledAgents: string[]; workTypes: string[] }

/** Checks the plan against things zod can't know: enabled agents and roster work types. */
export function validatePlan(raw: unknown, ctx: PlanContext): { ok: true; plan: Plan } | { ok: false; error: string } {
  const parsed = Plan.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.') || 'plan'}: ${i.message}`).join('; ') };
  }
  const problems: string[] = [];
  for (const t of parsed.data.tasks) {
    if (!ctx.enabledAgents.includes(t.agent_id)) problems.push(`task ${t.key}: agent "${t.agent_id}" is unknown or disabled`);
    if (!ctx.workTypes.includes(t.work_type)) problems.push(`task ${t.key}: work_type "${t.work_type}" is not in roster.yaml`);
  }
  return problems.length ? { ok: false, error: problems.join('; ') } : { ok: true, plan: parsed.data };
}

/** Plan task keys that `key` depends on, directly or through other tasks. */
function ancestors(plan: Plan, key: string): Set<string> {
  const byKey = new Map(plan.tasks.map((t) => [t.key, t]));
  const seen = new Set<string>();
  const stack = [...(byKey.get(key)?.depends_on ?? [])];
  while (stack.length) {
    const k = stack.pop()!;
    if (seen.has(k)) continue;
    seen.add(k);
    stack.push(...(byKey.get(k)?.depends_on ?? []));
  }
  return seen;
}

/**
 * Design → dev handoff (docs/05): when a plan has both design work a developer builds from (wireframe, ui-mockup,
 * brand-asset, ux-audit by the designer) and Web Developer tasks, every dev task must wait for that design, so it is
 * released only after the design task is QA-passed and CEO-approved ('done') and gets the spec as input.
 * Missing dependencies are added (never ones that would create a cycle). Returns the fixed plan + what was added.
 */
export function enforceDesignHandoff(plan: Plan): { plan: Plan; added: { task: string; design: string }[] } {
  const designKeys = plan.tasks
    .filter((t) => t.agent_id === 'designer' && (HANDOFF_DESIGN_WORK_TYPES as readonly string[]).includes(t.work_type))
    .map((t) => t.key);
  const added: { task: string; design: string }[] = [];
  if (!designKeys.length) return { plan, added };
  const tasks = plan.tasks.map((t) => ({ ...t, depends_on: [...t.depends_on] }));
  const fixed: Plan = { ...plan, tasks };
  for (const t of tasks) {
    if (t.agent_id !== 'web-dev') continue;
    const before = ancestors(fixed, t.key);
    if (designKeys.some((d) => before.has(d))) continue; // already waits for a design task
    for (const d of designKeys) {
      if (ancestors(fixed, d).has(t.key)) continue; // the design waits for this dev task: adding it would loop
      t.depends_on.push(d);
      added.push({ task: t.key, design: d });
    }
  }
  if (added.length) {
    fixed.assumptions = [...plan.assumptions,
      ...added.map((a) => `Task ${a.task} waits for design task ${a.design}: it starts after the design is QA-passed and approved, and gets the design spec as input.`)];
  }
  return { plan: fixed, added };
}

function clientSlugs(deps: WorkerDeps): string[] {
  const slugs = new Set<string>();
  for (const f of deps.brain.list('clients')) {
    const m = /^clients\/([^/]+)\//.exec(f);
    if (m?.[1]) slugs.add(m[1]);
  }
  return [...slugs];
}

export async function buildPlanPrompt(req: RequestRow, deps: WorkerDeps): Promise<{ system: string; prompt: string; ctx: PlanContext }> {
  const coo = deps.loadRole('coo');
  const agents = (await deps.db.listAgents()).filter((a) => a.enabled);
  const roster = readRoster(deps.agentsDir);
  const ctx: PlanContext = { enabledAgents: agents.map((a) => a.id), workTypes: Object.keys(roster.routing) };

  const agentLines = agents.map((a) => {
    let workTypes = '';
    try { workTypes = deps.loadRole(a.id).work_types.join(', '); } catch { /* role file missing: roster still routes */ }
    return `- ${a.id} (${a.name}, ${a.department})${workTypes ? `: ${workTypes}` : ''}`;
  });

  let client: ClientRow | null = req.client_id ? await deps.db.getClient(req.client_id) : null;
  const slug = client?.slug ?? guessClientSlug(req.raw_text, clientSlugs(deps));
  const clientParts: string[] = [];
  if (client) {
    clientParts.push(`Client: ${client.name} (slug ${client.slug}) · platforms: ${client.platforms.join(', ') || 'unknown'}`
      + `${client.website ? ` · ${client.website}` : ''}${client.service_package ? ` · package ${client.service_package}` : ''}`);
    if (client.notes) clientParts.push(`Notes: ${client.notes}`);
  }
  if (slug) {
    for (const f of ['profile.md', 'brand.md']) {
      const text = deps.brain.tryRead(`clients/${slug}/${f}`, 8000);
      if (text) clientParts.push(`## brain/clients/${slug}/${f}\n${text}`);
    }
  }
  if (!clientParts.length) clientParts.push('No client identified and no client brain files found. If the work is for a client, ask in questions_for_ceo instead of guessing.');

  const playbook = matchPlaybook(req.raw_text);
  const playbookText = deps.brain.tryRead(`playbooks/${playbook}.md`, 8000);
  const planningSop = deps.brain.tryRead('sops/planning.md', 6000);
  const planningChecklist = deps.brain.tryRead('qa-checklists/planning.md', 6000);

  const brief = (req.brief ?? {}) as Record<string, unknown>;
  const feedback = Array.isArray(brief.ceo_feedback) ? (brief.ceo_feedback as unknown[]).map(String) : [];
  const previousPlan = feedback.length && Array.isArray(brief.tasks) ? { ...brief, ceo_feedback: undefined } : null;

  const system = [
    coo.body,
    '# Output',
    'You are running in planning mode: return ONLY the plan object (schema given by the caller). It becomes the create_plan call.',
    'Use only agent ids from the enabled list and work_type values from roster.yaml routing. Each task: 3–7 binary, testable acceptance_criteria.',
    'depends_on lists task keys from this same plan. Never plan an external action without saying it needs CEO approval via request_external_action.',
    'Design → dev handoff: when a request needs both design (designer: wireframe, ui-mockup, brand-asset or ux-audit) and building (web-dev), '
      + 'plan the design task first and put its key in depends_on of every web-dev task that builds it. The developer starts only after the design '
      + 'is QA-passed and approved, and receives the design spec (colours, fonts, spacing, layout notes, asset list) and assets as input. '
      + 'Never ask the Web Developer to design, and never ask the designer to build.',
  ].join('\n\n');

  const prompt = [
    `Today (Asia/Manila): ${manilaToday(deps.now?.() ?? new Date())}`,
    `# Request\n${req.raw_text}\n\nPriority: ${req.priority}${req.due_date ? ` · Due: ${req.due_date}` : ''} · Source: ${req.source}`,
    feedback.length ? `# CEO feedback on your previous plan (address every note)\n${feedback.map((f) => `- ${f}`).join('\n')}` : '',
    previousPlan ? `# Your previous plan\n${JSON.stringify(previousPlan)}` : '',
    `# Client\n${clientParts.join('\n\n')}`,
    `# Enabled agents\n${agentLines.join('\n')}`,
    `# agents/roster.yaml\n${readRosterText(deps.agentsDir)}`,
    playbookText ? `# Matching playbook: brain/playbooks/${playbook}.md\n${playbookText}` : '',
    planningSop ? `# brain/sops/planning.md\n${planningSop}` : '',
    planningChecklist ? `# brain/qa-checklists/planning.md (self-check)\n${planningChecklist}` : '',
  ].filter(Boolean).join('\n\n');

  return { system, prompt, ctx };
}

function describeGenerationError(e: unknown): { error: string; text?: string } {
  if (NoObjectGeneratedError.isInstance(e)) {
    const cause = e.cause as { message?: string } | undefined;
    return { error: cause?.message ? `${e.message}: ${cause.message}` : e.message, text: e.text };
  }
  return { error: errMsg(e) };
}

export type PlanOutcome =
  | { status: 'idle' }
  | { status: 'submitted'; requestId: string; approvalId: string; attempts: number }
  | { status: 'failed'; requestId: string; reason: string }
  | { status: 'deferred'; requestId: string; reason: string };

/** Claims one staged request and plans it. */
export async function planNext(deps: WorkerDeps): Promise<PlanOutcome> {
  const req = await deps.db.claimRequestForPlanning();
  if (!req) return { status: 'idle' };
  return planRequest(req, deps);
}

export async function planRequest(req: RequestRow, deps: WorkerDeps): Promise<PlanOutcome> {
  let picked: PickedModel;
  let usage: TokenUsage = {};
  let calls = 0;
  let cost = 0;
  try {
    picked = await deps.pickModel('lead', { override: (await deps.db.getAgent('coo'))?.model_override });
  } catch (e) {
    if (isQuotaError(e)) {
      await deps.db.releaseRequestForPlanning(req.id, errMsg(e));
      return { status: 'deferred', requestId: req.id, reason: errMsg(e) };
    }
    throw e;
  }

  const screen = (step_note: string, progress: number, content?: string) =>
    deps.db.updateAgentScreen('coo', null, { app: 'whiteboard', title: req.title ?? req.raw_text.slice(0, 80), step_note, progress, content })
      .catch(() => undefined);

  try {
    await screen('Reading request', 10);
    const { system, prompt, ctx } = await buildPlanPrompt(req, deps);
    let lastError = '';
    let lastText: string | undefined;

    for (let attempt = 1; attempt <= 2; attempt++) {
      const fullPrompt = attempt === 1 ? prompt : [
        prompt,
        `# Your previous plan was rejected by validation\nError: ${lastError}`,
        lastText ? `Previous output:\n${lastText.slice(0, 6000)}` : '',
        'Return a corrected plan that fixes every error.',
      ].filter(Boolean).join('\n\n');

      let candidate: unknown;
      try {
        const res = await generateObject({ model: picked.model, schema: Plan, schemaName: 'create_plan', ...cachedPrompt(picked.provider, system, fullPrompt) });
        calls++; usage = addUsage(usage, normalizeUsage(picked.provider, res.usage, res.providerMetadata)); cost += picked.recordCall(res.usage, res.providerMetadata);
        candidate = res.object;
        lastText = JSON.stringify(res.object);
      } catch (e) {
        if (isQuotaError(e)) throw e;
        calls++;
        const d = describeGenerationError(e);
        if (NoObjectGeneratedError.isInstance(e) && e.usage) { usage = addUsage(usage, normalizeUsage(picked.provider, e.usage)); cost += picked.recordCall(e.usage); }
        lastError = d.error; lastText = d.text;
        log(deps, `[coo] plan attempt ${attempt} invalid: ${lastError}`);
        continue;
      }

      const checked = validatePlan(candidate, ctx);
      if (!checked.ok) { lastError = checked.error; log(deps, `[coo] plan attempt ${attempt} invalid: ${lastError}`); continue; }
      const handoff = enforceDesignHandoff(checked.plan);
      if (handoff.added.length) log(deps, `[coo] design → dev handoff: ${handoff.added.map((a) => `${a.task} waits for ${a.design}`).join(', ')}`);
      const v = { ok: true as const, plan: handoff.plan };
      if (deps.monthlyBudgetUsd === 0) v.plan = { ...v.plan, estimated_cost_usd: 0 };   // free models only: nothing to pay

      await screen('Plan ready for CEO', 100, v.plan.tasks.map((t) => `${t.key} → ${t.agent_id}: ${t.title}`).join('\n'));
      try {
        const approvalId = await deps.db.submitPlan(req.id, v.plan);
        log(deps, `[coo] plan submitted for request ${req.id} (${v.plan.tasks.length} tasks)`);
        return { status: 'submitted', requestId: req.id, approvalId, attempts: attempt };
      } catch (e) {
        lastError = `database rejected the plan: ${errMsg(e)}`;
        lastText = JSON.stringify(v.plan);
        log(deps, `[coo] ${lastError}`);
      }
    }

    const reason = lastError.slice(0, 500) || 'no valid plan produced';
    await deps.db.planningFailed(req.id, reason);
    return { status: 'failed', requestId: req.id, reason };
  } catch (e) {
    if (isQuotaError(e)) {
      deps.onProviderQuota?.(picked.provider);
      await deps.db.releaseRequestForPlanning(req.id, errMsg(e));
      return { status: 'deferred', requestId: req.id, reason: errMsg(e) };
    }
    const reason = `planner crashed: ${errMsg(e)}`.slice(0, 500);
    await deps.db.planningFailed(req.id, reason).catch(() => undefined);
    return { status: 'failed', requestId: req.id, reason };
  } finally {
    const u = usage;
    if (calls > 0) {
      await deps.db.recordUsage({
        actor: 'coo', kind: 'plan', requestId: req.id, tokensIn: u.inputTokens ?? 0, tokensOut: u.outputTokens ?? 0,
        costUsd: cost, detail: usageDetail(picked, u, { calls, cost_usd: cost }),
      }).catch((e) => log(deps, '[coo] usage log failed', errMsg(e)));
    }
    await deps.db.finishAgentTurn('coo').catch(() => undefined);
  }
}
