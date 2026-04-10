-- Stratum — run once in Supabase SQL Editor (or migrate).
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

drop policy if exists "profiles_select_own" on public.profiles;
drop policy if exists "profiles_insert_own" on public.profiles;
drop policy if exists "profiles_update_own" on public.profiles;

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
-- stratum_room_sessions (no client SELECT; lookup via RPC only)
-- ---------------------------------------------------------------------------
create table if not exists public.stratum_room_sessions (
  room_code text primary key
    check (room_code ~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$'),
  host_peer_id text not null
    check (
      host_peer_id ~ '^stratum-host-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$'
      and substring(host_peer_id from 14) = room_code
    ),
  host_user_id uuid not null references auth.users (id) on delete cascade,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  room_title text not null default 'Room',
  motd text not null default '',
  world_name text not null default '',
  is_private boolean not null default false,
  password_hash text null,
  constraint stratum_room_sessions_room_title_len check (char_length(room_title) between 1 and 48),
  constraint stratum_room_sessions_motd_len check (char_length(motd) <= 280)
);

create or replace function public.set_stratum_room_sessions_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists stratum_room_sessions_set_updated_at on public.stratum_room_sessions;
create trigger stratum_room_sessions_set_updated_at
  before update on public.stratum_room_sessions
  for each row execute function public.set_stratum_room_sessions_updated_at();

-- Hosts call touch_stratum_room_session ~every 60s while online. Directory
-- listing and join lookup require updated_at within this window so closed
-- tabs (which never run clearRoom) stop advertising within a few minutes.
create or replace function public.stratum_room_session_is_directory_live(
  p_expires_at timestamptz,
  p_updated_at timestamptz
)
returns boolean
language sql
stable
as $$
  select p_expires_at > now()
    and p_updated_at > now() - interval '3 minutes';
$$;

grant execute on function public.stratum_room_session_is_directory_live(
  timestamptz,
  timestamptz
) to anon, authenticated;

alter table public.stratum_room_sessions enable row level security;

-- No SELECT policy: clients cannot list or read rows via PostgREST.

drop policy if exists "stratum_room_sessions_insert_host" on public.stratum_room_sessions;
drop policy if exists "stratum_room_sessions_update_host" on public.stratum_room_sessions;
drop policy if exists "stratum_room_sessions_delete_host" on public.stratum_room_sessions;

create policy "stratum_room_sessions_insert_host"
  on public.stratum_room_sessions for insert to authenticated
  with check (auth.uid() = host_user_id);

create policy "stratum_room_sessions_update_host"
  on public.stratum_room_sessions for update to authenticated
  using (auth.uid() = host_user_id)
  with check (auth.uid() = host_user_id);

create policy "stratum_room_sessions_delete_host"
  on public.stratum_room_sessions for delete to authenticated
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
  from public.stratum_room_sessions s
  where s.room_code = code
    and public.stratum_room_session_is_directory_live(s.expires_at, s.updated_at)
    and coalesce(s.is_private, false) = false
  limit 1;
  return pid;
end;
$$;

revoke all on public.stratum_room_sessions from public;
grant select, insert, update, delete on public.stratum_room_sessions to service_role;
grant insert, update, delete on public.stratum_room_sessions to authenticated;

grant execute on function public.lookup_room_host_peer(text) to anon;
grant execute on function public.lookup_room_host_peer(text) to authenticated;

-- Optional: schedule in Supabase (Database → Cron) to prune stale rows, e.g.:
-- delete from public.stratum_room_sessions where expires_at < now();

-- ---------------------------------------------------------------------------
-- Migration: room directory columns (no-op if already present)
-- ---------------------------------------------------------------------------
alter table public.stratum_room_sessions
  add column if not exists room_title text not null default 'Room';
alter table public.stratum_room_sessions
  add column if not exists motd text not null default '';
alter table public.stratum_room_sessions
  add column if not exists world_name text not null default '';
alter table public.stratum_room_sessions
  add column if not exists is_private boolean not null default false;
alter table public.stratum_room_sessions
  add column if not exists password_hash text null;

alter table public.stratum_room_sessions
  drop constraint if exists stratum_room_sessions_room_title_len;
alter table public.stratum_room_sessions
  add constraint stratum_room_sessions_room_title_len
    check (char_length(room_title) between 1 and 48);

alter table public.stratum_room_sessions
  drop constraint if exists stratum_room_sessions_motd_len;
alter table public.stratum_room_sessions
  add constraint stratum_room_sessions_motd_len
    check (char_length(motd) <= 280);

create index if not exists stratum_room_sessions_expires_idx
  on public.stratum_room_sessions (expires_at);
create index if not exists stratum_room_sessions_updated_idx
  on public.stratum_room_sessions (updated_at desc);

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- stratum_room_comments
-- ---------------------------------------------------------------------------
create table if not exists public.stratum_room_comments (
  id uuid primary key default gen_random_uuid(),
  room_code text not null references public.stratum_room_sessions (room_code) on delete cascade,
  author_id uuid not null references auth.users (id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  constraint stratum_room_comments_body_len check (char_length(body) between 1 and 500)
);

create index if not exists stratum_room_comments_room_idx
  on public.stratum_room_comments (room_code, created_at desc);

alter table public.stratum_room_comments enable row level security;

grant select, insert on public.stratum_room_comments to authenticated;
grant select on public.stratum_room_comments to anon;

drop policy if exists "stratum_room_comments_select_active" on public.stratum_room_comments;
drop policy if exists "stratum_room_comments_insert_own" on public.stratum_room_comments;

create policy "stratum_room_comments_select_active"
  on public.stratum_room_comments for select
  to anon, authenticated
  using (
    exists (
      select 1 from public.stratum_room_sessions s
      where s.room_code = stratum_room_comments.room_code
        and public.stratum_room_session_is_directory_live(s.expires_at, s.updated_at)
    )
  );

create policy "stratum_room_comments_insert_own"
  on public.stratum_room_comments for insert
  to authenticated
  with check (
    author_id = auth.uid()
    and exists (
      select 1 from public.stratum_room_sessions s
      where s.room_code = stratum_room_comments.room_code
        and public.stratum_room_session_is_directory_live(s.expires_at, s.updated_at)
    )
  );

-- ---------------------------------------------------------------------------
-- stratum_room_ratings (1–5 stars, one row per user per room)
-- ---------------------------------------------------------------------------
create table if not exists public.stratum_room_ratings (
  room_code text not null references public.stratum_room_sessions (room_code) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  stars smallint not null,
  updated_at timestamptz not null default now(),
  primary key (room_code, user_id),
  constraint stratum_room_ratings_stars check (stars between 1 and 5)
);

create index if not exists stratum_room_ratings_room_idx
  on public.stratum_room_ratings (room_code);

alter table public.stratum_room_ratings enable row level security;

grant select, insert, update on public.stratum_room_ratings to authenticated;
grant select on public.stratum_room_ratings to anon;

drop policy if exists "stratum_room_ratings_select_active" on public.stratum_room_ratings;
drop policy if exists "stratum_room_ratings_insert_own" on public.stratum_room_ratings;
drop policy if exists "stratum_room_ratings_update_own" on public.stratum_room_ratings;

create policy "stratum_room_ratings_select_active"
  on public.stratum_room_ratings for select
  to anon, authenticated
  using (
    exists (
      select 1 from public.stratum_room_sessions s
      where s.room_code = stratum_room_ratings.room_code
        and public.stratum_room_session_is_directory_live(s.expires_at, s.updated_at)
    )
  );

create policy "stratum_room_ratings_insert_own"
  on public.stratum_room_ratings for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.stratum_room_sessions s
      where s.room_code = stratum_room_ratings.room_code
        and public.stratum_room_session_is_directory_live(s.expires_at, s.updated_at)
    )
  );

