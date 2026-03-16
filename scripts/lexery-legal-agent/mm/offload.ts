/**
 * MM R2 Offload — store heavy memory content in R2; Supabase keeps pointer + preview only.
 * Key: tenant/{tenant_id}/mm/offload/{memory_item_id}.json
 * Bucket: same as runs (lexery-legal-agent).
 *
 * DEV RUN v11: 1 retry on transient 5xx; non-fatal for worker (log and skip insert or mark failed).
 */
import { PutObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { config } from '../lib/config.js';
import { r2KeyMmOffload } from '../lib/r2-keys.js';
import { logger } from '../lib/logger.js';

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

export interface OffloadPayload {
  content: string;
  content_hash?: string;
  created_at: string;
  memory_item_id: string;
  tenant_id: string | null;
}

/**
 * Put memory item full content to R2. Returns r2_key on success.
 * Key: tenant/{tenantId}/mm/offload/{memoryItemId}.json
 * 1 retry on 5xx.
 */
export async function putMemoryOffload(params: {
  tenantId: string | null;
  memoryItemId: string;
  content: string;
  contentHash?: string;
}): Promise<{ success: boolean; r2_key?: string; error?: string }> {
  const r2 = createR2Client();
  if (!r2) {
    return { success: false, error: 'R2 not configured' };
  }

  const effectiveTenant = params.tenantId ?? 'global';
  const r2Key = r2KeyMmOffload(effectiveTenant, params.memoryItemId);
  const body: OffloadPayload = {
    content: params.content,
    content_hash: params.contentHash,
    created_at: new Date().toISOString(),
    memory_item_id: params.memoryItemId,
    tenant_id: params.tenantId,
  };
  const bodyBuf = Buffer.from(JSON.stringify(body), 'utf8');

  const doPut = async (): Promise<void> => {
    await r2.send(
      new PutObjectCommand({
        Bucket: config.r2BucketRuns,
        Key: r2Key,
        Body: bodyBuf,
        ContentType: 'application/json; charset=utf-8',
        Metadata: {
          memory_item_id: params.memoryItemId,
          content_length: String(bodyBuf.length),
        },
      })
    );
  };

  try {
    await doPut();
    return { success: true, r2_key: r2Key };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const is5xx = /5\d{2}/.test(msg) || msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT');
    if (is5xx) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        await doPut();
        return { success: true, r2_key: r2Key };
      } catch (e2: unknown) {
        logger.warn('mm_offload: retry failed', { r2_key: r2Key, error: e2 instanceof Error ? e2.message : String(e2) });
        return { success: false, error: msg };
      }
    }
    return { success: false, error: msg };
  }
}

/**
 * Get full content from R2 offload (for lazy load in read path).
 * Returns content string or null on failure.
 */
export async function getMemoryOffload(r2Key: string): Promise<{ content: string | null; error?: string }> {
  const r2 = createR2Client();
  if (!r2) {
    return { content: null, error: 'R2 not configured' };
  }

  try {
    const res = await r2.send(
      new GetObjectCommand({
        Bucket: config.r2BucketRuns,
        Key: r2Key,
      })
    );
    const body = res.Body;
    if (!body) return { content: null, error: 'Empty body' };
    const text = await (body as { transformToString(enc: string): Promise<string> }).transformToString('utf-8');
    const parsed = JSON.parse(text) as OffloadPayload;
    return { content: parsed?.content ?? null };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { content: null, error: msg };
  }
}
