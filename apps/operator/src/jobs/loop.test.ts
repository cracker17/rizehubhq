import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OperatorChannel, OperatorClient } from '../db';
import { JobLoop, type AgentCall, type JobLoopDeps } from './loop';
import type { JobDb, OutboxRow } from './db';
import type { JobActionRow, JobRow } from './prompt';
import type { QaReport } from './qa';
import { buildJobPrompt, formatActions } from './prompt';
import { classifyEnd } from './runner';

const client: OperatorClient = { slug: 'lvlup', name: 'LvlUp Ventures', client_id: null, brain_project: 'lvlup-ventures', profile: 'lvlup', my_names: ['Julev'], rules: '- no money talk', enabled: true, paused: false };
const channel: OperatorChannel = { id: 'ch1', client_slug: 'lvlup', kind: 'google_chat', name: 'Team', url: 'https://chat.google.com/room/X', enabled: true, last_seen_key: null, last_polled_at: null, last_error: null };
const baseJob = (p: Partial<JobRow> = {}): JobRow => ({ id: 'job-1111-2222', client_slug: 'lvlup', inbox_id: 'in1', channel_id: 'ch1', source: 'chat', title: 'Update the team page',
  brief: 'From Alex: please update the bios', plan: ['Open the CMS'], status: 'running', runs: 1, max_runs: 4, feedback: null, result: {}, qa: null, cost_usd: 0, ...p });

function fakes(o: { agent: (c: AgentCall) => Promise<void> | void; qa?: QaReport; sends?: boolean } ) {
  const calls: string[] = [];
  let job: JobRow | null = baseJob();
  let claimed = false;
  const actions: JobActionRow[] = [];
  let outbox: OutboxRow | null = null;
  const memories: [string, string][] = [];
  const sent: { text: string; quote: boolean }[] = [];
  let paused: string | null = null;
  const db: JobDb = {
    claimJob: async () => { if (claimed || !job) return null; claimed = true; return job; },
    staleVerifying: async () => [],
    job: async () => job,
    actions: async () => actions,
    step: async (_j, a) => { calls.push(`step:${a}`); },
    requestAction: async (_j, kind, summary, spec) => {
      actions.push({ id: `a${actions.length + 1}`, job_id: job!.id, client_slug: 'lvlup', kind, summary, spec, status: 'pending', ceo_note: null, result: null, error: null });
      return { action_id: `a${actions.length}`, approval_id: 'ap-123456789' };
    },
    runDone: async (_j, outcome, result) => {
      calls.push(`runDone:${outcome}`);
      const st = outcome === 'finished' ? (actions.some((a) => a.status === 'pending') ? 'waiting' : 'verifying') : outcome === 'waiting' ? 'waiting' : outcome === 'blocked' ? 'escalated' : 'queued';
      job = { ...job!, status: st, result: outcome === 'finished' ? result : job!.result };
      return st;
    },
    verified: async (_j, pass, qa, feedback) => { calls.push(`verified:${pass}`); job = { ...job!, status: pass ? 'done' : 'queued', qa, feedback }; return job.status; },
    claimAction: async () => { const a = actions.find((x) => x.status === 'approved'); if (a) a.status = 'executing'; return a ?? null; },
    actionMayRun: async () => paused,
    actionDone: async (id, ok, result, error) => { const a = actions.find((x) => x.id === id)!; a.status = ok ? 'done' : 'failed'; a.result = result; a.error = error; return a.status; },
    queueUpdate: async (_j, text, mentions) => { outbox = { id: 'o1', client_slug: 'lvlup', channel_id: 'ch1', inbox_id: 'in1', job_id: job!.id, text, mentions, mode: 'approve', status: 'drafted', final_text: null, attempts: 0 }; return 'approval'; },
    claimUpdate: async () => (outbox?.status === 'approved' ? (outbox.status = 'sending', outbox) : null),
    updateMaySend: async () => paused,
    updateDone: async (_id, ok) => { outbox!.status = ok ? 'sent' : 'failed'; return outbox!.status; },
    inboxMessage: async () => ({ external_id: 'msg-1', thread_key: null }),
    saveEvidence: async () => 7,
    pruneEvidence: async () => 0,
    proposeMemory: async (_j, kind, text) => { memories.push([kind, text]); },
    promoteMemory: async () => 0,
    recentWork: async () => [],
    logins: async () => [],
    loginChecked: async () => 'ok',
    vaultToken: async () => null,
  };
  const deps: JobLoopDeps = {
    db,
    op: { clients: async () => [client], channels: async () => [channel], brainBundle: async () => null, brainSearch: async () => [], recordUsage: async () => { calls.push('usage'); } },
    withProfile: () => async (fn) => fn({} as never),
    gate: async () => ({ ok: true, model: 'claude-test', apiKey: 'k', capUsd: 1 }),
    runAgent: async (c) => { await o.agent(c); return { outcome: c.ended()?.kind === 'finished' ? 'finished' : c.ended()?.kind === 'waiting' ? 'waiting' : 'error', end: c.ended(), error: c.ended() ? null : 'no finish', costUsd: 0.2, tokensIn: 100, tokensOut: 50, model: 'claude-test', turns: 3 }; },
    qa: async () => o.qa ?? { pages: [{ url: 'https://lvlup.example/team', finalUrl: 'https://lvlup.example/team', status: 200, title: 'Team', consoleErrors: [], failedRequests: [], overflow: null, shots: [{ width: 375, jpeg: Buffer.from('a') }, { width: 1366, jpeg: Buffer.from('b') }], error: null }], links: [] },
    api: { http: { fetch, sleep: async () => undefined }, tokens: async () => null, env: {} },
    net: { lookup: async () => [{ address: '93.184.216.34', family: 4 }], transport: async () => new Response(''), allowPrivateHosts: [] },
    chat: { send: async (_c, _ch, input, steps) => { const why = await steps.lastCheck(); if (why) throw new Error(`not sent: ${why}`); sent.push({ text: input.text, quote: input.quote }); return { sent: true }; } },
    sends: o.sends ?? true,
    log: () => undefined,
  };
  return { deps, calls, actions, memories, sent, getJob: () => job, getOutbox: () => outbox, setPaused: (p: string | null) => { paused = p; } };
}

