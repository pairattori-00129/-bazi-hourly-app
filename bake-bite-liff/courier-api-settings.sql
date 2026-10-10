-- Server-only settings. Browser requests must pass the existing Admin session check.
create table if not exists public.courier_api_settings (
 platform text primary key check (platform in ('grabexpress','lalamove','lineman')),
 config jsonb not null default '{}'::jsonb,
 credentials jsonb not null default '{}'::jsonb,
 updated_at timestamptz not null default now()
);
alter table public.courier_api_settings enable row level security;
revoke all on public.courier_api_settings from public, anon, authenticated;
grant select, insert, update, delete on public.courier_api_settings to service_role;
