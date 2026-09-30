import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMemory } from './memoryParse';

const MEMORY = `# HQ Brain

## Overview
- What it is: the shared memory.

## Links
- Vault repo: github.com/cracker17/claude-memory-vault (private)
- Target URLs: https://hq.rizehub.ph/brain (UI), https://hq.rizehub.ph/mcp/brain (connector)

## Status
- M0 done: local vault, SessionEnd hook.
- Supabase is NOT a blocker:
  HQ already has its own project.

## Decisions log
<!-- Claude appends dated lines here: - YYYY-MM-DD: decision -->
- 2026-09-30: Markdown in git is the source of truth; Supabase is a rebuildable index.
- 2026-09-30 — Embeddings = OpenAI text-embedding-3-small.
- An undated decision.

## Open next steps
<!-- Claude keeps this list current -->
- Decide: agent write permissions (M4).
- [x] Health check
- [ ] M1: VPS mirror
`;

test('memory.md sections become facts', () => {
  const m = parseMemory(MEMORY);
  assert.equal(m.status, 'M0 done: local vault, SessionEnd hook. · Supabase is NOT a blocker: HQ already has its own project.');
  assert.deepEqual(m.links[0], { label: 'Vault repo', value: 'github.com/cracker17/claude-memory-vault (private)' });
  assert.equal(m.links[1].label, 'Target URLs');
  assert.deepEqual(m.decisions, [
    { decided_on: '2026-09-30', text: 'Markdown in git is the source of truth; Supabase is a rebuildable index.' },
    { decided_on: '2026-09-30', text: 'Embeddings = OpenAI text-embedding-3-small.' },
    { decided_on: null, text: 'An undated decision.' },
  ]);
  assert.deepEqual(m.next_steps, [
    { text: 'Decide: agent write permissions (M4).', done: false },
    { text: 'Health check', done: true },
    { text: 'M1: VPS mirror', done: false },
  ]);
});

test('a memory.md without those sections parses to empties', () => {
  assert.deepEqual(parseMemory('# X\n\nJust text.'), { status: null, links: [], decisions: [], next_steps: [] });
});
