// Role-evaluation fixtures (M10, docs/11-ROADMAP.md): 3+ realistic sample tasks per role in eval/fixtures/<role>.yaml.
// Every fixture runs through the real runner + QA path (eval/harness.ts). The `scripted` block is only used offline
// (eval/scripted.ts: deterministic fake model); with --live the configured providers do the work and `scripted` is ignored.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';

export const EVAL_ROLES = ['coo', 'web-dev', 'designer', 'writer', 'sales', 'qa-lead'] as const;
export type EvalRole = (typeof EVAL_ROLES)[number];
/** M10 acceptance: each role completes this many tasks with QA ≥ threshold. */
export const TASKS_PER_ROLE = 3;
export const FIXTURES_DIR = path.join(import.meta.dirname, 'fixtures');

/** Fictional client (never a real one): inserted into the in-memory DB so the task prompt carries client context. */
export const EvalClient = z.object({
  name: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  platforms: z.array(z.string()).default([]),
  website: z.string().nullable().default(null),
});

/** What the maker hands to submit_output (criteria_map defaults to "met" for every criterion). */
export const ScriptedOutput = z.object({
  summary: z.string().min(1),
  content: z.string().min(1),
  links: z.array(z.string()).default([]),
  files: z.array(z.string()).default([]),
  preview_url: z.string().nullable().default(null),
  criteria_map: z.record(z.string(), z.string()).optional(),
});
export type ScriptedOutput = z.infer<typeof ScriptedOutput>;

/** Scripted QA verdict: `fail` = indexes (0-based) of acceptance criteria QA fails. */
export const ScriptedQa = z.object({
  score: z.number().int().min(0).max(100),
  fail: z.array(z.number().int().min(0)).default([]),
  summary: z.string().optional(),
});
export type ScriptedQa = z.infer<typeof ScriptedQa>;

const Base = {
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().min(1),
  work_type: z.string().min(1),
  client: EvalClient.optional(),
  instructions: z.string().min(20),
  acceptance_criteria: z.array(z.string().min(1)).min(3),
};

/** A maker task: the role produces a deliverable, QA reviews it (revision loop included). */
export const MakeFixture = z.object({
  ...Base,
  kind: z.literal('make').default('make'),
  scripted: z.object({
    /** One entry per attempt: attempt 1 may fail QA to exercise the revision loop, the last one should pass. */
    attempts: z.array(z.object({ output: ScriptedOutput, qa: ScriptedQa })).min(1),
  }),
});

/**
 * A review task for qa-lead: QA gets a finished deliverable (from `maker`) and must reach the expected verdict.
 * The eval passes when QA's pass/fail matches `expect` (calibration), since QA does not produce deliverables itself.
 */
export const ReviewFixture = z.object({
  ...Base,
  kind: z.literal('review'),
  maker: z.enum(EVAL_ROLES),
  deliverable: ScriptedOutput,
  expect: z.enum(['pass', 'fail']),
  scripted: z.object({ qa: ScriptedQa }),
});

export const Fixture = z.union([ReviewFixture, MakeFixture]);
export type MakeFixture = z.infer<typeof MakeFixture>;
export type ReviewFixture = z.infer<typeof ReviewFixture>;
export type Fixture = MakeFixture | ReviewFixture;

export const FixtureFile = z.object({ role: z.enum(EVAL_ROLES), tasks: z.array(Fixture).min(1) });
export interface RoleFixtures { role: EvalRole; tasks: Fixture[] }

export function loadRoleFixtures(role: EvalRole, dir = FIXTURES_DIR): RoleFixtures {
  const file = path.join(dir, `${role}.yaml`);
  const parsed = FixtureFile.safeParse(YAML.parse(fs.readFileSync(file, 'utf8')));
  if (!parsed.success) throw new Error(`${file}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  if (parsed.data.role !== role) throw new Error(`${file}: role is "${parsed.data.role}", expected "${role}"`);
  return parsed.data as RoleFixtures;
}

/** Fixtures for the given roles (default: all six), in roster order. */
export function loadFixtures(roles: readonly EvalRole[] = EVAL_ROLES, dir = FIXTURES_DIR): RoleFixtures[] {
  return roles.map((r) => loadRoleFixtures(r, dir));
}

export function isEvalRole(x: string): x is EvalRole {
  return (EVAL_ROLES as readonly string[]).includes(x);
}
