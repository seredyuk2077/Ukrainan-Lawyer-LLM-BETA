/**
 * U1 Attachments — R2 overflow (LEX-72, LEX-77)
 * Bucket: lexery-legal-agent, prefix: runs/{tenant_id}/{run_id}/attachments/
 */
import { createHash } from 'crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { config } from '../lib/config.js';
import {
  extractRunIdFromRunsAttachmentKey,
  isAllowedInternalAttachmentReference,
  isMmDocRawKeyForIdentity,
  isRunsAttachmentKeyForTenant,
  r2KeyAttachment,
} from '../lib/r2-keys.js';
import { isSupportedMmDocAttachment, normalizeContentType } from '../mm/doc/formats.js';
import { withTransientGatewayIoRetry } from './retry.js';
import { RunRepository } from './storage.js';
import type { AttachmentInput, AttachmentManifestItem } from './types.js';

/** Sanitize filename: no ../, spaces → underscore */
function sanitizeFilename(name: string): string {
  return name
    .replace(/\.\./g, '')
    .replace(/[/\\]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 255) || 'unnamed';
}

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

function normalizeUrlOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

export function extractInternalR2KeyFromUrl(params: {
  url: string;
  endpoint?: string | null;
  allowedBuckets: string[];
}): string | null {
  return extractInternalR2ObjectFromUrl(params)?.key ?? null;
}

export function extractInternalR2ObjectFromUrl(params: {
  url: string;
  endpoint?: string | null;
  allowedBuckets: string[];
}): { bucket: string; key: string } | null {
  const endpointOrigin = normalizeUrlOrigin(params.endpoint);
  if (!endpointOrigin) return null;

  let url: URL;
  try {
    url = new URL(params.url);
  } catch {
    return null;
  }

  if (url.origin.toLowerCase() !== endpointOrigin) return null;

  const allowedBuckets = new Set(
    params.allowedBuckets
      .map((bucket) => bucket.trim())
      .filter((bucket) => bucket.length > 0)
  );
  if (allowedBuckets.size === 0) return null;

  const pathSegments = url.pathname.split('/').filter(Boolean);
  if (pathSegments.length === 0) return null;

  const [bucket, ...keyParts] = pathSegments;
  if (!bucket || !allowedBuckets.has(bucket) || keyParts.length === 0) return null;
  return {
    bucket,
    key: decodeURIComponent(keyParts.join('/')),
  };
}

export async function processAttachments(
  attachments: AttachmentInput[],
  tenantId: string,
  userId: string,
  runId: string
): Promise<{ manifest: AttachmentManifestItem[]; warnings: string[] }> {
  const manifest: AttachmentManifestItem[] = [];
  const warnings: string[] = [];
  const r2 = createR2Client();
  const runRepo = new RunRepository();
  const runOwnershipCache = new Map<string, boolean>();

  async function isAllowedInternalReferenceForCaller(r2Key: string): Promise<boolean> {
    if (
      !isAllowedInternalAttachmentReference({
        tenantId,
        userId,
        r2Key,
      })
    ) {
      return false;
    }
    if (
      isMmDocRawKeyForIdentity({
        tenantId,
        userId,
        r2Key,
      })
    ) {
      return true;
    }
    if (
      !isRunsAttachmentKeyForTenant({
        tenantId,
        r2Key,
      })
    ) {
      return false;
    }
    const referencedRunId = extractRunIdFromRunsAttachmentKey(r2Key);
    if (!referencedRunId) return false;
    if (runOwnershipCache.has(referencedRunId)) {
      return runOwnershipCache.get(referencedRunId) === true;
    }
    const referencedRun = await withTransientGatewayIoRetry(() => runRepo.findByRunId(referencedRunId));
    const allowed = Boolean(
      referencedRun &&
      referencedRun.user_id === userId &&
      (referencedRun.tenant_id ?? null) === tenantId
    );
    runOwnershipCache.set(referencedRunId, allowed);
    return allowed;
  }

  for (const att of attachments) {
    if (att.contentBase64) {
      const buf = Buffer.from(att.contentBase64, 'base64');
      const size = buf.length;
      const contentType = normalizeContentType(att.contentType) || 'application/octet-stream';
      const mmDocCandidate = isSupportedMmDocAttachment({ filename: att.name, contentType });

      if (size > config.attachmentInlineMaxBytes || mmDocCandidate) {
        if (r2) {
          const safeName = sanitizeFilename(att.name);
          const r2Key = r2KeyAttachment(tenantId, runId, safeName);
          const sha256 = createHash('sha256').update(buf).digest('hex');
          try {
            const s3 = r2;
            await s3.send(
              new PutObjectCommand({
                Bucket: config.r2BucketRuns,
                Key: r2Key,
                Body: buf,
                ContentType: contentType,
                Metadata: {
                  sha256,
                  sizeBytes: String(size),
                },
              })
            );
            manifest.push({
              name: att.name,
              size,
              sha256,
              content_type: contentType,
              storage: 'r2',
              r2_key: r2Key,
              mm_doc_candidate: mmDocCandidate || undefined,
            });
          } catch (e) {
            warnings.push(`R2 upload failed for ${att.name}: ${(e as Error).message}`);
            manifest.push({
              name: att.name,
              size,
              content_type: contentType,
              storage: 'inline',
              mm_doc_candidate: mmDocCandidate || undefined,
            });
          }
        } else {
          warnings.push(
            mmDocCandidate
              ? `Attachment ${att.name} is a document candidate but R2 is not configured; downstream MM Docs ingest will be unavailable`
              : `Attachment ${att.name} exceeds inline limit but R2 not configured; skipped`
          );
        }
      } else {
        manifest.push({
          name: att.name,
          size,
          sha256: createHash('sha256').update(buf).digest('hex'),
          content_type: contentType,
          storage: 'inline',
          mm_doc_candidate: mmDocCandidate || undefined,
        });
      }
    } else if (att.presignedUrl) {
      const contentType = normalizeContentType(att.contentType) || 'application/octet-stream';
      const mmDocCandidate = isSupportedMmDocAttachment({ filename: att.name, contentType });
      const internalR2Object = extractInternalR2ObjectFromUrl({
        url: att.presignedUrl,
        endpoint: config.r2Endpoint,
        allowedBuckets: Array.from(new Set([config.r2BucketRuns, config.mmDocsBucket])),
      });
      if (!internalR2Object) {
        warnings.push(
          `Attachment ${att.name} uses an unsupported presigned URL source; only internal R2 URLs are accepted for downstream processing`
        );
        continue;
      }
      if (!(await isAllowedInternalReferenceForCaller(internalR2Object.key))) {
        warnings.push(
          `Attachment ${att.name} uses an internal R2 key outside the caller tenant/user attachment namespace; skipped`
        );
        continue;
      }
      manifest.push({
        name: att.name,
        size: 0,
        content_type: contentType,
        storage: 'r2',
        r2_key: internalR2Object.key,
        mm_doc_candidate: mmDocCandidate || undefined,
      });
    }
  }

  return { manifest, warnings };
}

export function estimateRequestSize(body: { query?: string; attachments?: AttachmentInput[] }): number {
  let size = 0;
  if (body.query) size += Buffer.byteLength(body.query, 'utf8');
  for (const a of body.attachments || []) {
    if (a.contentBase64) size += Math.ceil((a.contentBase64.length * 3) / 4);
  }
  return size;
}
