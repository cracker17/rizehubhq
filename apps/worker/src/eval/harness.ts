// Role-evaluation harness (M10): runs fixture tasks through the REAL runner (runTask) and QA reviewer (reviewNext)
// against an in-memory HQ database (FakeHqDb), so nothing touches Supabase and no external action can run: every
// request_external_action / ask_ceo only lands in the in-memory approvals list. Models come from deps.pickModel:
// the scripted fake offline, the router (config/models.yaml + env keys) with --live.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ModelRole } from '@rizehubhq/shared';
import type { Brain } from '../brain';
import type { WorkerDeps } from '../deps';
import { FakeHqDb } from '../fakeHqDb';
import type { PickModel } from '../models/usage';
import type { ResearchEnv } from '../research/env';
import type { Role } from '../roles';
import { reviewNext } from '../qa';
import { runTask } from '../runner';
import { TASKS_PER_ROLE, type EvalRole, type Fixture, type MakeFixture, type ReviewFixture, type RoleFixtures } from './fixtures';

export type EvalMode = 'offline' | 'live';

export interface EvalEnv {
  mode: EvalMode;
  pickModel: PickModel;
  brain: Brain;
  loadRole: (id: string) => Role;
  agentsDir: string;
  qaThreshold: number;
  /** Called before every maker/QA round (the scripted provider points itself at the fixture + attempt). */
  onRound?: (fx: Fixture, attempt: number) => void;
  /** Research/QA-evidence overrides (offline: every network path blocked). */
  research?: Partial<ResearchEnv>;
  log?: (msg: string) => void;
}

export interface EvalOptions {
  /** Maker attempts per task, i.e. 1 + allowed QA revisions (default 3). */
  maxRounds?: number;
}

export interface AttemptResult { attempt: number; qaScore: number | null; qaPass: boolean; failedChecks: string[]; note?: string }

export interface EvalResult {
  role: EvalRole;
  id: string;
  title: string;
  workType: string;
  kind: 'make' | 'review';
  /** pass = QA passed (≥ threshold, every check passed); review tasks: QA's verdict matched `expect`. error = no verdict. */
  status: 'pass' | 'fail' | 'error';
  finalScore: number | null;
  firstScore: number | null;
  attempts: AttemptResult[];
  expected?: 'pass' | 'fail';
  /** provider:model per model role the task used (e.g. writer → google:gemini-3.8-flash, qa → …). */
  models: Record<string, string>;
  costUsd: number;
  /** Approvals the run created (questions, external actions): recorded only, never executed. */
  approvals: string[];
  note?: string;
  durationMs: number;
}

/** Wraps pickModel to remember which model served each role (for the scorecard). */
function recordingPicker(pick: PickModel, models: Record<string, string>): PickModel {
  return async (role: ModelRole, opts) => {
    const p = await pick(role, opts);
    models[role] = `${p.provider}:${p.modelId}`;
    return p;
  };
}

function makeDeps(env: EvalEnv, db: FakeHqDb, models: Record<string, string>): WorkerDeps & { research?: Partial<ResearchEnv> } {
  return {
    db, brain: env.brain, pickModel: recordingPicker(env.pickModel, models), loadRole: env.loadRole,
    agentsDir: env.agentsDir, qaThreshold: env.qaThreshold,
    log: (m, e) => env.log?.(e === undefined ? m : `${m} ${String(e)}`),
    ...(env.research ? { research: env.research } : {}),
  };
}

function addClient(db: FakeHqDb, fx: Fixture): string | null {
  if (!fx.client) return null;
  const id = randomUUID();
  db.clients.set(id, { id, ...fx.client, service_package: null, status: 'active', notes: null });
  return id;
}

const failedChecks = (v: { checks: { criterion: string; result: string }[] }) => v.checks.filter((c) => c.result !== 'pass').map((c) => c.criterion);
const approvalsOf = (db: FakeHqDb) => db.approvals.map((a) => a.title);
const costOf = (db: FakeHqDb) => Math.round(db.usage.reduce((s, u) => s + u.costUsd, 0) * 1e6) / 1e6;

