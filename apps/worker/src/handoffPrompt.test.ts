// Design→dev handoff wired into the task prompt of BOTH runtimes (built-in runner and Hermes): a web-dev task that
// depends on a finished designer task gets the design spec + asset links/files; a task without dependencies is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildRunPrompt, buildTaskPrompt, runTask } from './runner';
import { FakeHqDb } from './fakeHqDb';
import { makeDeps, mockModel, promptText, toolCalls } from './testing';
import { hermesInstructions } from './hermes/runner';
import { hermesStartupReport, type HermesAgentConfig } from './hermes/config';
import { completion, startMockHermes } from './hermes/testServer';

const SPEC = [
  '1. Colours: color.bg.surface #0B0A1F, color.text #FFFFFF',
  '2. Fonts: Inter 400/600',
  '5. Asset list: assets/hero.png 1440x800 PNG',
].join('\n');
const FIGMA = 'https://figma.com/file/bundle-mockup';

function fixture() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-handoff-prompt-'));
  const db = new FakeHqDb(['designer', 'web-dev']);
  const design = db.addTask({ agent_id: 'designer', work_type: 'ui-mockup', title: 'Bundle page mockup', status: 'done',
    output: { summary: 'Mobile-first mockup', content: SPEC, files: ['assets/hero.png'], links: [FIGMA], preview_url: null } });
  fs.mkdirSync(path.join(ws, design.id, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(ws, design.id, 'assets', 'hero.png'), 'png-bytes');
  const dev = db.addTask({ agent_id: 'web-dev', work_type: 'shopify-section', title: 'Bundle builder section', status: 'working',
    depends_on: [design.id] });
  db.agents.get('web-dev')!.current_task_id = dev.id;
  return { ws, db, design, dev: { ...dev } };
}

const submit = toolCalls([{ name: 'submit_output', input: { summary: 'Section built', content: 'sections/bundle.liquid' } }]);

