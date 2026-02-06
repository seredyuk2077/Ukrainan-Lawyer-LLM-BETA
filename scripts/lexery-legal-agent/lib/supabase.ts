/**
 * Supabase client for LEXERY LEGAL AGENT DB
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from './config.js';

let client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (!client) {
    if (!config.supabaseUrl || !config.supabaseServiceKey) {
      throw new Error('SUPABASE_LEXERY_LEGAL_AGENT_DB_URL and SUPABASE_LEXERY_LEGAL_AGENT_DB_SERVICE_ROLE_KEY required');
    }
    client = createClient(config.supabaseUrl, config.supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return client;
}

export async function checkSupabaseHealth(): Promise<boolean> {
  try {
    const sb = getSupabaseClient();
    const { error } = await sb.from('runs').select('id').limit(1);
    return !error;
  } catch {
    return false;
  }
}
