/**
 * Server-only, tenant-scoped campaign repository.
 *
 * Writes use PostgreSQL functions so version checks and mutations happen in one
 * transaction. Never fall back to the process-local Map when Supabase is configured:
 * a database error must fail closed rather than silently split the source of truth.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Campaign, CampaignStatus } from './types.js';
import { getSupabaseServerClient, isSupabaseServerConfigured } from './supabase.js';

export class CampaignRepositoryError extends Error {
  constructor(
    message: string,
    public readonly code: 'NOT_CONFIGURED' | 'NOT_FOUND' | 'CONFLICT' | 'DATABASE_ERROR'
  ) {
    super(message);
    this.name = 'CampaignRepositoryError';
  }
}

function clientOrThrow(): SupabaseClient {
  const client = getSupabaseServerClient();
  if (!client || !isSupabaseServerConfigured()) {
    throw new CampaignRepositoryError('Durable campaign persistence is not configured.', 'NOT_CONFIGURED');
  }
  return client;
}

function mapRow(row: Record<string, any>): Campaign {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    provider: row.provider,
    providerAccountId: String(row.provider_account_id),
    providerCampaignId: row.provider_campaign_id || undefined,
    name: String(row.name),
    objective: row.objective,
    status: row.status,
    budgetType: row.budget_type,
    budgetMinorUnits: Number(row.budget_minor_units),
    currency: String(row.currency),
    startDate: String(row.start_date),
    endDate: row.end_date ? String(row.end_date) : undefined,
    targeting: row.targeting,
    adGroupCount: Number(row.ad_group_count),
    creativeIds: Array.isArray(row.creative_ids) ? row.creative_ids : [],
    actualSpendMinorUnits: Number(row.actual_spend_minor_units || 0),
    impressions: Number(row.impressions || 0),
    clicks: Number(row.clicks || 0),
    conversions: Number(row.conversions || 0),
    revenueMinorUnits: Number(row.revenue_minor_units || 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    version: Number(row.version),
  };
}

function throwDatabaseError(error: { code?: string; message?: string }): never {
  if (error.code === '40001' || error.message?.includes('campaign_version_conflict')) {
    throw new CampaignRepositoryError('Campaign was changed by another request. Refresh and retry.', 'CONFLICT');
  }
  if (error.code === 'P0002' || error.message?.includes('campaign_not_found')) {
    throw new CampaignRepositoryError('Campaign not found within the active organization.', 'NOT_FOUND');
  }
  throw new CampaignRepositoryError('Durable campaign storage failed. No local fallback was used.', 'DATABASE_ERROR');
}

export function isDurableCampaignPersistenceEnabled(): boolean {
  return isSupabaseServerConfigured();
}

export async function listCampaignsForOrganization(orgId: string): Promise<Campaign[]> {
  const client = clientOrThrow();
  const { data, error } = await client
    .from('app_campaigns')
    .select('*')
    .eq('org_id', orgId)
    .order('updated_at', { ascending: false })
    .limit(500);
  if (error) throwDatabaseError(error);
  return (data || []).map((row) => mapRow(row as Record<string, any>));
}

export async function createDurableCampaign(campaign: Campaign): Promise<Campaign> {
  const client = clientOrThrow();
  const payload = {
    id: campaign.id,
    org_id: campaign.orgId,
    provider: campaign.provider,
    provider_account_id: campaign.providerAccountId,
    provider_campaign_id: campaign.providerCampaignId ?? null,
    name: campaign.name,
    objective: campaign.objective,
    budget_type: campaign.budgetType,
    budget_minor_units: campaign.budgetMinorUnits,
    currency: campaign.currency,
    start_date: campaign.startDate,
    end_date: campaign.endDate ?? null,
    targeting: campaign.targeting,
    ad_group_count: campaign.adGroupCount,
    creative_ids: campaign.creativeIds,
  };
  const { data, error } = await client.rpc('app_create_campaign', { p_campaign: payload });
  if (error) throwDatabaseError(error);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new CampaignRepositoryError('Campaign creation returned no persisted record.', 'DATABASE_ERROR');
  return mapRow(row as Record<string, any>);
}

export async function updateDurableCampaignStatus(
  orgId: string,
  campaignId: string,
  expectedVersion: number,
  status: Exclude<CampaignStatus, 'ACTIVE'>
): Promise<Campaign> {
  const client = clientOrThrow();
  const { data, error } = await client.rpc('app_update_campaign_status', {
    p_org_id: orgId,
    p_campaign_id: campaignId,
    p_expected_version: expectedVersion,
    p_new_status: status,
  });
  if (error) throwDatabaseError(error);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new CampaignRepositoryError('Campaign update returned no persisted record.', 'DATABASE_ERROR');
  return mapRow(row as Record<string, any>);
}
