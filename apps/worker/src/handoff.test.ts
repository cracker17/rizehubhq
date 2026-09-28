import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBrain, WRITING_SAMPLES_DIR } from './brain';
import { FakeHqDb } from './fakeHqDb';
import { copyUpstreamFiles, HANDOFF_LIMITS, isDesignHandoff, taskHandoffContext, upstreamContext } from './handoff';

const SPEC = [
  '1. Colours: color.bg.surface #0B0A1F, color.text #FFFFFF (15.9:1)',
  '2. Fonts: Inter 400/600; 375: 16/24, 1440: 18/28',
  '3. Spacing: base 8, section 64/96',
  '4. Layout notes: hero stacks on mobile; CTA sticky',
  '5. Asset list: assets/hero.png 1440x800 PNG alt "Bundle hero"',
].join('\n');

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-handoff-'));
  const ws = path.join(dir, 'workspaces');
  fs.mkdirSync(ws);
  return { dir, ws };
}

function fixture() {
  const db = new FakeHqDb(['designer', 'web-dev', 'writer']);
  const copy = db.addTask({ agent_id: 'writer', work_type: 'landing-copy', title: 'Bundle page copy', status: 'done',
    output: { summary: 'Hero + 3 sections', content: 'H1: Build your bundle', files: [], links: [] } });
  const design = db.addTask({ agent_id: 'designer', work_type: 'ui-mockup', title: 'Bundle page mockup', status: 'done', depends_on: [copy.id],
    output: { summary: 'Mobile-first mockup', content: SPEC, files: ['assets/hero.png', 'mockup/index.html', '../escape.txt', '.env', 'missing.png'], links: ['https://figma.com/x'], preview_url: null } });
  const dev = db.addTask({ agent_id: 'web-dev', work_type: 'shopify-section', title: 'Bundle builder section', status: 'queued', depends_on: [copy.id, design.id] });
  return { db, copy, design, dev };
}

test('isDesignHandoff: only designer layout/brand work types feed developers', () => {
  assert.equal(isDesignHandoff({ agent_id: 'designer', work_type: 'ui-mockup' }), true);
  assert.equal(isDesignHandoff({ agent_id: 'designer', work_type: 'wireframe' }), true);
  assert.equal(isDesignHandoff({ agent_id: 'designer', work_type: 'ad-creative' }), false);
  assert.equal(isDesignHandoff({ agent_id: 'writer', work_type: 'ui-mockup' }), false);
});

test('upstreamContext: no dependencies → empty string (the prompt is unchanged)', async () => {
  const db = new FakeHqDb(['web-dev']);
  const t = db.addTask({ agent_id: 'web-dev', work_type: 'shopify-section' });
  assert.equal(await upstreamContext(db, t, { workspacesDir: null }), '');
  assert.equal(await upstreamContext(db, { id: t.id }, { workspacesDir: null }), '', 'depends_on read from the DB when not on the row');
});

