import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { config } from '../../lib/config.js';
import {
  r2KeyMmDocCanonical,
  r2KeyMmDocRaw,
  type MmDocScopeKey,
} from '../../lib/r2-keys.js';
import type { MmDocCanonical } from './types.js';

let clientInstance: S3Client | null = null;
const MM_DOC_CANONICAL_CACHE_TTL_MS = 60_000;
const MM_DOC_CANONICAL_CACHE_MAX_ENTRIES = 32;
const canonicalCache = new Map<
  string,
  {
    expiresAt: number;
    canonical: MmDocCanonical;
  }
>();
const canonicalInflight = new Map<string, Promise<MmDocCanonical>>();

function getR2Client(): S3Client {
  if (!clientInstance) {
    if (!config.r2Endpoint || !config.r2AccessKey || !config.r2SecretKey) {
      throw new Error('R2 not configured');
    }
    clientInstance = new S3Client({
      endpoint: config.r2Endpoint,
      region: config.r2Region,
      credentials: {
        accessKeyId: config.r2AccessKey,
        secretAccessKey: config.r2SecretKey,
      },
      forcePathStyle: true,
    });
  }
  return clientInstance;
}

async function streamToBuffer(body: unknown): Promise<Buffer> {
  if (!body) return Buffer.from('');
  if (typeof (body as { transformToByteArray?: () => Promise<Uint8Array> }).transformToByteArray === 'function') {
    const bytes = await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
    return Buffer.from(bytes);
  }
  if (typeof (body as { transformToString?: (enc: string) => Promise<string> }).transformToString === 'function') {
    const text = await (body as { transformToString: (enc: string) => Promise<string> }).transformToString('utf8');
    return Buffer.from(text, 'utf8');
  }
  const chunks: Buffer[] = [];
  const iterator = (body as AsyncIterable<Buffer | Uint8Array>)[Symbol.asyncIterator]?.();
  if (!iterator) return Buffer.from('');
  for (let result = await iterator.next(); !result.done; result = await iterator.next()) {
    chunks.push(Buffer.isBuffer(result.value) ? result.value : Buffer.from(result.value));
  }
  return Buffer.concat(chunks);
}

function getCachedCanonical(r2Key: string): MmDocCanonical | null {
  const cached = canonicalCache.get(r2Key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    canonicalCache.delete(r2Key);
    return null;
  }
  canonicalCache.delete(r2Key);
  canonicalCache.set(r2Key, cached);
  return cached.canonical;
}

function cacheCanonical(r2Key: string, canonical: MmDocCanonical): void {
  canonicalCache.set(r2Key, {
    expiresAt: Date.now() + MM_DOC_CANONICAL_CACHE_TTL_MS,
    canonical,
  });
  while (canonicalCache.size > MM_DOC_CANONICAL_CACHE_MAX_ENTRIES) {
    const oldest = canonicalCache.keys().next().value;
    if (!oldest) break;
    canonicalCache.delete(oldest);
  }
}

export async function putMmDocRaw(params: {
  tenantId: string | null;
  userId: string;
  docId: string;
  filename: string;
  contentType?: string;
  buffer: Buffer;
  sha256?: string;
}): Promise<{ r2Key: string }> {
  const client = getR2Client();
  if (params.buffer.length > config.mmDocsRawMaxBytes) {
    throw new Error(
      `MM Docs raw upload too large: ${params.buffer.length} > ${config.mmDocsRawMaxBytes}`
    );
  }
  const r2Key = r2KeyMmDocRaw(params.tenantId || 'global', params.userId, params.docId, params.filename);
  await client.send(
    new PutObjectCommand({
      Bucket: config.mmDocsBucket,
      Key: r2Key,
      Body: params.buffer,
      ContentType: params.contentType || 'application/octet-stream',
      Metadata: {
        doc_id: params.docId,
        user_id: params.userId,
        ...(params.sha256 ? { sha256: params.sha256 } : {}),
      },
    })
  );
  return { r2Key };
}

export async function getMmDocRaw(r2Key: string): Promise<Buffer> {
  const client = getR2Client();
  const res = await client.send(
    new GetObjectCommand({
      Bucket: config.mmDocsBucket,
      Key: r2Key,
    })
  );
  return await streamToBuffer(res.Body);
}

export async function putMmDocCanonical(params: {
  tenantId: string | null;
  userId: string;
  scopeType: MmDocScopeKey;
  scopeId?: string | null;
  docId: string;
  canonical: MmDocCanonical;
}): Promise<{ r2Key: string }> {
  const client = getR2Client();
  const r2Key = r2KeyMmDocCanonical(
    params.tenantId || 'global',
    params.userId,
    params.scopeType,
    params.scopeId,
    params.docId
  );
  await client.send(
    new PutObjectCommand({
      Bucket: config.mmDocsBucket,
      Key: r2Key,
      Body: Buffer.from(JSON.stringify(params.canonical), 'utf8'),
      ContentType: 'application/json; charset=utf-8',
      Metadata: {
        doc_id: params.docId,
        user_id: params.userId,
        scope_type: params.scopeType,
        scope_id: params.scopeId ?? 'global',
      },
    })
  );
  canonicalInflight.delete(r2Key);
  cacheCanonical(r2Key, params.canonical);
  return { r2Key };
}

export async function getMmDocCanonical(r2Key: string): Promise<MmDocCanonical> {
  const cached = getCachedCanonical(r2Key);
  if (cached) return cached;

  const inflight = canonicalInflight.get(r2Key);
  if (inflight) return inflight;

  const promise = (async () => {
    const buf = await getMmDocRaw(r2Key);
    const canonical = JSON.parse(buf.toString('utf8')) as MmDocCanonical;
    cacheCanonical(r2Key, canonical);
    return canonical;
  })();
  canonicalInflight.set(r2Key, promise);
  try {
    return await promise;
  } finally {
    canonicalInflight.delete(r2Key);
  }
}

export async function getMmDocChunkText(r2Key: string, jsonPath: string): Promise<string | null> {
  const canonical = await getMmDocCanonical(r2Key);
  const match = jsonPath.match(/^\$\.content\.chunks\[(\d+)\]\.text$/);
  if (!match) return null;
  const index = Number(match[1]);
  return canonical.content.chunks[index]?.text ?? null;
}