async function runMake(role: EvalRole, fx: MakeFixture, env: EvalEnv, opts: Required<EvalOptions>): Promise<EvalResult> {
  const started = Date.now();
  const db = new FakeHqDb();
  const models: Record<string, string> = {};
  const deps = makeDeps(env, db, models);
  const task = db.addTask({
    agent_id: role, title: fx.title, instructions: fx.instructions, work_type: fx.work_type,
    acceptance_criteria: fx.acceptance_criteria, client_id: addClient(db, fx), max_revisions: opts.maxRounds - 1,
  });
  const attempts: AttemptResult[] = [];
  let note: string | undefined;
  let status: EvalResult['status'] = 'error';

  for (let attempt = 1; attempt <= opts.maxRounds; attempt++) {
    const claimed = await db.claimNextTask();
    if (!claimed || claimed.id !== task.id) { note = `task not claimable (status ${db.tasks.get(task.id)?.status})`; break; }
    env.onRound?.(fx, attempt);
    // Built-in runner for every role: Hermes needs the worker's live /mcp endpoint, which the eval does not start.
    const run = await runTask(claimed, deps, { heartbeatMs: 60_000, hermes: { resolve: () => null, fallback: true } });
    if (run.status !== 'submitted') {
      note = run.status === 'asked_ceo' ? `asked the CEO: ${db.approvals.at(-1)?.title ?? ''}` : `run ${run.status}${'reason' in run ? `: ${run.reason}` : ''}`;
      status = run.status === 'asked_ceo' ? 'fail' : 'error';
      break;
    }
    const qa = await reviewNext(deps);
    if (qa.status !== 'recorded') { // no valid verdict (the reviewer already retried once) or quota: report, don't loop
      note = `QA ${qa.status}${'reason' in qa ? `: ${qa.reason}` : ''}`;
      attempts.push({ attempt, qaScore: null, qaPass: false, failedChecks: [], note });
      status = 'error';
      break;
    }
    attempts.push({ attempt, qaScore: qa.verdict.score, qaPass: qa.pass, failedChecks: failedChecks(qa.verdict) });
    if (qa.pass) { status = 'pass'; break; }
    status = 'fail';
    if (qa.result !== 'revision') { note = `QA ${qa.result} after ${attempt} attempt(s)`; break; }
  }
  if (status === 'fail' && !note && attempts.length >= opts.maxRounds) note = `QA still failing after ${opts.maxRounds} attempt(s)`;
  const scored = attempts.filter((a) => a.qaScore !== null);
  return {
    role, id: fx.id, title: fx.title, workType: fx.work_type, kind: 'make', status,
    finalScore: scored.at(-1)?.qaScore ?? null, firstScore: scored[0]?.qaScore ?? null,
    attempts, models, costUsd: costOf(db), approvals: approvalsOf(db), note, durationMs: Date.now() - started,
  };
}

async function runReview(role: EvalRole, fx: ReviewFixture, env: EvalEnv): Promise<EvalResult> {
  const started = Date.now();
  const db = new FakeHqDb();
  const models: Record<string, string> = {};
  const deps = makeDeps(env, db, models);
  const d = fx.deliverable;
  db.addTask({
    agent_id: fx.maker, title: fx.title, instructions: fx.instructions, work_type: fx.work_type,
    acceptance_criteria: fx.acceptance_criteria, client_id: addClient(db, fx), status: 'qa_pending',
    output: {
      summary: d.summary, content: d.content, files: d.files, links: d.links, preview_url: d.preview_url,
      criteria_map: d.criteria_map ?? Object.fromEntries(fx.acceptance_criteria.map((c) => [c, 'Met: see the deliverable content'])),
    },
  });
  env.onRound?.(fx, 1);
  const qa = await reviewNext(deps);
  const base = { role, id: fx.id, title: fx.title, workType: fx.work_type, kind: 'review' as const, expected: fx.expect, models, approvals: approvalsOf(db) };
  if (qa.status !== 'recorded') {
    const note = `QA ${qa.status}${'reason' in qa ? `: ${qa.reason}` : ''}`;
    return { ...base, status: 'error', finalScore: null, firstScore: null, attempts: [{ attempt: 1, qaScore: null, qaPass: false, failedChecks: [], note }],
      costUsd: costOf(db), note, durationMs: Date.now() - started };
  }
  const got = qa.pass ? 'pass' : 'fail';
  return {
    ...base, status: got === fx.expect ? 'pass' : 'fail', finalScore: qa.verdict.score, firstScore: qa.verdict.score,
    attempts: [{ attempt: 1, qaScore: qa.verdict.score, qaPass: qa.pass, failedChecks: failedChecks(qa.verdict) }],
    costUsd: costOf(db), note: got === fx.expect ? undefined : `QA said ${got}, expected ${fx.expect}`, durationMs: Date.now() - started,
  };
}

