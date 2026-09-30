-- HQ Brain M1 (docs/16-BRAIN.md): search index + activity feed for the memory vault (github.com/cracker17/claude-memory-vault).
-- The vault (markdown in git) is the source of truth; everything in these tables is rebuildable from it. The only writer is
-- the brain service (apps/brain, container hq-brain, service role). The CEO reads through RLS and the CEO API below (M3 UI).
-- No secrets are ever indexed: the service skips files that match the vault's secret patterns (apps/brain/src/secretScan.ts).
-- All functions take/return scalars or jsonb so supabase-js rpc() and the local PGlite store call them the same way.

create schema if not exists extensions;
create extension if not exists vector with schema extensions;

-- ---------- tables ----------
create table brain_projects (
  slug          text primary key check (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  name          text not null,
  aliases       text[] not null default '{}',
  paths         text[] not null default '{}',
  status        text,                                   -- first lines of memory.md "## Status"
  links         jsonb not null default '[]',            -- memory.md "## Links" bullets
  listed        boolean not null default true,          -- false = has a folder but no projects.json entry (or was removed)
  doc_count     int not null default 0,
  last_activity date,
  updated_at    timestamptz not null default now()
);

create table brain_documents (
  id            uuid primary key default gen_random_uuid(),
  path          text not null unique check (path ~ '^[^/].*\.md$' and path !~ '(^|/)\.\.(/|$)'),
  project_slug  text,                                   -- no FK: a folder can exist before its projects.json entry
  kind          text not null check (kind in ('memory', 'session', 'transcript', 'session_log', 'project_doc', 'profile',
                                             'scheduled_task', 'prompt', 'command', 'readme', 'other')),
  title         text not null,
  doc_date      date,
  frontmatter   jsonb not null default '{}',
  body          text not null,
  content_sha   text not null,
  git_sha       text,
  bytes         int not null,
  indexed_at    timestamptz not null default now()
);
create index brain_documents_project on brain_documents (project_slug, kind, doc_date desc);

create table brain_chunks (
  id            bigint generated always as identity primary key,
  doc_id        uuid not null references brain_documents (id) on delete cascade,
  ord           int not null,
  heading       text not null default '',
  text          text not null,
  text_sha      text not null,
  embedding     extensions.vector(1536),
  tsv           tsvector generated always as (to_tsvector('english'::regconfig, heading || ' ' || text)) stored,
  unique (doc_id, ord)
);
create index brain_chunks_tsv on brain_chunks using gin (tsv);
create index brain_chunks_embedding on brain_chunks using hnsw (embedding extensions.vector_cosine_ops);

create table brain_decisions (
  id            bigint generated always as identity primary key,
  doc_id        uuid not null references brain_documents (id) on delete cascade,
  project_slug  text,
  ord           int not null,
  decided_on    date,
  text          text not null
);
create index brain_decisions_project on brain_decisions (project_slug, decided_on desc);

create table brain_next_steps (
  id            bigint generated always as identity primary key,
  doc_id        uuid not null references brain_documents (id) on delete cascade,
  project_slug  text,
  ord           int not null,
  text          text not null,
  done          boolean not null default false
);
create index brain_next_steps_project on brain_next_steps (project_slug, ord);

create table brain_events (
  id            bigint generated always as identity primary key,
  ts            timestamptz not null default now(),
  actor         text not null,                          -- brain-service | github:<pusher> | julev | claude-code | agent:<id>
  action        text not null,                          -- pulled | indexed | doc_added | doc_changed | doc_removed | blocked_secret | error
  project_slug  text,
  path          text,
  summary       text not null default '',
  meta          jsonb not null default '{}'
);
create index brain_events_ts on brain_events (ts desc);

create table brain_sync_state (
  id              boolean primary key default true check (id),
  branch          text,
  head_sha        text,
  status          text not null default 'starting' check (status in ('starting', 'ok', 'degraded', 'error')),
  error           text,
  embed_model     text,
  last_pull_at    timestamptz,
  last_index_at   timestamptz,
  last_webhook_at timestamptz,
  updated_at      timestamptz not null default now()
);
insert into brain_sync_state (id) values (true);

-- RLS: the CEO reads everything, nobody but the service role writes (no write policies; service_role bypasses RLS).
do $$
declare t text;
begin
  foreach t in array array['brain_projects', 'brain_documents', 'brain_chunks', 'brain_decisions', 'brain_next_steps',
                           'brain_events', 'brain_sync_state'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy ceo_read on %I for select to authenticated using (is_ceo())', t);
    execute format('revoke all on %I from anon, authenticated', t);
    execute format('grant select on %I to authenticated', t);
  end loop;
end $$;

-- ---------- service (hq-brain) ----------

-- projects.json → brain_projects. p: [{slug, name, aliases[], paths[], status?, links?}]. Rows missing from p become listed=false.
create or replace function brain_sync_projects(p_projects jsonb) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare n int;
begin
  insert into brain_projects (slug, name, aliases, paths, status, links, listed, updated_at)
  select x->>'slug', coalesce(nullif(x->>'name', ''), x->>'slug'),
         coalesce(array(select jsonb_array_elements_text(coalesce(x->'aliases', '[]'))), '{}'),
         coalesce(array(select jsonb_array_elements_text(coalesce(x->'paths', '[]'))), '{}'),
         nullif(x->>'status', ''), coalesce(x->'links', '[]'), coalesce((x->>'listed')::boolean, true), now()
    from jsonb_array_elements(coalesce(p_projects, '[]')) x
  on conflict (slug) do update set name = excluded.name, aliases = excluded.aliases, paths = excluded.paths,
    status = excluded.status, links = excluded.links, listed = excluded.listed, updated_at = now()
  where (brain_projects.name, brain_projects.aliases, brain_projects.paths, brain_projects.status, brain_projects.links, brain_projects.listed)
        is distinct from (excluded.name, excluded.aliases, excluded.paths, excluded.status, excluded.links, excluded.listed);
  get diagnostics n = row_count;
  update brain_projects set listed = false, updated_at = now()
   where listed and slug not in (select x->>'slug' from jsonb_array_elements(coalesce(p_projects, '[]')) x);
  return n;
end $$;

-- {path: content_sha} of everything indexed (the service diffs the working tree against it).
create or replace function brain_document_manifest() returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select coalesce(jsonb_object_agg(path, content_sha), '{}'::jsonb) from brain_documents;
$$;

-- Replace a document's chunks. A chunk keeps its embedding when the same text (text_sha) was already embedded anywhere,
-- so an edit only re-embeds the chunks that really changed. New rows go in at ord + 1e6 first (the old ones are still there to
-- copy vectors from), then the old rows go and the new ones shift down. language sql on purpose: vectors never pass through
-- plpgsql, which crashes PGlite's wasm build (pnpm db:test); real Postgres is fine either way.
create or replace function brain_replace_chunks(p_doc_id uuid, p_chunks jsonb) returns int
language sql security definer set search_path = public, extensions as $$
  insert into brain_chunks (doc_id, ord, heading, text, text_sha, embedding)
  select p_doc_id, (x.o - 1)::int + 1000000, coalesce(x.v->>'heading', ''), x.v->>'text', x.v->>'text_sha',
         (select c.embedding from brain_chunks c where c.text_sha = x.v->>'text_sha' and c.embedding is not null limit 1)
    from jsonb_array_elements(coalesce(p_chunks, '[]')) with ordinality as x(v, o);
  delete from brain_chunks where doc_id = p_doc_id and ord < 1000000;
  update brain_chunks set ord = ord - 1000000 where doc_id = p_doc_id;
  select count(*)::int from brain_chunks where doc_id = p_doc_id and embedding is null;
$$;

-- One document with its chunks, decisions and next steps, in one transaction.
-- p_doc: {path, project_slug, kind, title, doc_date, frontmatter, body, content_sha, git_sha}
-- p_chunks: [{heading, text, text_sha}] · p_decisions: [{decided_on, text}] · p_next_steps: [{text, done}]
create or replace function brain_upsert_document(p_doc jsonb, p_chunks jsonb, p_decisions jsonb, p_next_steps jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_id uuid;
  v_new boolean;
  v_missing int;
begin

  select id into v_id from brain_documents where path = p_doc->>'path';
  v_new := v_id is null;
  insert into brain_documents (path, project_slug, kind, title, doc_date, frontmatter, body, content_sha, git_sha, bytes, indexed_at)
  values (p_doc->>'path', nullif(p_doc->>'project_slug', ''), p_doc->>'kind', coalesce(nullif(p_doc->>'title', ''), p_doc->>'path'),
          nullif(p_doc->>'doc_date', '')::date, coalesce(p_doc->'frontmatter', '{}'), coalesce(p_doc->>'body', ''),
          p_doc->>'content_sha', nullif(p_doc->>'git_sha', ''), octet_length(coalesce(p_doc->>'body', '')), now())
  on conflict (path) do update set project_slug = excluded.project_slug, kind = excluded.kind, title = excluded.title,
    doc_date = excluded.doc_date, frontmatter = excluded.frontmatter, body = excluded.body, content_sha = excluded.content_sha,
    git_sha = excluded.git_sha, bytes = excluded.bytes, indexed_at = now()
  returning id into v_id;

  v_missing := brain_replace_chunks(v_id, p_chunks);

  delete from brain_decisions where doc_id = v_id;
  insert into brain_decisions (doc_id, project_slug, ord, decided_on, text)
  select v_id, nullif(p_doc->>'project_slug', ''), (x.o - 1)::int, nullif(x.v->>'decided_on', '')::date, x.v->>'text'
    from jsonb_array_elements(coalesce(p_decisions, '[]')) with ordinality as x(v, o);

  delete from brain_next_steps where doc_id = v_id;
  insert into brain_next_steps (doc_id, project_slug, ord, text, done)
  select v_id, nullif(p_doc->>'project_slug', ''), (x.o - 1)::int, x.v->>'text', coalesce((x.v->>'done')::boolean, false)
    from jsonb_array_elements(coalesce(p_next_steps, '[]')) with ordinality as x(v, o);

  return jsonb_build_object('id', v_id, 'new', v_new, 'chunks', jsonb_array_length(coalesce(p_chunks, '[]')), 'needs_embedding', v_missing);
end $$;

create or replace function brain_delete_documents(p_paths jsonb) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare n int;
begin
  delete from brain_documents where path in (select jsonb_array_elements_text(coalesce(p_paths, '[]')));
  get diagnostics n = row_count;
  return n;
end $$;

-- Recompute per-project doc_count and last_activity (newest doc_date) after an index run.
create or replace function brain_refresh_projects() returns void
language sql security definer set search_path = public, extensions as $$
  update brain_projects p
     set doc_count = coalesce(s.n, 0), last_activity = s.last
    from (select pr.slug, count(d.id)::int as n, max(d.doc_date) as last
            from brain_projects pr left join brain_documents d on d.project_slug = pr.slug
           group by pr.slug) s
   where s.slug = p.slug
     and (p.doc_count, p.last_activity) is distinct from (coalesce(s.n, 0), s.last);
$$;

create or replace function brain_chunks_missing_embedding(p_limit int default 100) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'title', d.title, 'heading', c.heading, 'text', c.text) order by c.id), '[]'::jsonb)
    from (select id, doc_id, heading, text from brain_chunks where embedding is null order by id limit greatest(1, least(p_limit, 500))) c
    join brain_documents d on d.id = c.doc_id;
