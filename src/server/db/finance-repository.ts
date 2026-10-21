/**
 * Server-only finance repository. Budget mutations are performed by PostgreSQL RPCs
 * so proposal creation, four-eyes review, campaign version checks and audit events
 * are transactional rather than process-local.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { BudgetProposal, Campaign } from './types.js';
import { getSupabaseServerClient, isSupabaseServerConfigured } from './supabase.js';
import { CampaignRepositoryError } from './campaign-repository.js';

export interface FinanceActor { userId: string; email: string; role: string; }
const clientOrThrow = (): SupabaseClient => {
  const client = getSupabaseServerClient();
  if (!client || !isSupabaseServerConfigured()) throw new CampaignRepositoryError('Durable finance persistence is not configured.', 'NOT_CONFIGURED');
  return client;
};
const actorPayload = (actor: FinanceActor) => ({ user_id: actor.userId, email: actor.email, role: actor.role });

function mapProposal(row: Record<string, any>): BudgetProposal {
  return {
    id: String(row.id), orgId: String(row.org_id), campaignId: String(row.campaign_id),
    type: row.proposal_type, title: String(row.title), description: String(row.description || ''),
    requestedByUserId: String(row.requested_by_user_id), requestedAt: String(row.requested_at),
    reviewedByUserId: row.reviewed_by_user_id || undefined, reviewedAt: row.reviewed_at || undefined,
    status: row.status, currentBudgetMinorUnits: Number(row.current_budget_minor_units),
    proposedBudgetMinorUnits: Number(row.proposed_budget_minor_units), currency: String(row.currency),
    reason: String(row.reason), campaignVersionAtRequest: Number(row.campaign_version_at_request),
    reviewNotes: row.review_notes || undefined,
  };
}

function mapCampaign(row: Record<string, any>): Campaign {
  return {
    id: String(row.id), orgId: String(row.org_id), provider: row.provider,
    providerAccountId: String(row.provider_account_id), providerCampaignId: row.provider_campaign_id || undefined,
    name: String(row.name), objective: row.objective, status: row.status, budgetType: row.budget_type,
    budgetMinorUnits: Number(row.budget_minor_units), currency: String(row.currency), startDate: String(row.start_date),
    endDate: row.end_date ? String(row.end_date) : undefined, targeting: row.targeting,
    adGroupCount: Number(row.ad_group_count), creativeIds: Array.isArray(row.creative_ids) ? row.creative_ids : [],
    actualSpendMinorUnits: Number(row.actual_spend_minor_units || 0), impressions: Number(row.impressions || 0),
    clicks: Number(row.clicks || 0), conversions: Number(row.conversions || 0),
    revenueMinorUnits: Number(row.revenue_minor_units || 0), createdAt: String(row.created_at),
    updatedAt: String(row.updated_at), version: Number(row.version),
  };
}

function financeError(error: { code?: string; message?: string }): never {
  const msg = error.message || '';
  if (error.code === 'P0002' || msg.includes('campaign_not_found') || msg.includes('proposal_not_found')) {
    throw new CampaignRepositoryError('The campaign or proposal was not found in the active organization.', 'NOT_FOUND');
  }
  if (error.code === '40001' || msg.includes('proposal_already_processed')) {
    throw new CampaignRepositoryError('The proposal changed or has already been reviewed. Refresh and retry.', 'CONFLICT');
  }
  if (msg.includes('four_eyes_violation')) throw new CampaignRepositoryError('The requester cannot approve their own proposal.', 'CONFLICT');
  if (msg.includes('emergency_stop_active')) throw new CampaignRepositoryError('Emergency Stop is active; financial review is blocked.', 'CONFLICT');
  if (msg.includes('budget_ceiling_exceeded') || msg.includes('budget_unchanged') || msg.includes('invalid_budget_proposal')) {
    throw new CampaignRepositoryError('The budget proposal violates the organization policy or contains invalid values.', 'CONFLICT');
  }
  if (msg.includes('permission_denied') || msg.includes('approval_permission_denied') || msg.includes('active_actor_membership_required') || msg.includes('service_role_required')) {
    throw new CampaignRepositoryError('The current organization role is not authorized for this financial action.', 'NOT_CONFIGURED');
  }
  throw new CampaignRepositoryError('Durable finance storage failed. No local fallback was used.', 'DATABASE_ERROR');
}

export function isDurableFinancePersistenceEnabled(): boolean { return isSupabaseServerConfigured(); }

export async function listDurableProposals(orgId: string): Promise<BudgetProposal[]> {
  const { data, error } = await clientOrThrow().from('app_budget_proposals').select('*')
    .eq('org_id', orgId).order('requested_at', { ascending: false }).limit(500);
  if (error) financeError(error);
  return (data || []).map((row) => mapProposal(row as Record<string, any>));
}

export async function getDurableCampaignForFinance(orgId: string, campaignId: string): Promise<Campaign> {
  const { data, error } = await clientOrThrow().from('app_campaigns').select('*').eq('org_id', orgId).eq('id', campaignId).maybeSingle();
  if (error) financeError(error);
  if (!data) throw new CampaignRepositoryError('Campaign not found in active organization.', 'NOT_FOUND');
  return mapCampaign(data as Record<string, any>);
}

export async function createDurableBudgetProposal(input: {
  orgId: string; campaignId: string; proposedBudgetMinorUnits: number; title?: string; description?: string; reason: string;
}, actor: FinanceActor): Promise<BudgetProposal> {
  const { data, error } = await clientOrThrow().rpc('app_create_budget_proposal', {
    p_org_id: input.orgId, p_campaign_id: input.campaignId,
    p_proposed_budget_minor_units: input.proposedBudgetMinorUnits,
    p_title: input.title || null, p_description: input.description || null,
    p_reason: input.reason, p_actor: actorPayload(actor),
  });
  if (error) financeError(error);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new CampaignRepositoryError('Budget proposal creation returned no persisted record.', 'DATABASE_ERROR');
  return mapProposal(row as Record<string, any>);
}

export async function reviewDurableBudgetProposal(input: {
  orgId: string; proposalId: string; action: 'APPROVE' | 'REJECT'; notes?: string;
}, actor: FinanceActor): Promise<BudgetProposal> {
  const { data, error } = await clientOrThrow().rpc('app_review_budget_proposal', {
    p_org_id: input.orgId, p_proposal_id: input.proposalId,
    p_action: input.action, p_notes: input.notes || null, p_actor: actorPayload(actor),
  });
  if (error) financeError(error);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new CampaignRepositoryError('Budget proposal review returned no persisted record.', 'DATABASE_ERROR');
  return mapProposal(row as Record<string, any>);
}

export async function setDurableEmergencyStop(input: {
  orgId: string; action: 'TRIGGER' | 'RELEASE'; reason?: string;
}, actor: FinanceActor): Promise<{ active: boolean; reason?: string; triggeredAt?: string; triggeredBy?: string }> {
  const { data, error } = await clientOrThrow().rpc('app_set_emergency_stop', {
    p_org_id: input.orgId, p_action: input.action, p_reason: input.reason || null, p_actor: actorPayload(actor),
  });
  if (error) financeError(error);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new CampaignRepositoryError('Emergency stop operation returned no persisted record.', 'DATABASE_ERROR');
  return {
    active: Boolean(row.emergency_stop_active),
    reason: row.emergency_stop_reason || undefined,
    triggeredAt: row.emergency_stop_triggered_at || undefined,
    triggeredBy: row.emergency_stop_triggered_by || undefined,
  };
}
