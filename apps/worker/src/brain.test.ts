import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrainAccessError, createBrain } from './brain';
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