create policy "stratum_room_ratings_update_own"
  on public.stratum_room_ratings for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- RPC: join with optional password (public + private rooms)
-- ---------------------------------------------------------------------------
create or replace function public.lookup_room_host_peer_for_join(
  p_room_code text,
  p_password text
)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  rec record;
  code text;
begin
  if p_room_code is null or length(trim(p_room_code)) <> 6 then
    return null;
  end if;
  code := upper(trim(p_room_code));
  if code !~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$' then
    return null;
  end if;
  select s.host_peer_id, s.is_private, s.password_hash
    into rec
  from public.stratum_room_sessions s
  where s.room_code = code
    and public.stratum_room_session_is_directory_live(s.expires_at, s.updated_at)
  limit 1;
  if rec.host_peer_id is null then
    return null;
  end if;
  if not coalesce(rec.is_private, false) then
    return rec.host_peer_id;
  end if;
  if rec.password_hash is null then
    return null;
  end if;
  if p_password is null or length(trim(p_password)) < 1 then
    return null;
  end if;
  if extensions.crypt(p_password, rec.password_hash) = rec.password_hash then
    return rec.host_peer_id;
  end if;
  return null;
end;
$$;

grant execute on function public.lookup_room_host_peer_for_join(text, text) to anon;
grant execute on function public.lookup_room_host_peer_for_join(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- RPC: host upsert session + metadata + optional password (server-side hash)
-- ---------------------------------------------------------------------------
create or replace function public.upsert_stratum_room_session(
  p_room_code text,
  p_host_peer_id text,
  p_room_title text,
  p_motd text,
  p_world_name text,
  p_is_private boolean,
  p_password_plain text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  code text;
  v_hash text;
  v_expires timestamptz;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if p_room_code is null or length(trim(p_room_code)) <> 6 then
    raise exception 'invalid room code';
  end if;
  code := upper(trim(p_room_code));
  if code !~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$' then
    raise exception 'invalid room code';
  end if;
  if p_host_peer_id is null
    or p_host_peer_id !~ '^stratum-host-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$'
    or substring(p_host_peer_id from 14) <> code
  then
    raise exception 'invalid host peer id';
  end if;
  if p_room_title is null or char_length(trim(p_room_title)) < 1
    or char_length(p_room_title) > 48
  then
    raise exception 'invalid room title';
  end if;
  if p_motd is null or char_length(p_motd) > 280 then
    raise exception 'invalid motd';
  end if;
  if coalesce(p_is_private, false) then
    if p_password_plain is null or char_length(trim(p_password_plain)) < 4 then
      raise exception 'private rooms require a password of at least 4 characters';
    end if;
    v_hash := extensions.crypt(p_password_plain, extensions.gen_salt('bf'));
  else
    v_hash := null;
  end if;
  v_expires := now() + interval '4 hours';
  insert into public.stratum_room_sessions (
    room_code,
    host_peer_id,
    host_user_id,
    expires_at,
    room_title,
    motd,
    world_name,
    is_private,
    password_hash
  )
  values (
    code,
    p_host_peer_id,
    auth.uid(),
    v_expires,
    trim(p_room_title),
    coalesce(p_motd, ''),
    coalesce(trim(p_world_name), ''),
    coalesce(p_is_private, false),
    v_hash
  )
  on conflict (room_code) do update set
    host_peer_id = excluded.host_peer_id,
    host_user_id = excluded.host_user_id,
    expires_at = excluded.expires_at,
    room_title = excluded.room_title,
    motd = excluded.motd,
    world_name = excluded.world_name,
    is_private = excluded.is_private,
    password_hash = excluded.password_hash,
    updated_at = now()
  where public.stratum_room_sessions.host_user_id = auth.uid();
end;
$$;

grant execute on function public.upsert_stratum_room_session(
  text, text, text, text, text, boolean, text
) to authenticated;

-- ---------------------------------------------------------------------------
-- RPC: host heartbeat (activity sort + extend lease)
-- ---------------------------------------------------------------------------
create or replace function public.touch_stratum_room_session(p_room_code text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  code text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if p_room_code is null or length(trim(p_room_code)) <> 6 then
    return;
  end if;
  code := upper(trim(p_room_code));
  update public.stratum_room_sessions s
  set
    expires_at = now() + interval '4 hours',
    updated_at = now()
  where s.room_code = code
    and s.host_user_id = auth.uid();
end;
$$;

grant execute on function public.touch_stratum_room_session(text) to authenticated;

-- ---------------------------------------------------------------------------
-- RPC: list public room directory (safe fields only)
-- ---------------------------------------------------------------------------
create or replace function public.list_stratum_rooms(
  p_search text,
  p_filter text,
  p_sort text,
  p_limit int,
  p_offset int
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  lim int := least(coalesce(p_limit, 40), 80);
  off int := greatest(coalesce(p_offset, 0), 0);
  filt text := lower(coalesce(nullif(trim(p_filter), ''), 'all'));
  sort_mode text := lower(coalesce(nullif(trim(p_sort), ''), 'active'));
  q text := trim(coalesce(p_search, ''));
begin
  return coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'room_code', u.room_code,
          'room_title', u.room_title,
          'motd', u.motd,
          'world_name', u.world_name,
          'is_private', u.is_private,
          'updated_at', u.updated_at,
          'expires_at', u.expires_at,
          'host_username', u.host_username,
          'avg_rating', u.avg_rating,
          'rating_count', u.rating_count,
          'comment_count', u.comment_count
        )
        order by u._o1 desc nulls last, u._o2 desc nulls last, u.room_code
      )
      from (
        select
          s.room_code,
          s.room_title,
          s.motd,
          s.world_name,
          s.is_private,
          s.updated_at,
          s.expires_at,
          coalesce(p.username, '') as host_username,
          coalesce(r.avg_stars, 0)::numeric(3,2) as avg_rating,
          coalesce(r.cnt, 0)::int as rating_count,
          coalesce(c.cnt, 0)::int as comment_count,
          case sort_mode
            when 'rating' then coalesce(r.avg_stars, 0)::double precision
            else extract(epoch from s.updated_at)
          end as _o1,
          case sort_mode
            when 'rating' then coalesce(r.cnt, 0)::double precision
            else 0::double precision
          end as _o2
        from public.stratum_room_sessions s
        left join public.profiles p on p.id = s.host_user_id
        left join lateral (
          select avg(x.stars)::numeric as avg_stars, count(*)::bigint as cnt
          from public.stratum_room_ratings x
          where x.room_code = s.room_code
        ) r on true
        left join lateral (
          select count(*)::bigint as cnt
          from public.stratum_room_comments y
          where y.room_code = s.room_code
        ) c on true
        where public.stratum_room_session_is_directory_live(s.expires_at, s.updated_at)
          and (
            q = ''
            or s.room_title ilike '%' || q || '%'
            or s.motd ilike '%' || q || '%'
            or s.world_name ilike '%' || q || '%'
          )
          and (
            filt = 'all'
            or (filt = 'public' and s.is_private = false)
            or (filt = 'private' and s.is_private = true)
          )
        order by
          case sort_mode when 'active' then extract(epoch from s.updated_at) end desc nulls last,
          case sort_mode when 'new' then extract(epoch from s.updated_at) end desc nulls last,
          case sort_mode when 'rating' then coalesce(r.avg_stars, 0) end desc nulls last,
          case sort_mode when 'rating' then coalesce(r.cnt, 0) end desc,
          s.room_code
        limit lim offset off
      ) u
    ),
    '[]'::jsonb
  );
