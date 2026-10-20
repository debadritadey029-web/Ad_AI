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
