import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  chooseGate, classifyFallback, fallbackCandidate, FallbackSwitch, isClaudeOutage, loadFallbackConfig, parseFallbackId, runJobFallback, toAiTools, voiceSection,
} from './fallback';
import { buildUserPrompt } from './prompt';
import type { ModelsConfig } from 'worker/src/models/router';
import type { ToolSpec, RunEnd } from './jobs/tools';

const cfg = {
  active_profile: 'paid',
  daily_request_caps: {},
  profiles: {
    paid: { specialist: ['anthropic:claude-sonnet-5'] },
    free: { specialist: ['google:gemini-3.8-flash', 'groq:openai/gpt-oss-120b'], light: ['groq:openai/gpt-oss-20b'] },
  },
} as unknown as ModelsConfig;
const fbOn = loadFallbackConfig({}, ['specialist', 'light']);

test('voice: his own messages as examples, oldest first, deduplicated and clipped; empty when none', () => {
  const v = voiceSection(['Thanks Alex! On it.', 'thanks alex! on it.', 'ok', 'Hi Riley, quick one: can you send the logo files?', 'x'.repeat(400)]);
  assert.match(v, /^HOW JULEV WRITES/);
  assert.equal((v.match(/^- /gm) ?? []).length, 3, 'duplicate and too-short ones dropped');
  assert.ok(v.indexOf('Hi Riley') < v.indexOf('Thanks Alex'), 'oldest first');
  assert.match(v, /x{300}…/);
  assert.equal(voiceSection([]), '');
  const p = buildUserPrompt({ client: { slug: 'lvlup', name: 'LvlUp', client_id: null, brain_project: null, profile: 'lvlup', my_names: ['Julev'], rules: '', enabled: true, paused: false },
    channelName: 'Alex', message: { id: 'm', body: 'hi' } as never, history: [], memory: '', voice: v });
  assert.match(p, /HOW JULEV WRITES[\s\S]*CHAT: Alex/);
});

test('fallback model: from models.yaml (no hard-coded id), only allowed providers with a key, never Anthropic', () => {
  assert.deepEqual(fallbackCandidate({ env: { GROQ_API_KEY: 'g' }, cfg, role: 'specialist', providers: ['groq'] }), { provider: 'groq', modelId: 'openai/gpt-oss-120b' });
  assert.equal(fallbackCandidate({ env: {}, cfg, role: 'specialist', providers: ['groq'] }), null, 'no key, no fallback');
  assert.deepEqual(fallbackCandidate({ env: { GROQ_API_KEY: 'g', GOOGLE_GENERATIVE_AI_API_KEY: 'x' }, cfg, role: 'specialist', providers: ['google', 'groq'] })?.provider, 'google');
  assert.equal(fallbackCandidate({ env: { ANTHROPIC_API_KEY: 'a' }, cfg, role: 'specialist', providers: ['anthropic'] }), null);
  assert.deepEqual(parseFallbackId('fallback:groq:openai/gpt-oss-120b'), { provider: 'groq', modelId: 'openai/gpt-oss-120b' });
  assert.deepEqual([fbOn.enabled, fbOn.providers, fbOn.role, fbOn.jobs, fbOn.maxSteps, fbOn.maxUsdPerDay], [true, ['groq'], 'specialist', true, 24, 1]);
  assert.equal(loadFallbackConfig({ OPERATOR_FALLBACK: 'off', OPERATOR_FALLBACK_PROVIDERS: 'anthropic' }, []).providers[0], 'groq');
});