test('upstreamContext: the design spec comes first, verbatim, with a build-to-spec rule; other outputs follow', async () => {
  const { db, dev, design, copy } = fixture();
  const text = await upstreamContext(db, { id: dev.id }, { workspacesDir: null }); // depends_on fetched via getTask
  assert.match(text, /^## Inputs from the tasks this one depends on \(approved: QA passed \+ CEO approved\)/);
  assert.ok(text.indexOf('### Design spec: Bundle page mockup') < text.indexOf('### Bundle page copy'), 'design first');
  assert.ok(text.includes(SPEC), 'spec verbatim');
  assert.match(text, /Build exactly to this spec\. Do not redesign/);
  assert.match(text, /Links:\n- https:\/\/figma\.com\/x/);
  assert.match(text, new RegExp(`Files \\(in task ${design.id}'s workspace\\):\\n- assets/hero\\.png`));
  assert.match(text, /Deliverable:\nH1: Build your bundle/);
  assert.doesNotMatch(text, /not approved yet/);
  // a dependency that is somehow not done is flagged
  db.tasks.get(copy.id)!.status = 'awaiting_ceo';
  assert.match(await upstreamContext(db, dev, { workspacesDir: null }), /Status is "awaiting_ceo", not approved yet/);
});

test('upstreamContext: long specs and the whole section are capped', async () => {
  const { db, dev, design } = fixture();
  db.tasks.get(design.id)!.output = { summary: 's', content: 'z'.repeat(50_000), files: [] };
  const text = await upstreamContext(db, dev, { workspacesDir: null, limits: { specChars: 1000, totalChars: 3000 } });
  assert.match(text, /\[… truncated at 1000 characters\]/);
  assert.ok(text.length < 3100);
});

test('upstreamContext: design files + design-spec.md are copied into upstream/<design-id>/ of the dev workspace (jail rules apply)', async () => {
  const { dir, ws } = tmp();
  const { db, dev, design } = fixture();
  const src = path.join(ws, design.id);
  fs.mkdirSync(path.join(src, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(src, 'mockup'), { recursive: true });
  fs.writeFileSync(path.join(src, 'assets', 'hero.png'), 'PNG');
  fs.writeFileSync(path.join(src, 'mockup', 'index.html'), '<h1>Bundle</h1>');
  fs.writeFileSync(path.join(src, '.env'), 'SECRET=1');
  fs.writeFileSync(path.join(dir, 'escape.txt'), 'outside');

  const text = await upstreamContext(db, dev, { workspacesDir: ws });
  const dest = path.join(ws, dev.id, 'upstream', design.id);
  assert.equal(fs.readFileSync(path.join(dest, 'assets', 'hero.png'), 'utf8'), 'PNG');
  assert.equal(fs.readFileSync(path.join(dest, 'mockup', 'index.html'), 'utf8'), '<h1>Bundle</h1>');
  assert.equal(fs.readFileSync(path.join(dest, 'design-spec.md'), 'utf8'), `${SPEC}\n`, 'spec written from the submitted content');
  assert.equal(fs.existsSync(path.join(dest, '.env')), false);
  assert.equal(fs.existsSync(path.join(ws, dev.id, 'upstream', 'escape.txt')), false);
  assert.match(text, new RegExp(`Files copied into your workspace:\\n- upstream/${design.id}/design-spec\\.md\\n- upstream/${design.id}/assets/hero\\.png`));
  assert.match(text, /Not copied \(ask_ceo if you need them\):\n- \.\.\/escape\.txt: "\.\." is not allowed/);
  assert.match(text, /- \.env: .*secret/);
  assert.match(text, /- missing\.png: missing/);
});

test('copyUpstreamFiles: symlinks are refused and size caps hold', () => {
  const { dir, ws } = tmp();
  const src = path.join(ws, 'task-a');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'x');
  fs.symlinkSync(path.join(dir, 'secret.txt'), path.join(src, 'link.txt'));
  fs.writeFileSync(path.join(src, 'big.bin'), Buffer.alloc(2048));
  fs.writeFileSync(path.join(src, 'ok.txt'), 'ok');
  const r = copyUpstreamFiles(ws, 'task-a', 'task-b', ['link.txt', 'big.bin', 'ok.txt'], { ...HANDOFF_LIMITS, maxFileBytes: 1024 });
  assert.deepEqual(r.copied, ['upstream/task-a/ok.txt']);
  assert.match(r.skipped.join('\n'), /link\.txt: not a regular file/);
  assert.match(r.skipped.join('\n'), /big\.bin: larger than/);
  assert.deepEqual(copyUpstreamFiles(ws, 'task-missing', 'task-b', ['x'], HANDOFF_LIMITS).copied, []);
});

test('taskHandoffContext: dev gets the upstream section, writer gets its voice samples; failures never throw', async () => {
  const { dir } = tmp();
  const root = path.join(dir, 'brain');
  fs.mkdirSync(path.join(root, ...WRITING_SAMPLES_DIR.split('/')), { recursive: true });
  fs.writeFileSync(path.join(root, ...WRITING_SAMPLES_DIR.split('/'), '01-post.md'), 'I write short. Then I write long, winding sentences.');
  const brain = createBrain(root);
  const { db, dev } = fixture();

  const devCtx = await taskHandoffContext({ db, brain }, dev, { workspacesDir: null });
  assert.match(devCtx, /^\n\n## Inputs from the tasks this one depends on/);
  assert.doesNotMatch(devCtx, /Writing samples/);

  const w = db.addTask({ agent_id: 'writer', work_type: 'seo-article' });
  const wCtx = await taskHandoffContext({ db, brain }, w, { workspacesDir: null });
  assert.match(wCtx, /^\n\n## Writing samples \(read before drafting/);
  assert.match(wCtx, /I write short\./);

  const lone = db.addTask({ agent_id: 'sales', work_type: 'lead-report' });
  assert.equal(await taskHandoffContext({ db, brain }, lone, { workspacesDir: null }), '');

  const broken = { getTask: async () => { throw new Error('db down'); } };
  assert.match(await taskHandoffContext({ db: broken, brain }, { id: 'x', agent_id: 'web-dev' }), /Could not load them \(db down\)/);
});
