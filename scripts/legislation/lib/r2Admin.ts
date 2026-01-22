/**
 * R2 Admin helpers for Legislation bucket (AWS SDK v3 S3Client).
 * Підтримує HEAD + COPY (archive) + DELETE.
 */
import { CopyObjectCommand, DeleteObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createR2Client, getLegislationBucket } from './r2Client.js';
import { assertLegislationBucketConfiguredCorrectly, assertNoDoubleLegislationPrefix } from './r2Guardrails.js';

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

