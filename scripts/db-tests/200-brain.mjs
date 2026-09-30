// HQ Brain index (supabase/migrations/20260930010000_brain_index.sql, docs/16-BRAIN.md): only the brain service (service
// role) writes; the CEO reads through RLS and the CEO API; anon and other signed-in users see nothing. Search is hybrid
// (keyword + pgvector, reciprocal-rank fused), and re-indexing an edited document keeps the embeddings of unchanged chunks.
export default async function ({ db, step, val, as, assert }) {
  const CEO = '11111111-1111-1111-1111-111111111111';
  const OTHER = '22222222-2222-2222-2222-222222222222';
  const nowSec = () => Math.floor(Date.now() / 1000);
  async function asJwt(role, claims, fn) {
    await db.exec(`set role ${role}`);
    await db.query(`select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claims', $2, false)`,
      [claims.sub ?? '', JSON.stringify({ role, ...claims })]);
    try { await fn(); } finally {
      await db.exec(`reset role; select set_config('request.jwt.claim.sub','',false); select set_config('request.jwt.claims','',false);`);
    }
  }
  const ceo = { sub: CEO, aal: 'aal2', amr: [{ method: 'totp', timestamp: nowSec() - 5 }] };
  const service = { role: 'service_role' };
  const j = (v) => JSON.stringify(v);
  // Unit vector along one axis, pgvector text form.
  const axis = (i) => `[${Array.from({ length: 1536 }, (_, k) => (k === i ? 1 : 0)).join(',')}]`;
  const upsert = (doc, chunks, decisions = [], steps = []) =>
    val(`select brain_upsert_document($1::jsonb, $2::jsonb, $3::jsonb, $4::jsonb)`, [j(doc), j(chunks), j(decisions), j(steps)]);
  const doc = (path, extra = {}) => ({ path, project_slug: 'hq-brain', kind: 'memory', title: 'HQ Brain', doc_date: '2026-09-30',
    frontmatter: { project: 'hq-brain' }, body: 'body', content_sha: 'sha-1', git_sha: 'abc123', ...extra });

  await step('brain: the service indexes projects, a document, its chunks, decisions and next steps', () => asJwt('service_role', service, async () => {
    assert.equal(await val(`select brain_sync_projects($1::jsonb)`, [j([
      { slug: 'hq-brain', name: 'HQ Brain', aliases: ['the brain'], paths: [], status: 'M1 in build', links: [{ label: 'Repo', url: 'https://github.com/cracker17/rizehubhq' }] },
      { slug: 'powerg-solar', name: 'PowerG Solar', aliases: ['powerg'] },
    ])]), 2);
    const r = await upsert(doc('projects/hq-brain/memory.md'), [
      { heading: 'Status', text: 'VPS reaches the vault repo with an SSH deploy key', text_sha: 't1' },
      { heading: 'Decisions log', text: 'Embeddings use OpenAI text-embedding-3-small', text_sha: 't2' },
    ], [{ decided_on: '2026-09-30', text: 'Backup to Cloudflare R2' }], [{ text: 'Build M1', done: false }, { text: 'Health check', done: true }]);
    assert.equal(r.new, true);
    assert.equal(r.chunks, 2);
    assert.equal(r.needs_embedding, 2);
    await upsert(doc('projects/powerg-solar/memory.md', { project_slug: 'powerg-solar', title: 'PowerG', doc_date: '2026-09-28', content_sha: 'p1' }),
      [{ heading: 'Deploy', text: 'Hostinger Git auto-deploy from cracker17/powergsolar', text_sha: 'p1c' }]);
    await db.query(`select brain_refresh_projects()`);
    assert.deepEqual(await val(`select brain_document_manifest()`), { 'projects/hq-brain/memory.md': 'sha-1', 'projects/powerg-solar/memory.md': 'p1' });
    assert.equal(await val(`select doc_count from brain_projects where slug = 'hq-brain'`), 1);
    assert.equal(String(await val(`select last_activity::text from brain_projects where slug = 'powerg-solar'`)), '2026-09-28');
  }));

  await step('brain: embeddings are stored, and an edit keeps the vectors of unchanged chunks', () => asJwt('service_role', service, async () => {
    const missing = await val(`select brain_chunks_missing_embedding(10)`);
    assert.equal(missing.length, 3);
    const byText = Object.fromEntries(missing.map((c) => [c.text, c.id]));
    const items = [
      { id: byText['VPS reaches the vault repo with an SSH deploy key'], embedding: axis(0) },
      { id: byText['Embeddings use OpenAI text-embedding-3-small'], embedding: axis(1) },
      { id: byText['Hostinger Git auto-deploy from cracker17/powergsolar'], embedding: axis(2) },
    ];
    assert.equal(await val(`select brain_set_embeddings($1::jsonb)`, [j(items)]), 3);
    // Edit: chunk t1 unchanged, t2 replaced by t3 → only one chunk needs a new vector.
    const r = await upsert(doc('projects/hq-brain/memory.md', { content_sha: 'sha-2' }), [
      { heading: 'Status', text: 'VPS reaches the vault repo with an SSH deploy key', text_sha: 't1' },
      { heading: 'Decisions log', text: 'Off-site backup goes to Cloudflare R2 nightly', text_sha: 't3' },
    ]);
    assert.equal(r.new, false);
    assert.equal(r.needs_embedding, 1);
    assert.equal(await val(`select count(*)::int from brain_decisions where project_slug = 'hq-brain'`), 0, 'decisions replaced');
  }));

  await step('brain: hybrid search (keyword, semantic, fused; project and kind filters)', () => asJwt('service_role', service, async () => {
    const kw = await val(`select brain_search('deploy key', null, null, null, 5)`);
    assert.equal(kw[0].path, 'projects/hq-brain/memory.md');
    assert.deepEqual(kw[0].via, ['keyword']);
    const any = await val(`select brain_search('hostinger backup', null, null, null, 5)`);
    assert.deepEqual(new Set(any.map((h) => h.project)), new Set(['hq-brain', 'powerg-solar']), 'any-term fallback finds both');
    const sem = await val(`select brain_search('zzzz nothing matches', $1, null, null, 5)`, [axis(2)]);
    assert.equal(sem[0].project, 'powerg-solar');
    assert.deepEqual(sem[0].via, ['semantic']);
    const both = await val(`select brain_search('deploy', $1, null, null, 5)`, [axis(0)]);
    assert.deepEqual(both[0].via, ['keyword', 'semantic']);
    assert.equal(both[0].heading, 'Status');
    assert.equal((await val(`select brain_search('deploy', null, 'powerg-solar', null, 5)`)).every((h) => h.project === 'powerg-solar'), true);
    assert.deepEqual(await val(`select brain_search('deploy', null, null, '["session"]'::jsonb, 5)`), []);
    assert.deepEqual(await val(`select brain_search('', null, null, null, 5)`), []);
  }));

  await step('brain: the CEO reads the index, the bundle and events; cannot write', async () => {
    await asJwt('service_role', service, async () => {
      await db.query(`select brain_log_event('brain-service', 'indexed', 'hq-brain', 'projects/hq-brain/memory.md', '2 chunks', '{}'::jsonb)`);
      await db.query(`select brain_set_sync_state('{"status":"ok","head_sha":"abc123","branch":"main","last_index_at":"2026-09-30T05:00:00Z"}'::jsonb)`);
    });
    await asJwt('authenticated', ceo, async () => {
      assert.equal(await val(`select count(*)::int from brain_documents`), 2);
      const b = await val(`select brain_project_bundle('hq-brain', 2)`);
      assert.equal(b.project.status, 'M1 in build');
      assert.equal(b.memory.path, 'projects/hq-brain/memory.md');
      assert.deepEqual(b.next_steps, []);
      assert.equal((await val(`select brain_list_projects()`)).length, 2);
      assert.equal((await val(`select brain_recent_events(10)`))[0].action, 'indexed');
      const h = await val(`select brain_health()`);
      assert.deepEqual([h.status, h.documents, h.chunks, h.embedded], ['ok', 2, 3, 2]);
      assert.equal((await val(`select brain_get_document('projects/powerg-solar/memory.md')`)).title, 'PowerG');
      assert.equal(await val(`select brain_project_bundle('nope', 2)`), null);
      await assert.rejects(db.query(`insert into brain_events (actor, action) values ('ceo', 'x')`), /permission denied/);
      await assert.rejects(db.query(`update brain_documents set body = 'x'`), /permission denied/);
      await assert.rejects(db.query(`select brain_reset_index()`), /permission denied/);
      await assert.rejects(db.query(`select brain_upsert_document('{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)`), /permission denied/);
    });
  });

  await step('brain: other signed-in users and anon see nothing and call nothing', async () => {
    await asJwt('authenticated', { sub: OTHER }, async () => {
      assert.equal(await val(`select count(*)::int from brain_documents`), 0);
      assert.equal(await val(`select count(*)::int from brain_chunks`), 0);
      await assert.rejects(db.query(`select brain_search('deploy')`), /not allowed/);
      await assert.rejects(db.query(`select brain_project_bundle('hq-brain')`), /not allowed/);
    });
    await as('anon', null, async () => {
      await assert.rejects(db.query(`select count(*) from brain_documents`), /permission denied/);
      await assert.rejects(db.query(`select brain_search('deploy')`), /permission denied/);
      await assert.rejects(db.query(`select brain_log_event('x', 'y')`), /permission denied/);
    });
  });

  await step('brain: delete, model change and rebuild', () => asJwt('service_role', service, async () => {
    assert.equal(await val(`select brain_delete_documents('["projects/powerg-solar/memory.md"]'::jsonb)`), 1);
    assert.equal(await val(`select count(*)::int from brain_chunks c join brain_documents d on d.id = c.doc_id where d.project_slug = 'powerg-solar'`), 0);
    assert.equal(await val(`select brain_clear_embeddings()`), 1);
    assert.equal(await val(`select brain_sync_projects('[{"slug":"hq-brain","name":"HQ Brain"}]'::jsonb)`), 1);
    assert.equal(await val(`select listed from brain_projects where slug = 'powerg-solar'`), false);
    assert.equal(await val(`select brain_reset_index()`), 1);
    assert.equal(await val(`select count(*)::int from brain_chunks`), 0);
  }));
}
