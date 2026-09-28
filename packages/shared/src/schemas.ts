import { z } from 'zod';

// COO plan output (docs/05-ORCHESTRATION.md §2)
export const PlanTask = z.object({
  key: z.string().min(1),
  agent_id: z.string().min(1),
  work_type: z.string().min(1),
  title: z.string().min(1),
  instructions: z.string().min(1),
  acceptance_criteria: z.array(z.string().min(1)).min(3).max(7),
  depends_on: z.array(z.string()).default([]),
});

export const Plan = z.object({
  title: z.string().min(1),
  client_slug: z.string().nullable(),
  summary: z.string(),
  assumptions: z.array(z.string()).default([]),
  questions_for_ceo: z.array(z.string()).default([]),
  due_date: z.string().nullable(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  estimated_cost_usd: z.number().nonnegative().default(0),
  tasks: z.array(PlanTask).min(1),
}).superRefine((plan, ctx) => {
  const keys = new Set(plan.tasks.map((t) => t.key));
  if (keys.size !== plan.tasks.length) ctx.addIssue({ code: 'custom', message: 'Duplicate task keys' });
  for (const t of plan.tasks) {
    for (const d of t.depends_on) {
      if (!keys.has(d)) ctx.addIssue({ code: 'custom', message: `Task ${t.key} depends on unknown task ${d}` });
      if (d === t.key) ctx.addIssue({ code: 'custom', message: `Task ${t.key} depends on itself` });
    }
  }
});
export type Plan = z.infer<typeof Plan>;

// QA verdict (docs/05-ORCHESTRATION.md §5)
export const QaCheck = z.object({
  criterion: z.string(),
  result: z.enum(['pass', 'fail']),
  note: z.string().default(''),
  evidence: z.string().optional(),
});
export const QaVerdict = z.object({
  verdict: z.enum(['pass', 'fail']),
  score: z.number().int().min(0).max(100),
  checks: z.array(QaCheck).min(1),
  summary: z.string(),
  fix_list: z.array(z.string()).default([]),
});
export type QaVerdict = z.infer<typeof QaVerdict>;

/** A verdict only passes if every check passes and the score meets the threshold. */
export function isQaPass(v: QaVerdict, threshold = 85): boolean {
  return v.verdict === 'pass' && v.score >= threshold && v.checks.every((c) => c.result === 'pass');
}

// Agent standup (docs/13-WORKFLOWS.md §7)
export const Standup = z.object({
  done: z.array(z.string()),
  next: z.array(z.string()),
  blockers: z.array(z.string()),
});
