/**
 * U1 Query overflow to R2 (runs/{tenant_id}/{run_id}/input/query.txt)
 * Bucket: lexery-legal-agent. When query exceeds QUERY_R2_THRESHOLD_BYTES, store full text in R2.
 */
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { config } from '../lib/config.js';
import type { QueryOverflowRef, QueryPreview } from './types.js';

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

export interface PutQueryOverflowResult {
  success: boolean;
  query_ref?: QueryOverflowRef;
  query_preview: QueryPreview;
  error?: string;
}

export async function putQueryOverflow(
  query: string,
  tenantId: string,
  runId: string
): Promise<PutQueryOverflowResult> {
  const originalLength = Buffer.byteLength(query, 'utf8');
  const headChars = config.queryPreviewHeadChars;
  const tailChars = config.queryPreviewTailChars;
  const head = query.slice(0, headChars);
  const tail = query.slice(-tailChars);
  const query_preview: QueryPreview = {
    head,
    tail,
    original_length: originalLength,
    effective_length_hint: head.length + tail.length + 50,
  };

  const r2 = createR2Client();
  if (!r2) {
    return { success: false, query_preview, error: 'R2 not configured' };
  }

  const effectiveTenant = tenantId || 'dev-tenant';
  const r2Key = `runs/${effectiveTenant}/${runId}/input/query.txt`;

  try {
    const buf = Buffer.from(query, 'utf8');
    await r2.send(
      new PutObjectCommand({
        Bucket: config.r2BucketRuns,
        Key: r2Key,
        Body: buf,
        ContentType: 'text/plain; charset=utf-8',
        Metadata: {
          original_length: String(originalLength),
        },
      })
    );

    const query_ref: QueryOverflowRef = {
      storage: 'r2',
      r2_bucket: config.r2BucketRuns,
      r2_key: r2Key,
      content_type: 'text/plain',
      original_length: originalLength,
    };

    return { success: true, query_ref, query_preview };
  } catch (e) {
    const error = (e as Error).message;
    return { success: false, query_preview, error };
  }
}
