/**
 * R2 Admin helpers for Legislation bucket (AWS SDK v3 S3Client).
 * Підтримує HEAD + COPY (archive) + DELETE + PUT (run artifacts).
 */
import { CopyObjectCommand, DeleteObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createR2Client, getLegislationBucket } from './r2Client.js';
import { assertLegislationBucketConfiguredCorrectly, assertNoDoubleLegislationPrefix, R2_PREFIX_RUNS } from './r2Guardrails.js';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';

export interface R2HeadInfo {
  exists: boolean;
  size?: number;
  etag?: string;
  lastModified?: string;
}

export function getR2AdminClient(): { client: S3Client; bucket: string } {
  assertLegislationBucketConfiguredCorrectly();
  const client = createR2Client();
  const bucket = getLegislationBucket();
  return { client, bucket };
}

export async function headObject(client: S3Client, bucket: string, key: string): Promise<R2HeadInfo> {
  assertNoDoubleLegislationPrefix(key);
  try {
    const res = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return {
      exists: true,
      size: typeof res.ContentLength === 'number' ? res.ContentLength : undefined,
      etag: res.ETag || undefined,
      lastModified: res.LastModified ? res.LastModified.toISOString() : undefined,
    };
  } catch (e: any) {
    if (e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404) {
      return { exists: false };
    }
    throw e;
  }
}

export async function copyObject(params: {
  client: S3Client;
  bucket: string;
  sourceKey: string;
  destKey: string;
}): Promise<void> {
  assertNoDoubleLegislationPrefix(params.sourceKey);
  assertNoDoubleLegislationPrefix(params.destKey);

  // CopySource format: "<bucket>/<key>" where key is URL-encoded but slashes preserved.
  // (S3 expects bucket/key, not an encoded "/" between them.)
  const encodedKey = encodeURIComponent(params.sourceKey).replace(/%2F/g, '/');
  const copySource = `${params.bucket}/${encodedKey}`;
  await params.client.send(
    new CopyObjectCommand({
      Bucket: params.bucket,
      Key: params.destKey,
      CopySource: copySource,
      ContentType: 'application/json; charset=utf-8',
      MetadataDirective: 'COPY',
    })
  );
}

export async function deleteObject(client: S3Client, bucket: string, key: string): Promise<void> {
  assertNoDoubleLegislationPrefix(key);
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

/**
 * Записати buffer в R2 (для run artifacts під legislation/tech/runs/).
 */
export async function putObject(params: {
  client: S3Client;
  bucket: string;
  key: string;
  body: Buffer | Uint8Array;
  contentType?: string;
}): Promise<void> {
  const { client, bucket, key, body, contentType = 'application/octet-stream' } = params;
  assertNoDoubleLegislationPrefix(key);
  if (!key.startsWith(R2_PREFIX_RUNS)) {
    throw new Error(`putObject for runs: key must start with ${R2_PREFIX_RUNS}, got: ${key}`);
  }
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );
}

/** Зібрати всі файли в директорії рекурсивно (relative paths, forward slashes). */
async function listFilesRecursive(dir: string, baseDir: string = dir): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    const rel = full.slice(baseDir.length).replace(/^[/\\]+/, '').replace(/\\/g, '/');
    if (e.isDirectory()) {
      out.push(...(await listFilesRecursive(full, baseDir)));
    } else {
      out.push(rel);
    }
  }
  return out;
}

/**
 * Завантажити вміст локальної директорії в R2 під prefix.
 * Ключі: r2Prefix + relativePath (forward slashes).
 * Після успішного upload можна видалити localDir (caller responsibility).
 */
export async function uploadDirectoryToR2(params: {
  client: S3Client;
  bucket: string;
  localDir: string;
  r2Prefix: string;
}): Promise<{ uploaded: number; keys: string[] }> {
  const { client, bucket, localDir, r2Prefix } = params;
  assertNoDoubleLegislationPrefix(r2Prefix);
  if (!r2Prefix.startsWith(R2_PREFIX_RUNS)) {
    throw new Error(`uploadDirectoryToR2: r2Prefix must start with ${R2_PREFIX_RUNS}, got: ${r2Prefix}`);
  }
  const prefix = r2Prefix.endsWith('/') ? r2Prefix : r2Prefix + '/';
  const keys: string[] = [];
  const relativePaths = await listFilesRecursive(localDir);
  for (const rel of relativePaths) {
    const fullPath = join(localDir, rel);
    const r2Key = prefix + rel.replace(/\\/g, '/');
    const body = await readFile(fullPath);
    const contentType = r2Key.endsWith('.json') ? 'application/json; charset=utf-8' : r2Key.endsWith('.txt') ? 'text/plain; charset=utf-8' : 'application/octet-stream';
    await putObject({ client, bucket, key: r2Key, body, contentType });
    keys.push(r2Key);
  }
  return { uploaded: keys.length, keys };
}