end;
$$;

grant execute on function public.list_stratum_rooms(text, text, text, int, int) to anon;
grant execute on function public.list_stratum_rooms(text, text, text, int, int) to authenticated;

-- ---------------------------------------------------------------------------
-- RPC: list comments with author usernames (profiles are not world-readable)
-- ---------------------------------------------------------------------------
create or replace function public.list_stratum_room_comments(
  p_room_code text,
  p_limit int,
  p_offset int
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  code text;
  lim int := least(coalesce(p_limit, 50), 100);
  off int := greatest(coalesce(p_offset, 0), 0);
begin
  if p_room_code is null or length(trim(p_room_code)) <> 6 then
    return '[]'::jsonb;
  end if;
  code := upper(trim(p_room_code));
  if code !~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$' then
    return '[]'::jsonb;
  end if;
  if not exists (
    select 1 from public.stratum_room_sessions s
    where s.room_code = code
      and public.stratum_room_session_is_directory_live(s.expires_at, s.updated_at)
  ) then
    return '[]'::jsonb;
  end if;
  return coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'id', x.id,
          'body', x.body,
          'created_at', x.created_at,
          'author_username', x.author_username
        )
        order by x.created_at desc
      )
      from (
        select
          c.id,
          c.body,
          c.created_at,
          coalesce(p.username, '') as author_username
        from public.stratum_room_comments c
        left join public.profiles p on p.id = c.author_id
        where c.room_code = code
        order by c.created_at desc
        limit lim offset off
      ) x
    ),
    '[]'::jsonb
  );