$$;

-- p_items: [{id, embedding: "[0.1,0.2,…]"}] (pgvector text form). language sql on purpose: the same UPDATE in plpgsql
-- crashes PGlite's wasm build (pnpm db:test) when it touches several vectors; real Postgres is fine either way.
create or replace function brain_set_embeddings(p_items jsonb) returns int
language sql security definer set search_path = public, extensions as $$
  with u as (
    update brain_chunks c set embedding = (x->>'embedding')::extensions.vector(1536)
      from jsonb_array_elements(coalesce(p_items, '[]')) x
     where c.id = (x->>'id')::bigint
    returning 1)
  select count(*)::int from u;
$$;

-- Embedding model changed → every vector is stale.
create or replace function brain_clear_embeddings() returns int
language plpgsql security definer set search_path = public, extensions as $$
declare n int;
begin
  update brain_chunks set embedding = null where embedding is not null;
  get diagnostics n = row_count;
  return n;
end $$;

-- "Rebuild index": drop every document (chunks/decisions/next steps cascade). Projects and events stay.
create or replace function brain_reset_index() returns int
language plpgsql security definer set search_path = public, extensions as $$
declare n int;
begin
  delete from brain_documents where true;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function brain_log_event(p_actor text, p_action text, p_project text default null, p_path text default null,
                                           p_summary text default '', p_meta jsonb default '{}') returns void