test('outage detection and the switch: Claude first; fallback on outage / no budget; announced once; back once', () => {
  assert.equal(isClaudeOutage('400 {"error":{"message":"Your credit balance is too low to access the Anthropic API"}}'), true);
  assert.equal(isClaudeOutage('the monthly AI budget is 0 (Admin → API & AI)'), true);
  assert.equal(isClaudeOutage('category reply needs a draft'), false);
  let t = 0;
  const fb = new FallbackSwitch(() => t);
  fb.markDown('credit balance is too low');
  assert.equal(fb.isDown(), true);
  assert.equal(fb.shouldAnnounce(), true);
  assert.equal(fb.shouldAnnounce(), false);
  t += 31 * 60_000;
  assert.equal(fb.isDown(), false, 'Claude is tried again after 30 minutes');
  assert.equal(fb.restored(), true);
  assert.equal(fb.restored(), false);

  const claudeOk = { ok: true as const, model: 'claude-sonnet-5', apiKey: 'k', capUsd: 0.25 };
  const cand = { provider: 'groq' as const, modelId: 'openai/gpt-oss-120b' };
  const base = { claudeDown: false, kind: 'message' as const, cfg: fbOn, candidate: cand, fallbackSpentTodayUsd: 0, capUsd: 0.25 };
  assert.deepEqual(chooseGate({ ...base, claude: claudeOk }), { gate: claudeOk, event: 'restored', reason: '' });
  const down = chooseGate({ ...base, claude: claudeOk, claudeDown: true });
  assert.deepEqual([down.gate.ok && down.gate.model, down.event], ['fallback:groq:openai/gpt-oss-120b', 'fallback']);
  const noBudget = chooseGate({ ...base, claude: { ok: false, reason: 'the monthly AI budget is used up' } });
  assert.equal(noBudget.gate.ok, true);
  assert.equal(chooseGate({ ...base, claude: { ok: false, reason: 'x' }, cfg: { ...fbOn, jobs: false }, kind: 'job' }).gate.ok, false);
  assert.match((chooseGate({ ...base, claude: { ok: false, reason: 'x' }, candidate: null }).gate as { reason: string }).reason, /GROQ_API_KEY/);
  assert.match((chooseGate({ ...base, claude: { ok: false, reason: 'x' }, fallbackSpentTodayUsd: 1 }).gate as { reason: string }).reason, /daily cap/);
  assert.equal((chooseGate({ ...base, claude: { ok: false, reason: 'x' }, fallbackSpentTodayUsd: 0.9 }).gate as { capUsd: number }).capUsd, 0.1);
});

test('classify on the fallback: same schema and validation, cost priced, model label kept', async () => {
  const gen = (async () => ({
    object: { category: 'reply', action_types: ['ack'], confidence: 0.8, summary: 's', reasons: 'r', draft: 'On it, Alex!', mentions: [], task_plan: [], needs_from_julev: '', addressed_to_julev: true },
    usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100 }, providerMetadata: undefined,
  })) as never;
  const out = await classifyFallback({ model: {} as never, c: { provider: 'groq', modelId: 'openai/gpt-oss-120b' }, prompt: 'p', generate: gen });
  assert.deepEqual([out.result.draft, out.result.addressed_to_julev, out.model, out.tokensIn], ['On it, Alex!', true, 'groq:openai/gpt-oss-120b', 1000]);
  const bad = (async () => { throw new Error('rate limited'); }) as never;
  await assert.rejects(classifyFallback({ model: {} as never, c: { provider: 'groq', modelId: 'm' }, prompt: 'p', generate: bad }), /groq:m: rate limited/);
});

test('jobs on the fallback: the same tools, stops at finish, outcome like a Claude run', async () => {
  let ended: RunEnd | null = null;
  const tools: ToolSpec[] = [
    { name: 'report_progress', description: 'd', shape: { step: z.string() }, run: async () => ({ content: [{ type: 'text', text: 'Noted.' }] }) },
    { name: 'finish', description: 'd', shape: { summary: z.string() }, run: async (a: { summary: string }) => { ended = { kind: 'finished', finish: { status: 'done', summary: a.summary } as never }; return { content: [{ type: 'text', text: 'ok' }] }; } },
  ];
  const ai = toAiTools(tools);
  assert.deepEqual(Object.keys(ai), ['report_progress', 'finish']);
  const gen = (async (o: { tools: Record<string, { execute: (a: unknown, x: unknown) => Promise<unknown> }>; stopWhen: ((x: unknown) => boolean)[] }) => {
    await o.tools.report_progress!.execute({ step: 'Reading GitHub' }, {});
    await o.tools.finish!.execute({ summary: 'Checked the PR; nothing to change' }, {});
    assert.equal(o.stopWhen[1]!({ steps: [] }), true, 'stops right after finish');
    return { steps: [{}, {}], usage: { inputTokens: 500, outputTokens: 50 }, totalUsage: { inputTokens: 500, outputTokens: 50 }, providerMetadata: undefined };
  }) as never;
  const out = await runJobFallback({ model: {} as never, c: { provider: 'groq', modelId: 'openai/gpt-oss-120b' }, prompt: 'p', systemPrompt: 's', tools, ended: () => ended, maxSteps: 24, generate: gen });
  assert.deepEqual([out.outcome, out.turns, out.model], ['finished', 2, 'groq:openai/gpt-oss-120b']);
  ended = null;
  const none = await runJobFallback({ model: {} as never, c: { provider: 'groq', modelId: 'm' }, prompt: 'p', systemPrompt: 's', tools, ended: () => ended, maxSteps: 2,
    generate: (async () => ({ steps: [{}, {}], usage: {}, totalUsage: {} })) as never });
  assert.deepEqual([none.outcome, none.error], ['error', 'used all its turns before finish (split the task or continue)']);
});
