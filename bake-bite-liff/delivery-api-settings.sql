-- Server-only settings. Browser requests must pass the existing Admin session check.
create table if not exists public.delivery_api_settings (
 platform text primary key check (platform in ('shopeefood','grabfood','lineman')),
 config jsonb not null default '{}'::jsonb,
 credentials jsonb not null default '{}'::jsonb,
 updated_at timestamptz not null default now()
);
alter table public.delivery_api_settings enable row level security;
revoke all on public.delivery_api_settings from public, anon, authenticated;
grant select, insert, update, delete on public.delivery_api_settings to service_role;
