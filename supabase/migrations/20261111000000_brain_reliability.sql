-- HQ Brain P0 reliability (2026-11-11). Records the fixes applied by hand on prod that day, plus what the indexer needs to
-- keep going when one file fails. Idempotent: safe on prod where parts already exist.
--
-- Background: from 2026-10-14 every vault pull died with "brain_upsert_document: canceling statement due to statement
-- timeout" and the index fell four weeks behind. Causes: no index on brain_chunks.text_sha (every chunk's embedding
-- lookup scanned the table), brain_replace_chunks rewriting every chunk three times (each pass also updating HNSW + GIN),
-- and the 8 s API timeout. Then brain_health() (exact counts) timed out and the /brain page rendered empty.

-- 1. Embedding reuse lookup by text (partial: only rows that have a vector are worth finding).
create index if not exists brain_chunks_text_sha on brain_chunks (text_sha) where embedding is not null;

-- 2. Incremental chunk replace: only positions whose content changed are rewritten (session transcripts grow at the end,
--    so an append touches a few rows instead of all of them). A changed chunk reuses any existing vector for the same
--    text. language sql on purpose: vectors never pass through plpgsql (PGlite's wasm build crashes, see 16-BRAIN.md).
--    Each statement in a sql function sees the previous one's changes.
create or replace function brain_replace_chunks(p_doc_id uuid, p_chunks jsonb) returns int
language sql security definer set search_path = public, extensions as $$
  delete from brain_chunks where doc_id = p_doc_id and ord >= jsonb_array_length(coalesce(p_chunks, '[]'));

  update brain_chunks c
     set heading = nw.heading, text = nw.txt, text_sha = nw.sha,
         embedding = case when c.text_sha = nw.sha then c.embedding
                          else (select e.embedding from brain_chunks e where e.text_sha = nw.sha and e.embedding is not null limit 1) end
    from (select (x.o - 1)::int as ord, coalesce(x.v->>'heading', '') as heading, x.v->>'text' as txt, x.v->>'text_sha' as sha
            from jsonb_array_elements(coalesce(p_chunks, '[]')) with ordinality as x(v, o)) nw
   where c.doc_id = p_doc_id and c.ord = nw.ord
     and (c.text_sha is distinct from nw.sha or c.heading is distinct from nw.heading or c.text is distinct from nw.txt);

  insert into brain_chunks (doc_id, ord, heading, text, text_sha, embedding)
  select p_doc_id, nw.ord, nw.heading, nw.txt, nw.sha,
         (select e.embedding from brain_chunks e where e.text_sha = nw.sha and e.embedding is not null limit 1)
    from (select (x.o - 1)::int as ord, coalesce(x.v->>'heading', '') as heading, x.v->>'text' as txt, x.v->>'text_sha' as sha
            from jsonb_array_elements(coalesce(p_chunks, '[]')) with ordinality as x(v, o)) nw
   where not exists (select 1 from brain_chunks c where c.doc_id = p_doc_id and c.ord = nw.ord);

  select count(*)::int from brain_chunks where doc_id = p_doc_id and embedding is null;
$$;

-- 3. Sync state remembers which files failed in the last run (the indexer now skips a failing file instead of stopping).
alter table brain_sync_state add column if not exists failed jsonb not null default '[]';
alter table brain_sync_state add column if not exists lag_alerted_at timestamptz;

create or replace function brain_set_sync_state(p jsonb) returns void
language sql security definer set search_path = public, extensions as $$
  update brain_sync_state set
    branch          = case when p ? 'branch' then p->>'branch' else branch end,
    head_sha        = case when p ? 'head_sha' then p->>'head_sha' else head_sha end,
    status          = case when p ? 'status' then p->>'status' else status end,
    error           = case when p ? 'error' then left(p->>'error', 1000) else error end,
    embed_model     = case when p ? 'embed_model' then p->>'embed_model' else embed_model end,
    last_pull_at    = case when p ? 'last_pull_at' then (p->>'last_pull_at')::timestamptz else last_pull_at end,
    last_index_at   = case when p ? 'last_index_at' then (p->>'last_index_at')::timestamptz else last_index_at end,
    last_webhook_at = case when p ? 'last_webhook_at' then (p->>'last_webhook_at')::timestamptz else last_webhook_at end,
    failed          = case when p ? 'failed' then coalesce(p->'failed', '[]') else failed end,
    lag_alerted_at  = case when p ? 'lag_alerted_at' then (p->>'lag_alerted_at')::timestamptz else lag_alerted_at end,
    updated_at      = now()
  where id;
$$;

-- The raw sync-state row for the brain service (lag alert bookkeeping). Service only.
create or replace function brain_sync_state_row() returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select to_jsonb(s) from brain_sync_state s where id;
$$;
revoke all on function brain_sync_state_row() from public, anon, authenticated;
grant execute on function brain_sync_state_row() to service_role;

-- 4. brain_health() must stay fast while the database is busy (it backs the whole /brain page, 8 s API timeout).
--    Small tables: exact counts. Big chunk table: live-row estimate from table stats + share of embedded rows in a 5% sample.
create or replace function brain_health() returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  s brain_sync_state;
  v_est bigint;
  v_chunks bigint;
  v_embedded bigint;
  v_ratio numeric;
  v_mode text := 'exact';
begin
  perform hq_guard();
  select * into s from brain_sync_state where id;
  select greatest(coalesce(n_live_tup, 0), 0) into v_est from pg_stat_user_tables where relid = 'public.brain_chunks'::regclass;
  if coalesce(v_est, 0) < 20000 then
    select count(*), count(*) filter (where embedding is not null) into v_chunks, v_embedded from brain_chunks;
  else
    v_mode := 'estimated';
    v_chunks := v_est;
    select avg((embedding is not null)::int) into v_ratio from brain_chunks tablesample system (5);
    v_embedded := least(v_chunks, round(v_chunks * coalesce(v_ratio, 0)))::bigint;
  end if;
  return jsonb_build_object(
    'branch', s.branch, 'head_sha', s.head_sha, 'status', s.status, 'error', s.error, 'embed_model', s.embed_model,
    'last_pull_at', s.last_pull_at, 'last_index_at', s.last_index_at, 'last_webhook_at', s.last_webhook_at,
    'failed', coalesce(s.failed, '[]'::jsonb),
    'projects', (select count(*) from brain_projects where listed),
    'documents', (select count(*) from brain_documents),
    'chunks', v_chunks,
    'embedded', v_embedded,
    'counts', v_mode);
end $$;

-- 5. Alerts the Telegram bot sends (the brain service can't reach the bot; Supabase is the contract). Written by the
--    brain service (e.g. indexing more than an hour behind the vault), sent once by apps/bot's notifier.
create table if not exists brain_alerts (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  kind       text not null check (kind in ('index_lagging', 'index_failed', 'device_unhealthy')),
  text       text not null,
  meta       jsonb not null default '{}',
  sent_at    timestamptz
);
create index if not exists brain_alerts_unsent on brain_alerts (created_at) where sent_at is null;
alter table brain_alerts enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'brain_alerts' and policyname = 'ceo_read') then
    create policy ceo_read on brain_alerts for select to authenticated using (is_ceo());
  end if;
end $$;
revoke all on brain_alerts from anon, authenticated;
grant select on brain_alerts to authenticated;

create or replace function brain_raise_alert(p_kind text, p_text text, p_meta jsonb default '{}') returns bigint
language sql security definer set search_path = public, extensions as $$
  insert into brain_alerts (kind, text, meta) values (p_kind, left(p_text, 1000), coalesce(p_meta, '{}')) returning id;
$$;
revoke all on function brain_raise_alert(text, text, jsonb) from public, anon, authenticated;
grant execute on function brain_raise_alert(text, text, jsonb) to service_role;
grant select, update on brain_alerts to service_role;

-- 6. The brain service (service_role) runs long batches (a first index of big transcripts, the embedding backlog).
--    The dashboard/browser roles keep their short timeouts. Guarded: PGlite test roles may not accept it.
do $$ begin
  execute 'alter role service_role set statement_timeout = ''300s''';
exception when others then null;
end $$;
notify pgrst, 'reload schema';
