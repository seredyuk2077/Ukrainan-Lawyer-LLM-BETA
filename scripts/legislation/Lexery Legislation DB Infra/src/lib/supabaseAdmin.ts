/**
 * Supabase Admin helpers (service role).
 * Використовує ТІЛЬКИ Supabase legislation проект.
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { resolve } from 'path';

dotenv.config({ path: resolve(process.cwd(), '.env') });

export function createSupabaseAdminClient(): SupabaseClient {
  const url = process.env.SUPABASE_LEGISLATION_URL;
  const key = process.env.SUPABASE_LEGISLATION_SERVICE_ROLE_KEY;

  if (!url) throw new Error('SUPABASE_LEGISLATION_URL не встановлено');
  if (!key) throw new Error('SUPABASE_LEGISLATION_SERVICE_ROLE_KEY не встановлено');

  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export function nowIso(): string {
  return new Date().toISOString();
}

