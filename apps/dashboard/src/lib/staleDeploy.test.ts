import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RELOAD_GAP_MS, isStaleDeployError, mayReload } from './staleDeploy';

test('isStaleDeployError: old-deployment Server Action and chunk errors, nothing else', () => {
  assert.equal(isStaleDeployError(new Error('Failed to find Server Action "00867764ad". This request might be from an older or newer deployment.')), true);
  assert.equal(isStaleDeployError(new Error('Server Action "4060ce3c" was not found on the server.')), true);
  const chunk = new Error('Loading chunk 812 failed.'); chunk.name = 'ChunkLoadError';
  assert.equal(isStaleDeployError(chunk), true);
  assert.equal(isStaleDeployError(new Error('Loading CSS chunk app-layout failed')), true);
  assert.equal(isStaleDeployError(new Error('Cannot read properties of undefined (reading "map")')), false);
  assert.equal(isStaleDeployError(null), false);
});

test('mayReload: at most once per gap so a real failure never loops', () => {
  assert.equal(mayReload(null, 1_000_000), true);
  assert.equal(mayReload(1_000_000, 1_000_000 + 5_000), false);
  assert.equal(mayReload(1_000_000, 1_000_000 + RELOAD_GAP_MS + 1), true);
});
