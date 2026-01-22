/**
 * Job Progress Tracking — відстеження прогресу імпорту через legislation_import_jobs
 * 
 * PHASE 4: Timeout/Resume/Progress для великих документів
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { nowIso } from './supabaseAdmin.js';

export type ImportStage = 
  | 'fetched' 
  | 'canonical_built' 
  | 'r2_uploaded' 
  | 'ai_enrichment_done'
  | 'embeddings_started' 
  | 'embeddings_progress' 
  | 'embeddings_done'
  | 'qdrant_upsert_started'
  | 'qdrant_upsert_progress'
  | 'qdrant_upsert_done'
  | 'supabase_updated'
  | 'done';

export interface JobProgress {
  jobId: string;
  stage: ImportStage;
  stageProgress?: string; // "{batch_i}/{total_batches}" або "{processed}/{total}"
  documentNreg?: string;
  contentHash?: string;
  expectedChunks?: number;
  processedChunks?: number;
  lastError?: string;
}

/**
 * Оновлює прогрес job
 */
export async function updateJobProgress(
  supabase: SupabaseClient,
  progress: JobProgress
): Promise<void> {
  const progressData: any = {
    stage: progress.stage,
    updated_at: nowIso(),
  };
  
  if (progress.stageProgress) {
    progressData.stage_progress = progress.stageProgress;
  }
  if (progress.documentNreg) {
    progressData.document_nreg = progress.documentNreg;
  }
  if (progress.contentHash) {
    progressData.content_hash = progress.contentHash;
  }
  if (progress.expectedChunks !== undefined) {
    progressData.expected_chunks = progress.expectedChunks;
  }
  if (progress.processedChunks !== undefined) {
    progressData.processed_chunks = progress.processedChunks;
  }
  if (progress.lastError) {
    progressData.last_error = progress.lastError;
  }
  
  const updateData: any = {
    progress_data: progressData,
  };
  
  // updated_at може не існувати в старій схемі
  // Перевіряємо через SELECT спочатку, але не критично якщо немає
  const { error } = await supabase
    .from('legislation_import_jobs')
    .update(updateData)
    .eq('id', progress.jobId);
  
  if (error) {
    console.warn(`⚠️  Failed to update job progress: ${error.message}`);
    // Не кидаємо помилку, бо це не критично для імпорту
  }
}

/**
 * Завершує job як успішний
 */
export async function completeJob(
  supabase: SupabaseClient,
  jobId: string
): Promise<void> {
  await updateJobProgress(supabase, {
    jobId,
    stage: 'done',
  });
  
  const { error } = await supabase
    .from('legislation_import_jobs')
    .update({
      status: 'completed',
      completed_at: nowIso(),
      success_count: 1,
      processed_count: 1,
    })
    .eq('id', jobId);
  
  if (error) {
    console.warn(`⚠️  Failed to complete job: ${error.message}`);
  }
}

/**
 * Помічає job як failed
 */
export async function failJob(
  supabase: SupabaseClient,
  jobId: string,
  errorMessage: string
): Promise<void> {
  const { error } = await supabase
    .from('legislation_import_jobs')
    .update({
      status: 'failed',
      completed_at: nowIso(),
      error_message: errorMessage,
      error_count: 1,
      processed_count: 1,
      progress_data: {
        stage: 'failed',
        last_error: errorMessage,
      },
    })
    .eq('id', jobId);
  
  if (error) {
    console.warn(`⚠️  Failed to mark job as failed: ${error.message}`);
  }
}

/**
 * Перевіряє чи є незавершений job для документа (resume)
 */
export async function findResumeJob(
  supabase: SupabaseClient,
  radaNreg: string
): Promise<{ jobId: string; progress: any } | null> {
  const { data, error } = await supabase
    .from('legislation_import_jobs')
    .select('id, progress_data, config')
    .eq('status', 'running')
    .eq('config->>rada_nreg', radaNreg)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  
  if (error || !data) {
    return null;
  }
  
  return {
    jobId: data.id as string,
    progress: data.progress_data || {},
  };
}
