import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import { nowIso } from '../utils.js';

export interface R2LockFile {
  run_id: string;
  created_at: string; // ISO
  ttl_seconds: number;
}

function joinKey(prefix: string, ...parts: string[]): string {
  const p = (prefix || '').replace(/^\/+/, '').replace(/\/+$/, '');
  const tail = parts
    .map((x) => String(x || '').replace(/^\/+/, '').replace(/\/+$/, ''))
    .filter(Boolean)
    .join('/');
  return p ? `${p}/${tail}` : tail;
}

async function readBodyAsString(body: any): Promise<string> {
  if (!body) return '';
  if (typeof body.transformToString === 'function') {
    return await body.transformToString();
  }
  const chunks: Buffer[] = [];
  for await (const c of body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(c));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function isNotFound(e: any): boolean {
  const code = e?.$metadata?.httpStatusCode;
  if (code === 404) return true;
  const name = String(e?.name || '');
  return name === 'NoSuchKey' || name === 'NotFound';
}

function parseIsoMs(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export async function acquireDailyLock(params: {
  s3: S3Client;
  bucket: string;
  prefix: string;
  runId: string;
  ttlSeconds: number;
}): Promise<{ acquired: true; key: string; lock: R2LockFile } | { acquired: false; key: string; lock: R2LockFile | null }> {
  const key = joinKey(params.prefix, 'locks/daily.lock');

  let existing: R2LockFile | null = null;
  try {
    const res = await params.s3.send(new GetObjectCommand({ Bucket: params.bucket, Key: key }));
    const raw = await readBodyAsString(res.Body as any);
    const j = raw ? (JSON.parse(raw) as any) : null;
    if (j && typeof j.run_id === 'string' && typeof j.created_at === 'string' && typeof j.ttl_seconds === 'number') {
      existing = { run_id: j.run_id, created_at: j.created_at, ttl_seconds: j.ttl_seconds };
    }
  } catch (e: any) {
    if (!isNotFound(e)) throw e;
  }

  if (existing) {
    const createdMs = parseIsoMs(existing.created_at);
    const ageMs = createdMs !== null ? Date.now() - createdMs : Number.POSITIVE_INFINITY;
    const ttlMs = Math.max(0, existing.ttl_seconds) * 1000;
    if (ageMs >= 0 && ageMs < ttlMs) {
      return { acquired: false, key, lock: existing };
    }
  }

  const lock: R2LockFile = { run_id: params.runId, created_at: nowIso(), ttl_seconds: params.ttlSeconds };
  await params.s3.send(
    new PutObjectCommand({
      Bucket: params.bucket,
      Key: key,
      Body: JSON.stringify(lock, null, 2),
      ContentType: 'application/json',
    })
  );
  return { acquired: true, key, lock };
}

export async function releaseLock(params: { s3: S3Client; bucket: string; key: string }): Promise<void> {
  await params.s3.send(new DeleteObjectCommand({ Bucket: params.bucket, Key: params.key })).catch(() => null);
}

