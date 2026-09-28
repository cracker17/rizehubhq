# Production Supabase for RizeHub HQ

One hosted Supabase project is the only contract between the dashboard, worker and bot. Do this once, from your laptop (Supabase CLI), before running `deploy/setup-vps.sh`. It takes about 20 minutes.

## 1. Create the project
1. https://supabase.com/dashboard → **New project**.
2. Name `rizehub-hq`, region **Southeast Asia (Singapore)** (`ap-southeast-1`, the lowest latency from the PH and the VPS).
3. Generate a strong **database password** and store it in your password manager. You need it for `supabase link` and backups.
4. Turn on 2FA for your supabase.com account itself (Account → Security). Whoever controls that account controls all HQ data.

> Free plan: projects pause after about a week without API activity. The worker polls constantly, so a running HQ keeps it awake. If the VPS is down for a week, un-pause the project in the dashboard.

## 2. Apply the schema (migrations)
From the repo root on your laptop:
```bash
supabase login
supabase link --project-ref <project-ref>        # asks for the database password
supabase db push --dry-run                       # lists the migrations it will apply
supabase db push                                 # applies supabase/migrations/* in order
```
Later schema changes follow the same path: add a **new** migration file, `pnpm db:test` passes in CI, run `supabase db push`, **then** deploy the code. `deploy/update.sh` prints a warning whenever a deploy contains new migrations.

## 3. Seed (once)
The migrations already create the 6 agents (`20260928080000_six_agent_roster.sql`); `supabase/seed.sql` upserts them again and inserts the default settings. The settings part is **not** idempotent, so run it once:
```bash
psql "<session-pooler connection string>" -v ON_ERROR_STOP=1 -f supabase/seed.sql
```
(or open **SQL Editor → New query**, paste the file and run it). Check:
```sql
select count(*) from agents;          -- 6
```

## 4. Auth settings
**Authentication → Sign In / Providers**
- **Email**: enabled. Password sign-in is what the dashboard uses.
- **Allow new users to sign up**: **OFF**. Only you exist as a user; RLS (`is_ceo()`) would block strangers anyway, but don't let them create accounts.

**Authentication → URL Configuration**
- Site URL: `https://hq.rizehub.ph`
- Redirect URLs: `https://hq.rizehub.ph/**`

## 5. Create the CEO user
1. **Authentication → Users → Add user → Create new user**, with your email and a long unique password, and **Auto Confirm User** ticked.
2. **SQL Editor**:
```sql
insert into ceo_users (user_id)
select id from auth.users where email = 'you@example.com'
on conflict (user_id) do nothing;

select u.email, c.created_at from ceo_users c join auth.users u on u.id = c.user_id;   -- your email
```
Without this row you can log in but see nothing (RLS).

## 6. Storage bucket `evidence` (private)
QA screenshots and Lighthouse reports go here. The worker creates the bucket on first use, but create it now so permissions are explicit:
```sql
insert into storage.buckets (id, name, public, file_size_limit)
values ('evidence', 'evidence', false, 20971520)          -- private, 20 MB per file
on conflict (id) do update set public = false;
```
No storage policies are needed. Only the worker (service role) writes, and the dashboard shows files through short-lived signed URLs. **Never** make this bucket public: evidence can show client admin screens.

## 7. Two-factor (recommended)
- TOTP MFA is available by default in Supabase Auth (**Authentication → Multi-Factor**). Keep **TOTP** enabled.
- The dashboard's TOTP enrol/verify screen is still a TODO (apps/dashboard/README.md "Two-factor", roadmap M12). Until it ships, your protection is a unique, long password plus 2FA on the supabase.com account (step 1.4), with sign-ups disabled (step 4).

## 8. Copy the keys into the VPS `.env`
**Project Settings → API** (or **API Keys**):

| .env | Value |
|---|---|
| `SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon key (`eyJ…`, role anon) or publishable key (`sb_publishable_…`) |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key (`eyJ…`, role service_role) or secret key (`sb_secret_…`). **Server only** |
| `SUPABASE_DB_URL` (backups) | **Connect → Session pooler** string (IPv4): `postgresql://postgres.<ref>:<password>@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres` |

`pnpm check:env -- --production` (and `setup-vps.sh`) catches the classic mistakes: swapped anon/service keys, localhost URLs, a missing https.

## 9. Verify
```sql
select count(*) from agents;                                    -- 6
select * from pg_publication_tables where pubname = 'supabase_realtime' limit 3;   -- agents, requests, tasks…
select id, public from storage.buckets where id = 'evidence';   -- evidence | false
```
Then, once the VPS stack runs: log in at https://hq.rizehub.ph and the office shows the 6 agents. Change an agent's status in **Table Editor → agents** and the tile updates live (Realtime).

## Backups
- `deploy/backup.sh` (cron on the VPS) → nightly `pg_dump` of the `public` schema, rotated after `BACKUP_KEEP_DAYS`.
- The free plan has no Supabase-side point-in-time recovery; Pro adds daily backups. Copy dumps off the VPS as well.
- `VAULT_MASTER_KEY` is **not** in any dump. Without it, restored vault credentials are unreadable, so keep it in your password manager.
