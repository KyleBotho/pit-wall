-- Pit Wall sync (docs/history.md, item 12). Run once in Supabase: SQL Editor -> New query -> paste -> Run.
-- Safe to re-run. One row per signed-in user; RLS limits every user to their own row.

create table if not exists public.configs (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.configs enable row level security;

drop policy if exists "configs: read own"   on public.configs;
drop policy if exists "configs: insert own" on public.configs;
drop policy if exists "configs: update own" on public.configs;

create policy "configs: read own" on public.configs
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "configs: insert own" on public.configs
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "configs: update own" on public.configs
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- Explicit grants: signed-out visitors get nothing; signed-in users read/write (RLS still applies). No delete.
revoke all on public.configs from anon;
grant select, insert, update on public.configs to authenticated;

-- A settings row is tens of KB (an imported league with every member's rounds is the big part). Cap it at 1 MB
-- (stored, i.e. compressed) so an account can't use the table as free storage.
alter table public.configs drop constraint if exists configs_data_size;
alter table public.configs add constraint configs_data_size check (pg_column_size(data) < 1048576);

-- The server sets updated_at, so "Synced n min ago" doesn't depend on the browser's clock.
create or replace function public.configs_touch() returns trigger
  language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists configs_touch on public.configs;
create trigger configs_touch before insert or update on public.configs
  for each row execute function public.configs_touch();

-- Keep-alive for refresh.yml: a real database query callable with the public key, returns no data.
create or replace function public.ping() returns int
  language sql stable set search_path = '' as $$ select 1 $$;
grant execute on function public.ping() to anon;

-- Live feed cache for the "live" Edge Function (supabase/functions/live). One row per gameday: F1's public feed data,
-- nothing personal. RLS on with no policies and no grants: only the function (service role) reads or writes it.
create table if not exists public.live_cache (
  gd         int primary key,
  body       jsonb not null,
  fetched_at timestamptz not null default now()
);
alter table public.live_cache enable row level security;
revoke all on public.live_cache from anon, authenticated;
-- Scoring lines live in their own column, written only by the function's background run and merged in here, so a
-- request saving the player feed (body) and that run can never write over each other. stats_busy claims the run.
alter table public.live_cache add column if not exists stats jsonb not null default '{}'::jsonb;
alter table public.live_cache add column if not exists stats_busy timestamptz;
-- p_rest: F1 refused or failed, so keep the claim (nobody asks F1 again for a few minutes) instead of releasing it.
create or replace function public.live_stats_merge(p_gd int, p_patch jsonb, p_rest boolean default false)
  returns void language sql set search_path = '' as $$
  update public.live_cache
     set stats = stats || p_patch, stats_busy = case when p_rest then now() else null end
   where gd = p_gd
$$;
revoke all on function public.live_stats_merge(int, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.live_stats_merge(int, jsonb, boolean) to service_role;

-- Owners = the site's admins (web/js/lab.js, web/js/admin.js): they see the Sim lab tab and Settings > Admin, and
-- can change app_config (below). Each signed-in user can read only their own row, so the page learns "am I an
-- owner" and nothing about anyone else. No inserts from the page: add an owner here, in the SQL Editor:
--   insert into public.owners (user_id) select id from auth.users where email = '<your sign-in email>'
--   on conflict do nothing;
create table if not exists public.owners (
  user_id uuid primary key references auth.users (id) on delete cascade
);
alter table public.owners enable row level security;
revoke all on public.owners from anon, authenticated;
grant select on public.owners to authenticated;
drop policy if exists "owners: read own row" on public.owners;
create policy "owners: read own row" on public.owners
  for select to authenticated using ((select auth.uid()) = user_id);

-- Private leagues, read by signing in (no passphrase). The private repo's workflow (leagues.py) upserts the league
-- payload into league_data with the secret key; only accounts listed in league_readers can read it. Each signed-in
-- user can read only their own league_readers row. Add a reader in the SQL Editor:
--   insert into public.league_readers (user_id) select id from auth.users where email = '<sign-in email>'
--   on conflict do nothing;
create table if not exists public.league_readers (
  user_id uuid primary key references auth.users (id) on delete cascade
);
alter table public.league_readers enable row level security;
revoke all on public.league_readers from anon, authenticated;
grant select on public.league_readers to authenticated;
drop policy if exists "league_readers: read own row" on public.league_readers;
create policy "league_readers: read own row" on public.league_readers
  for select to authenticated using ((select auth.uid()) = user_id);

create table if not exists public.league_data (
  id         text primary key, -- "current": the whole payload the page reads
  body       jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.league_data enable row level security;
revoke all on public.league_data from anon, authenticated;
grant select on public.league_data to authenticated;
drop policy if exists "league_data: readers only" on public.league_data;
create policy "league_data: readers only" on public.league_data
  for select to authenticated
  using (exists (select 1 from public.league_readers r where r.user_id = (select auth.uid())));

-- Team Tracking (docs/team-tracking-plan.md). Users join Pit Wall's tracking league on F1 Fantasy, then link their
-- F1 Fantasy account once. No raw F1 ids are kept: an account is known by its account key (first 16 hex of
-- SHA-256 of F1's account guid; f1feeds.account_key, web/js/core.js accountKey).
--
-- tracked_accounts: one row per F1 account in the tracking league, written only by the private repo's workflow
-- (leagues.py, secret key). username = what users search for (they opted in by joining); teams = [{tk, no, name}];
-- body = those teams' history in the league-payload shape ({names, rounds, seen}, keyed by team key). Every signed-in
-- user can read it (search and loading); nobody signed out can.
create table if not exists public.tracked_accounts (
  account_key text primary key,
  username    text not null,
  teams       jsonb not null default '[]'::jsonb,
  body        jsonb not null default '{}'::jsonb,
  league      text not null, -- the tracking league's name (never its id)
  season      int not null,
  updated_at  timestamptz not null default now()
);
alter table public.tracked_accounts enable row level security;
revoke all on public.tracked_accounts from anon, authenticated;
grant select on public.tracked_accounts to authenticated;
drop policy if exists "tracked_accounts: signed-in read" on public.tracked_accounts;
create policy "tracked_accounts: signed-in read" on public.tracked_accounts
  for select to authenticated using (true);

-- account_links: which F1 account a Pit Wall account follows. One per Pit Wall account; any number of Pit Wall
-- accounts may follow the same F1 account (no unique key on account_key), so nobody can block its owner. Each user
-- reads and writes only their own row; deleting the Pit Wall account deletes the link.
create table if not exists public.account_links (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  account_key text not null check (account_key ~ '^[0-9a-f]{16}$'),
  linked_at   timestamptz not null default now()
);
alter table public.account_links enable row level security;
revoke all on public.account_links from anon, authenticated;
grant select, insert, update, delete on public.account_links to authenticated;
drop policy if exists "account_links: read own"   on public.account_links;
drop policy if exists "account_links: insert own" on public.account_links;
drop policy if exists "account_links: update own" on public.account_links;
drop policy if exists "account_links: delete own" on public.account_links;
create policy "account_links: read own" on public.account_links
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "account_links: insert own" on public.account_links
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "account_links: update own" on public.account_links
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "account_links: delete own" on public.account_links
  for delete to authenticated using ((select auth.uid()) = user_id);

-- app_config: settings that change from season to season, read by the page once signed in, e.g. the tracking
-- league's join code (kept out of the public page source). Signed-in users read; admins (accounts in owners, above)
-- change them in Settings > Admin. Or here:
--   insert into public.app_config (key, value) values ('tracking_join_code', '<code>')
--   on conflict (key) do update set value = excluded.value, updated_at = now();
create table if not exists public.app_config (
  key   text primary key,
  value text not null
);
alter table public.app_config add column if not exists updated_at timestamptz not null default now();
alter table public.app_config drop constraint if exists app_config_key_format;
alter table public.app_config add constraint app_config_key_format check (key ~ '^[a-z][a-z0-9_]{1,62}$');
alter table public.app_config drop constraint if exists app_config_value_size;
alter table public.app_config add constraint app_config_value_size check (length(value) <= 2000);
alter table public.app_config enable row level security;
revoke all on public.app_config from anon, authenticated;
grant select, insert, update, delete on public.app_config to authenticated;
grant select on public.app_config to anon;
drop policy if exists "app_config: signed-in read" on public.app_config;
drop policy if exists "app_config: public notice" on public.app_config;
drop policy if exists "app_config: admins insert" on public.app_config;
drop policy if exists "app_config: admins update" on public.app_config;
drop policy if exists "app_config: admins delete" on public.app_config;
create policy "app_config: signed-in read" on public.app_config
  for select to authenticated using (true);
-- the site notice is for everyone; every other setting (the join code...) only for signed-in users
create policy "app_config: public notice" on public.app_config
  for select to anon using (key = 'site_notice');
-- An admin is an account with an owners row (each user can see only their own, which is all this needs). Admins
-- change only the settings the page knows (web/js/admin.js CONFIG_KEYS): a new setting needs code that reads it,
-- so it's added here and there together.
create or replace function public.app_config_admin_key(k text) returns boolean
  language sql stable set search_path = '' as $$
  select k in ('site_notice', 'tracking_join_code', 'tracking_league_name', 'support_contact')
     and exists (select 1 from public.owners o where o.user_id = (select auth.uid()))
$$;
create policy "app_config: admins insert" on public.app_config
  for insert to authenticated with check (public.app_config_admin_key(key));
create policy "app_config: admins update" on public.app_config
  for update to authenticated
  using (public.app_config_admin_key(key)) with check (public.app_config_admin_key(key));
create policy "app_config: admins delete" on public.app_config
  for delete to authenticated using (public.app_config_admin_key(key));

-- Data refresh (supabase/functions/refresh): the site rebuilds when new data is due, not on a blind timer. The
-- function keeps one row here: the last plan entry it started the workflow for, the last start (scheduled or an
-- admin's "Refresh now") and the last error. Only the function (service role) reads or writes it.
create table if not exists public.refresh_state (
  id         int primary key default 1 check (id = 1),
  last_due   timestamptz,
  started_at timestamptz,
  source     text,
  reason     text,
  error      text,
  error_at   timestamptz
);
alter table public.refresh_state enable row level security;
revoke all on public.refresh_state from anon, authenticated;
insert into public.refresh_state (id) values (1) on conflict (id) do nothing;

-- The scheduler: every 5 minutes, ask the refresh function whether a plan entry fell due. Needs the pg_cron and
-- pg_net extensions (Database > Extensions, or the two lines below). Re-running this replaces the job. The URL's
-- last part is the function's slug: check it in Edge Functions if the function got a different name.
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.schedule(
  'pit-wall-refresh-tick',
  '*/5 * * * *',
  $$ select net.http_post(
       url := 'https://tfljgylwpkpammzsapin.supabase.co/functions/v1/refresh?tick=1',
       headers := '{"Content-Type": "application/json"}'::jsonb,
       body := '{}'::jsonb
     ) $$
);