end;
$$;

grant execute on function public.list_stratum_room_comments(text, int, int) to anon;
grant execute on function public.list_stratum_room_comments(text, int, int) to authenticated;

-- Direct INSERT/UPDATE on sessions table: hosts must use upsert RPC (password hashing).
revoke insert, update on public.stratum_room_sessions from authenticated;
grant delete on public.stratum_room_sessions to authenticated;

-- ---------------------------------------------------------------------------
-- Workshop mods (stratum_mods + comments + ratings)
-- ---------------------------------------------------------------------------
create table if not exists public.stratum_mods (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  description text not null default '',
  mod_id text not null,
  version text not null,
  mod_type text not null
    check (mod_type in ('behavior_pack', 'resource_pack', 'world')),
  file_path text not null,
  cover_path text not null default '',
  file_size integer not null,
  download_count integer not null default 0,
  is_published boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint stratum_mods_mod_id_len check (char_length(mod_id) between 1 and 128),
  constraint stratum_mods_name_len check (char_length(name) between 1 and 64),
  constraint stratum_mods_version_len check (char_length(version) between 1 and 32)
);

create unique index if not exists stratum_mods_mod_id_version_key
  on public.stratum_mods (mod_id, version);

create index if not exists stratum_mods_published_type_created_idx
  on public.stratum_mods (is_published, mod_type, created_at desc);

