import { createHash } from 'crypto';
import { config } from '../../lib/config.js';
import { embedMany, embedQuery } from '../../retrieval/embedding.js';
import { logger } from '../../lib/logger.js';
import type { MmDocChunk, MmDocScopeType, MmDocSearchHit } from './types.js';

const DOC_PAYLOAD_INDEX_FIELDS = [
  'tenant_id',
  'user_id',
  'project_id',
  'conversation_id',
  'scope_type',
  'scope_id',
  'doc_id',
] as const;

export function buildMmDocPointId(docId: string, chunkIndex: number): string {
  const hex = createHash('sha1').update(`${docId}:${chunkIndex}`).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function shouldRetryMmDocsQdrantStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function isTransientFetchError(error: unknown): boolean {
  if (!error) return false;
  const msg = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return /fetch failed|ECONNRESET|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|EAI_AGAIN|AbortError|This operation was aborted/i.test(msg);
}

async function fetchQdrant(
  url: string,
  init: RequestInit,
  options?: { attempts?: number; retry409?: boolean }
): Promise<Response> {
  const attempts = Math.max(1, options?.attempts ?? 3);
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
      if ((res.status === 409 && options?.retry409) || shouldRetryMmDocsQdrantStatus(res.status)) {
        if (i < attempts - 1) {
          await new Promise((resolve) => setTimeout(resolve, 250 * (i + 1)));
          continue;
        }
      }
      return res;
    } catch (error) {
      lastError = error;
      if (!isTransientFetchError(error) || i === attempts - 1) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * (i + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('MM Docs Qdrant fetch failed');
}

function getBaseUrl(): string {
  if (!config.mmDocsQdrantUrl) {
    throw new Error('MM Docs Qdrant not configured');
  }
  return config.mmDocsQdrantUrl.replace(/\/+$/, '');
}

function getApiKey(): string {
  if (!config.mmDocsQdrantApiKey) {
    throw new Error('MM Docs Qdrant API key not configured');
  }
  return config.mmDocsQdrantApiKey;
}

export function buildDocScopeFilter(params: {
  tenantId: string | null;
  userId: string;
  scopeType: MmDocScopeType;
  scopeId?: string | null;
}): { must: Array<{ key: string; match: { value: string } }> } {
  const must: Array<{ key: string; match: { value: string } }> = [
    { key: 'tenant_id', match: { value: params.tenantId ?? '' } },
    { key: 'user_id', match: { value: params.userId } },
    { key: 'scope_type', match: { value: params.scopeType } },
  ];
  if (params.scopeId) {
    must.push({ key: 'scope_id', match: { value: params.scopeId } });
  }
  return { must };
}

export async function upsertMmDocChunks(params: {
  docId: string;
  tenantId: string | null;
  userId: string;
  projectId?: string | null;
  conversationId?: string | null;
  scopeType: MmDocScopeType;
  scopeId?: string | null;
  filename: string;
  title: string;
  contentType?: string;
  canonicalR2Key: string;
  chunks: MmDocChunk[];
}): Promise<void> {
  if (!config.mmDocsQdrantUrl || !config.mmDocsQdrantApiKey) {
    throw new Error('MM Docs Qdrant not configured');
  }
  await ensureMmDocsCollection();
  const base = getBaseUrl();
  const apiKey = getApiKey();
  const embedded = await embedMany(params.chunks.map((chunk) => chunk.text));
  const points = params.chunks.map((chunk, index) => ({
    id: buildMmDocPointId(params.docId, chunk.chunk_index),
    vector: embedded[index]?.embedding,
    payload: {
      doc_id: params.docId,
      tenant_id: params.tenantId ?? '',
      user_id: params.userId,
      project_id: params.projectId ?? '',
      conversation_id: params.conversationId ?? '',
      scope_type: params.scopeType,
      scope_id: params.scopeId ?? '',
      filename: params.filename,
      title: params.title,
      content_type: params.contentType ?? '',
      chunk_index: chunk.chunk_index,
      r2_key: params.canonicalR2Key,
      json_path: `$.content.chunks[${chunk.chunk_index}].text`,
      preview: chunk.text.slice(0, 180),
      section_label: chunk.section_label ?? '',
      table_name: chunk.table_name ?? '',
      sheet_name: chunk.sheet_name ?? '',
    },
  }));

  const res = await fetchQdrant(`${base}/collections/${config.mmDocsQdrantCollection}/points?wait=true`, {
    method: 'PUT',
    headers: {
      'api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ points }),
  }, { attempts: 3 });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MM Docs Qdrant upsert failed: ${res.status} ${text.slice(0, 200)}`);
  }
}

let ensurePromise: Promise<void> | null = null;

export async function ensureMmDocsCollection(): Promise<void> {
  if (ensurePromise) return ensurePromise;
  ensurePromise = (async () => {
    const base = getBaseUrl();
    const apiKey = getApiKey();

    const existing = await fetchQdrant(`${base}/collections/${config.mmDocsQdrantCollection}`, {
      method: 'GET',
      headers: { 'api-key': apiKey },
    }, { attempts: 3 });

    if (existing.status === 404) {
      const createRes = await fetchQdrant(`${base}/collections/${config.mmDocsQdrantCollection}`, {
        method: 'PUT',
        headers: {
          'api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          vectors: {
            size: 1536,
            distance: 'Cosine',
          },
        }),
      }, { attempts: 3, retry409: true });
      if (!createRes.ok) {
        const text = await createRes.text();
        throw new Error(`MM Docs Qdrant collection create failed: ${createRes.status} ${text.slice(0, 200)}`);
      }
    } else if (!existing.ok) {
      const text = await existing.text();
      throw new Error(`MM Docs Qdrant collection check failed: ${existing.status} ${text.slice(0, 200)}`);
    }

    for (const field of DOC_PAYLOAD_INDEX_FIELDS) {
      const res = await fetchQdrant(`${base}/collections/${config.mmDocsQdrantCollection}/index?wait=true`, {
        method: 'PUT',
        headers: {
          'api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          field_name: field,
          field_schema: 'keyword',
        }),
      }, { attempts: 3, retry409: true });
      if (!res.ok && res.status !== 409) {
        const text = await res.text();
        logger.warn('mm_docs: payload index create failed', {
          field_name: field,
          status: res.status,
          error_preview: text.slice(0, 200),
        });
      }
    }
  })();

  try {
    await ensurePromise;
  } catch (err) {
    ensurePromise = null;
    throw err;
  }
}

export async function searchMmDocsSemantic(params: {
  queryText: string;
  tenantId: string | null;
  userId: string;
  scopeType: MmDocScopeType;
  scopeId?: string | null;
  topK?: number;
  runId?: string;
}): Promise<MmDocSearchHit[]> {
  if (!config.mmDocsQdrantUrl || !config.mmDocsQdrantApiKey) {
    return [];
  }
  const base = getBaseUrl();
  const apiKey = getApiKey();
  const topK = params.topK ?? config.mmDocsTopK;
  const embedding = await embedQuery(params.queryText.slice(0, 1000));
  const requestBody = JSON.stringify({
    vector: embedding.embedding,
    limit: topK,
    with_payload: true,
    filter: buildDocScopeFilter({
      tenantId: params.tenantId,
      userId: params.userId,
      scopeType: params.scopeType,
      scopeId: params.scopeId,
    }),
  });

  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.round(config.mmDocsQdrantTimeoutMs * (attempt === 0 ? 1 : 1.5))
    );
    try {
      const res = await fetchQdrant(
        `${base}/collections/${config.mmDocsQdrantCollection}/points/search`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'api-key': apiKey,
            'Content-Type': 'application/json',
          },
          body: requestBody,
        },
        { attempts: 1 }
      );
      clearTimeout(timer);
      if (!res.ok) {
        const text = await res.text();
        logger.warn('mm_docs: qdrant search failed', {
          run_id: params.runId,
          attempt: attempt + 1,
          status: res.status,
          error_preview: text.slice(0, 200),
        });
        return [];
      }
      const data = (await res.json()) as {
        result?: Array<{ id: string | number; score: number; payload?: Record<string, unknown> }>;
      };
      return (data.result ?? []).map((row) => ({
        id: String(row.id),
        score: row.score,
        doc_id: (row.payload?.doc_id as string) ?? '',
        chunk_index: Number(row.payload?.chunk_index ?? 0),
        r2_key: (row.payload?.r2_key as string) ?? '',
        json_path: (row.payload?.json_path as string) ?? '',
        scope_type: (row.payload?.scope_type as MmDocScopeType) ?? params.scopeType,
        scope_id: (row.payload?.scope_id as string) || null,
        filename: row.payload?.filename as string | undefined,
        title: row.payload?.title as string | undefined,
        preview: row.payload?.preview as string | undefined,
      }));
    } catch (error) {
      clearTimeout(timer);
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      if (attempt < 1 && isTransientFetchError(error)) {
        logger.warn('mm_docs: qdrant search retry', {
          run_id: params.runId,
          attempt: attempt + 1,
          error: message,
        });
        continue;
      }
      throw error;
    }
  }
  return [];
}
