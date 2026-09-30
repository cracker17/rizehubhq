import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_NAV, NAV, NAV_GROUPS, PINNED_NAV, groupOf, openGroups } from './nav';

test('nav: every page appears exactly once; pinned + categories cover NAV and ADMIN_NAV', () => {
  const all = [...PINNED_NAV, ...NAV_GROUPS.flatMap((g) => g.items)].map((i) => i.href);
  assert.equal(new Set(all).size, all.length, 'no duplicate links');
  assert.deepEqual([...NAV, ...ADMIN_NAV].map((i) => i.href).sort(), [...all].sort());
  assert.ok(ADMIN_NAV.every((i) => i.description), 'admin hub cards need a description');
  assert.ok(ADMIN_NAV.some((i) => i.href === '/admin/api'));
});

test('groupOf: the category of the current page (sub-pages too); pinned pages and the hub have none', () => {
  assert.equal(groupOf('/tasks'), 'work');
  assert.equal(groupOf('/clients/acme'), 'sales');
  assert.equal(groupOf('/admin/connectors'), 'integrations');
  assert.equal(groupOf('/settings'), 'system');
  assert.equal(groupOf('/'), null);
  assert.equal(groupOf('/approvals'), null);
  assert.equal(groupOf('/admin'), null);
});

test('openGroups: saved choice wins, the active category is always open, first visit is compact', () => {
  assert.deepEqual(openGroups('/', null), [], 'nothing saved, on a pinned page: all collapsed');
  assert.deepEqual(openGroups('/leads', null), ['sales'], 'nothing saved: just the current page\'s category');
  assert.deepEqual(openGroups('/tasks', '[]'), ['work'], 'a saved choice never hides the current page');
  assert.deepEqual(openGroups('/', '["team","gone","sales"]'), ['sales', 'team'], 'unknown ids dropped, menu order kept');
  assert.deepEqual(openGroups('/costs', '{bad json'), ['team'], 'corrupt value: treated as nothing saved');
  assert.deepEqual(openGroups('/', JSON.stringify(NAV_GROUPS.map((g) => g.id))), NAV_GROUPS.map((g) => g.id));
});
