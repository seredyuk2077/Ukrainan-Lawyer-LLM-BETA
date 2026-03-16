/**
 * Full retrieval_trace offload to R2; pointer stored in DB compact trace meta.
 * New writes: tenant/{tenant_id}/runs/{run_id}/retrieval/trace_full.v1.json (see lib/r2-keys.ts).
 * Legacy keys (runs/.../retrieval_trace_full.json) remain readable via stored full_trace_r2_key.
 */
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { config } from '../lib/config.js';
import { r2KeyRetrievalTrace } from '../lib/r2-keys.js';
import { logger } from '../lib/logger.js';
import type { RetrievalTrace } from './types.js';

function createR2Client(): S3Client | null {
  if (!config.r2Endpoint || !config.r2AccessKey || !config.r2SecretKey) return null;
  return new S3Client({
    endpoint: config.r2Endpoint,
    region: config.r2Region,
    credentials: {
      accessKeyId: config.r2AccessKey,
      secretAccessKey: config.r2SecretKey,
    },
    forcePathStyle: true,
  });
}

export async function putRetrievalTraceFull(
  tenantId: string | null,
  runId: string,
  trace: RetrievalTrace
): Promise<{ success: boolean; r2_key?: string; error?: string }> {
  const r2 = createR2Client();
  if (!r2) return { success: false, error: 'R2 not configured' };
  const r2Key = r2KeyRetrievalTrace(tenantId ?? '', runId);
  try {
    const body = JSON.stringify(trace);
    await r2.send(
      new PutObjectCommand({
        Bucket: config.r2BucketRuns,
        Key: r2Key,
        Body: body,
        ContentType: 'application/json',
      })
    );
    return { success: true, r2_key: r2Key };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    logger.warn('retrieval_trace_r2: put failed', { r2_key: r2Key, error });
    return { success: false, error };
  }
}

export async function getRetrievalTraceFull(r2Key: string): Promise<{
  trace: RetrievalTrace | null;
  error?: string;
}> {
  const r2 = createR2Client();
  if (!r2) return { trace: null, error: 'R2 not configured' };
  try {
    const res = await r2.send(
      new GetObjectCommand({
        Bucket: config.r2BucketRuns,
        Key: r2Key,
      })
    );
    const body = await res.Body?.transformToString('utf-8');
    if (!body) return { trace: null, error: 'Empty body' };
    const trace = JSON.parse(body) as RetrievalTrace;
    return { trace };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { trace: null, error };
  }
}

/**
 * For forensics: return hits from DB, or full hits from R2 when full_trace_r2_key is set.
 */
export async function getRetrievalTraceHitsForForensics(run: {
  retrieval_trace?: { hits?: unknown[]; meta?: { full_trace_r2_key?: string } } | null;
}): Promise<{ hits: unknown[]; source: 'db' | 'r2' }> {
  const rt = run.retrieval_trace;
  const dbHits = Array.isArray(rt?.hits) ? rt.hits : [];
  const r2Key = rt?.meta?.full_trace_r2_key;
  if (!r2Key) return { hits: dbHits, source: 'db' };
  const { trace, error } = await getRetrievalTraceFull(r2Key);
  if (error || !trace) return { hits: dbHits, source: 'db' };
  const fullHits = Array.isArray(trace.hits) ? trace.hits : [];
  return { hits: fullHits, source: 'r2' };
}
