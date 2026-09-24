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
