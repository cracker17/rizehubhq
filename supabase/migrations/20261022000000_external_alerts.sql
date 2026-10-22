-- External alerts: other apps (Hushdesk first) tell the CEO about problems through HQ.
--   POST https://hq.rizehub.ph/api/notify (dashboard, public) → worker /hooks/notify verifies the HMAC
--   (HQ_NOTIFY_SECRET) and stores the alert here once (id = the sender's idempotency key).
--   The bot sends it to Telegram (critical at any hour, the rest outside quiet hours) and marks telegram_sent_at;
--   the worker emails it through "Email me updates" and marks email_sent_at.
-- The worker's uptime watch (UPTIME_URLS) writes here too (source 'uptime').

create table if not exists external_alerts (
  id                text primary key check (id ~ '^[A-Za-z0-9_.:-]{1,120}$'),
  source            text not null check (source ~ '^[a-z0-9-]{1,40}$'),
  level             text not null check (level in ('info', 'warning', 'error', 'critical')),
  title             text not null check (char_length(title) between 1 and 200),
  body              text not null default '' check (char_length(body) <= 4000),
  url               text check (url is null or (url ~ '^https://' and char_length(url) <= 500)),
  received_at       timestamptz not null default now(),
  telegram_sent_at  timestamptz,                                 -- set once by the bot
  email_sent_at     timestamptz,                                 -- set once by the worker (or when email is off)
  email_error       text
);
create index if not exists external_alerts_unsent_tg on external_alerts (received_at) where telegram_sent_at is null;
create index if not exists external_alerts_unsent_email on external_alerts (received_at) where email_sent_at is null;
alter table external_alerts enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'external_alerts' and policyname = 'ceo_all') then
    create policy ceo_all on external_alerts for all to authenticated using (is_ceo()) with check (is_ceo());
  end if;
end $$;
