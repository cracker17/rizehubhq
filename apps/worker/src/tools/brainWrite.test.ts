import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { brainWriteTarget } from './brainWrite';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-'));

test('only brain/clients/<slug>/<name>.md is writable', () => {
  assert.equal(brainWriteTarget(root, 'brain/clients/madam-muse/profile.md'), path.join(root, 'clients/madam-muse/profile.md'));
  assert.equal(brainWriteTarget(root, 'clients/acme/brand.md'), path.join(root, 'clients/acme/brand.md'));
  for (const bad of ['brain/company/pricing.md', 'brain/clients/../company/x.md', 'brain/clients/a/b/c.md', '/etc/passwd',
    'brain/clients/Acme/profile.md', 'brain/clients/acme/profile.txt', 'brain/sops/seo-article.md']) {
    assert.throws(() => brainWriteTarget(root, bad), Error, bad);
  }
});

test('symlinked client folders are refused', () => {
  fs.mkdirSync(path.join(root, 'clients'), { recursive: true });
  fs.symlinkSync(os.tmpdir(), path.join(root, 'clients', 'evil'));
  assert.throws(() => brainWriteTarget(root, 'brain/clients/evil/profile.md'), /symlink/);
});
