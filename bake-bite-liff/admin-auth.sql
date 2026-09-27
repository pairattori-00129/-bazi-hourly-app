create table if not exists public.admin_auth (
  id integer primary key default 1 check(id=1),
  salt text not null,
  password_hash text not null,
  updated_at timestamptz not null default now()
);
create table if not exists public.admin_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists admin_sessions_expires_at_idx on public.admin_sessions(expires_at);
create table if not exists public.admin_login_attempts (
  ip_hash text primary key,
  failed_attempts integer not null default 0,
  blocked_until timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.admin_auth enable row level security;
alter table public.admin_sessions enable row level security;
alter table public.admin_login_attempts enable row level security;
revoke all on public.admin_auth, public.admin_sessions, public.admin_login_attempts from public, anon, authenticated;
