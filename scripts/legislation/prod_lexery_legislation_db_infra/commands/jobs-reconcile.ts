/**
 * Jobs Reconcile — помічає stuck running jobs як failed
 */

import { createSupabaseAdminClient, nowIso } from '../lib/supabaseAdmin.js';

export interface ReconcileResult {
  total_running: number;
  stuck_1h: number;
  stuck_24h: number;
  marked_failed: number;
  failed_jobs: number;
}

export async function reconcileJobs(options?: {
  dryRun?: boolean;
  ttlHours?: number;
}): Promise<ReconcileResult> {
  const { dryRun = false, ttlHours = 24 } = options || {};
  const supabase = createSupabaseAdminClient();
  
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Jobs Reconcile${dryRun ? ' (DRY RUN)' : ''}`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  
  // Отримуємо running jobs
  const { data: runningJobs, error } = await supabase
    .from('legislation_import_jobs')
    .select('id, status, started_at, created_at, config')
    .eq('status', 'running')
    .order('started_at', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true });
  
  if (error) throw new Error(`Supabase query error: ${error.message}`);
  if (!runningJobs) {
    return { total_running: 0, stuck_1h: 0, stuck_24h: 0, marked_failed: 0, failed_jobs: 0 };
  }
  
  const totalRunning = runningJobs.length;
  const now = new Date();
  const ttlMs = ttlHours * 60 * 60 * 1000;
  
  let stuck1h = 0;
  let stuck24h = 0;
  let markedFailed = 0;
  
  for (const job of runningJobs) {
    const startTime = job.started_at ? new Date(job.started_at) : new Date(job.created_at || now);
    const ageMs = now.getTime() - startTime.getTime();
    const ageHours = ageMs / (60 * 60 * 1000);
    
    if (ageHours >= 1) stuck1h++;
    if (ageHours >= 24) stuck24h++;
    
    if (ageMs >= ttlMs) {
      const nreg = (job.config as any)?.rada_nreg || 'unknown';
      console.log(`${dryRun ? '[DRY RUN] ' : ''}⚠️  Job ${job.id} (nreg=${nreg}) stuck for ${ageHours.toFixed(1)}h, marking as failed`);
      
      if (!dryRun) {
        const { error: updateError } = await supabase
          .from('legislation_import_jobs')
          .update({
            status: 'failed',
            completed_at: nowIso(),
            error_message: `Stuck job timeout (TTL=${ttlHours}h, age=${ageHours.toFixed(1)}h)`,
          })
          .eq('id', job.id);
        
        if (updateError) {
          console.error(`  ❌ Failed to update job ${job.id}: ${updateError.message}`);
        } else {
          markedFailed++;
        }
      } else {
        markedFailed++;
      }
    }
  }
  
  // Отримуємо failed jobs count
  const { count: failedCount } = await supabase
    .from('legislation_import_jobs')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'failed');
  
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Summary`);
  console.log(`═══════════════════════════════════════════════════════════`);
  console.log(`Total running: ${totalRunning}`);
  console.log(`Stuck >1h: ${stuck1h}`);
  console.log(`Stuck >24h: ${stuck24h}`);
  console.log(`${dryRun ? '[DRY RUN] Would mark' : 'Marked'} as failed: ${markedFailed}`);
  console.log(`Total failed jobs: ${failedCount || 0}`);
  
  return {
    total_running: totalRunning,
    stuck_1h: stuck1h,
    stuck_24h: stuck24h,
    marked_failed: markedFailed,
    failed_jobs: failedCount || 0,
  };
}
