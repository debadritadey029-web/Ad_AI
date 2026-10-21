/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { SerializedDataStore } from './persistence.js';

let serverClient: SupabaseClient | null = null;

function getServerConfig() {
  return {
    url: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '',
    // Server-side database access must use the service role key. Never use a
    // public anon key for persistence because it is intentionally exposed to browsers.
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  };
}

function getOrCreateServerClient(): SupabaseClient | null {
  if (serverClient) return serverClient;

  const { url, serviceKey } = getServerConfig();
  if (!url || !serviceKey) return null;

  try {
    serverClient = createClient(url, serviceKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  } catch (err) {
    console.warn('[Supabase Server] Failed to initialize server client:', err);
  }

  return serverClient;
}

export function isSupabaseServerConfigured(): boolean {
  return Boolean(getOrCreateServerClient());
}

export function getSupabaseServerClient(): SupabaseClient | null {
  return getOrCreateServerClient();
}

export function getSupabaseServerStatus(): {
  configured: boolean;
  mode: 'SUPABASE_CLOUD' | 'STORE_PERSISTENCE';
  url: string;
  hasServiceRoleKey: boolean;
  message: string;
} {
  const { url, serviceKey } = getServerConfig();
  const isConfigured = isSupabaseServerConfigured();
  return {
    configured: isConfigured,
    mode: isConfigured ? 'SUPABASE_CLOUD' : 'STORE_PERSISTENCE',
    url: url ? url.replace(/^https?:\/\//, '').split('.')[0] + '...supabase.co' : '',
    hasServiceRoleKey: Boolean(serviceKey),
    message: isConfigured
      ? 'Connected to Supabase PostgreSQL database and Auth service.'
      : 'Supabase credentials not detected in environment. Using atomic persistent storage adapter with complete Supabase SQL schema ready for 1-click execution.',
  };
}

/**
 * Optional health check to verify Supabase connectivity
 */
export async function testSupabaseConnection(): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  const client = getOrCreateServerClient();
  if (!client) {
    return { ok: false, error: 'Supabase server client not initialized. Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.' };
  }

  const start = Date.now();
  try {
    const { error } = await client.from('application_state').select('id').eq('id', 'default').maybeSingle();
    const latencyMs = Date.now() - start;
    if (error) {
      return { ok: false, latencyMs, error: error.message };
    }
    return { ok: true, latencyMs };
  } catch (err: any) {
    return { ok: false, error: err.message || 'Connection failed' };
  }
}

export async function loadSupabaseSnapshot(): Promise<SerializedDataStore | null> {
  const client = getOrCreateServerClient();
  if (!client) return null;

  const { data, error } = await client
    .from('application_state')
    .select('snapshot')
    .eq('id', 'default')
    .maybeSingle();

  if (error) {
    console.error('[Supabase] Failed to load application state:', error.message);
    return null;
  }

  return (data?.snapshot as SerializedDataStore | null) || null;
}

export async function saveSupabaseSnapshot(snapshot: SerializedDataStore): Promise<boolean> {
  const client = getOrCreateServerClient();
  if (!client) return false;

  const { error } = await client.from('application_state').upsert({
    id: 'default',
    snapshot,
    updated_at: new Date().toISOString(),
  });

  if (error) {
    console.error('[Supabase] Failed to save application state:', error.message);
    return false;
  }

  return true;
}


export interface SupabaseProvisionedIdentity {
  authUserId: string;
  email: string;
  appUser: {
    id: string;
    email: string;
    name: string;
    phone?: string;
    avatarUrl?: string;
    createdAt: string;
  };
  organization: {
    id: string;
    name: string;
    slug: string;
    tier: string;
    defaultCurrency: string;
    emergencyStopActive: boolean;
    emergencyStopReason?: string;
    emergencyStopTriggeredAt?: string;
    emergencyStopTriggeredBy?: string;
    settings: Record<string, unknown>;
    createdAt: string;
  };
  membership: {
    id: string;
    userId: string;
    orgId: string;
    role: string;
    status: string;
    joinedAt: string;
  };
}

/**
 * Verifies a Supabase access token with Auth and loads its explicitly provisioned
 * application account and ACTIVE tenant membership from the server-only database client.
 */
export async function resolveSupabaseProvisionedIdentity(
  accessToken: string,
  requestedOrganizationId?: string
): Promise<SupabaseProvisionedIdentity | null> {
  const client = getOrCreateServerClient();
  if (!client || !accessToken) return null;

  try {
    const { data: authData, error: authError } = await client.auth.getUser(accessToken);
    const authUser = authData?.user;
    if (authError || !authUser?.id || !authUser.email || !authUser.email_confirmed_at) return null;

    const normalizedEmail = authUser.email.trim().toLowerCase();
    const { data: appUser, error: userError } = await client
      .from('users')
      .select('id,email,name,phone,avatar_url,created_at,auth_user_id')
      .eq('auth_user_id', authUser.id)
      .maybeSingle();
    if (userError || !appUser?.id || String(appUser.email).trim().toLowerCase() !== normalizedEmail) return null;

    let membershipQuery = client
      .from('memberships')
      .select('id,user_id,org_id,role,status,created_at')
      .eq('user_id', appUser.id)
      .eq('status', 'ACTIVE');
    if (requestedOrganizationId) membershipQuery = membershipQuery.eq('org_id', requestedOrganizationId);

    const { data: memberships, error: membershipError } = await membershipQuery.limit(50);
    if (membershipError || !memberships?.length) return null;

    for (const membership of memberships) {
      const { data: organization, error: organizationError } = await client
        .from('organizations')
        .select('id,name,slug,tier,default_currency,emergency_stop_active,emergency_stop_reason,emergency_stop_triggered_at,emergency_stop_triggered_by,settings,created_at')
        .eq('id', membership.org_id)
        .maybeSingle();
      if (organizationError || !organization?.id) continue;

      return {
        authUserId: authUser.id,
        email: normalizedEmail,
        appUser: {
          id: String(appUser.id),
          email: normalizedEmail,
          name: String(appUser.name || normalizedEmail),
          phone: appUser.phone ? String(appUser.phone) : undefined,
          avatarUrl: appUser.avatar_url ? String(appUser.avatar_url) : undefined,
          createdAt: String(appUser.created_at || new Date().toISOString()),
        },
        organization: {
          id: String(organization.id),
          name: String(organization.name),
          slug: String(organization.slug),
          tier: String(organization.tier || 'STARTER'),
          defaultCurrency: String(organization.default_currency || 'USD'),
          emergencyStopActive: Boolean(organization.emergency_stop_active),
          emergencyStopReason: organization.emergency_stop_reason ? String(organization.emergency_stop_reason) : undefined,
          emergencyStopTriggeredAt: organization.emergency_stop_triggered_at ? String(organization.emergency_stop_triggered_at) : undefined,
          emergencyStopTriggeredBy: organization.emergency_stop_triggered_by ? String(organization.emergency_stop_triggered_by) : undefined,
          settings: (organization.settings || {}) as Record<string, unknown>,
          createdAt: String(organization.created_at || new Date().toISOString()),
        },
        membership: {
          id: String(membership.id),
          userId: String(membership.user_id),
          orgId: String(membership.org_id),
          role: String(membership.role),
          status: String(membership.status),
          joinedAt: String(membership.created_at || new Date().toISOString()),
        },
      };
    }
    return null;
  } catch (error) {
    console.error('[Supabase Auth] Access-token validation failed:', error);
    return null;
  }
}