const tool = (c: AgentCall, name: string) => c.tools.find((t) => t.name === name)!;
const finishArgs = { status: 'done', summary: 'Updated 3 bios on the team page.', links: ['https://lvlup.example/team'], client_update: 'Done! The team page is updated: https://lvlup.example/team',
  mentions: ['Alex Doe'], decisions: ['Bios stay under 60 words'], next_steps: ['Get new headshots'], needs_from_julev: '' };

test('a finished job is QA-checked, then the client update and memories follow', async () => {
  const f = fakes({ agent: async (c) => {
    assert.match(c.prompt, /JOB: Update the team page \(run 1 of 4/);
    assert.match(c.prompt, /CLIENT RULES[^]*no money talk/);
    assert.ok(c.tools.some((t) => t.name === 'browser_snapshot') && !c.tools.some((t) => t.name === 'terminal'), 'no terminal without a sandbox');
    await tool(c, 'report_progress').run({ step: 'Opening the CMS' });
    const r = await tool(c, 'finish').run(finishArgs);
    assert.match((r.content[0] as { text: string }).text, /Stop now/);
    const again = await tool(c, 'browser_snapshot').run({});
    assert.equal(again.isError, true, 'tools refuse after finish');
  } });
  const loop = new JobLoop(f.deps);
  assert.equal(await loop.jobTick(), 'done');
  assert.deepEqual(f.calls.filter((c) => !c.startsWith('step:job.progress')).filter((c) => /runDone|verified|usage/.test(c)), ['usage', 'runDone:finished', 'verified:true']);
  assert.ok(f.calls.includes('step:job.progress'));
  const qa = f.getJob()!.qa as { evidence: number[]; pass: boolean };
  assert.deepEqual(qa.evidence, [7, 7]);
  assert.equal(f.getOutbox()!.text, finishArgs.client_update);
  assert.deepEqual(f.getOutbox()!.mentions, ['Alex Doe']);
  assert.deepEqual(f.memories.map((m) => m[0]), ['session_note', 'decision', 'next_step']);
  assert.match(f.memories[0]![1], /Operator job "Update the team page": Updated 3 bios.*https:\/\/lvlup\.example\/team/);
  assert.equal(await loop.jobTick(), null, 'nothing else queued');
});

test('QA failure sends the job back with the findings', async () => {
  const f = fakes({
    agent: async (c) => { await tool(c, 'finish').run(finishArgs); },
    qa: { pages: [{ url: 'https://lvlup.example/team', finalUrl: 'https://lvlup.example/team', status: 200, title: '', consoleErrors: ['TypeError: boom'], failedRequests: [], overflow: null, shots: [], error: null }], links: [] },
  });
  assert.equal(await new JobLoop(f.deps).jobTick(), 'queued');
  assert.match(f.getJob()!.feedback!, /console error: TypeError: boom/);
  assert.equal(f.getOutbox(), null, 'no client update before QA passes');
  assert.equal(f.memories.length, 0);
});

test('outside-world changes wait for approval; the approved spec runs; a pause stops it', async () => {
  const f = fakes({ agent: async (c) => {
    const no = await tool(c, 'wait_for_approvals').run({});
    assert.equal(no.isError, true, 'nothing requested yet');
    await tool(c, 'request_action').run({ kind: 'webflow_publish', summary: 'Publish the site', spec: { site_id: 'c'.repeat(24) } });
    await tool(c, 'wait_for_approvals').run({ note: 'waiting for publish' });
  } });
  const loop = new JobLoop(f.deps);
  assert.equal(await loop.jobTick(), 'waiting');
  assert.equal(await loop.actionTick(), null, 'not approved yet');
  f.actions[0]!.status = 'approved';
  f.setPaused('operator paused (kill switch)');
  assert.equal(await loop.actionTick(), 'failed');
  assert.match(f.actions[0]!.error!, /kill switch/);
});

test('approved client updates post through the last check; OPERATOR_SENDS=off posts nothing', async () => {
  const f = fakes({ agent: async (c) => { await tool(c, 'finish').run(finishArgs); } });
  const loop = new JobLoop(f.deps);
  await loop.jobTick();
  assert.equal(await loop.updateTick(), null, 'drafted, not approved');
  f.getOutbox()!.status = 'approved'; f.getOutbox()!.final_text = 'All done: https://lvlup.example/team';
  assert.equal(await loop.updateTick(), 'sent');
  assert.deepEqual(f.sent, [{ text: 'All done: https://lvlup.example/team', quote: true }]);
  const off = fakes({ agent: () => undefined, sends: false });
  assert.equal(await new JobLoop(off.deps).updateTick(), null);
});

test('a run without finish is an error (retried by SQL); a blocked finish escalates', async () => {
  const f = fakes({ agent: () => undefined });
  assert.equal(await new JobLoop(f.deps).jobTick(), 'queued');
  assert.equal(classifyEnd({ kind: 'finished', finish: { ...finishArgs, status: 'blocked', needs_from_julev: 'log in to Webflow' } as never }, {}).outcome, 'blocked');
  assert.equal(classifyEnd(null, { subtype: 'error_max_budget_usd' }).error, 'hit the spend cap of one run before finish');
  assert.equal(classifyEnd(null, { timedOut: true }).error, 'the run timed out before finish');
  assert.equal(classifyEnd({ kind: 'waiting' }, { subtype: 'error_max_turns' }).outcome, 'waiting', 'what the tools recorded wins');
});

test('the prompt carries earlier runs, approvals with notes, and QA findings', () => {
  const p = buildJobPrompt({ client, job: baseJob({ runs: 2, feedback: 'QA found 1 problem(s)', result: { summary: 'Edited bios', links: ['https://lvlup.example/team'] } }),
    memory: 'memory text', recentWork: [{ kind: 'session_note', text: 'Did X', status: 'approved', created_at: '2026-10-15T00:00:00Z' }],
    actions: [{ id: 'a', job_id: 'j', client_slug: 'lvlup', kind: 'webflow_cms', summary: 'Update bios', spec: {}, status: 'rejected', ceo_note: 'Only Riley', result: null, error: null }], tools: ['finish'] });
  assert.match(p, /FIX FIRST[^]*QA found 1/);
  assert.match(p, /Earlier run's result: Edited bios/);
  assert.match(p, /Julev's note: "Only Riley"/);
  assert.match(p, /2026-10-15 \[session_note\] Did X/);
  assert.match(p, /Continue from where the earlier run stopped/);
  assert.equal(formatActions([]), '(none yet)');
});
