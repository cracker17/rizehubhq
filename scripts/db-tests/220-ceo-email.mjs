// "Email me updates" (supabase/migrations/20261009000000_ceo_email.sql): the settings row 'ceo_email' changes only
// through ceo_email_set() (validated, audited; a new address or turning it on needs a fresh 2FA code), enabled_at is
// stamped on turning on, the worker's pending list honours enabled_at / events / the log / retries and never includes
// action approvals or Vault 2FA questions, the log is service-only and the CEO reads it through ceo_email_recent().
export default async function ({ db, step, val, as, assert }) {
  const CEO = '11111111-1111-1111-1111-111111111111';
  const OTHER = '22222222-2222-2222-2222-222222222222';
  const GMAIL = 'aaaaaaaa-0000-4000-8000-00000000c0e1';
  const GMAIL_OFF = 'aaaaaaaa-0000-4000-8000-00000000c0e2';
  const nowSec = () => Math.floor(Date.now() / 1000);
  async function asJwt(role, claims, fn) {
    await db.exec(`set role ${role}`);
    await db.query(`select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claims', $2, false)`,
      [claims.sub ?? '', JSON.stringify({ role, ...claims })]);
    try { await fn(); } finally {
      await db.exec(`reset role; select set_config('request.jwt.claim.sub','',false); select set_config('request.jwt.claims','',false);`);
    }
  }
  const stale = { sub: CEO, aal: 'aal2', amr: [{ method: 'totp', timestamp: nowSec() - 3600 }] };
  const fresh = { sub: CEO, aal: 'aal2', amr: [{ method: 'totp', timestamp: nowSec() - 5 }] };
  const service = { role: 'service_role' };
  const set = (p) => val(`select ceo_email_set($1::jsonb)`, [JSON.stringify(p)]);
  const row = () => val(`select value from settings where key = 'ceo_email'`);
  const ON = { enabled: true, connector_id: GMAIL, to: 'CEO@Example.com', events: { results: true, questions: true, failures: true, plans: false } };

  await step('ceo email: fixtures (the CEO has a verified TOTP factor; two Gmail accounts, one off)', async () => {
    await db.exec(`create table if not exists auth.mfa_factors (id uuid primary key default gen_random_uuid(), user_id uuid not null, factor_type text not null, status text not null)`);
    if (!(await val(`select count(*)::int from auth.mfa_factors where user_id = $1 and status = 'verified'`, [CEO]))) {
      await db.query(`insert into auth.mfa_factors (user_id, factor_type, status) values ($1, 'totp', 'verified')`, [CEO]);
    }
    await db.query(`insert into connectors (id, kind, name, account_email, auth_type, status) values
      ($1, 'gmail', 'HQ mail', 'ceo-email-hq@gmail.com', 'app_password', 'active'),
      ($2, 'gmail', 'Old mail', 'ceo-email-old@gmail.com', 'app_password', 'disabled')`, [GMAIL, GMAIL_OFF]);
  });

  await step('ceo email: the CEO cannot write the ceo_email settings row directly (other rows still work)', async () => {
    await asJwt('authenticated', fresh, async () => {
      await assert.rejects(db.query(`insert into settings (key, value) values ('ceo_email', '{"enabled":true,"to":"x@evil.example"}')`), /row-level security/);
      await db.query(`insert into settings (key, value) values ('ceo_email_probe', '1') on conflict (key) do update set value = excluded.value`);
      await db.query(`delete from settings where key = 'ceo_email_probe'`);
    });
    await db.query(`insert into settings (key, value) values ('ceo_email', '{"enabled":false}') on conflict (key) do update set value = excluded.value`);
    await asJwt('authenticated', fresh, async () => {
      await db.query(`update settings set value = '{"enabled":true,"to":"x@evil.example"}' where key = 'ceo_email'`);
      await db.query(`delete from settings where key = 'ceo_email'`);
    });
    assert.deepEqual(await row(), { enabled: false }, 'update/delete by the CEO touched nothing');
    await db.query(`delete from settings where key = 'ceo_email'`);
  });

  await step('ceo email: anon and other users cannot call ceo_email_set / ceo_email_recent', async () => {
    await as('anon', null, async () => {
      await assert.rejects(db.query(`select ceo_email_set('{"enabled":false}'::jsonb)`), /permission denied/);
      await assert.rejects(db.query(`select * from ceo_email_recent()`), /permission denied/);
    });
    await asJwt('authenticated', { sub: OTHER }, async () => {
      await assert.rejects(db.query(`select ceo_email_set('{"enabled":false}'::jsonb)`), /not allowed/);
      await assert.rejects(db.query(`select * from ceo_email_recent()`), /not allowed/);
    });
  });

  await step('ceo email: turning it on needs a fresh 2FA code, then stores a clean value with enabled_at (audited)', async () => {
    await asJwt('authenticated', stale, async () => { await assert.rejects(set(ON), /step_up_required/); });
    assert.equal(await row(), undefined);
    await asJwt('service_role', service, async () => { await assert.rejects(set(ON), /step_up_required/, 'the bot cannot turn it on'); });
    let v;
    await asJwt('authenticated', fresh, async () => { v = await set(ON); });
    assert.equal(v.enabled, true);
    assert.equal(v.to, 'ceo@example.com', 'stored lower-case');
    assert.equal(v.connector_id, GMAIL);
    assert.deepEqual(v.events, { results: true, questions: true, failures: true, plans: false });
    assert.ok(typeof v.enabled_at === 'string' && Date.parse(v.enabled_at) > 0);
    assert.deepEqual(await row(), v);
    assert.equal(await val(`select count(*)::int from activity_log where action = 'ceo_email.updated'`), 1);
  });

  await step('ceo email: events change without 2FA, enabled_at is kept; a new address needs 2FA', async () => {
    const before = await row();
    await asJwt('authenticated', stale, async () => {
      const v = await set({ ...ON, to: 'ceo@example.com', events: { results: true, questions: false, failures: true, plans: true } });
      assert.equal(v.enabled_at, before.enabled_at);
      assert.deepEqual(v.events, { results: true, questions: false, failures: true, plans: true });
      await assert.rejects(set({ ...ON, to: 'someone-else@example.com' }), /step_up_required/);
    });
    assert.equal((await row()).to, 'ceo@example.com');
    await asJwt('authenticated', fresh, async () => { assert.equal((await set({ ...ON, to: 'talent@example.com' })).to, 'talent@example.com'); });
    assert.equal(await val(`select count(*)::int from activity_log where action = 'ceo_email.updated'`), 3);
  });

  await step('ceo email: validation (address, account, events, enabled)', async () => {
    await asJwt('authenticated', fresh, async () => {
      for (const to of ['not-an-address', 'a@b', 'Boss <boss@example.com>', 'a@example.com, b@example.com', 'a b@example.com', 'a@example.com\nBcc: x@evil.example']) {
        await assert.rejects(set({ ...ON, to }), /not a valid email address/, to);
      }
      await assert.rejects(set({ ...ON, connector_id: GMAIL_OFF }), /active Gmail account/);
      await assert.rejects(set({ ...ON, connector_id: '00000000-0000-4000-8000-000000000000' }), /unknown Gmail account/);
      await assert.rejects(set({ ...ON, connector_id: 'x' }), /unknown Gmail account/);
      await assert.rejects(set({ ...ON, connector_id: null }), /active Gmail account/);
      await assert.rejects(set({ ...ON, to: null }), /enter the address/);
      await assert.rejects(set({ ...ON, events: { results: false, questions: false, failures: false, plans: false } }), /at least one/);
      await assert.rejects(set({ ...ON, events: { results: 'yes' } }), /true or false/);
      await assert.rejects(set({ ...ON, events: { everything: true } }), /unknown event/);
      await assert.rejects(set({ ...ON, enabled: 'true' }), /enabled must be/);
      await assert.rejects(val(`select ceo_email_set('[]'::jsonb)`), /must be an object/);
    });
    assert.equal((await row()).to, 'talent@example.com', 'nothing changed');
  });

  await step('ceo email: turning it off needs no code and clears enabled_at; an off account may stay selected', async () => {
    await asJwt('authenticated', stale, async () => {
      const v = await set({ ...ON, to: 'talent@example.com', enabled: false, connector_id: GMAIL_OFF });
      assert.equal(v.enabled, false);
      assert.equal(v.enabled_at, null);
      await assert.rejects(set({ ...ON, to: 'talent@example.com' }), /step_up_required/, 'turning it back on needs the code');
    });
  });

  // ---------- worker side ----------
  let since, reqId;
  const ap = async (kind, payload, title = 't', ago = '0 seconds') => val(
    `insert into approvals (kind, request_id, agent_id, title, payload, created_at) values ($1::approval_kind, $2, 'coo', $3, $4::jsonb, now() - $5::interval) returning id`,
    [kind, reqId, title, JSON.stringify(payload), ago]);
  const pending = async (events, s = since) => {
    let rows;
    await asJwt('service_role', service, async () => {
      rows = (await db.query(`select id, event, request_text from ceo_email_pending($1::timestamptz, $2::text[], 50)`, [s, events])).rows;
    });
    return rows;
  };
  const ids = {};

  await step('ceo email: pending = approvals after enabled_at of the chosen events; never actions or Vault 2FA', async () => {
    await asJwt('authenticated', fresh, async () => { since = (await set({ ...ON, to: 'talent@example.com' })).enabled_at; });
    reqId = await val(`insert into requests (source, raw_text, title, status) values ('dashboard', 'Summarize my calendar', 'Calendar', 'in_progress') returning id`);
    ids.old = await ap('deliverable', { output: { summary: 'old' } }, 'Old result', '1 hour');
    ids.result = await ap('deliverable', { output: { summary: 'Your week', content: '# Week' }, qa: { score: 91 } }, 'Calendar summary');
    ids.plan = await ap('plan', { tasks: [] }, 'Plan: X');
    ids.question = await ap('external_action', { type: 'question', question: 'Which week?' });
    ids.twofa = await ap('external_action', { type: 'question', question: 'Code?', vault: { kind: '2fa' } });
    ids.failed = await ap('external_action', { type: 'task_failed', reason: 'boom' });
    ids.action = await ap('external_action', { type: 'external_action', action_type: 'gmail.send' });
    ids.vault = await ap('external_action', { type: 'vault_problem' });
    const rows = await pending(['results', 'questions', 'failures']);
    assert.deepEqual(rows.map((r) => r.id).sort(), [ids.result, ids.question, ids.failed].sort());
    assert.equal(rows.find((r) => r.id === ids.result).event, 'results');
    assert.equal(rows.find((r) => r.id === ids.result).request_text, 'Summarize my calendar');
    assert.deepEqual((await pending(['plans'])).map((r) => r.id), [ids.plan]);
    assert.deepEqual(await pending([]), []);
  });

  await step('ceo email: sent once (log), failures retried at most 3 times, 2 minutes apart; bad keys refused', async () => {
    await asJwt('service_role', service, async () => {
      await db.query(`select ceo_email_record($1, true, null)`, [`approval:${ids.result}`]);
      await db.query(`select ceo_email_record($1, false, 'Could not reach Gmail (network). Try again.')`, [`approval:${ids.question}`]);
      await assert.rejects(db.query(`select ceo_email_record('evil; drop', true, null)`), /bad key/);
    });
    assert.deepEqual((await pending(['results', 'questions', 'failures'])).map((r) => r.id), [ids.failed], 'sent → gone; just failed → waits 2 minutes');
    await db.query(`update ceo_email_log set sent_at = now() - interval '3 minutes' where key = $1`, [`approval:${ids.question}`]);
    assert.deepEqual((await pending(['questions'])).map((r) => r.id), [ids.question], 'retried after 2 minutes');
    await asJwt('service_role', service, async () => {
      await db.query(`select ceo_email_record($1, false, 'x')`, [`approval:${ids.question}`]);
      await db.query(`select ceo_email_record($1, false, 'x')`, [`approval:${ids.question}`]);
    });
    await db.query(`update ceo_email_log set sent_at = now() - interval '3 minutes' where key = $1`, [`approval:${ids.question}`]);
    assert.equal(await val(`select attempts from ceo_email_log where key = $1`, [`approval:${ids.question}`]), 3);
    assert.deepEqual(await pending(['questions']), [], 'given up after 3 attempts');
  });

  await step('ceo email: the log is service-only; the CEO reads the last rows through ceo_email_recent()', async () => {
    await asJwt('service_role', service, async () => { await db.query(`select ceo_email_record('test:2026-09-30T12:00:00.000Z', true, null)`); });
    await asJwt('authenticated', fresh, async () => {
      await assert.rejects(db.query(`select * from ceo_email_log`), /permission denied/);
      await assert.rejects(db.query(`insert into ceo_email_log (key, ok) values ('approval:x', true)`), /permission denied/);
      await assert.rejects(db.query(`select * from ceo_email_pending(now(), array['results'], 5)`), /permission denied/);
      await assert.rejects(db.query(`select ceo_email_record('test:x', true, null)`), /permission denied/);
      const rows = (await db.query(`select key, title, kind, ok, error from ceo_email_recent()`)).rows;
      assert.equal(rows.length, 3);
      const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
      assert.equal(byKey[`approval:${ids.result}`].title, 'Calendar summary');
      assert.equal(byKey[`approval:${ids.result}`].kind, 'deliverable');
      assert.equal(byKey['test:2026-09-30T12:00:00.000Z'].title, 'Test email');
      assert.equal(byKey[`approval:${ids.question}`].ok, false);
    });
    await as('anon', null, async () => { await assert.rejects(db.query(`select * from ceo_email_log`), /permission denied/); });
  });

  await step('ceo email: turning it off and on again moves enabled_at forward (no backfill of what came in between)', async () => {
    await asJwt('authenticated', fresh, async () => {
      await set({ ...ON, to: 'talent@example.com', enabled: false });
      const v = await set({ ...ON, to: 'talent@example.com' });
      assert.ok(Date.parse(v.enabled_at) >= Date.parse(since));
    });
    await db.query(`delete from settings where key = 'ceo_email'`);
  });
}
