import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWall, CURSOR_SPOTS, replayStep, screenApp } from './wallView';
import type { HqSnapshot } from './data/types';

const agent = (id: string, status: string, p: Record<string, unknown> = {}) => ({
  id, name: id === 'web-dev' ? 'Web Developer' : 'Content Writer', department: 'dev', model_role: 'dev', status, current_task_id: null,
  idle_activity: status === 'idle' ? 'coffee' : null, idle_since: null, avatar: null, enabled: true, updated_at: '2026-10-15T00:00:00Z', ...p,
});

function snap(): HqSnapshot {
  return {
    clients: [{ id: 'c1', name: 'Madam Muse', slug: 'madam-muse' }],
    agents: [agent('writer', 'idle'), agent('web-dev', 'working', { current_task_id: 't1' })] as unknown as HqSnapshot['agents'],
    screens: [{ agent_id: 'web-dev', task_id: 't1', app: 'editor', title: 'hero.liquid', content: 'a\nb', image_url: null, step_note: 'Writing the hero section', progress: 40, updated_at: '2026-10-15T00:05:00Z' }],
    approvals: [], requests: [],
    tasks: [{ id: 't1', request_id: 'r1', client_id: 'c1', agent_id: 'web-dev', title: 'Bundle hero', work_type: 'shopify-section', status: 'working' }] as unknown as HqSnapshot['tasks'],
    activity: [
      { id: 2, actor: 'web-dev', action: 'usage.task', request_id: null, task_id: 't1', client_id: null, detail: {}, cost_usd: 0.01, created_at: '2026-10-15T00:04:00Z' },
      { id: 1, actor: 'web-dev', action: 'task.submitted', request_id: null, task_id: 't1', client_id: null, detail: {}, cost_usd: 0, created_at: '2026-10-15T00:03:00Z' },
    ],
    qaReviews: [], loadedAt: '2026-10-15T00:05:00Z',
  };
}

test('wall: working agents first with their screen, client and steps (usage rows hidden); idle agents show their break', () => {
  const tiles = buildWall({ snap: snap(), operator: null });
  assert.deepEqual(tiles.map((t) => t.id), ['agent:web-dev', 'agent:writer']);
  const dev = tiles[0]!;
  assert.equal(dev.app, 'editor');
  assert.equal(dev.project, 'Madam Muse');
  assert.equal(dev.note, 'Writing the hero section');
  assert.equal(dev.progress, 40);
  assert.deepEqual(dev.steps.map((s) => s.text), ['Writing the hero section', 'Web Developer sent Bundle hero to QA']);
  assert.equal(tiles[1]!.app, 'idle');
  assert.equal(tiles[1]!.note, 'On a coffee break');
});

test('wall: an operator camera per client; offline when the heartbeat is old; recent browser steps show the chat', () => {
  const now = new Date().toISOString();
  const op = { clients: [{ slug: 'lvlup', name: 'LvlUp Ventures', profile: 'lvlup', paused: false, enabled: true, viewer_url: 'https://ws.example/', brain_project: null }],
    actions: [{ id: 9, created_at: now, client_slug: 'lvlup', inbox_id: null, actor: 'operator' as const, action: 'browser.typed', ok: true, detail: { chars: 12 } }] };
  const live = buildWall({ snap: snap(), operator: { ...op, online: true } }).find((t) => t.kind === 'operator')!;
  assert.equal(live.state, 'working');
  assert.equal(live.app, 'chat');
  assert.equal(live.cam, 3, 'after the two agents');
  assert.equal(live.viewerUrl, 'https://ws.example/');
  assert.equal(buildWall({ snap: snap(), operator: { ...op, online: false } }).find((t) => t.kind === 'operator')!.state, 'offline');
});

test('apps, cursor spots and replay', () => {
  assert.equal(screenApp('leads'), 'sheet');
  assert.equal(screenApp(''), 'idle');
  assert.equal(screenApp('something-new'), 'browser');
  for (const [app, spots] of Object.entries(CURSOR_SPOTS)) {
    for (const s of spots) assert.ok(s.x >= 0 && s.x <= 100 && s.y >= 0 && s.y <= 100 && s.box.x + s.box.w <= 100 && s.box.y + s.box.h <= 100, app);
  }
  const steps = [{ at: 'b', text: 'newest' }, { at: 'a', text: 'older' }];
  assert.equal(replayStep(steps, 0)!.text, 'newest');
  assert.equal(replayStep(steps, 9)!.text, 'older');
  assert.equal(replayStep([], 0), null);
});
