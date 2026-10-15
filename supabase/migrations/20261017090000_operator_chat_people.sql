-- Julev Operator phase 3, milestone 8b (docs/17-OPERATOR.md "People to watch"): per client, the people whose chat
-- messages count (Google Chat, Slack, Teams, WhatsApp). Messages from anyone else are still stored (history the
-- drafter reads for context) but never drafted: they stay FYI. Empty list = everyone (unchanged). Gmail has its own list
-- (operator_email_targets), where non-targets are not stored at all.

create table operator_chat_people (
  client_slug  text not null references operator_clients(slug) on delete cascade,
  name         text not null check (length(name) between 2 and 120 and name = lower(name)),
  created_at   timestamptz not null default now(),
  primary key (client_slug, name)
);
alter table operator_chat_people enable row level security;
create policy ceo_read on operator_chat_people for select to authenticated using (is_ceo());
revoke all on operator_chat_people from anon, authenticated;
grant select on operator_chat_people to authenticated;

-- A name matches when it is part of the sender's display name ("riley" matches "Riley Chen"); digits-only entries match
-- WhatsApp numbers ("639171112222" or "+63 917 111 2222").
create or replace function operator_chat_person_match(p_client text, p_sender text) returns boolean
language sql stable security definer set search_path = public as $$
  select not exists (select 1 from operator_chat_people where client_slug = p_client)
      or exists (select 1 from operator_chat_people p where p.client_slug = p_client and (
            lower(coalesce(p_sender, '')) like '%' || p.name || '%'
         or (regexp_replace(p.name, '\D', '', 'g') <> '' and length(regexp_replace(p.name, '\D', '', 'g')) >= 6
             and regexp_replace(coalesce(p_sender, ''), '\D', '', 'g') like '%' || regexp_replace(p.name, '\D', '', 'g') || '%')));
$$;

-- The wrapper of 20261017080000_operator_email.sql, plus: in chats, only the people to watch get drafts.
create or replace function operator_record_draft(p_inbox uuid, p_result jsonb) returns text
language plpgsql security definer set search_path = public as $$
declare r operator_inbox; c operator_clients; ch operator_channels; addressed boolean; res jsonb := p_result;
begin
  perform hq_guard();
  select * into r from operator_inbox where id = p_inbox;
  if r.id is not null and coalesce(p_result ->> 'category', '') in ('reply', 'task') then
    select * into c from operator_clients where slug = r.client_slug;
    select * into ch from operator_channels where id = r.channel_id;
    if ch.kind <> 'gmail' and r.opened_at is null and not operator_chat_person_match(r.client_slug, r.sender_name) then
      res := p_result || jsonb_build_object('category', 'fyi', 'draft', '', 'not_watched_person', true, 'drafted_category', p_result ->> 'category');
    else
      addressed := ch.direct or ch.kind = 'whatsapp' or r.mentions_me or r.opened_at is not null
                   or coalesce((p_result ->> 'addressed_to_julev')::boolean, false);
      if coalesce(c.reply_when, 'addressed') = 'addressed' and not addressed then
        res := p_result || jsonb_build_object('category', 'fyi', 'draft', '', 'not_addressed', true, 'drafted_category', p_result ->> 'category');
      end if;
    end if;
  end if;
  return operator_record_draft_tiers(p_inbox, res);
end $$;

create or replace function operator_set_chat_people(p_client text, p_names text[]) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform hq_guard();
  if not exists (select 1 from operator_clients where slug = p_client) then raise exception 'unknown client %', p_client; end if;
  delete from operator_chat_people where client_slug = p_client;
  insert into operator_chat_people (client_slug, name)
  select distinct p_client, lower(btrim(x)) from unnest(coalesce(p_names, '{}')) x where length(btrim(x)) between 2 and 120
  on conflict do nothing;
  get diagnostics n = row_count;
  if (select count(*) from operator_chat_people where client_slug = p_client) > 100 then raise exception 'at most 100 people'; end if;
  perform operator_log('ceo', 'chat_people.set', p_client, null, jsonb_build_object('count', n));
  return n;
end $$;

do $$
begin
  execute 'revoke execute on function operator_chat_person_match(text,text) from public, anon, authenticated';
  execute 'grant execute on function operator_chat_person_match(text,text) to service_role';
  execute 'revoke execute on function operator_record_draft(uuid,jsonb) from public, anon, authenticated';
  execute 'grant execute on function operator_record_draft(uuid,jsonb) to service_role';
  execute 'revoke execute on function operator_set_chat_people(text,text[]) from public, anon';
  execute 'grant execute on function operator_set_chat_people(text,text[]) to authenticated, service_role';
end $$;