language sql security definer set search_path = public, extensions as $$
  insert into brain_events (actor, action, project_slug, path, summary, meta)
  values (left(p_actor, 80), left(p_action, 40), nullif(p_project, ''), nullif(p_path, ''), left(coalesce(p_summary, ''), 500), coalesce(p_meta, '{}'));
$$;

-- Merge the given keys into the single sync-state row. p: {branch, head_sha, status, error, embed_model, last_pull_at, …}
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
    updated_at      = now()
  where id;
$$;

-- ---------- CEO API (dashboard M3) + service ----------

create or replace function brain_health() returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare s brain_sync_state;
begin
  perform hq_guard();
  select * into s from brain_sync_state where id;
  return jsonb_build_object(
    'branch', s.branch, 'head_sha', s.head_sha, 'status', s.status, 'error', s.error, 'embed_model', s.embed_model,
    'last_pull_at', s.last_pull_at, 'last_index_at', s.last_index_at, 'last_webhook_at', s.last_webhook_at,
    'projects', (select count(*) from brain_projects where listed),
    'documents', (select count(*) from brain_documents),
    'chunks', (select count(*) from brain_chunks),
    'embedded', (select count(*) from brain_chunks where embedding is not null));
end $$;

create or replace function brain_list_projects() returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform hq_guard();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'slug', p.slug, 'name', p.name, 'aliases', p.aliases, 'status', p.status, 'listed', p.listed,
             'doc_count', p.doc_count, 'last_activity', p.last_activity,
             'sessions', (select count(*) from brain_documents d where d.project_slug = p.slug and d.kind = 'session'),
             'open_next_steps', (select count(*) from brain_next_steps n where n.project_slug = p.slug and not n.done))
           order by p.last_activity desc nulls last, p.slug)
      from brain_projects p), '[]'::jsonb);
