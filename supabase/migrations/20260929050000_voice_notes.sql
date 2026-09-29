-- Telegram voice notes (docs/08 "Voice notes"). The bot has no worker secret (CLAUDE.md rule 2), so Supabase is the
-- hand-off: the bot (service role) inserts the downloaded clip → the worker claims it (voice_note_claim), transcribes it
-- with config/models.yaml `transcription:` and finishes it (voice_note_finish) → the bot, polling the row, treats the
-- text exactly like a typed message.
-- The audio lives here only until it is transcribed: finishing (done or failed) clears it, a check keeps it that way,
-- and clips nobody finished within 5 minutes are expired (audio cleared) on the next claim.
-- Browser sessions: the CEO may read the metadata + transcript; nobody in a browser writes, claims or reads audio.

create table voice_notes (
  id          uuid primary key default gen_random_uuid(),
  chat_id     bigint not null,
  message_id  bigint not null,
  audio       bytea check (audio is null or octet_length(audio) <= 8 * 1024 * 1024),
  media_type  text not null,
  status      text not null default 'pending' check (status in ('pending', 'working', 'done', 'failed')),
  text        text,
  error       text,
  seconds     numeric,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- a finished clip never keeps its audio
  constraint voice_notes_audio_cleared check (status in ('pending', 'working') or audio is null)
);
create index voice_notes_pending on voice_notes (created_at) where status in ('pending', 'working');
create trigger t_voice_notes_touch before update on voice_notes for each row execute function touch_updated_at();

alter table voice_notes enable row level security;
create policy ceo_read on voice_notes for select to authenticated using (is_ceo());
revoke all on voice_notes from anon, authenticated;
grant select (id, chat_id, message_id, media_type, status, text, error, seconds, created_at, updated_at) on voice_notes to authenticated;
grant all on voice_notes to service_role;

-- ---------- worker only ----------
-- The oldest waiting clip, locked so two workers never transcribe the same one ('pending' → 'working'). A null row
-- (all columns null) when there is nothing to do. Clips older than 5 minutes are expired first: the bot stopped
-- waiting long ago, so their audio is dropped instead of transcribed.
create or replace function voice_note_claim() returns voice_notes
language plpgsql security definer set search_path = public as $$
declare v voice_notes;
begin
  perform vault_service_guard();
  update voice_notes set status = 'failed', error = 'expired before it was transcribed', audio = null
  where status in ('pending', 'working') and created_at < now() - interval '5 minutes';
  select * into v from voice_notes where status = 'pending' and audio is not null
  order by created_at for update skip locked limit 1;
  if v.id is null then return null; end if;
  update voice_notes set status = 'working' where id = v.id returning * into v;
  return v;
end $$;

-- done (text) or failed (error); the audio is cleared either way. Only a clip that is still 'working' is finished
-- (the bot may have given up on it meanwhile). Returns whether the row was finished.
create or replace function voice_note_finish(p_id uuid, p_text text, p_error text default null, p_seconds numeric default null)
returns boolean
language plpgsql security definer set search_path = public as $$
declare ok boolean := coalesce(trim(p_text), '') <> '' and p_error is null;
begin
  perform vault_service_guard();
  update voice_notes
  set status = case when ok then 'done' else 'failed' end,
      text = case when ok then left(trim(p_text), 4000) else null end,
      error = case when ok then null else left(coalesce(nullif(trim(p_error), ''), 'No words were recognised.'), 500) end,
      seconds = coalesce(p_seconds, seconds),
      audio = null
  where id = p_id and status = 'working';
  return found;
end $$;

do $$
declare f text;
begin
  foreach f in array array['voice_note_claim()', 'voice_note_finish(uuid,text,text,numeric)']
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