create index if not exists stratum_mods_owner_idx
  on public.stratum_mods (owner_id);

alter table public.stratum_mods enable row level security;

grant select, insert, update, delete on public.stratum_mods to authenticated;
grant select on public.stratum_mods to anon;

drop policy if exists "stratum_mods_select_published" on public.stratum_mods;
drop policy if exists "stratum_mods_select_own" on public.stratum_mods;
drop policy if exists "stratum_mods_insert_own" on public.stratum_mods;
drop policy if exists "stratum_mods_update_own" on public.stratum_mods;
drop policy if exists "stratum_mods_delete_own" on public.stratum_mods;

create policy "stratum_mods_select_published"
  on public.stratum_mods for select
  to anon, authenticated
  using (is_published = true);

create policy "stratum_mods_select_own"
  on public.stratum_mods for select
  to authenticated
  using (auth.uid() = owner_id);

create policy "stratum_mods_insert_own"
  on public.stratum_mods for insert
  to authenticated
  with check (auth.uid() = owner_id);

create policy "stratum_mods_update_own"
  on public.stratum_mods for update
  to authenticated
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

create policy "stratum_mods_delete_own"
  on public.stratum_mods for delete
  to authenticated
  using (auth.uid() = owner_id);

create or replace function public.set_stratum_mods_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists stratum_mods_set_updated_at on public.stratum_mods;
create trigger stratum_mods_set_updated_at
  before update on public.stratum_mods
  for each row execute function public.set_stratum_mods_updated_at();