end $$;

-- /load: project + memory.md + newest sessions (full text) + decisions + next steps + other docs.
create or replace function brain_project_bundle(p_slug text, p_sessions int default 2) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare p brain_projects;
begin
  perform hq_guard();
  select * into p from brain_projects where slug = p_slug;
  if not found then return null; end if;
  return jsonb_build_object(
    'project', to_jsonb(p),
    'memory', (select jsonb_build_object('path', path, 'title', title, 'doc_date', doc_date, 'body', body, 'frontmatter', frontmatter)
                 from brain_documents where project_slug = p_slug and kind = 'memory' order by path limit 1),
    'sessions', coalesce((select jsonb_agg(jsonb_build_object('path', path, 'title', title, 'doc_date', doc_date, 'body', body) order by doc_date desc nulls last, path desc)
                            from (select * from brain_documents where project_slug = p_slug and kind = 'session'
                                   order by doc_date desc nulls last, path desc limit greatest(0, least(p_sessions, 20))) s), '[]'::jsonb),
    'decisions', coalesce((select jsonb_agg(jsonb_build_object('decided_on', decided_on, 'text', text) order by decided_on desc nulls last, ord desc)
                             from brain_decisions where project_slug = p_slug), '[]'::jsonb),
    'next_steps', coalesce((select jsonb_agg(jsonb_build_object('text', text, 'done', done) order by ord)
                              from brain_next_steps where project_slug = p_slug), '[]'::jsonb),
    'documents', coalesce((select jsonb_agg(jsonb_build_object('path', path, 'title', title, 'kind', kind, 'doc_date', doc_date) order by kind, doc_date desc nulls last, path)
                             from brain_documents where project_slug = p_slug), '[]'::jsonb));
end $$;

create or replace function brain_get_document(p_path text) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform hq_guard();
  return (select jsonb_build_object('path', path, 'project_slug', project_slug, 'kind', kind, 'title', title, 'doc_date', doc_date,
                                    'frontmatter', frontmatter, 'body', body, 'git_sha', git_sha, 'indexed_at', indexed_at)
            from brain_documents where path = p_path);
end $$;

