// Validates the migration + seed + queue functions + RLS in an in-memory Postgres (PGlite).
// Run from repo root: pnpm db:test
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
const db = new PGlite();
const stub = `
create role authenticated nologin; create role anon nologin; create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
grant usage on schema auth to authenticated, anon;
grant execute on function auth.uid() to authenticated, anon;
create publication supabase_realtime;
alter default privileges in schema public grant all on tables to authenticated, anon, service_role;
alter default privileges in schema public grant all on sequences to authenticated, anon, service_role;
grant usage on schema public to authenticated, anon, service_role;
`;
const mig = fs.readFileSync('./supabase/migrations/20260928000000_init_schema.sql','utf8');
const seed = fs.readFileSync('./supabase/seed.sql','utf8');
try {
  await db.exec(stub); console.log('stub ok');
  await db.exec(mig); console.log('migration ok');
  await db.exec(seed); console.log('seed ok');
  const n = await db.query('select count(*)::int n from agents'); console.log('agents', n.rows[0].n);
  // Queue flow test
  await db.exec(`
    insert into requests (id, source, raw_text, priority) values ('00000000-0000-0000-0000-000000000001','dashboard','test','high');
    insert into tasks (id, request_id, agent_id, title, instructions, work_type, status) values
      ('00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-000000000001','seo-1','Copy','x','landing-copy','pending'),
      ('00000000-0000-0000-0000-00000000000b','00000000-0000-0000-0000-000000000001','uiux-1','Wireframe','x','wireframe','pending');
    update tasks set depends_on = array['00000000-0000-0000-0000-00000000000a'::uuid] where id='00000000-0000-0000-0000-00000000000b';
  `);
  let r = await db.query(`select release_ready_tasks('00000000-0000-0000-0000-000000000001') n`); console.log('released', r.rows[0].n, '(expect 1)');
  r = await db.query(`select (claim_next_task()).id`); console.log('claimed', r.rows[0].id);
  r = await db.query(`select status, current_task_id from agents where id='seo-1'`); console.log('agent', r.rows[0]);
  r = await db.query(`select (claim_next_task()).id`); console.log('second claim (expect null)', r.rows[0].id);
  await db.exec(`update tasks set status='done' where id='00000000-0000-0000-0000-00000000000a'`);
  r = await db.query(`select release_ready_tasks('00000000-0000-0000-0000-000000000001') n`); console.log('released after dep done', r.rows[0].n, '(expect 1)');
  await db.exec(`update tasks set status='working', heartbeat_at=now()-interval '20 minutes' where id='00000000-0000-0000-0000-00000000000b'`);
  r = await db.query(`select requeue_stale_tasks() n`); console.log('requeued stale', r.rows[0].n, '(expect 1)');
  // RLS test: non-CEO authenticated user sees nothing; CEO sees agents; secret column blocked
  await db.exec(`insert into auth.users (id,email) values ('11111111-1111-1111-1111-111111111111','ceo@x.com'),('22222222-2222-2222-2222-222222222222','other@x.com');
                 insert into ceo_users (user_id) values ('11111111-1111-1111-1111-111111111111');`);
  for (const [who,uid] of [['other','22222222-2222-2222-2222-222222222222'],['ceo','11111111-1111-1111-1111-111111111111']]) {
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${uid}',false);`);
    const q = await db.query('select count(*)::int n from agents'); console.log(who,'sees agents', q.rows[0].n);
    try { await db.query('select secret_cipher from client_credentials'); console.log(who,'CAN read secret_cipher (BAD)'); }
    catch(e){ console.log(who,'blocked from secret_cipher: OK'); }
    await db.exec('reset role;');
  }
} catch (e) { console.error('ERROR:', e.message); process.exit(1); }