-- ---------------------------------------------------------------------------
-- stratum_mod_comments (body length matches room comments: 1–500)
-- ---------------------------------------------------------------------------
create table if not exists public.stratum_mod_comments (
  id uuid primary key default gen_random_uuid(),
  mod_uuid uuid not null references public.stratum_mods (id) on delete cascade,
  author_id uuid not null references auth.users (id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  constraint stratum_mod_comments_body_len check (char_length(body) between 1 and 500)
);

create index if not exists stratum_mod_comments_mod_idx
  on public.stratum_mod_comments (mod_uuid, created_at desc);

alter table public.stratum_mod_comments enable row level security;

grant select, insert, delete on public.stratum_mod_comments to authenticated;
grant select on public.stratum_mod_comments to anon;

drop policy if exists "stratum_mod_comments_select_published" on public.stratum_mod_comments;
drop policy if exists "stratum_mod_comments_insert_own" on public.stratum_mod_comments;
drop policy if exists "stratum_mod_comments_delete_own" on public.stratum_mod_comments;

create policy "stratum_mod_comments_select_published"
  on public.stratum_mod_comments for select
  to anon, authenticated
  using (
    exists (
      select 1 from public.stratum_mods m
      where m.id = stratum_mod_comments.mod_uuid
        and m.is_published = true
    )
  );

create policy "stratum_mod_comments_insert_own"
  on public.stratum_mod_comments for insert
  to authenticated
  with check (
    author_id = auth.uid()
    and exists (
      select 1 from public.stratum_mods m
      where m.id = stratum_mod_comments.mod_uuid
        and m.is_published = true
    )
  );

create policy "stratum_mod_comments_delete_own"
  on public.stratum_mod_comments for delete
  to authenticated
  using (author_id = auth.uid());

-- ---------------------------------------------------------------------------
-- stratum_mod_ratings (1–5 stars, one row per user per mod; mirrors room ratings)
-- ---------------------------------------------------------------------------
create table if not exists public.stratum_mod_ratings (
  mod_uuid uuid not null references public.stratum_mods (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  stars smallint not null,
  updated_at timestamptz not null default now(),
  primary key (mod_uuid, user_id),
  constraint stratum_mod_ratings_stars check (stars between 1 and 5)
);

create index if not exists stratum_mod_ratings_mod_idx
  on public.stratum_mod_ratings (mod_uuid);

alter table public.stratum_mod_ratings enable row level security;

grant select, insert, update on public.stratum_mod_ratings to authenticated;
grant select on public.stratum_mod_ratings to anon;

drop policy if exists "stratum_mod_ratings_select_published" on public.stratum_mod_ratings;
drop policy if exists "stratum_mod_ratings_insert_own" on public.stratum_mod_ratings;
drop policy if exists "stratum_mod_ratings_update_own" on public.stratum_mod_ratings;

create policy "stratum_mod_ratings_select_published"
  on public.stratum_mod_ratings for select
  to anon, authenticated
  using (
    exists (
      select 1 from public.stratum_mods m
      where m.id = stratum_mod_ratings.mod_uuid
        and m.is_published = true
    )
  );

create policy "stratum_mod_ratings_insert_own"
  on public.stratum_mod_ratings for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.stratum_mods m
      where m.id = stratum_mod_ratings.mod_uuid
        and m.is_published = true
    )
  );

create policy "stratum_mod_ratings_update_own"
  on public.stratum_mod_ratings for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- RPC: increment download count (authenticated install)