/** Runs one fixture. Never throws: a crash becomes status "error" with the message in note. */
export async function runFixture(role: EvalRole, fx: Fixture, env: EvalEnv, opts: EvalOptions = {}): Promise<EvalResult> {
  const o = { maxRounds: Math.max(1, opts.maxRounds ?? 3) };
  try {
    return fx.kind === 'review' ? await runReview(role, fx, env) : await runMake(role, fx, env, o);
  } catch (e) {
    return {
      role, id: fx.id, title: fx.title, workType: fx.work_type, kind: fx.kind, status: 'error', finalScore: null, firstScore: null,
      attempts: [], models: {}, costUsd: 0, approvals: [], note: `crashed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500), durationMs: 0,
    };
  }
}

/** Runs every fixture of every role sequentially (the scripted provider and free-tier quotas both want one at a time). */
export async function runEval(sets: RoleFixtures[], env: EvalEnv, opts: EvalOptions = {}): Promise<EvalResult[]> {
  const out: EvalResult[] = [];
  for (const set of sets) {
    for (const fx of set.tasks) {
      env.log?.(`[eval] ${set.role} · ${fx.id} …`);
      const r = await runFixture(set.role, fx, env, opts);
      env.log?.(`[eval] ${set.role} · ${fx.id} → ${r.status.toUpperCase()} (QA ${r.finalScore ?? '–'}${r.attempts.length > 1 ? ` after ${r.attempts.length} attempts` : ''})${r.note ? ` · ${r.note}` : ''}`);
      out.push(r);
    }
  }
  return out;
}

// ---------- scorecard ----------

export interface RoleSummary { role: EvalRole; passed: number; total: number; target: number; ready: boolean; avgScore: number | null; costUsd: number }
export interface Scorecard {
  generatedAt: string;
  mode: EvalMode;
  profile: string;
  threshold: number;
  target: number;
  roles: RoleSummary[];
  results: EvalResult[];
  allPassed: boolean;
}

export function buildScorecard(results: EvalResult[], meta: { mode: EvalMode; profile: string; threshold: number; now?: Date }): Scorecard {
  const roles: RoleSummary[] = [];
  for (const role of [...new Set(results.map((r) => r.role))]) {
    const rs = results.filter((r) => r.role === role);
    const scores = rs.map((r) => r.finalScore).filter((s): s is number => s !== null);
    const passed = rs.filter((r) => r.status === 'pass').length;
    roles.push({
      role, passed, total: rs.length, target: TASKS_PER_ROLE, ready: passed >= TASKS_PER_ROLE && passed === rs.length,
      avgScore: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
      costUsd: Math.round(rs.reduce((s, r) => s + r.costUsd, 0) * 1e6) / 1e6,
    });
  }
  return {
    generatedAt: (meta.now ?? new Date()).toISOString(), mode: meta.mode, profile: meta.profile, threshold: meta.threshold,
    target: TASKS_PER_ROLE, roles, results, allPassed: results.length > 0 && results.every((r) => r.status === 'pass'),
  };
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const usd = (n: number) => `$${n.toFixed(4)}`;

export function scorecardMarkdown(card: Scorecard): string {
  const lines = [
    `# Role evaluation (${card.mode})`,
    '',
    `Generated ${card.generatedAt} · profile \`${card.profile}\` · QA pass ≥ ${card.threshold} · target ${card.target} passing tasks per role (docs/11 M10)`,
    card.mode === 'offline' ? '\n> Offline run: scripted model outputs (deterministic, no keys). It proves the harness + runner + QA path; real quality needs `--live`.' : '',
    '',
    '## Roles',
    '',
    '| Role | Passed | Avg QA | Cost | M10 ready |',
    '|---|---|---|---|---|',
    ...card.roles.map((r) => `| ${r.role} | ${r.passed}/${r.total} | ${r.avgScore ?? '–'} | ${usd(r.costUsd)} | ${r.ready ? 'yes' : 'no'} |`),
    '',
    '## Tasks',
    '',
    '| Role | Task | Work type | Attempts | First QA | Final QA | Result | Models | Cost | Notes |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...card.results.map((r) => {
      const notes = [
        r.kind === 'review' ? `review, expected ${r.expected}` : '',
        r.attempts.at(-1)?.failedChecks.length ? `failed: ${r.attempts.at(-1)!.failedChecks.join('; ')}` : '',
        r.approvals.length ? `approvals: ${r.approvals.join('; ')}` : '',
        r.note ?? '',
      ].filter(Boolean).join(' · ');
      const models = Object.entries(r.models).map(([k, v]) => `${k}=${v}`).join(', ');
      return `| ${r.role} | ${cell(r.title)} | ${r.workType} | ${r.attempts.length} | ${r.firstScore ?? '–'} | ${r.finalScore ?? '–'} | ${r.status === 'pass' ? 'PASS' : r.status === 'fail' ? 'FAIL' : 'ERROR'} | ${cell(models) || '–'} | ${usd(r.costUsd)} | ${cell(notes) || ''} |`;
    }),
    '',
    `**${card.allPassed ? 'All tasks passed.' : `${card.results.filter((r) => r.status !== 'pass').length} of ${card.results.length} task(s) did not pass.`}**`,
    '',
  ];
  return lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
}

/** Writes <dir>/role-eval-<mode>-<stamp>.{json,md} and latest-<mode>.{json,md}. Returns the timestamped paths. */
export function writeScorecard(card: Scorecard, dir: string): { json: string; md: string } {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = card.generatedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-');
  const base = path.join(dir, `role-eval-${card.mode}-${stamp}`);
  const json = `${JSON.stringify(card, null, 2)}\n`;
  const md = scorecardMarkdown(card);
  fs.writeFileSync(`${base}.json`, json);
  fs.writeFileSync(`${base}.md`, md);
  fs.writeFileSync(path.join(dir, `latest-${card.mode}.json`), json);
  fs.writeFileSync(path.join(dir, `latest-${card.mode}.md`), md);
  return { json: `${base}.json`, md: `${base}.md` };
}
