import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ago, coreNodes, dayAgo, describeEvent, isFeedEvent, nextStepLines, parseInline, parseMarkdown, platformOf, pulses, recency,
  slugPreview, sourceOf, spherePoints, suggestAliases, type BrainProject,
} from './brainView';

const P = (over: Partial<BrainProject>): BrainProject => ({
  slug: 'demo', name: 'Demo', aliases: [], status: null, listed: true, doc_count: 4, last_activity: null, sessions: 1, open_next_steps: 2, ...over,
});

test('platform comes from the name, aliases or status', () => {
  assert.equal(platformOf(P({ name: 'Spicy Voyage', aliases: ['spicy voyage shopify'] })), 'shopify');
  assert.equal(platformOf(P({ name: 'Madam Muse Horizon' })), 'shopify');
  assert.equal(platformOf(P({ name: 'Acme', status: '- Webflow rebuild live' })), 'webflow');
  assert.equal(platformOf(P({ name: 'Blog', aliases: ['woocommerce'] })), 'wordpress');
  assert.equal(platformOf(P({ name: 'HQ Brain' })), 'custom');
});

test('recency: today = 1, old or never = the floor', () => {
  const now = Date.parse('2026-09-30T12:00:00+08:00');
  assert.equal(recency('2026-09-30', now), 1);
  assert.ok(recency('2026-09-20', now) < 1 && recency('2026-09-20', now) > recency('2026-07-01', now));
  assert.equal(recency('2025-01-01', now), 0.15);
  assert.equal(recency(null, now), 0.15);
});

test('ago() reads like a person', () => {
  const now = Date.parse('2026-09-30T12:00:00Z');
  assert.equal(ago('2026-09-30T11:59:50Z', now), 'just now');
  assert.equal(ago('2026-09-30T11:30:00Z', now), '30 min ago');
  assert.equal(ago('2026-09-29T11:00:00Z', now), 'yesterday');
  assert.equal(ago(null, now), 'never');
  const pht = Date.parse('2026-09-30T22:00:00+08:00');
  assert.equal(dayAgo('2026-09-30', pht), 'today');
  assert.equal(dayAgo('2026-09-29', pht), 'yesterday');
  assert.equal(dayAgo('2026-09-20', pht), '10 days ago');
});

test('core nodes: stable, unlisted projects left out, size follows memory volume', () => {
  const ps = [P({ slug: 'a', doc_count: 1 }), P({ slug: 'b', doc_count: 16 }), P({ slug: 'c', listed: false })];
  const a = coreNodes(ps, 0);
  assert.deepEqual(a.map((n) => n.slug), ['a', 'b']);
  assert.ok(a[1]!.size > a[0]!.size);
  assert.deepEqual(coreNodes(ps, 0), a);
  assert.ok(a.every((n) => n.orbit > 1.2)); // outside the sphere
  const pts = spherePoints(200);
  assert.equal(pts.length, 200);
  assert.ok(pts.every(([x, y, z]) => Math.abs(Math.hypot(x, y, z) - 1) < 1e-9));
});

test('activity: sources, lines, feed filter, pulses', () => {
  assert.equal(sourceOf('claude:Claude Code (hq-brain)'), 'claude');
  assert.equal(sourceOf('github:cracker17'), 'pc');
  assert.equal(sourceOf('julev'), 'julev');
  assert.equal(sourceOf('agent:coo'), 'agent');
  const e = { id: 1, ts: '2026-09-30T13:00:00Z', actor: 'claude:Claude Code', action: 'saved', project_slug: 'hq-brain', path: 'projects/hq-brain/memory.md', summary: 'session saved: M3' };
  assert.equal(describeEvent(e), 'Claude Code: session saved: M3');
  assert.ok(pulses(e));
  assert.ok(!isFeedEvent({ ...e, action: 'tool_call' }));
  assert.ok(!pulses({ ...e, project_slug: null }));
  assert.equal(describeEvent({ ...e, action: 'blocked_secret', path: 'x.md' }), 'Kept out (looks like a secret): x.md');
});

test('markdown: frontmatter dropped, headings, checklists, tables, code, safe links only', () => {
  const md = `---\nproject: x\n---\n# Title\n\nSome **bold** and \`code\` text\ncontinued.\n\n## Steps\n- [x] done\n- open\n  - nested\n<!-- hidden -->\n| a | b |\n|---|---|\n| 1 | 2 |\n\n\`\`\`\nraw <b>\n\`\`\`\n> quoted\n---\nSee [site](https://ex.com) and [bad](javascript:alert(1)) or https://x.io/a.`;
  const b = parseMarkdown(md);
  assert.deepEqual(b.map((x) => x.t), ['h', 'p', 'h', 'list', 'table', 'code', 'quote', 'hr', 'p']);
  const list = b[3] as Extract<typeof b[number], { t: 'list' }>;
  assert.deepEqual(list.items.map((i) => [i.checked, i.depth]), [[true, 0], [null, 0], [null, 1]]);
  assert.equal((b[4] as { rows: unknown[] }).rows.length, 2);
  assert.equal((b[5] as { v: string }).v, 'raw <b>');
  const last = (b[8] as { text: ReturnType<typeof parseInline> }).text;
  const links = last.filter((i) => i.t === 'link');
  assert.deepEqual(links.map((l) => (l as { href: string }).href), ['https://ex.com', 'https://x.io/a']);
  assert.ok(last.some((i) => i.t === 'text' && i.v === 'bad'));
  assert.deepEqual(parseInline('**b** *e*').map((i) => i.t), ['bold', 'text', 'em']);
});

test('wizard helpers: next-step lines, slug, alias suggestions', () => {
  assert.deepEqual(nextStepLines([{ text: ' Build  UI ', done: false }, { text: 'Ship', done: true }, { text: ' ', done: false }]), ['Build UI', '[x] Ship']);
  assert.equal(slugPreview('Spicy Voyage — Shopify!'), 'spicy-voyage-shopify');
  const a = suggestAliases('Spicy Voyage Shopify', ['Site: https://www.spicyvoyage.com']);
  assert.ok(a.includes('spicy voyage shopify'));
  assert.ok(a.includes('spicyvoyage.com'));
  assert.ok(a.includes('spicy voyage'));
  assert.ok(!a.includes('shopify'));
});
