#!/usr/bin/env node
/**
 * DB capability check for supabase-lexery-legal-agent-db (Lexery Brain).
 * Verifies: runs.llm_result, runs.verify_result, runs_status_check with required statuses.
 * Read-only. Run before release / in CI: pnpm brain:db:capabilities
 */
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config as loadEnv } from 'dotenv';
import { getSupabaseClient } from '../../lib/supabase.js';
import { config } from '../../lib/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(__dirname, '../../.env') });

const REQUIRED_STATUSES = ['U10_RUNNING', 'U10_DONE', 'U11_RUNNING', 'U11_DONE', 'U12_RUNNING'];

async function main(): Promise<void> {
  if (!config.supabaseUrl || !config.supabaseServiceKey) {
    console.error('[db:capabilities] FAIL: SUPABASE_LEXERY_LEGAL_AGENT_DB_URL and SUPABASE_LEXERY_LEGAL_AGENT_DB_SERVICE_ROLE_KEY required');
    process.exit(1);
  }

  const sb = getSupabaseClient();
  const { data, error } = await sb.rpc('get_lexery_db_capabilities');

  if (error) {
    console.error('[db:capabilities] FAIL: RPC error:', error.message);
    console.error('  (Ensure migration lexery_db_capabilities_rpc is applied to Lexery DB.)');
    process.exit(1);
  }

  const cap = data as { llm_result?: boolean; verify_result?: boolean; runs_status_check_def?: string | null } | null;
  if (!cap || typeof cap !== 'object') {
    console.error('[db:capabilities] FAIL: unexpected RPC result');
    process.exit(1);
  }

  const report: string[] = [];
  let pass = true;

  if (cap.llm_result !== true) {
    report.push('runs.llm_result: MISSING');
    pass = false;
  } else {
    report.push('runs.llm_result: present (jsonb)');
  }

  if (cap.verify_result !== true) {
    report.push('runs.verify_result: MISSING');
    pass = false;
  } else {
    report.push('runs.verify_result: present (jsonb)');
  }

  const def = cap.runs_status_check_def ?? '';
  if (!def) {
    report.push('runs_status_check: MISSING or not found');
    pass = false;
  } else {
    const missing = REQUIRED_STATUSES.filter((s) => !def.includes(s));
    if (missing.length > 0) {
      report.push(`runs_status_check: MISSING statuses: ${missing.join(', ')}`);
      pass = false;
    } else {
      report.push('runs_status_check: contains required statuses (U10_*, U11_*, U12_RUNNING)');
    }
  }

  console.log('\n--- Lexery DB capabilities (supabase-lexery-legal-agent-db) ---');
  report.forEach((r) => console.log(r));
  console.log('---');
  console.log(pass ? 'PASS' : 'FAIL');
  if (!pass) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('[db:capabilities]', e);
  process.exit(1);
});
