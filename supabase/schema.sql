-- Turf'd — run once in Supabase SQL Editor (or migrate).
-- Profiles + authenticated room relay. RLS assumes a hostile anon key.

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_username_format check (username ~ '^[a-zA-Z0-9_]{3,20}$')
);

create unique index if not exists profiles_username_lower_key
  on public.profiles (lower(username));

grant select, insert, update on public.profiles to authenticated;

alter table public.profiles enable row level security;

create policy "profiles_select_own"
  on public.profiles for select to authenticated
  using (auth.uid() = id);

create policy "profiles_insert_own"
  on public.profiles for insert to authenticated
  with check (auth.uid() = id);

create policy "profiles_update_own"
  on public.profiles for update to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- New auth users get a row (trigger runs as security definer).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  suffix text;
begin
  suffix := substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
  insert into public.profiles (id, username)
  values (new.id, 'user_' || suffix);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.set_profiles_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_profiles_updated_at();

-- ---------------------------------------------------------------------------
-- turfd_room_sessions (no client SELECT; lookup via RPC only)
-- ---------------------------------------------------------------------------
create table if not exists public.turfd_room_sessions (
  room_code text primary key
    check (room_code ~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$'),
  host_peer_id text not null
    check (
      host_peer_id ~ '^turfd-host-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$'
      and substring(host_peer_id from 12) = room_code
    ),
  host_user_id uuid not null references auth.users (id) on delete cascade,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create or replace function public.set_turfd_room_sessions_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists turfd_room_sessions_set_updated_at on public.turfd_room_sessions;
create trigger turfd_room_sessions_set_updated_at
  before update on public.turfd_room_sessions
  for each row execute function public.set_turfd_room_sessions_updated_at();

alter table public.turfd_room_sessions enable row level security;

-- No SELECT policy: clients cannot list or read rows via PostgREST.

create policy "turfd_room_sessions_insert_host"
  on public.turfd_room_sessions for insert to authenticated
  with check (auth.uid() = host_user_id);

create policy "turfd_room_sessions_update_host"
  on public.turfd_room_sessions for update to authenticated
  using (auth.uid() = host_user_id)
  with check (auth.uid() = host_user_id);

create policy "turfd_room_sessions_delete_host"
  on public.turfd_room_sessions for delete to authenticated
  using (auth.uid() = host_user_id);

create or replace function public.lookup_room_host_peer(p_room_code text)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  pid text;
  code text;
begin
  if p_room_code is null or length(trim(p_room_code)) <> 6 then
    return null;
  end if;
  code := upper(trim(p_room_code));
  if code !~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$' then
    return null;
  end if;
  select s.host_peer_id into pid
  from public.turfd_room_sessions s
  where s.room_code = code
    and s.expires_at > now()
  limit 1;
  return pid;
end;
$$;

revoke all on public.turfd_room_sessions from public;
grant select, insert, update, delete on public.turfd_room_sessions to service_role;
grant insert, update, delete on public.turfd_room_sessions to authenticated;

grant execute on function public.lookup_room_host_peer(text) to anon;
grant execute on function public.lookup_room_host_peer(text) to authenticated;

-- Optional: schedule in Supabase (Database → Cron) to prune stale rows, e.g.:
-- delete from public.turfd_room_sessions where expires_at < now();
