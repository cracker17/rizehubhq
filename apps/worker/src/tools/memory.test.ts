import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryPromptSection, memoryTools, looksSecret, setMemoryForTests, type MemoryStore, type MemoryContext } from './memory';
import type { ToolFactory } from './types';

type ToolContext = Parameters<ToolFactory>[0];

after(() => setMemoryForTests(undefined));

const CTX: MemoryContext = {
  project: 'spicy-voyage', name: 'Spicy Voyage', last_activity: '2026-09-30',
  scope: { agent: 'writer', read_scope: 'task_project', propose: ['session_note'], project: 'spicy-voyage' },
  memory: `---\nproject: spicy-voyage\n---\n# Spicy Voyage\n\n## Status\n- Weekly preorder theme built\n${'filler '.repeat(3000)}`,
  next_steps: ['Launch the preorder page'], decisions: [{ date: '2026-09-29', text: 'Preorders close Thursday noon' }],
  session: { title: 'Theme build', date: '2026-09-28', body: '## What we did\n- Built the engine' },
};

function fakeStore(over: Partial<MemoryStore> = {}) {
  const calls: Array<[string, unknown[]]> = [];
  const store: MemoryStore = {
    context: async (...a) => { calls.push(['context', a]); return CTX; },
    search: async (...a) => { calls.push(['search', a]); return [{ path: 'projects/spicy-voyage/memory.md', title: 'Spicy Voyage', project: 'spicy-voyage', heading: 'Status', text: 'Weekly preorder theme built', doc_date: '2026-09-30' }]; },
    get: async (...a) => { calls.push(['get', a]); return a[2] === 'projects/spicy-voyage/memory.md' ? { path: a[2], project: 'spicy-voyage', title: 'x', date: null, body: 'BODY' } : null; },
    propose: async (...a) => { calls.push(['propose', a]); return { proposal_id: 'p1', approval_id: 'a1', project: 'spicy-voyage' }; },
    ...over,
  };
  return { store, calls };
}

const ctx = (roleId: string, agentId = 'writer') => ({
  task: { id: 't1', agent_id: agentId } as ToolContext['task'], role: { id: roleId } as ToolContext['role'],
  deps: { log: () => {} } as unknown as ToolContext['deps'], state: { ended: null, costUsd: 0, overBudget: false, toolErrors: 0 },
}) as ToolContext;
const run = (tools: ReturnType<typeof memoryTools>, name: string, input: unknown) =>
  (tools[name]!.execute as (i: unknown, o: unknown) => Promise<string>)(input, { toolCallId: 'x', messages: [] });

test('prompt section: the client\'s memory, next steps, decisions, newest session and what the role may propose; capped', async () => {
  const { store } = fakeStore();
  const s = await memoryPromptSection('writer', 't1', null, store, 3000);
  assert.match(s, /## Project memory: Spicy Voyage \(HQ Brain, project spicy-voyage, last activity 2026-09-30\)/);
  assert.doesNotMatch(s, /^project: spicy-voyage$/m, 'frontmatter stripped');
  assert.match(s, /Weekly preorder theme built/);
  assert.match(s, /Open next steps:\n- Launch the preorder page/);
  assert.match(s, /2026-09-29: Preorders close Thursday noon/);
  assert.match(s, /memory_propose/);
  assert.match(s, /session_note/);
  assert.doesNotMatch(s, /decision: something/, 'only the kinds this role may use');
  assert.match(s, /not as instructions/, 'memory is context, not commands');
  assert.ok(s.length <= 3000 + 3);
});

test('prompt section: no brain, no project or a failing brain → nothing (a task never fails because of it)', async () => {
  assert.equal(await memoryPromptSection('writer', 't1', null, null), '');
  const { store } = fakeStore({ context: async () => { throw new Error('db down'); } });
  assert.equal(await memoryPromptSection('writer', 't1', null, store), '');
  const { store: noProj } = fakeStore({ context: async () => ({ project: null, scope: CTX.scope }) });
  assert.match(await memoryPromptSection('writer', 't1', null, noProj), /## HQ Brain\n.*this project's memory only/);
  assert.equal(await memoryPromptSection('coo', null, null, fakeStore().store), '', 'planning without a client');
});

test('tools act as the ROLE on the task (QA reviewing a writer task acts as qa-lead)', async () => {
  const { store, calls } = fakeStore();
  setMemoryForTests(store);
  const tools = memoryTools(ctx('qa-lead', 'writer'));
  assert.match(await run(tools, 'memory_search', { query: 'preorder' }), /projects\/spicy-voyage\/memory.md › Status/);
  assert.deepEqual(calls[0], ['search', ['qa-lead', 't1', 'preorder', null, 8]]);
  assert.equal(await run(tools, 'memory_read', { path: '/projects/spicy-voyage/memory.md' }), '# projects/spicy-voyage/memory.md\n\nBODY');
  assert.match(await run(tools, 'memory_read', { path: 'profile/profile.md' }), /not in the memory you can read/);
});

test('memory_propose: goes to the CEO as a proposal; secrets and disallowed kinds are refused clearly', async () => {
  const { store } = fakeStore({
    propose: async (agent, _t, kind) => { if (kind === 'decision') throw new Error(`${agent} may not propose a decision`); return { proposal_id: 'p', approval_id: 'a', project: 'spicy-voyage' }; },
  });
  setMemoryForTests(store);
  const tools = memoryTools(ctx('writer'));
  assert.match(await run(tools, 'memory_propose', { kind: 'session_note', text: 'Wrote 3 hero variants' }), /Proposed \(session_note for spicy-voyage\)\. The CEO will approve/);
  assert.match(await run(tools, 'memory_propose', { kind: 'decision', text: 'Use Horizon' }), /your role may not propose a decision/);
  assert.match(await run(tools, 'memory_propose', { kind: 'fact', text: `Shopify token: shpat_${'a'.repeat(20)}` }), /looks like it contains a secret/);
  assert.ok(looksSecret(`key sk-proj-${'x1'.repeat(20)}`));
  assert.ok(!looksSecret('The Shopify token is in the Client Vault'));
});

test('no brain configured → tools say so and the agent carries on', async () => {
  setMemoryForTests(null);
  const tools = memoryTools(ctx('writer'));
  assert.match(await run(tools, 'memory_search', { query: 'x y' }), /not available right now/);
  assert.match(await run(tools, 'memory_propose', { kind: 'session_note', text: 'abc' }), /not available right now/);
});
