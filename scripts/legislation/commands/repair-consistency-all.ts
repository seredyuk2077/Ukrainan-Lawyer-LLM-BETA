/**
 * Repair Consistency All — виправлення невідповідностей для всіх документів
 */

import { createSupabaseAdminClient } from '../lib/supabaseAdmin.js';
import { repairConsistency } from './repair-consistency.js';

export async function repairConsistencyAll(options?: {
  dryRun?: boolean;
  limit?: number;
}): Promise<void> {
  const { dryRun = false, limit } = options || {};
  const supabase = createSupabaseAdminClient();
  
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Repair Consistency All${dryRun ? ' (DRY RUN)' : ''}`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  
  let query = supabase
    .from('legislation_documents')
    .select('rada_nreg')
    .order('rada_nreg');
  
  if (limit) {
    query = query.limit(limit);
  }
  
  const { data: docs, error } = await query;
  if (error) throw new Error(`Supabase query error: ${error.message}`);
  if (!docs || docs.length === 0) {
    console.log('No documents found');
    return;
  }
  
  console.log(`Found ${docs.length} documents to process\n`);
  
  let updated = 0;
  let unchanged = 0;
  let errors = 0;
  
  for (const doc of docs) {
    try {
      await repairConsistency(doc.rada_nreg, { dryRun });
      updated++;
    } catch (e: any) {
      console.error(`❌ ${doc.rada_nreg}: ${e.message}`);
      errors++;
    }
  }
  
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Summary`);
  console.log(`═══════════════════════════════════════════════════════════`);
  console.log(`Total: ${docs.length}`);
  console.log(`Updated: ${updated}`);
  console.log(`Errors: ${errors}`);
}