-- Hybrid search: keyword (full text, all terms first, then any term) and, when p_embedding is given, cosine similarity
-- (>= 0.2), fused by reciprocal rank (k = 60). p_embedding = pgvector text form "[…]" or null (keyword only).
create or replace function brain_search(p_query text, p_embedding text default null, p_project text default null,
                                        p_kinds jsonb default null, p_limit int default 10) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  -- language sql (not plpgsql): see brain_replace_chunks.
  select hq_guard();
  with params as (
    select websearch_to_tsquery('english', coalesce(p_query, '')) as q_all,
           nullif(replace(websearch_to_tsquery('english', coalesce(p_query, ''))::text, ' & ', ' | '), '')::tsquery as q_any,
           case when coalesce(p_embedding, '') <> '' then p_embedding::extensions.vector(1536) end as v,
           case when jsonb_typeof(p_kinds) = 'array' and jsonb_array_length(p_kinds) > 0
                then array(select jsonb_array_elements_text(p_kinds)) end as kinds,
           greatest(1, least(coalesce(p_limit, 10), 50)) as lim,
           tsvector_to_array(to_tsvector('english', coalesce(p_query, ''))) as terms
  ), scope as (
    select c.id, c.doc_id, c.tsv, c.embedding from brain_chunks c join brain_documents d on d.id = c.doc_id, params
     where (coalesce(p_project, '') = '' or d.project_slug = p_project)
       and (params.kinds is null or d.kind = any (params.kinds))
  ), kw as (
    -- all terms first, then chunks matching more of the distinct terms, then term frequency
    select s.id, row_number() over (order by (s.tsv @@ params.q_all) desc,
             cardinality(array(select unnest(tsvector_to_array(s.tsv)) intersect select unnest(params.terms))) desc,
             ts_rank(s.tsv, params.q_any) desc, s.id) as r
      from scope s, params where params.q_any is not null and s.tsv @@ params.q_any
     order by r limit 50
  ), vec as (
    select s.id, row_number() over (order by s.embedding <=> params.v, s.id) as r
      from scope s, params
     where params.v is not null and s.embedding is not null
       and s.embedding <=> params.v <= 0.8                    -- cosine similarity >= 0.2: unrelated text doesn't count
     order by r limit 50
  ), scored as (
    select u.id, sum(1.0 / (60 + u.r)) as score, array_agg(u.src order by u.src) as via
      from (select id, r, 'keyword' as src from kw union all select id, r, 'semantic' from vec) u
     group by u.id
  ), fused as (
    -- at most 2 chunks per document, so one long file can't crowd out the rest
    select id, score, via from (
      select sc.*, row_number() over (partition by c.doc_id order by sc.score desc, sc.id) as per_doc
        from scored sc join brain_chunks c on c.id = sc.id) x
     where per_doc <= 2
     order by score desc, id limit (select lim from params)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'path', d.path, 'title', d.title, 'kind', d.kind, 'project', d.project_slug, 'doc_date', d.doc_date,
           'heading', c.heading, 'text', c.text, 'score', round(f.score::numeric, 5), 'via', to_jsonb(f.via))
         order by f.score desc), '[]'::jsonb)
    from fused f join brain_chunks c on c.id = f.id join brain_documents d on d.id = c.doc_id;
$$;

create or replace function brain_recent_events(p_limit int default 50) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform hq_guard();
  return coalesce((select jsonb_agg(to_jsonb(e) order by e.ts desc, e.id desc)
                     from (select * from brain_events order by ts desc, id desc limit greatest(1, least(coalesce(p_limit, 50), 500))) e), '[]'::jsonb);
end $$;

-- ---------- grants ----------
do $$
declare f text;
begin
  foreach f in array array['brain_health()', 'brain_list_projects()', 'brain_project_bundle(text, int)', 'brain_get_document(text)',
                           'brain_search(text, text, text, jsonb, int)', 'brain_recent_events(int)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
  foreach f in array array['brain_sync_projects(jsonb)', 'brain_document_manifest()', 'brain_replace_chunks(uuid, jsonb)',
                           'brain_upsert_document(jsonb, jsonb, jsonb, jsonb)',
                           'brain_delete_documents(jsonb)', 'brain_refresh_projects()', 'brain_chunks_missing_embedding(int)',
                           'brain_set_embeddings(jsonb)', 'brain_clear_embeddings()', 'brain_reset_index()',
                           'brain_log_event(text, text, text, text, text, jsonb)', 'brain_set_sync_state(jsonb)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
