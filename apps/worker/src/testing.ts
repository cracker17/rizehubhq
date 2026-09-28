// Test helpers: mock models (ai/test MockLanguageModelV2) + WorkerDeps wired to FakeHqDb. No network.
import { MockLanguageModelV2 } from 'ai/test';
import { createBrain, type Brain } from './brain';
import { config } from './config';
import type { WorkerDeps } from './deps';
import { FakeHqDb } from './fakeHqDb';
import { costUsd, normalizeUsage, type PickedModel } from './models/usage';
import { loadRole } from './roles';

type CallOptions = MockLanguageModelV2['doGenerateCalls'][number];
type GenerateResult = Awaited<ReturnType<MockLanguageModelV2['doGenerate']>>;
export interface MockUsage { inputTokens?: number; outputTokens?: number }

const u = (x: MockUsage = {}) => ({ inputTokens: x.inputTokens ?? 100, outputTokens: x.outputTokens ?? 50, totalTokens: (x.inputTokens ?? 100) + (x.outputTokens ?? 50) });

export function textResponse(text: string, usage?: MockUsage): GenerateResult {
  return { content: [{ type: 'text', text }], finishReason: 'stop', usage: u(usage), warnings: [] };
}
export function jsonResponse(obj: unknown, usage?: MockUsage): GenerateResult {
  return textResponse(typeof obj === 'string' ? obj : JSON.stringify(obj), usage);
}
let callSeq = 0;
export function toolCalls(calls: { name: string; input: unknown }[], usage?: MockUsage): GenerateResult {
  return {
    content: calls.map((c) => ({ type: 'tool-call' as const, toolCallId: `call-${++callSeq}`, toolName: c.name, input: JSON.stringify(c.input) })),
    finishReason: 'tool-calls', usage: u(usage), warnings: [],
  };
}

/** A mock model that returns the given responses in order (or throws `error` on every call). */
export function mockModel(responses: GenerateResult[] | { error: unknown }): MockLanguageModelV2 {
  const model: MockLanguageModelV2 = new MockLanguageModelV2({
    doGenerate: async () => {
      if (!Array.isArray(responses)) throw responses.error;
      const r = responses[model.doGenerateCalls.length - 1];
      if (!r) throw new Error(`mock model: no response #${model.doGenerateCalls.length}`);
      return r;
    },
  });
  return model;
}

/** All text in a model call's prompt (system + user + tool results), for assertions. */
export function promptText(call: CallOptions): string {
  return call.prompt.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
}

export function makeDeps(opts: {
  db?: FakeHqDb; model: MockLanguageModelV2; provider?: string; modelId?: string; brain?: Brain; qaThreshold?: number;
}): WorkerDeps & { db: FakeHqDb; logs: string[]; quotaHits: string[] } {
  const db = opts.db ?? new FakeHqDb();
  const provider = opts.provider ?? 'google';
  const modelId = opts.modelId ?? 'mock-model';
  const logs: string[] = [];
  const quotaHits: string[] = [];
  const picked: PickedModel = { model: opts.model, provider, modelId, recordCall: (usage, meta) => costUsd(provider, modelId, normalizeUsage(provider, usage, meta)) };
  return {
    db, brain: opts.brain ?? createBrain(), pickModel: async () => picked, loadRole: (id) => loadRole(id),
    agentsDir: config.agentsDir, qaThreshold: opts.qaThreshold ?? 85,
    onProviderQuota: (p) => { quotaHits.push(p); },
    log: (m, e) => { logs.push(e === undefined ? m : `${m} ${String(e)}`); },
    now: () => new Date('2026-09-28T02:00:00Z'),
    logs, quotaHits,
  };
}
