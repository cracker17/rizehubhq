import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrainAccessError, createBrain, loadWritingSamples, roleBrainContext, WRITING_SAMPLES_DIR } from './brain';
import { runIdleShuffle } from './idle';
import { FakeHqDb } from './fakeHqDb';

function tmpBrain() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-brain-'));
  const root = path.join(dir, 'brain');
  fs.mkdirSync(path.join(root, 'clients', 'madam-muse'), { recursive: true });
  fs.writeFileSync(path.join(root, 'clients', 'madam-muse', 'profile.md'), '# Madam Muse\nShopify lingerie store. Bundle builder.');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'not markdown');
  fs.writeFileSync(path.join(root, 'big.md'), 'x'.repeat(100_000));
  fs.writeFileSync(path.join(dir, 'secret.md'), 'TOP SECRET');
  fs.writeFileSync(path.join(dir, '.env'), 'KEY=1');
  fs.symlinkSync(path.join(dir, 'secret.md'), path.join(root, 'link.md'));
  return { dir, brain: createBrain(root) };
}

test('brain path traversal and escapes are blocked', () => {
  const { brain } = tmpBrain();
  for (const bad of ['../secret.md', 'brain/../../secret.md', 'clients/../../secret.md', '/etc/passwd', '../.env', 'link.md', 'notes.txt', '']) {
    assert.throws(() => brain.read(bad), BrainAccessError, bad);
    assert.equal(brain.tryRead(bad), null);
  }
  assert.throws(() => brain.read('clients/nobody/profile.md'), /does not exist/);
});

test('brain reads .md files (with or without brain/ prefix), caps size, and searches', () => {
  const { brain } = tmpBrain();
  assert.match(brain.read('clients/madam-muse/profile.md'), /lingerie/);
  assert.match(brain.read('brain/clients/madam-muse/profile.md'), /lingerie/);
  const big = brain.read('big.md');
  assert.ok(big.length < 70_000);
  assert.match(big, /\[truncated/);
  assert.ok(!brain.list().includes('link.md') || !brain.exists('link.md'));
  const hits = brain.search('bundle builder madam');
  assert.equal(hits[0]?.path, 'brain/clients/madam-muse/profile.md');
  assert.deepEqual(brain.search('zz'), []);
});

test('the real brain/ is readable', () => {
  const brain = createBrain();
  assert.match(brain.read('qa-checklists/_general.md'), /QA checklist/);
  assert.ok(brain.search('shopify section').length > 0);
});

test('idle shuffler writes activities only for idle agents', async () => {
  const db = new FakeHqDb(['a', 'b', 'c']);
  db.agents.get('c')!.status = 'working';
  const moved = await runIdleShuffle(db, Date.now(), () => 0);
  assert.equal(moved, 2);
  assert.equal(db.agents.get('c')!.idle_activity, null);
  assert.ok(db.agents.get('a')!.idle_activity);
});

test('writer: writing samples (.md/.txt, README excluded) are loaded in name order, capped per file and in total', () => {
  const { dir, brain } = tmpBrain();
  const samples = path.join(brain.root, ...WRITING_SAMPLES_DIR.split('/'));
  fs.mkdirSync(samples, { recursive: true });
  fs.writeFileSync(path.join(samples, 'README.md'), 'Drop 3-5 samples here');
  fs.writeFileSync(path.join(samples, '02-newsletter.txt'), 'Short and punchy. Then a longer sentence that wanders a little before it lands.');
  fs.writeFileSync(path.join(samples, '01-blog.md'), '# Speed matters\nYour store is slow. Here is why.');
  fs.writeFileSync(path.join(samples, '03-long.md'), 'y'.repeat(9000));
  fs.writeFileSync(path.join(samples, 'image.png'), 'not text');
  fs.symlinkSync(path.join(dir, 'secret.md'), path.join(samples, '00-link.md'));

  const got = loadWritingSamples(brain);
  assert.deepEqual(got.map((s) => s.path.split('/').pop()), ['01-blog.md', '02-newsletter.txt', '03-long.md'], 'README, non-text files and symlinks skipped');
  assert.equal(got[2]!.text.length, 6000);
  assert.equal(got[2]!.truncated, true);
  assert.equal(loadWritingSamples(brain, { maxTotalChars: 60 }).reduce((n, s) => n + s.text.length, 0) <= 60, true, 'total cap');
  assert.equal(loadWritingSamples(brain, { maxFiles: 1 }).length, 1);

  const ctx = roleBrainContext(brain, 'writer');
  assert.match(ctx, /## Writing samples \(read before drafting/);
  assert.match(ctx, /### brain\/style\/writing-samples\/01-blog\.md\n# Speed matters/);
  assert.match(ctx, /03-long\.md \(excerpt\)/);
  assert.doesNotMatch(ctx, /TOP SECRET|Drop 3-5 samples/);
  assert.equal(roleBrainContext(brain, 'web-dev'), '', 'other roles get nothing extra');
});

test('writer: no samples yet → a short note pointing at brand-voice.md', () => {
  const { brain } = tmpBrain();
  assert.deepEqual(loadWritingSamples(brain), []);
  assert.match(roleBrainContext(brain, 'writer'), /No samples in brain\/style\/writing-samples\/ yet/);
  assert.ok(fs.existsSync(path.join(createBrain().root, WRITING_SAMPLES_DIR, 'README.md')), 'the repo ships the drop-folder README');
});
