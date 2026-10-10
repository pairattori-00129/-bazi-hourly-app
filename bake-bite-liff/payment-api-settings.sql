-- Server-only settings. Browser requests must pass the existing Admin session check.
create table if not exists public.payment_api_settings (
 platform text primary key check (platform in ('truemoney','shopeepay')),
 config jsonb not null default '{}'::jsonb,
 credentials jsonb not null default '{}'::jsonb,
 updated_at timestamptz not null default now()
);
alter table public.payment_api_settings enable row level security;
revoke all on public.payment_api_settings from public, anon, authenticated;
grant select, insert, update, delete on public.payment_api_settings to service_role;
