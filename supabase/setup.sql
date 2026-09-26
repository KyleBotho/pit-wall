-- Pit Wall sync (CLAUDE.md item 12). Run once in Supabase: SQL Editor -> New query -> paste -> Run.
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

-- Sim lab gate (web/js/lab.js): accounts listed here see the owner-only Sim lab tab. Each signed-in user can read
-- only their own row, so the page learns "am I an owner" and nothing about anyone else. No inserts from the page:
-- add an owner here, in the SQL Editor:
--   insert into public.owners (user_id) select id from auth.users where email = '<your sign-in email>'
--   on conflict do nothing;
create table if not exists public.owners (
  user_id uuid primary key references auth.users (id) on delete cascade
);
alter table public.owners enable row level security;
revoke all on public.owners from anon, authenticated;
grant select on public.owners to authenticated;
drop policy if exists "owners: read own row" on public.owners;
create policy "owners: read own row" on public.owners for select to authenticated using (auth.uid() = user_id);