-- ---------------------------------------------------------------------------
create or replace function public.increment_mod_download_count(p_mod_uuid uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_mod_uuid is null then
    return;
  end if;
  update public.stratum_mods
  set download_count = download_count + 1
  where id = p_mod_uuid
    and is_published = true;
end;
$$;

grant execute on function public.increment_mod_download_count(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- RPC: list published mods (directory)
-- ---------------------------------------------------------------------------
create or replace function public.list_stratum_mods(
  p_mod_type text,
  p_sort text,
  p_search text,
  p_limit int,
  p_offset int
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  lim int := least(coalesce(p_limit, 20), 80);
  off int := greatest(coalesce(p_offset, 0), 0);
  sort_mode text := lower(coalesce(nullif(trim(p_sort), ''), 'newest'));
  q text := trim(coalesce(p_search, ''));
  type_filt text := lower(trim(coalesce(p_mod_type, '')));
begin
  return coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'id', u.id,
          'name', u.name,
          'description', u.description,
          'mod_id', u.mod_id,
          'version', u.version,
          'mod_type', u.mod_type,
          'file_path', u.file_path,
          'cover_path', u.cover_path,
          'file_size', u.file_size,
          'download_count', u.download_count,
          'created_at', u.created_at,
          'author_name', u.author_name,
          'avg_rating', u.avg_rating,
          'rating_count', u.rating_count,
          'comment_count', u.comment_count
        )
        order by u._o1 desc nulls last, u._o2 desc nulls last, u.created_at desc, u.id
      )
      from (
        select
          m.id,
          m.name,
          m.description,
          m.mod_id,
          m.version,
          m.mod_type,
          m.file_path,
          m.cover_path,
          m.file_size,
          m.download_count,
          m.created_at,
          coalesce(p.username, '') as author_name,
          coalesce(r.avg_stars, 0)::numeric(4,3) as avg_rating,
          coalesce(r.cnt, 0)::bigint as rating_count,
          coalesce(c.cnt, 0)::bigint as comment_count,
          case sort_mode
            when 'downloads' then m.download_count::double precision
            when 'rating' then coalesce(r.avg_stars, 0)::double precision
            else extract(epoch from m.created_at)
          end as _o1,
          case sort_mode
            when 'rating' then coalesce(r.cnt, 0)::double precision
            else 0::double precision
          end as _o2
        from public.stratum_mods m
        left join public.profiles p on p.id = m.owner_id
        left join lateral (
          select avg(x.stars)::numeric as avg_stars, count(*)::bigint as cnt
          from public.stratum_mod_ratings x
          where x.mod_uuid = m.id
        ) r on true
        left join lateral (
          select count(*)::bigint as cnt
          from public.stratum_mod_comments y
          where y.mod_uuid = m.id
        ) c on true
        where m.is_published = true
          and (
            type_filt = ''
            or type_filt = 'all'
            or m.mod_type = type_filt
          )
          and (
            q = ''
            or m.name ilike '%' || q || '%'
            or m.description ilike '%' || q || '%'
            or p.username ilike '%' || q || '%'
            or m.mod_id ilike '%' || q || '%'
          )
        order by
          case sort_mode when 'newest' then extract(epoch from m.created_at) end desc nulls last,
          case sort_mode when 'downloads' then m.download_count end desc nulls last,
          case sort_mode when 'rating' then coalesce(r.avg_stars, 0) end desc nulls last,
          case sort_mode when 'rating' then coalesce(r.cnt, 0) end desc,
          m.created_at desc,
          m.id
        limit lim offset off
      ) u
    ),
    '[]'::jsonb
  );
end;
$$;

grant execute on function public.list_stratum_mods(text, text, text, int, int) to anon;
grant execute on function public.list_stratum_mods(text, text, text, int, int) to authenticated;

-- ---------------------------------------------------------------------------
-- RPC: single published mod summary (for detail header)
-- ---------------------------------------------------------------------------
create or replace function public.get_stratum_mod(p_mod_uuid uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_mod_uuid is null then
    return null;
  end if;
  return (
    select jsonb_build_object(
      'id', m.id,
      'name', m.name,
      'description', m.description,
      'mod_id', m.mod_id,
      'version', m.version,
      'mod_type', m.mod_type,
      'file_path', m.file_path,
      'cover_path', m.cover_path,
      'file_size', m.file_size,
      'download_count', m.download_count,
      'created_at', m.created_at,
      'author_name', coalesce(p.username, ''),
      'avg_rating', coalesce(r.avg_stars, 0)::numeric(4,3),
      'rating_count', coalesce(r.cnt, 0)::bigint
    )
    from public.stratum_mods m
    left join public.profiles p on p.id = m.owner_id
    left join lateral (
      select avg(x.stars)::numeric as avg_stars, count(*)::bigint as cnt
      from public.stratum_mod_ratings x
      where x.mod_uuid = m.id
    ) r on true
    where m.id = p_mod_uuid
      and m.is_published = true
    limit 1
  );
end;
$$;

grant execute on function public.get_stratum_mod(uuid) to anon;
grant execute on function public.get_stratum_mod(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- RPC: latest published row for a manifest mod_id (workshop updates)
-- ---------------------------------------------------------------------------
create or replace function public.get_latest_published_stratum_mod_by_mod_id(p_mod_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_mod_id is null or length(trim(p_mod_id)) < 1 then
    return null;
  end if;
  return (
    select jsonb_build_object(
      'id', m.id,
      'name', m.name,
      'description', m.description,
      'mod_id', m.mod_id,
      'version', m.version,
      'mod_type', m.mod_type,
      'file_path', m.file_path,
      'cover_path', m.cover_path,
      'file_size', m.file_size,
      'download_count', m.download_count,
      'created_at', m.created_at,
      'author_name', coalesce(p.username, ''),
      'avg_rating', coalesce(r.avg_stars, 0)::numeric(4,3),
      'rating_count', coalesce(r.cnt, 0)::bigint
    )
    from public.stratum_mods m
    left join public.profiles p on p.id = m.owner_id
    left join lateral (
      select avg(x.stars)::numeric as avg_stars, count(*)::bigint as cnt
      from public.stratum_mod_ratings x
      where x.mod_uuid = m.id
    ) r on true
    where m.mod_id = trim(p_mod_id)
      and m.is_published = true
    order by m.created_at desc
    limit 1
  );
end;
$$;

grant execute on function public.get_latest_published_stratum_mod_by_mod_id(text) to anon;
grant execute on function public.get_latest_published_stratum_mod_by_mod_id(text) to authenticated;

-- ---------------------------------------------------------------------------
-- RPC: list mod comments with author usernames
-- ---------------------------------------------------------------------------
create or replace function public.list_stratum_mod_comments(
  p_mod_uuid uuid,
  p_limit int,
  p_offset int
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  lim int := least(coalesce(p_limit, 50), 100);
  off int := greatest(coalesce(p_offset, 0), 0);
begin
  if p_mod_uuid is null then
    return '[]'::jsonb;
  end if;
  if not exists (
    select 1 from public.stratum_mods m
    where m.id = p_mod_uuid and m.is_published = true
  ) then
    return '[]'::jsonb;
  end if;
  return coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'id', x.id,
          'mod_uuid', x.mod_uuid,
          'author_id', x.author_id,
          'body', x.body,
          'created_at', x.created_at,
          'author_username', x.author_username
        )
        order by x.created_at desc
      )
      from (
        select
          c.id,
          c.mod_uuid,
          c.author_id,
          c.body,
          c.created_at,
          coalesce(p.username, '') as author_username
        from public.stratum_mod_comments c
        left join public.profiles p on p.id = c.author_id
        where c.mod_uuid = p_mod_uuid
        order by c.created_at desc
        limit lim offset off
      ) x
    ),
    '[]'::jsonb
  );
