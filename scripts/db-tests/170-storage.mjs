// M13.5 Storage (supabase/migrations/20260929080000_storage.sql): Google Drive / Dropbox connections are connectors of
// kind 'storage' stored only by the worker; the CEO picks the default (audited); the worker gets the default's sealed
// secret; a saved deliverable's links land on the task output and the pending deliverable card.
export default async function ({ db, step, val, as, assert }) {
  const CEO = '11111111-1111-1111-1111-111111111111';
  const OTHER = '22222222-2222-2222-2222-222222222222';
  const D1 = 'c0e00000-0000-0000-0000-00000000d001';
  const D2 = 'c0e00000-0000-0000-0000-00000000d002';
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
  const insert = (id, provider, name) => db.query(
    `select connector_insert($1, 'storage', $2, null, null, 'oauth', $3::jsonb, '\\x0a0b'::bytea, '\\x0c0d'::bytea, 1, '{}', $4)`,
    [id, name, JSON.stringify({ provider }), provider]);
  const defaultId = async () => {
    let id = null;
    await asJwt('service_role', service, async () => { id = await val(`select id from storage_default_connector()`); });
    return id;
  };

  await step('storage: the worker stores a storage connection; anon and the CEO cannot', async () => {
    await as('anon', null, async () => { await assert.rejects(insert(D1, 'drive', 'Google Drive'), /permission denied/); });
    await asJwt('authenticated', ceo, async () => { await assert.rejects(insert(D1, 'drive', 'Google Drive'), /permission denied/); });
    await asJwt('service_role', service, async () => { await insert(D1, 'drive', 'Google Drive'); });
    assert.equal(await val(`select kind from connectors where id = $1`, [D1]), 'storage');
    await assert.rejects(db.query(`insert into connectors (id, kind, name, auth_type) values (gen_random_uuid(), 'ftp', 'x', 'none')`), /check/);
  });

  await step('storage: with no default marked the oldest active connection is used; the CEO never reads the secret', async () => {
    await asJwt('service_role', service, async () => { await insert(D2, 'dropbox', 'Dropbox'); });
    assert.equal(await defaultId(), D1);
    await asJwt('authenticated', ceo, async () => {
      await assert.rejects(db.query(`select * from storage_default_connector()`), /permission denied/);
      await assert.rejects(db.query(`select secret_cipher from connectors`), /permission denied/);
      assert.equal(await val(`select settings->>'provider' from connectors where id = $1`, [D2]), 'dropbox');
    });
  });

  await step('storage: only the CEO (or the worker) sets the default; one default at a time; audited', async () => {
    await as('anon', null, async () => { await assert.rejects(db.query(`select storage_set_default($1)`, [D2]), /permission denied/); });
    await asJwt('authenticated', { sub: OTHER }, async () => {
      await assert.rejects(db.query(`select storage_set_default($1)`, [D2]), /not allowed/);
    });
    await asJwt('authenticated', ceo, async () => { await db.query(`select storage_set_default($1)`, [D2]); });
    assert.equal(await defaultId(), D2);
    await asJwt('authenticated', ceo, async () => { await db.query(`select storage_set_default($1)`, [D1]); });
    assert.equal(await defaultId(), D1);
    assert.equal(await val(`select count(*)::int from connectors where kind = 'storage' and settings @> '{"default": true}'`), 1);
    assert.equal(await val(`select settings->>'provider' from connectors where id = $1`, [D1]), 'drive', 'provider kept');
    assert.equal(await val(`select count(*)::int from activity_log where action = 'storage.default_set' and actor = 'ceo'`), 2);
    const gmail = await val(`select id from connectors where kind <> 'storage' limit 1`);
    await asJwt('authenticated', ceo, async () => {
      await assert.rejects(db.query(`select storage_set_default(gen_random_uuid())`), /unknown storage/);
      if (gmail) await assert.rejects(db.query(`select storage_set_default($1)`, [gmail]), /unknown storage/);
    });
  });

  await step('storage: a disabled or broken default falls back to another active connection', async () => {
    await asJwt('service_role', service, async () => { await db.query(`select connector_mark($1, 'needs_reauth', 'refresh token revoked')`, [D1]); });
    assert.equal(await defaultId(), D2);
    await asJwt('service_role', service, async () => { await db.query(`select connector_rotate_secret($1, '\\x01'::bytea, '\\x02'::bytea, 1)`, [D1]); });
    assert.equal(await defaultId(), D1);
  });

  await step('storage: saved links are recorded on the task output and the pending deliverable card (worker only)', async () => {
    const req = await val(`insert into requests (source, raw_text, status) values ('dashboard', 'storage test', 'in_progress') returning id`);
    const task = await val(`insert into tasks (request_id, agent_id, title, instructions, work_type, acceptance_criteria, status, output)
                            values ($1, 'writer', 'Blog post', 'x', 'seo-article', '["a"]', 'awaiting_ceo', '{"summary":"s"}') returning id`, [req]);
    const ap = await val(`insert into approvals (kind, request_id, task_id, agent_id, title, payload)
                          values ('deliverable', $1, $2, 'writer', 'Blog post', '{"output":{"summary":"s"}}') returning id`, [req, task]);
    const saved = JSON.stringify({ provider: 'drive', folder_url: 'https://drive.google.com/drive/folders/f1', files: [{ name: 'Blog post.md', url: 'https://drive.google.com/file/d/x/view' }] });
    await asJwt('authenticated', ceo, async () => {
      await assert.rejects(db.query(`select task_record_storage($1, $2::jsonb)`, [task, saved]), /permission denied/);
    });
    await asJwt('service_role', service, async () => { await db.query(`select task_record_storage($1, $2::jsonb)`, [task, saved]); });
    assert.equal(await val(`select output->'storage'->>'provider' from tasks where id = $1`, [task]), 'drive');
    assert.equal(await val(`select output->>'summary' from tasks where id = $1`, [task]), 's', 'the rest of the output is kept');
    assert.equal(await val(`select payload->'output'->'storage'->>'folder_url' from approvals where id = $1`, [ap]), 'https://drive.google.com/drive/folders/f1');
  });

  await step('storage: removing a storage connection works like any connector', async () => {
    await asJwt('authenticated', ceo, async () => {
      await db.query(`select connector_delete($1)`, [D1]);
      await db.query(`select connector_delete($1)`, [D2]);
    });
    assert.equal(await defaultId() ?? null, null);
  });
}
