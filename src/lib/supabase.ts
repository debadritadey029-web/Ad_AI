/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Access client environment variables safely
const supabaseUrl = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) || '';
const supabaseAnonKey = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_ANON_KEY) || '';

let client: SupabaseClient | null = null;

if (supabaseUrl && supabaseAnonKey) {
  try {
    client = createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
      },
    });
  } catch (err) {
    console.warn('[Supabase Client] Failed to initialize client:', err);
  }
}

export function isSupabaseConfigured(): boolean {
  return Boolean(supabaseUrl && supabaseAnonKey && client);
}

export function getSupabaseClient(): SupabaseClient | null {
  return client;
}

export function getSupabaseConfig(): { url: string; hasAnonKey: boolean } {
  return {
    url: supabaseUrl || '',
    hasAnonKey: Boolean(supabaseAnonKey),
  };
}

/**
 * Sign in using Supabase native Email or SMS OTP
 */
export async function supabaseSignInWithOtp(params: {
  email?: string;
  phone?: string;
}): Promise<{ data: any; error: any }> {
  if (!client) {
    return { data: null, error: new Error('Supabase client is not configured.') };
  }

  if (params.email) {
    return client.auth.signInWithOtp({
      email: params.email,
      options: {
        shouldCreateUser: true,
      },
    });
  }

  if (params.phone) {
    return client.auth.signInWithOtp({
      phone: params.phone,
      options: {
        shouldCreateUser: true,
      },
    });
  }

  return { data: null, error: new Error('Either email or phone is required.') };
}

/**
 * Verify Supabase native OTP token
 */
export async function supabaseVerifyOtp(params: {
  email?: string;
  phone?: string;
  token: string;
  type?: 'email' | 'sms' | 'magiclink';
}): Promise<{ data: any; error: any }> {
  if (!client) {
    return { data: null, error: new Error('Supabase client is not configured.') };
  }

  if (params.email) {
    return client.auth.verifyOtp({
      email: params.email,
      token: params.token,
      type: (params.type as any) || 'email',
    });
  }

  if (params.phone) {
    return client.auth.verifyOtp({
      phone: params.phone,
      token: params.token,
      type: (params.type as any) || 'sms',
    });
  }

  return { data: null, error: new Error('Either email or phone is required.') };
}
