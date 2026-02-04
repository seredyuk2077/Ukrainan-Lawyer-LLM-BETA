/**
 * Jobs commands — управління legislation_import_jobs
 * 
 * PHASE 4: Resume/Progress CLI
 */
import { createSupabaseAdminClient } from '../lib/supabaseAdmin.js';
import { findResumeJob } from '../lib/jobProgress.js';

export async function listJobs(opts: { failed?: boolean; running?: boolean }): Promise<void> {
  const supabase = createSupabaseAdminClient();
  
  let query = supabase
    .from('legislation_import_jobs')
    .select('id,status,started_at,completed_at,error_message,progress_data,config')
    .order('started_at', { ascending: false })
    .limit(50);
  
  if (opts.failed) {
    query = query.eq('status', 'failed');
  } else if (opts.running) {
    query = query.eq('status', 'running');
  }
  
  const { data: jobs, error } = await query;
  if (error) throw new Error(`Supabase jobs list error: ${error.message}`);
  
  console.log(`## Jobs (${jobs?.length || 0} found)`);
  if (!jobs || jobs.length === 0) {
    console.log('No jobs found');
    return;
  }
  
  for (const job of jobs) {
    const progress = job.progress_data as any || {};
    const config = job.config as any || {};
    console.log(`\n- id: ${job.id}`);
    console.log(`  status: ${job.status}`);
    console.log(`  started_at: ${job.started_at}`);
    console.log(`  completed_at: ${job.completed_at || 'null'}`);
    console.log(`  rada_nreg: ${config.rada_nreg || 'null'}`);
    console.log(`  stage: ${progress.stage || 'unknown'}`);
    console.log(`  stage_progress: ${progress.stage_progress || 'null'}`);
    if (job.error_message) {
      console.log(`  error: ${job.error_message}`);
    }
  }
}

export async function inspectJob(jobId: string): Promise<void> {
  const supabase = createSupabaseAdminClient();
  
  const { data: job, error } = await supabase
    .from('legislation_import_jobs')
    .select('*')
    .eq('id', jobId)
    .maybeSingle();
  
  if (error) throw new Error(`Supabase job inspect error: ${error.message}`);
  
  if (!job) {
    console.log(`Job ${jobId} not found`);
    return;
  }
  
  console.log('## Job Inspect');
  console.log(JSON.stringify(job, null, 2));
}

export async function resumeJob(jobId: string): Promise<void> {
  // TODO: реалізація resume logic
  // Поки що тільки показуємо job
  console.log(`Resume job ${jobId} - TODO: implement resume logic`);
  await inspectJob(jobId);
}
