// Telegram voice notes (supabase/migrations/20260929050000_voice_notes.sql): only the service role (bot + worker)
// queues, claims and finishes clips; the audio is cleared once finished; the CEO reads status + transcript, never audio.
export default async function ({ db, step, val, as, assert }) {
  const CEO = '11111111-1111-1111-1111-111111111111';
  async function asJwt(role, claims, fn) {
    await db.exec(`set role ${role}`);
    await db.query(`select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claims', $2, false)`,
      [claims.sub ?? '', JSON.stringify({ role, ...claims })]);
    try { await fn(); } finally {
      await db.exec(`reset role; select set_config('request.jwt.claim.sub','',false); select set_config('request.jwt.claims','',false);`);
    }
  }
  const ceo = { sub: CEO, aal: 'aal2' };
  const service = { role: 'service_role' };
  const insert = (chat = 42, msg = 1, audio = '4f676753', created = null) => db.query(
    `insert into voice_notes (chat_id, message_id, audio, media_type, seconds, created_at)
     values ($1, $2, decode($3, 'hex'), 'audio/ogg', 3, coalesce($4::timestamptz, now())) returning id`, [chat, msg, audio, created]);
  const claim = async () => (await db.query(`select (c).id, (c).status, encode((c).audio, 'hex') as audio from voice_note_claim() c`)).rows[0];

  await step('voice notes: browsers (anon, any signed-in user, the CEO) cannot queue, claim or finish clips', async () => {
    await as('anon', null, async () => {
      await assert.rejects(insert(), /permission denied/);
      await assert.rejects(db.query(`select voice_note_claim()`), /permission denied/);
    });
    await asJwt('authenticated', { sub: '22222222-2222-2222-2222-222222222222' }, async () => {
      await assert.rejects(insert(), /permission denied/);
      await assert.rejects(db.query(`select voice_note_claim()`), /permission denied/);
    });
    await asJwt('authenticated', ceo, async () => {
      await assert.rejects(insert(), /permission denied/);
      await assert.rejects(db.query(`select voice_note_claim()`), /permission denied/);
      await assert.rejects(db.query(`select voice_note_finish(gen_random_uuid(), 'x')`), /permission denied/);
    });
    assert.equal(await val(`select count(*)::int from voice_notes`), 0);
  });

  let first, second;
  await step('voice notes: the service role queues clips and claims the oldest first (pending → working)', async () => {
    await asJwt('service_role', service, async () => {
      first = (await insert(42, 1, '0a0b', new Date(Date.now() - 60_000).toISOString())).rows[0].id;
      second = (await insert(42, 2, '0c0d')).rows[0].id;
      const a = await claim();
      assert.deepEqual([a.id, a.status, a.audio], [first, 'working', '0a0b']);
      const b = await claim();
      assert.deepEqual([b.id, b.status], [second, 'working'], 'a claimed clip is never handed out twice');
      assert.equal((await claim()).id, null, 'nothing left: a null row');
    });
    assert.match(await val(`select pg_get_functiondef('voice_note_claim()'::regprocedure)`), /for update skip locked/i,
      'two workers skip each other\'s locked rows (PGlite is single-connection, so the lock itself is not exercised here)');
  });

  await step('voice notes: finishing clears the audio (done keeps the transcript, failed keeps the error)', async () => {
    await asJwt('service_role', service, async () => {
      assert.equal(await val(`select voice_note_finish($1, '  Write a blog post  ', null, 4.5)`, [first]), true);
      assert.equal(await val(`select voice_note_finish($1, null, 'No speech-to-text model available')`, [second]), true);
      assert.equal(await val(`select voice_note_finish($1, 'again')`, [first]), false, 'only a working clip is finished');
    });
    assert.deepEqual((await db.query(`select status, text, error, seconds::float, audio is null as cleared from voice_notes where id = $1`, [first])).rows[0],
      { status: 'done', text: 'Write a blog post', error: null, seconds: 4.5, cleared: true });
    assert.deepEqual((await db.query(`select status, text, error, seconds::float, audio is null as cleared from voice_notes where id = $1`, [second])).rows[0],
      { status: 'failed', text: null, error: 'No speech-to-text model available', seconds: 3, cleared: true });
  });

  await step('voice notes: a finished clip can never hold audio again; clips over 8 MB are refused', async () => {
    await assert.rejects(db.query(`update voice_notes set audio = '\\x01' where id = $1`, [first]), /voice_notes_audio_cleared/);
    await assert.rejects(db.query(
      `insert into voice_notes (chat_id, message_id, audio, media_type) values (1, 1, decode(repeat('00', 8 * 1024 * 1024 + 1), 'hex'), 'audio/ogg')`),
    /check constraint/);
  });

  await step('voice notes: clips nobody finished within 5 minutes expire on the next claim (audio dropped, not transcribed)', async () => {
    let old;
    await asJwt('service_role', service, async () => {
      old = (await insert(42, 3, '0e0f', new Date(Date.now() - 10 * 60_000).toISOString())).rows[0].id;
      assert.equal((await claim()).id, null);
    });
    assert.deepEqual((await db.query(`select status, error, audio is null as cleared from voice_notes where id = $1`, [old])).rows[0],
      { status: 'failed', error: 'expired before it was transcribed', cleared: true });
  });

  await step('voice notes: the CEO reads status + transcript but never the audio, and cannot change rows', async () => {
    await asJwt('authenticated', ceo, async () => {
      assert.equal(await val(`select text from voice_notes where id = $1`, [first]), 'Write a blog post');
      await assert.rejects(db.query(`select audio from voice_notes`), /permission denied/);
      await assert.rejects(db.query(`update voice_notes set text = 'x'`), /permission denied/);
      await assert.rejects(db.query(`delete from voice_notes`), /permission denied/);
    });
    await asJwt('authenticated', { sub: '22222222-2222-2222-2222-222222222222' }, async () => {
      assert.equal(await val(`select count(*)::int from voice_notes`), 0, 'RLS: only the CEO');
    });
    await as('anon', null, async () => { await assert.rejects(db.query(`select text from voice_notes`), /permission denied/); });
  });
}