test('buildRunPrompt: web-dev task depending on a finished design task gets the spec, asset links and copied files', async () => {
  const { ws, db, design, dev } = fixture();
  const deps = makeDeps({ db, model: mockModel([]) });
  const p = await buildRunPrompt(dev, null, deps, { workspacesDir: ws });
  assert.ok(p.startsWith(buildTaskPrompt(dev, null, deps)), 'the handoff is appended to the normal task prompt');
  assert.match(p, /### Design spec: Bundle page mockup \(Graphic Designer · ui-mockup/);
  assert.ok(p.includes(SPEC), 'spec verbatim');
  assert.ok(p.includes(`- ${FIGMA}`), 'asset link');
  assert.ok(p.includes(`upstream/${design.id}/assets/hero.png`) && p.includes(`upstream/${design.id}/design-spec.md`));
  assert.equal(fs.readFileSync(path.join(ws, dev.id, 'upstream', design.id, 'assets', 'hero.png'), 'utf8'), 'png-bytes');
});

test('buildRunPrompt: tasks without dependencies get exactly buildTaskPrompt()', async () => {
  const db = new FakeHqDb(['designer', 'web-dev']);
  const deps = makeDeps({ db, model: mockModel([]) });
  for (const t of [
    db.addTask({ agent_id: 'web-dev', work_type: 'shopify-section', status: 'working' }),
    db.addTask({ agent_id: 'designer', work_type: 'ui-mockup', status: 'working', depends_on: [] }),
  ]) {
    assert.equal(await buildRunPrompt(t, null, deps, { workspacesDir: null }), buildTaskPrompt(t, null, deps));
  }
});

test('built-in runner: the web-dev prompt carries the upstream design spec + assets', async () => {
  const { ws, db, design, dev } = fixture();
  const model = mockModel([submit]);
  const deps = makeDeps({ db, model });
  // Hermes not configured → the built-in runner (fallback) builds the prompt.
  const r = await runTask(dev, deps, { heartbeatMs: 5, handoff: { workspacesDir: ws }, hermes: { resolve: () => null, fallback: true } });
  assert.equal(r.status, 'submitted');
  const text = promptText(model.doGenerateCalls[0]!);
  assert.ok(text.includes('Colours: color.bg.surface #0B0A1F'), 'spec in the prompt');
  assert.ok(text.includes(FIGMA));
  assert.ok(text.includes(`upstream/${design.id}/assets/hero.png`));
});

test('Hermes runner: the web-dev prompt carries the spec, assets and where to open the copied files', async () => {
  const { ws, db, design, dev } = fixture();
  const srv = await startMockHermes((r) => (r.path === '/health' ? [200, { status: 'ok' }]
    : [200, completion('```json\n{"summary":"Section built","content":"ok"}\n```')]));
  const cfg: HermesAgentConfig = { agentId: 'web-dev', url: srv.url, key: 'k', timeoutMs: 5_000, model: 'claude-sonnet-5' };
  const model = mockModel([]);
  try {
    const r = await runTask(dev, makeDeps({ db, model }), { heartbeatMs: 5, handoff: { workspacesDir: ws }, hermes: { resolve: () => cfg } });
    assert.equal(r.status, 'submitted');
    assert.equal(model.doGenerateCalls.length, 0, 'ran on Hermes');
    const chat = srv.seen.find((s) => s.path === '/v1/chat/completions')!;
    const user = (chat.body as { messages: { role: string; content: string }[] }).messages[1]!.content;
    assert.ok(user.includes(SPEC));
    assert.ok(user.includes(FIGMA));
    assert.ok(user.includes(`upstream/${design.id}/design-spec.md`));
    assert.match(user, /open them with the HQ workspace_fs tool/);
    assert.ok(user.indexOf('### Design spec') < user.indexOf('## Running on Hermes'), 'Hermes note stays last');
  } finally { await srv.close(); }
});

test('Hermes instructions: the workspace_fs note only appears when upstream files were copied', () => {
  assert.doesNotMatch(hermesInstructions({ id: 't' }), /workspace_fs/);
  assert.match(hermesInstructions({ id: 't' }, { upstreamFiles: true }), /HQ workspace_fs tool/);
});

test('Hermes usage: over_task_budget uses the stricter of the role budget and MAX_COST_PER_TASK_USD', async () => {
  const { db, dev } = fixture();
  const srv = await startMockHermes((r) => (r.path === '/health' ? [200, { status: 'ok' }]
    : [200, completion('```json\n{"summary":"ok"}\n```', { prompt_tokens: 10_000, completion_tokens: 2_000 })]));
  const cfg: HermesAgentConfig = { agentId: 'web-dev', url: srv.url, key: 'k', timeoutMs: 5_000, model: 'claude-sonnet-5' };
  try {
    await runTask(dev, makeDeps({ db, model: mockModel([]) }), {
      heartbeatMs: 5, handoff: { workspacesDir: null }, hermes: { resolve: () => cfg }, limits: { maxSteps: 25, maxCostUsd: 0.01 },
    });
    assert.equal(db.usage.length, 1);
    assert.equal(db.usage[0]!.detail.over_task_budget, 0.01, 'role budget is 1.50; the global cap 0.01 is stricter');
  } finally { await srv.close(); }
});

test('hermesStartupReport: configured / not configured agents and half-configured warnings', () => {
  const roles = [{ id: 'coo', runtime: 'worker' }, { id: 'web-dev', runtime: 'hermes' }, { id: 'writer', runtime: 'hermes' }, { id: 'sales', runtime: 'hermes' }];
  const none = hermesStartupReport(roles, {});
  assert.match(none.line, /on the built-in runner \(Hermes not configured\): web-dev, writer, sales/);
  assert.match(none.line, /HERMES_FALLBACK on/);
  assert.deepEqual(none.warnings, []);

  const env = {
    HERMES_URL_WEB_DEV: 'http://hermes-web-dev:8642', HERMES_KEY_WEB_DEV: 'k'.repeat(64), HQ_MCP_TOKEN_WEB_DEV: 't'.repeat(64), HERMES_MODEL: 'claude-sonnet-5',
    HERMES_URL_WRITER: 'http://hermes-writer:8642', HERMES_KEY_WRITER: 'k'.repeat(64), // no MCP token
    HERMES_URL_SALES: 'http://hermes-sales:8642', // no key
    HERMES_FALLBACK: 'off',
  };
  const r = hermesStartupReport(roles, env);
  assert.match(r.line, /on Hermes: web-dev, writer/);
  assert.match(r.line, /NOT RUNNABLE .*: sales/);
  assert.match(r.line, /HERMES_FALLBACK off/);
  assert.equal(r.warnings.length, 2);
  assert.match(r.warnings[0]!, /Hermes writer: HQ_MCP_TOKEN_WRITER missing/);
  assert.match(r.warnings[1]!, /Hermes sales: set both HERMES_URL_SALES and HERMES_KEY_SALES/);
  assert.ok(!r.warnings.join('\n').includes('k'.repeat(64)), 'no secrets in logs');
});
