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

alter table public.stratum_room_sessions enable row level security;

-- No SELECT policy: clients cannot list or read rows via PostgREST.

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
    and s.expires_at > now()
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

create policy "stratum_room_comments_select_active"
  on public.stratum_room_comments for select
  to anon, authenticated
  using (
    exists (
      select 1 from public.stratum_room_sessions s
      where s.room_code = stratum_room_comments.room_code
        and s.expires_at > now()
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
        and s.expires_at > now()
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

create policy "stratum_room_ratings_select_active"
  on public.stratum_room_ratings for select
  to anon, authenticated
  using (
    exists (
      select 1 from public.stratum_room_sessions s
      where s.room_code = stratum_room_ratings.room_code
        and s.expires_at > now()
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
        and s.expires_at > now()
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
    and s.expires_at > now()
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
        where s.expires_at > now()
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
    where s.room_code = code and s.expires_at > now()
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
