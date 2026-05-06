create table if not exists public.discord_links (
  user_id uuid primary key references auth.users(id) on delete cascade,
  discord_user_id text not null unique,
  discord_username text,
  discord_access_token text not null,
  discord_refresh_token text not null,
  token_expires_at timestamptz not null,
  is_donator boolean not null default false,
  donator_tier text not null default 'none' check (donator_tier in ('none', 'iron', 'gold', 'stratite')),
  last_role_check_at timestamptz not null default now(),
  last_role_check_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.discord_oauth_states (
  state text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  return_url text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists discord_oauth_states_user_id_idx
  on public.discord_oauth_states (user_id);

create index if not exists discord_oauth_states_expires_at_idx
  on public.discord_oauth_states (expires_at);

alter table public.discord_links enable row level security;
alter table public.discord_oauth_states enable row level security;

drop policy if exists "discord_links_select_own" on public.discord_links;
create policy "discord_links_select_own"
  on public.discord_links
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "discord_links_block_client_writes" on public.discord_links;
create policy "discord_links_block_client_writes"
  on public.discord_links
  for all
  to authenticated
  using (false)
  with check (false);

drop policy if exists "discord_oauth_states_no_client_access" on public.discord_oauth_states;
create policy "discord_oauth_states_no_client_access"
  on public.discord_oauth_states
  for all
  to authenticated
  using (false)
  with check (false);
