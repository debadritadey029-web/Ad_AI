-- Durable tenant-scoped financial proposals and independent review.
-- Apply after 20261022_normalized_campaign_persistence.sql.
begin;

create table if not exists public.app_org_controls (
  org_id text primary key references public.organizations(id) on delete restrict,
  emergency_stop_active boolean not null default false,
  emergency_stop_reason text,
  emergency_stop_triggered_at timestamptz,
  emergency_stop_triggered_by text,
  policy jsonb not null default '{"budgetChangeApprovalThresholdMinorUnits":50000,"dailySpendCeilingMinorUnits":200000,"monthlySpendCeilingMinorUnits":5000000,"requireFourEyesApproval":true,"brandSafetyStrictness":"STRICT"}'::jsonb,
  version integer not null default 1 check (version > 0),
  updated_at timestamptz not null default now()
);
alter table public.app_org_controls enable row level security;
revoke all on table public.app_org_controls from public, anon, authenticated;
grant select on public.app_org_controls to service_role;

create table if not exists public.app_budget_proposals (
  id text primary key,
  org_id text not null references public.organizations(id) on delete restrict,
  campaign_id text not null,
  proposal_type text not null check (proposal_type in ('BUDGET_INCREASE','BUDGET_DECREASE')),
  title text not null check (length(trim(title)) between 1 and 255),
  description text not null default '',
  requested_by_user_id text not null,
  requested_at timestamptz not null default now(),
  reviewed_by_user_id text,
  reviewed_at timestamptz,
  status text not null default 'PENDING' check (status in ('PENDING','APPROVED','REJECTED','STALE','CANCELLED')),
  current_budget_minor_units bigint not null check (current_budget_minor_units > 0),
  proposed_budget_minor_units bigint not null check (proposed_budget_minor_units > 0),
  currency varchar(3) not null check (currency ~ '^[A-Z]{3}$'),
  reason text not null check (length(trim(reason)) between 1 and 2000),
  campaign_version_at_request integer not null check (campaign_version_at_request > 0),
  review_notes text,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (org_id, campaign_id) references public.app_campaigns(org_id, id) on delete restrict,
  unique (org_id, id)
);
create index if not exists idx_app_budget_proposals_org_status_requested
  on public.app_budget_proposals(org_id, status, requested_at desc);
create index if not exists idx_app_budget_proposals_org_campaign
  on public.app_budget_proposals(org_id, campaign_id, requested_at desc);
alter table public.app_budget_proposals enable row level security;
revoke all on table public.app_budget_proposals from public, anon, authenticated;
grant select on public.app_budget_proposals to service_role;
revoke update, delete, truncate on table public.app_budget_proposals from service_role;

create or replace function public.app_create_budget_proposal(p_org_id text, p_campaign_id text, p_proposed_budget_minor_units bigint, p_title text, p_description text, p_reason text, p_actor jsonb)
returns setof public.app_budget_proposals
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_campaign public.app_campaigns;
  v_controls public.app_org_controls;
  v_row public.app_budget_proposals;
  v_settings jsonb;
  v_threshold bigint;
  v_ceiling bigint;
  v_four_eyes boolean;
  v_id text := 'prp_' || replace(gen_random_uuid()::text, '-', '');
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service_role_required' using errcode='42501'; end if;
  if not exists (select 1 from public.memberships m where m.org_id=p_org_id and m.user_id=p_actor->>'user_id' and m.status='ACTIVE' and m.role=p_actor->>'role') then
    raise exception 'active_actor_membership_required' using errcode='42501';
  end if;
  if p_actor->>'role' not in ('OWNER','ADMIN','CAMPAIGN_MANAGER','OPERATOR') then raise exception 'proposal_permission_denied' using errcode='42501'; end if;
  if p_proposed_budget_minor_units is null or p_proposed_budget_minor_units <= 0 or length(trim(coalesce(p_reason,''))) < 1 or length(p_reason) > 2000 then
    raise exception 'invalid_budget_proposal' using errcode='22023';
  end if;
  select * into v_campaign from public.app_campaigns where org_id=p_org_id and id=p_campaign_id for update;
  if not found then raise exception 'campaign_not_found' using errcode='P0002'; end if;
  if v_campaign.status in ('ACTIVE') then raise exception 'live_campaign_budget_write_not_supported' using errcode='42501'; end if;
  insert into public.app_org_controls(org_id, policy)
    select p_org_id, coalesce(o.settings, '{}'::jsonb) from public.organizations o where o.id=p_org_id
    on conflict (org_id) do nothing;
  select * into v_controls from public.app_org_controls where org_id=p_org_id for update;
  if v_controls.emergency_stop_active then raise exception 'emergency_stop_active' using errcode='42501'; end if;
  v_settings := v_controls.policy;
  v_threshold := coalesce((v_settings->>'budgetChangeApprovalThresholdMinorUnits')::bigint, 50000);
  v_ceiling := coalesce((v_settings->>'dailySpendCeilingMinorUnits')::bigint, 200000);
  v_four_eyes := coalesce((v_settings->>'requireFourEyesApproval')::boolean, true);
  if p_proposed_budget_minor_units > v_ceiling then raise exception 'budget_ceiling_exceeded' using errcode='22023'; end if;
  if p_proposed_budget_minor_units = v_campaign.budget_minor_units then raise exception 'budget_unchanged' using errcode='22023'; end if;
  insert into public.app_budget_proposals(
    id,org_id,campaign_id,proposal_type,title,description,requested_by_user_id,status,
    current_budget_minor_units,proposed_budget_minor_units,currency,reason,campaign_version_at_request
  ) values (
    v_id,p_org_id,p_campaign_id,
    case when p_proposed_budget_minor_units > v_campaign.budget_minor_units then 'BUDGET_INCREASE' else 'BUDGET_DECREASE' end,
    left(coalesce(nullif(trim(p_title),''),'Budget adjustment for '||v_campaign.name),255),
    coalesce(p_description,''),
    p_actor->>'user_id','PENDING',v_campaign.budget_minor_units,p_proposed_budget_minor_units,
    v_campaign.currency,trim(p_reason),v_campaign.version
  ) returning * into v_row;
  perform public.app_append_audit_event(p_org_id,p_actor,'BUDGET_PROPOSAL_CREATED','BUDGET_PROPOSAL',v_row.id,
    jsonb_build_object('campaign_id',p_campaign_id,'current_budget_minor_units',v_campaign.budget_minor_units,
      'proposed_budget_minor_units',p_proposed_budget_minor_units,'campaign_version',v_campaign.version,'four_eyes_required',v_four_eyes));
  return next v_row;
