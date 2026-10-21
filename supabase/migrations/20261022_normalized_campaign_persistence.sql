-- AdVantage AI normalized, tenant-scoped campaign persistence.
-- Apply after 20261021_harden_auth_and_rls.sql. No snapshot table is used here.
begin;

create table if not exists public.app_campaigns (
  id text primary key,
  org_id text not null references public.organizations(id) on delete cascade,
  provider text not null check (provider in ('meta','google','tiktok','linkedin','microsoft','pinterest','snapchat','reddit','x','apple')),
  provider_account_id text not null,
  provider_campaign_id text,
  name text not null check (length(trim(name)) between 1 and 255),
  objective text not null check (objective in ('AWARENESS','TRAFFIC','ENGAGEMENT','LEADS','APP_PROMOTION','CONVERSIONS')),
  status text not null default 'DRAFT' check (status in ('DRAFT','PENDING_APPROVAL','APPROVED','ACTIVE','PAUSED','COMPLETED','REJECTED')),
  budget_type text not null default 'DAILY' check (budget_type in ('DAILY','LIFETIME')),
  budget_minor_units bigint not null check (budget_minor_units > 0),
  currency varchar(3) not null check (currency ~ '^[A-Z]{3}$'),
  start_date timestamptz not null,
  end_date timestamptz,
  targeting jsonb not null default '{"locations":[],"ageMin":18,"ageMax":65,"genders":["ALL"]}'::jsonb,
  ad_group_count integer not null default 1 check (ad_group_count > 0),
  creative_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(creative_ids) = 'array'),
  actual_spend_minor_units bigint not null default 0 check (actual_spend_minor_units >= 0),
  impressions bigint not null default 0 check (impressions >= 0),
  clicks bigint not null default 0 check (clicks >= 0),
  conversions bigint not null default 0 check (conversions >= 0),
  revenue_minor_units bigint not null default 0 check (revenue_minor_units >= 0),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  check (end_date is null or end_date >= start_date)
);

create index if not exists idx_app_campaigns_org_updated
  on public.app_campaigns (org_id, updated_at desc);
create index if not exists idx_app_campaigns_org_status
  on public.app_campaigns (org_id, status, updated_at desc);

alter table public.app_campaigns enable row level security;
revoke all on table public.app_campaigns from anon, authenticated;

create or replace function public.app_create_campaign(p_campaign jsonb)
returns setof public.app_campaigns
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_row public.app_campaigns;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_campaign is null
    or nullif(trim(p_campaign->>'id'), '') is null
    or nullif(trim(p_campaign->>'org_id'), '') is null
    or nullif(trim(p_campaign->>'name'), '') is null
    or coalesce((p_campaign->>'budget_minor_units')::bigint, 0) <= 0 then
    raise exception 'invalid_campaign_payload' using errcode = '22023';
  end if;

  insert into public.app_campaigns (
    id, org_id, provider, provider_account_id, provider_campaign_id,
    name, objective, status, budget_type, budget_minor_units, currency,
    start_date, end_date, targeting, ad_group_count, creative_ids,
    actual_spend_minor_units, impressions, clicks, conversions,
    revenue_minor_units, version, created_at, updated_at
  ) values (
    p_campaign->>'id',
    p_campaign->>'org_id',
    p_campaign->>'provider',
    coalesce(nullif(p_campaign->>'provider_account_id',''), 'unlinked'),
    nullif(p_campaign->>'provider_campaign_id',''),
    trim(p_campaign->>'name'),
    coalesce(p_campaign->>'objective','CONVERSIONS'),
    'DRAFT',
    coalesce(p_campaign->>'budget_type','DAILY'),
    (p_campaign->>'budget_minor_units')::bigint,
    upper(coalesce(p_campaign->>'currency','USD')),
    coalesce((p_campaign->>'start_date')::timestamptz, now()),
    nullif(p_campaign->>'end_date','')::timestamptz,
    coalesce(p_campaign->'targeting','{"locations":[],"ageMin":18,"ageMax":65,"genders":["ALL"]}'::jsonb),
    greatest(coalesce((p_campaign->>'ad_group_count')::integer,1),1),
    coalesce(p_campaign->'creative_ids','[]'::jsonb),
    0,0,0,0,0,1,now(),now()
  ) returning * into v_row;
  return next v_row;
end;
$$;

create or replace function public.app_update_campaign_status(
  p_org_id text,
  p_campaign_id text,
  p_expected_version integer,
  p_new_status text
)
returns setof public.app_campaigns
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_row public.app_campaigns;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_new_status not in ('DRAFT','PENDING_APPROVAL','APPROVED','PAUSED','COMPLETED','REJECTED') then
    raise exception 'unsupported_or_provider_managed_status' using errcode = '22023';
  end if;

  update public.app_campaigns
     set status = p_new_status,
         version = version + 1,
         updated_at = now()
   where org_id = p_org_id
     and id = p_campaign_id
     and version = p_expected_version
   returning * into v_row;

  if not found then
    if exists (select 1 from public.app_campaigns where org_id = p_org_id and id = p_campaign_id) then
      raise exception 'campaign_version_conflict' using errcode = '40001';
    end if;
    raise exception 'campaign_not_found' using errcode = 'P0002';
  end if;
  return next v_row;
end;
$$;

revoke all on function public.app_create_campaign(jsonb) from public, anon, authenticated;
revoke all on function public.app_update_campaign_status(text,text,integer,text) from public, anon, authenticated;
grant execute on function public.app_create_campaign(jsonb) to service_role;
grant execute on function public.app_update_campaign_status(text,text,integer,text) to service_role;

comment on table public.app_campaigns is 'Normalized tenant-scoped campaign records. API writes use service-role-only transactional RPCs; direct browser access is prohibited.';
commit;