end;
$$;

grant execute on function public.list_stratum_mod_comments(uuid, int, int) to anon;
grant execute on function public.list_stratum_mod_comments(uuid, int, int) to authenticated;

-- ---------------------------------------------------------------------------
-- Workshop pack type migration (existing DBs that still use block_pack / etc.)
-- Safe to re-run after row updates; skip on fresh installs where constraint already matches.
-- ---------------------------------------------------------------------------
update public.stratum_mods
  set mod_type = 'behavior_pack'
  where mod_type in ('block_pack', 'mixed');
update public.stratum_mods
  set mod_type = 'resource_pack'
  where mod_type = 'texture_pack';
alter table public.stratum_mods drop constraint if exists stratum_mods_mod_type_check;
alter table public.stratum_mods
  add constraint stratum_mods_mod_type_check
  check (mod_type in ('behavior_pack', 'resource_pack', 'world'));

-- ---------------------------------------------------------------------------
-- Storage: workshop bucket `mods` (required or uploads fail with "Bucket not found")
-- Prefixes: zips/ (workshop .zip), covers/ (PNG/JPEG). Limits match client MOD_MAX_* constants.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'mods',
  'mods',
  true,
  2097152,
  array[
    'application/zip',
    'application/x-zip-compressed',
    'application/octet-stream',
    'application/json',
    'image/png',
    'image/jpeg'
  ]::text[]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "mods_objects_select_public" on storage.objects;
create policy "mods_objects_select_public"
  on storage.objects
  for select
  to public
  using (bucket_id = 'mods');

drop policy if exists "mods_objects_insert_authenticated" on storage.objects;
create policy "mods_objects_insert_authenticated"
  on storage.objects
  for insert
  to authenticated
  with check (bucket_id = 'mods');

drop policy if exists "mods_objects_update_authenticated" on storage.objects;
create policy "mods_objects_update_authenticated"
  on storage.objects
  for update
  to authenticated
  using (bucket_id = 'mods')
  with check (bucket_id = 'mods');

drop policy if exists "mods_objects_delete_authenticated" on storage.objects;
create policy "mods_objects_delete_authenticated"
  on storage.objects
  for delete
  to authenticated
  using (bucket_id = 'mods');
