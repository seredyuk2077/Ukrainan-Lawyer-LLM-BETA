/**
 * U1 Attachments — R2 overflow (LEX-72, LEX-77)
 * Bucket: lexery-legal-agent, prefix: runs/{tenant_id}/{run_id}/attachments/
 */
import { createHash } from 'crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { config } from '../lib/config.js';
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

export async function processAttachments(
  attachments: AttachmentInput[],
  tenantId: string,
  runId: string
): Promise<{ manifest: AttachmentManifestItem[]; warnings: string[] }> {
  const manifest: AttachmentManifestItem[] = [];
  const warnings: string[] = [];
  const r2 = createR2Client();

  for (const att of attachments) {
    if (att.contentBase64) {
      const buf = Buffer.from(att.contentBase64, 'base64');
      const size = buf.length;

      if (size > config.attachmentInlineMaxBytes) {
        if (r2) {
          const safeName = sanitizeFilename(att.name);
          const effectiveTenant = tenantId || 'dev-tenant';
          const r2Key = `runs/${effectiveTenant}/${runId}/attachments/${safeName}`;
          const sha256 = createHash('sha256').update(buf).digest('hex');
          const contentType = att.contentType || 'application/octet-stream';
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
              storage: 'r2',
              r2_key: r2Key,
            });
          } catch (e) {
            warnings.push(`R2 upload failed for ${att.name}: ${(e as Error).message}`);
            manifest.push({ name: att.name, size, storage: 'inline' });
          }
        } else {
          warnings.push(`Attachment ${att.name} exceeds inline limit but R2 not configured; skipped`);
        }
      } else {
        manifest.push({
          name: att.name,
          size,
          sha256: createHash('sha256').update(buf).digest('hex'),
          storage: 'inline',
        });
      }
    } else if (att.presignedUrl) {
      manifest.push({
        name: att.name,
        size: 0,
        storage: 'r2',
        r2_key: att.presignedUrl,
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
