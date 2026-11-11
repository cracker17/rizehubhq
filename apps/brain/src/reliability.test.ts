// P0 reliability (2026-11-11): run outcome, lag alerts, and the indexer surviving a failing file / embedding batch.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lagAlertDue, runOutcome, LAG_ALERT_MS, LAG_REALERT_MS } from './service';
import { indexVault } from './index/indexer';
import type { Store } from './store/types';
import type { Embedder } from './index/embed';

const base = { blocked: [], failed: [], pendingEmbeddings: 0, embedError: null };

test('run outcome: ok, degraded on failures, pending embeddings, or a paused embed step', () => {
  assert.deepEqual(runOutcome(base, true), { status: 'ok', error: null });
  const f = runOutcome({ ...base, failed: [{ path: 'projects/a/sessions/x.md', error: 'statement timeout' }] }, true);
  assert.equal(f.status, 'degraded');
  assert.match(f.error ?? '', /1 file could not be indexed \(first: projects\/a\/sessions\/x\.md: statement timeout\)/);
  assert.equal(runOutcome({ ...base, embedError: 'timeout' }, true).status, 'degraded');
  assert.deepEqual(runOutcome({ ...base, pendingEmbeddings: 3 }, true), { status: 'degraded', error: null });
  assert.deepEqual(runOutcome(base, false), { status: 'degraded', error: null }); // keyword-only
});

test('lag alert: only when pulls moved on but no complete index for an hour, then every 6 h', () => {
  const now = new Date('2026-11-11T12:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  assert.equal(lagAlertDue(ago(10 * 60_000), ago(60_000), null, now), false, 'indexed 10 min ago');
  assert.equal(lagAlertDue(ago(2 * LAG_ALERT_MS), ago(3 * LAG_ALERT_MS), null, now), false, 'nothing pulled since the index');
  assert.equal(lagAlertDue(ago(2 * LAG_ALERT_MS), ago(60_000), null, now), true);
  assert.equal(lagAlertDue(null, ago(60_000), null, now), true, 'never indexed');
  assert.equal(lagAlertDue(ago(2 * LAG_ALERT_MS), ago(60_000), ago(60 * 60_000), now), false, 'alerted an hour ago');
  assert.equal(lagAlertDue(ago(2 * LAG_ALERT_MS), ago(60_000), ago(LAG_REALERT_MS), now), true);
  assert.equal(lagAlertDue(ago(2 * LAG_ALERT_MS), null, null, now), false, 'no pull yet');
});

/** Minimal in-memory store: enough rpc surface for indexVault, with switchable failures. */
function fakeStore(opts: { failPath?: string; failEmbedAbove?: number }) {
  const docs = new Map<string, string>();
  const chunks: Array<{ id: number; embedded: boolean }> = [];
  const events: string[] = [];
  let nextId = 1;
  const store: Store = {
    async rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
      const a = (args ?? {}) as Record<string, any>;
      switch (fn) {
        case 'brain_document_manifest': return Object.fromEntries(docs) as T;
        case 'brain_upsert_document':
          if (a.p_doc.path === opts.failPath) throw new Error('canceling statement due to statement timeout');
          docs.set(a.p_doc.path, a.p_doc.content_sha);
          for (const _ of a.p_chunks) chunks.push({ id: nextId++, embedded: false });
          return {} as T;
        case 'brain_chunks_missing_embedding':
          return chunks.filter((c) => !c.embedded).slice(0, a.p_limit).map((c) => ({ id: c.id, title: 't', heading: '', text: 'x' })) as T;
        case 'brain_set_embeddings':
          if (opts.failEmbedAbove && a.p_items.length > opts.failEmbedAbove) throw new Error('statement timeout');
          for (const it of a.p_items) { const c = chunks.find((x) => x.id === it.id); if (c) c.embedded = true; }
          return a.p_items.length as T;
        case 'brain_health': return { chunks: chunks.length, embedded: chunks.filter((c) => c.embedded).length, embed_model: 'fake:1' } as T;
        case 'brain_log_event': events.push(`${a.p_action}:${a.p_path ?? ''}`); return undefined as T;
        default: return undefined as T;
      }
    },
  };
  return { store, docs, chunks, events };
}

function tempVault(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-p0-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

const fakeEmbedder: Embedder = { model: 'fake:1', embed: async (texts: string[]) => texts.map(() => Array(1536).fill(0.01)) } as unknown as Embedder;

test('one failing file is skipped and recorded; the rest of the vault is indexed', async () => {
  const dir = tempVault({
    'projects/a/memory.md': '# A\n\n## Status\n- fine\n',
    'projects/b/sessions/2026-11-01-big.md': '# Big\n\nlots of text\n',
    'projects/c/memory.md': '# C\n\n## Status\n- fine\n',
  });
  const f = fakeStore({ failPath: 'projects/b/sessions/2026-11-01-big.md' });
  const r = await indexVault({ store: f.store, embedder: null, vaultDir: dir });
  assert.deepEqual(r.added.sort(), ['projects/a/memory.md', 'projects/c/memory.md']);
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].path, 'projects/b/sessions/2026-11-01-big.md');
  assert.ok(f.events.includes('index_failed:projects/b/sessions/2026-11-01-big.md'));
  assert.equal(f.docs.has('projects/b/sessions/2026-11-01-big.md'), false, 'retried next run');
});

test('a timing-out embedding batch is retried smaller instead of stopping the run', async () => {
  const body = Array.from({ length: 40 }, (_, i) => `## Part ${i}\n\n${'word '.repeat(60)}\n`).join('\n');
  const dir = tempVault({ 'projects/a/notes.md': `# Notes\n\n${body}` });
  const f = fakeStore({ failEmbedAbove: 8 });
  const r = await indexVault({ store: f.store, embedder: fakeEmbedder, vaultDir: dir, embedBatch: 32 });
  assert.ok(f.chunks.length > 8);
  assert.equal(r.embedded, f.chunks.length, 'everything embedded at the smaller size');
  assert.equal(r.embedError, null);
});

test('if even the smallest batch fails, embedding pauses for this run without throwing', async () => {
  const dir = tempVault({ 'projects/a/notes.md': '# Notes\n\n## One\n\nhello world\n\n## Two\n\nmore words here\n' });
  const f = fakeStore({ failEmbedAbove: 0.5 });
  const r = await indexVault({ store: f.store, embedder: fakeEmbedder, vaultDir: dir, embedBatch: 8 });
  assert.equal(r.embedded, 0);
  assert.match(r.embedError ?? '', /statement timeout/);
});
