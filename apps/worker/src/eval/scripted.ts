// Deterministic fake model provider for the offline role eval (CI, no keys). It plugs in where the router would:
// the harness still calls deps.pickModel(role) for the maker and for QA, and the runner/QA code paths are the real ones.
// Behaviour, decided from each call (not from call order):
//   - structured output call (generateObject, QA)     → the fixture's scripted QA verdict for the current attempt
//   - maker call without tool results yet (step 1)     → brain_read(SOP) + report_progress tool calls
//   - maker call after tool results (step 2)           → submit_output with the fixture's scripted output
import { MockLanguageModelV2 } from 'ai/test';
import type { ModelRole } from '@rizehubhq/shared';
import type { PickModel, PickedModel } from '../models/usage';
import type { Fixture, ScriptedOutput, ScriptedQa } from './fixtures';

type CallOptions = MockLanguageModelV2['doGenerateCalls'][number];
type GenerateResult = Awaited<ReturnType<MockLanguageModelV2['doGenerate']>>;

export const SCRIPTED_PROVIDER = 'scripted';
const USAGE = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

/** Scripted maker output + QA verdict for a fixture's attempt (1-based; attempts past the script reuse the last one). */
export function scriptFor(fx: Fixture, attempt: number): { output: ScriptedOutput; qa: ScriptedQa } {
  if (fx.kind === 'review') return { output: fx.deliverable, qa: fx.scripted.qa };
  const list = fx.scripted.attempts;
  return list[Math.min(Math.max(attempt, 1), list.length) - 1]!;
}

/** QA verdict object (shared QaVerdict shape) built from a scripted score + failing criterion indexes. */
export function scriptedVerdict(criteria: string[], qa: ScriptedQa) {
  const failed = new Set(qa.fail);
  const checks = criteria.map((criterion, i) => ({
    criterion,
    result: failed.has(i) ? 'fail' as const : 'pass' as const,
    note: failed.has(i) ? 'Not met in the submitted output' : 'Met: verified in the output',
  }));
  return {
    verdict: failed.size ? 'fail' as const : 'pass' as const,
    score: qa.score,
    summary: qa.summary ?? (failed.size ? `${failed.size} check(s) failed` : 'All acceptance criteria met'),
    checks,
    fix_list: checks.filter((c) => c.result === 'fail').map((c) => `Meet this criterion: ${c.criterion}`),
  };
}

let seq = 0;
function toolCalls(calls: { name: string; input: unknown }[]): GenerateResult {
  return {
    content: calls.map((c) => ({ type: 'tool-call' as const, toolCallId: `eval-${++seq}`, toolName: c.name, input: JSON.stringify(c.input) })),
    finishReason: 'tool-calls', usage: USAGE, warnings: [],
  };
}
const text = (t: string): GenerateResult => ({ content: [{ type: 'text', text: t }], finishReason: 'stop', usage: USAGE, warnings: [] });

export class ScriptedProvider {
  private current: { fx: Fixture; attempt: number } | null = null;
  /** Every model role the harness asked for, in order (tests assert the runner used the role file's model_role). */
  readonly requested: ModelRole[] = [];

  /** Points the fake at the fixture + attempt the harness is about to run. */
  setRound(fx: Fixture, attempt: number): void { this.current = { fx, attempt }; }

  private respond(opts: CallOptions): GenerateResult {
    const cur = this.current;
    if (!cur) throw new Error('scripted provider: no fixture selected (call setRound first)');
    const { fx, attempt } = cur;
    const script = scriptFor(fx, attempt);
    if (opts.responseFormat?.type === 'json') return text(JSON.stringify(scriptedVerdict(fx.acceptance_criteria, script.qa)));
    const hasToolResults = opts.prompt.some((m) => m.role === 'tool');
    if (!hasToolResults) {
      return toolCalls([
        { name: 'brain_read', input: { path: `brain/sops/${fx.work_type}.md` } },
        { name: 'report_progress', input: { percent: 40, note: `Drafting (attempt ${attempt})`, app: 'doc', title: fx.title } },
      ]);
    }
    const out = script.output;
    const map = out.criteria_map ?? {};
    return toolCalls([{
      name: 'submit_output',
      input: {
        summary: out.summary, content: out.content, files: out.files, links: out.links,
        ...(out.preview_url ? { preview_url: out.preview_url } : {}),
        criteria_map: fx.acceptance_criteria.map((c) => ({ criterion: c, how_met: map[c] ?? 'Met: see the deliverable content' })),
      },
    }]);
  }

  /** PickModel for WorkerDeps: same contract as the router (role in, model out), zero cost. */
  pickModel: PickModel = async (role) => {
    this.requested.push(role);
    const model = new MockLanguageModelV2({ provider: SCRIPTED_PROVIDER, modelId: `scripted-${role}`, doGenerate: async (o) => this.respond(o) });
    const picked: PickedModel = { model, provider: SCRIPTED_PROVIDER, modelId: `scripted-${role}`, recordCall: () => 0 };
    return picked;
  };
}