end;
$$;

create or replace function public.app_review_budget_proposal(p_org_id text, p_proposal_id text, p_action text, p_notes text, p_actor jsonb)
returns setof public.app_budget_proposals
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_proposal public.app_budget_proposals;
  v_campaign public.app_campaigns;
  v_controls public.app_org_controls;
  v_four_eyes boolean;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service_role_required' using errcode='42501'; end if;
  if p_action not in ('APPROVE','REJECT') then raise exception 'invalid_review_action' using errcode='22023'; end if;
  if p_actor->>'role' not in ('OWNER','ADMIN','FINANCE_APPROVER') then raise exception 'approval_permission_denied' using errcode='42501'; end if;
  if not exists (select 1 from public.memberships m where m.org_id=p_org_id and m.user_id=p_actor->>'user_id' and m.status='ACTIVE' and m.role=p_actor->>'role') then
    raise exception 'active_actor_membership_required' using errcode='42501';
  end if;
  select * into v_proposal from public.app_budget_proposals where org_id=p_org_id and id=p_proposal_id for update;
  if not found then raise exception 'proposal_not_found' using errcode='P0002'; end if;
  if v_proposal.status <> 'PENDING' then raise exception 'proposal_already_processed' using errcode='40001'; end if;
  insert into public.app_org_controls(org_id, policy)
    select p_org_id, coalesce(o.settings, '{}'::jsonb) from public.organizations o where o.id=p_org_id
    on conflict (org_id) do nothing;
  select * into v_controls from public.app_org_controls where org_id=p_org_id for update;
  if v_controls.emergency_stop_active then raise exception 'emergency_stop_active' using errcode='42501'; end if;
  v_four_eyes := coalesce((v_controls.policy->>'requireFourEyesApproval')::boolean,true);
  if p_action='APPROVE' and v_four_eyes and v_proposal.requested_by_user_id=p_actor->>'user_id' then
    raise exception 'four_eyes_violation' using errcode='42501';
  end if;
  select * into v_campaign from public.app_campaigns where org_id=p_org_id and id=v_proposal.campaign_id for update;
  if not found then raise exception 'campaign_not_found' using errcode='P0002'; end if;
  if v_campaign.version <> v_proposal.campaign_version_at_request or v_campaign.budget_minor_units <> v_proposal.current_budget_minor_units then
    update public.app_budget_proposals set status='STALE', review_notes='Campaign changed after proposal creation.', version=version+1, updated_at=now()
      where org_id=p_org_id and id=p_proposal_id returning * into v_proposal;
    perform public.app_append_audit_event(p_org_id,p_actor,'BUDGET_PROPOSAL_MARKED_STALE','BUDGET_PROPOSAL',p_proposal_id,
      jsonb_build_object('campaign_id',v_campaign.id,'current_campaign_version',v_campaign.version));
    return next v_proposal;
    return;
  end if;
  if p_action='APPROVE' then
    update public.app_campaigns set budget_minor_units=v_proposal.proposed_budget_minor_units, version=version+1, updated_at=now()
      where org_id=p_org_id and id=v_campaign.id;
    update public.app_budget_proposals set status='APPROVED',reviewed_by_user_id=p_actor->>'user_id',
      reviewed_at=now(),review_notes=coalesce(p_notes,'Approved in AdVantage AI; no provider-side write was performed.'),
      version=version+1,updated_at=now() where org_id=p_org_id and id=p_proposal_id returning * into v_proposal;
  else
    update public.app_budget_proposals set status='REJECTED',reviewed_by_user_id=p_actor->>'user_id',
      reviewed_at=now(),review_notes=coalesce(p_notes,'Rejected during financial review.'),
      version=version+1,updated_at=now() where org_id=p_org_id and id=p_proposal_id returning * into v_proposal;
  end if;
  perform public.app_append_audit_event(p_org_id,p_actor,'BUDGET_PROPOSAL_'||p_action,'BUDGET_PROPOSAL',p_proposal_id,
    jsonb_build_object('campaign_id',v_proposal.campaign_id,'status',v_proposal.status,
      'proposed_budget_minor_units',v_proposal.proposed_budget_minor_units,'provider_write_performed',false));
  return next v_proposal;
end;
$$;

revoke all on function public.app_create_budget_proposal(text,text,bigint,text,text,text,jsonb) from public, anon, authenticated;
revoke all on function public.app_review_budget_proposal(text,text,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.app_create_budget_proposal(text,text,bigint,text,text,text,jsonb) to service_role;
grant execute on function public.app_review_budget_proposal(text,text,text,text,jsonb) to service_role;

comment on table public.app_budget_proposals is 'Tenant-scoped durable budget proposals with transactional four-eyes review.';
commit;
