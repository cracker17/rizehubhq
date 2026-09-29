// eval:roles body (imported by eval/cli.ts after the env is prepared, because config.ts reads process.env at import).
import path from 'node:path';
import type { ModelRole } from '@rizehubhq/shared';
import { createBrain } from '../brain';
import { config, workerEnv } from '../config';
import { chooseCandidate, loadModelsConfig, MODEL_PROFILES, QuotaExhaustedError, type ModelsConfig } from '../models/router';
import { ModelPicker } from '../models/usage';
import type { ResearchEnv } from '../research/env';
import { loadRole } from '../roles';
import type { CliArgs } from './cli';
import { FIXTURES_DIR, loadFixtures, type EvalRole } from './fixtures';
import { buildScorecard, runEval, scorecardMarkdown, writeScorecard, type EvalEnv } from './harness';
import { ScriptedProvider } from './scripted';

export const DEFAULT_OUT_DIR = path.join(config.root, 'reports', 'eval');

/** Model roles an eval of these agent roles needs: each role file's model_role, plus qa for every review. */
export function modelRolesFor(roles: readonly EvalRole[], load: (id: string) => { model_role: ModelRole } = loadRole): ModelRole[] {
  const out = new Set<ModelRole>(['qa']);
  for (const r of roles) if (r !== 'qa-lead') out.add(load(r).model_role);
  return [...out];
}

/**
 * Live pre-flight: every needed model role must resolve to a usable model under the active profile (key present,
 * budget > 0 for paid providers). Returns human-readable problems (empty = OK). Uses the router's own chooser.
 */
export function livePreflight(cfg: ModelsConfig, profile: string, needed: ModelRole[], env: Record<string, string | undefined>, monthlyBudgetUsd: number): string[] {
  if (!(MODEL_PROFILES as readonly string[]).includes(profile) || !cfg.profiles[profile]) {
    return [`MODEL_PROFILE "${profile}" is not one of ${MODEL_PROFILES.join(' | ')} (or missing from config/models.yaml)`];
  }
  const problems: string[] = [];
  for (const role of needed) {
    try {
      chooseCandidate(role, cfg, { profile, env, monthlyBudgetUsd, usage: { requestsToday: {}, spentThisMonthUsd: 0 } });
    } catch (e) {
      problems.push(e instanceof QuotaExhaustedError ? `model role "${role}": ${e.reasons.join('; ')}` : `model role "${role}": ${(e as Error).message}`);
    }
  }
  return problems;
}

/** Offline research env: every network path (fetch, DNS, browser, PageSpeed CLI) refuses, so QA evidence is skipped. */
export function offlineResearch(): Partial<ResearchEnv> {
  const no = () => Promise.reject(new Error('offline eval: network disabled'));
  return {
    net: { lookup: no, transport: no, allowPrivateHosts: [] },
    apiFetch: no as unknown as typeof fetch,
    launchBrowser: no,
    exec: no,
    qaEvidenceTimeoutMs: 1000,
  };
}

export async function main(args: CliArgs): Promise<number> {
  const log = args.quiet ? undefined : (m: string) => console.log(m);
  const threshold = args.threshold ?? config.qaThreshold;
  const sets = loadFixtures(args.roles, args.fixturesDir ? path.resolve(args.fixturesDir) : FIXTURES_DIR);
  const base = { brain: createBrain(), loadRole: (id: string) => loadRole(id), agentsDir: config.agentsDir, qaThreshold: threshold, log };
  let env: EvalEnv;
  let profile: string;

  if (args.live) {
    const cfg = loadModelsConfig();
    profile = config.modelProfile ?? cfg.active_profile;
    const problems = livePreflight(cfg, profile, modelRolesFor(args.roles), workerEnv(), config.monthlyBudgetUsd);
    if (problems.length) {
      console.error(`✗ eval:roles --live cannot run: no usable model under profile "${profile}".`);
      for (const p of problems) console.error(`  - ${p}`);
      console.error('  Add the provider key(s) to .env (docs/14: GOOGLE_GENERATIVE_AI_API_KEY / GROQ_API_KEY / OPENROUTER_API_KEY for "free";'
        + ' ANTHROPIC_API_KEY + OPENAI_API_KEY and MONTHLY_BUDGET_USD > 0 for "paid"; MOONSHOT_API_KEY and MONTHLY_BUDGET_USD > 0 for "kimi"),'
        + ' pick another MODEL_PROFILE, or run without --live.');
      return 2;
    }
    const picker = new ModelPicker({ cfg, profile, env: workerEnv(), monthlyBudgetUsd: config.monthlyBudgetUsd, dailyBudgetUsd: config.dailyAiBudgetUsd });
    env = { ...base, mode: 'live', pickModel: picker.pick };
    log?.(`[eval] LIVE · profile "${profile}" · roles ${args.roles.join(', ')} · QA ≥ ${threshold} · built-in runner, in-memory DB, mock RizeHub`);
  } else {
    const scripted = new ScriptedProvider();
    profile = 'scripted';
    env = { ...base, mode: 'offline', pickModel: scripted.pickModel, onRound: (fx, n) => scripted.setRound(fx, n), research: offlineResearch() };
    log?.(`[eval] offline (scripted model) · roles ${args.roles.join(', ')} · QA ≥ ${threshold}`);
  }

  const results = await runEval(sets, env, { maxRounds: args.maxRounds });
  const card = buildScorecard(results, { mode: env.mode, profile, threshold });
  const files = writeScorecard(card, args.out ? path.resolve(args.out) : DEFAULT_OUT_DIR);
  if (!args.quiet) console.log(`\n${scorecardMarkdown(card)}`);
  console.log(`Scorecard: ${path.relative(config.root, files.md)} (+ .json, and latest-${card.mode}.md)`);
  return card.allPassed ? 0 : 1;
}
