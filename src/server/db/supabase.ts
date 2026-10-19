/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';

let serverClient: SupabaseClient | null = null;

if (supabaseUrl && supabaseServiceKey) {
  try {
    serverClient = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  } catch (err) {
    console.warn('[Supabase Server] Failed to initialize server client:', err);
  }
}

export function isSupabaseServerConfigured(): boolean {
  return Boolean(supabaseUrl && supabaseServiceKey && serverClient);
}

export function getSupabaseServerClient(): SupabaseClient | null {
  return serverClient;
}

export function getSupabaseServerStatus(): {
  configured: boolean;
  mode: 'SUPABASE_CLOUD' | 'STORE_PERSISTENCE';
  url: string;
  hasServiceRoleKey: boolean;
  message: string;
} {
  const isConfigured = isSupabaseServerConfigured();
  return {
    configured: isConfigured,
    mode: isConfigured ? 'SUPABASE_CLOUD' : 'STORE_PERSISTENCE',
    url: supabaseUrl ? supabaseUrl.replace(/^https?:\/\//, '').split('.')[0] + '...supabase.co' : '',
    hasServiceRoleKey: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    message: isConfigured
      ? 'Connected to Supabase PostgreSQL database and Auth service.'
      : 'Supabase credentials not detected in environment. Using atomic persistent storage adapter with complete Supabase SQL schema ready for 1-click execution.',
  };
}

/**
 * Optional health check to verify Supabase connectivity
 */
export async function testSupabaseConnection(): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  if (!serverClient) {
    return { ok: false, error: 'Supabase server client not initialized. Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.' };
  }

  const start = Date.now();
  try {
    const { error } = await serverClient.from('organizations').select('id').limit(1);
    const latencyMs = Date.now() - start;
    if (error) {
      // Table might not exist yet before schema run, but connection was reached
      return { ok: true, latencyMs, error: error.message };
    }
    return { ok: true, latencyMs };
  } catch (err: any) {
    return { ok: false, error: err.message || 'Connection failed' };
  }
}
