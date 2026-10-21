-- Security hardening for projects that already applied supabase/schema.sql.
-- Run in Supabase SQL Editor before enabling Supabase sign-in.
-- The service-role key bypasses RLS; browser keys must not receive direct table access.

alter table public.users
  add column if not exists auth_user_id uuid unique references auth.users(id) on delete set null;

-- The old schema created USING (true) policies without a role restriction.
-- Remove them: a service-role client does not need permissive RLS policies.
drop policy if exists "Allow service role full access" on public.organizations;
drop policy if exists "Allow service role full access" on public.users;
drop policy if exists "Allow service role full access" on public.memberships;
drop policy if exists "Allow service role full access" on public.otp_codes;
drop policy if exists "Allow service role full access" on public.provider_connections;
drop policy if exists "Allow service role full access" on public.campaigns;
drop policy if exists "Allow service role full access" on public.budget_proposals;
drop policy if exists "Allow service role full access" on public.creatives;
drop policy if exists "Allow service role full access" on public.leads;
drop policy if exists "Allow service role full access" on public.audit_logs;

alter table public.application_state enable row level security;
alter table public.organizations enable row level security;
alter table public.users enable row level security;
alter table public.memberships enable row level security;
alter table public.otp_codes enable row level security;
alter table public.provider_connections enable row level security;
alter table public.campaigns enable row level security;
alter table public.budget_proposals enable row level security;
alter table public.creatives enable row level security;
alter table public.leads enable row level security;
alter table public.audit_logs enable row level security;

-- The application currently accesses these tables only through server-side
-- service-role code. Do not grant browser roles direct access; service_role
-- bypasses RLS and retains its configured privileges.
revoke all on table public.application_state from anon, authenticated;
revoke all on table public.organizations from anon, authenticated;
revoke all on table public.users from anon, authenticated;
revoke all on table public.memberships from anon, authenticated;
revoke all on table public.otp_codes from anon, authenticated;
revoke all on table public.provider_connections from anon, authenticated;
revoke all on table public.campaigns from anon, authenticated;
revoke all on table public.budget_proposals from anon, authenticated;
revoke all on table public.creatives from anon, authenticated;
revoke all on table public.leads from anon, authenticated;
revoke all on table public.audit_logs from anon, authenticated;

-- Do not create permissive client policies here. Tenant data must go through
-- the API until direct browser access is designed with per-tenant RLS policies.
