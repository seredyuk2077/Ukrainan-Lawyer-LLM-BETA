#!/usr/bin/env node
/**
 * Vectorize -> Qdrant (DocListDB catalog) — create collection + payload indexes + smoke-test
 *
 * Safety:
 * - Never touches existing Cloudflare Vectorize indexes (read-only passport fetch)
 * - Qdrant: only creates collection/indexes; smoke-test upserts 10 points and deletes ONLY those ids
 *
 * Run (from repo root):
 *   npm install --prefix "scripts/legislation/Documentation List DB/Full Import Script"
 *   npx --prefix "scripts/legislation/Documentation List DB/Full Import Script" tsx \
 *     "scripts/legislation/Documentation List DB/Full Import Script/Qdrant Migration/create_qdrant_collection.ts" create
 *
 * Smoke test:
 *   ... create --smoke-test
 */
import { Command } from 'commander';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fsp from 'node:fs/promises';
import { QdrantClient } from '@qdrant/js-client-rest';
import { createLogger } from '../src/logger.js';
import { getDefaults, getEnv, getPaths, loadEnv } from '../src/config.js';
import { downloadDocZip, extractDocTxtToUtf8, readLocalDocLines } from '../src/source.js';
import { parseDocTsvLine } from '../src/parser.js';
import { normalizeRow } from '../src/normalizers.js';
import { OpenRouterEmbeddingProvider } from '../src/embeddingProvider.js';
import { attachSupabaseFields } from '../src/supabaseSync.js';
import { nregToUuid } from '../src/qdrantIds.js';

type VectorizeMetric = 'cosine' | 'euclidean' | 'dot-product';
type QdrantDistance = 'Cosine' | 'Euclid' | 'Dot';

interface VectorizePassport {
  index_name: string;
  account_id?: string;
  dimensions: number;
  metric: VectorizeMetric;
  point_shape: {
    id: 'nreg';
    vector: { size: number };
    payload: Record<string, string>;
    notes?: string[];
  };
  source: {
    fetched_at: string;
    method: 'cloudflare_api' | 'static_defaults';
    endpoints: string[];
  };
}

interface QdrantPassport {
  collection_name: string;
  vectors: { size: number; distance: QdrantDistance };
  shard_number: number;
  replication_factor: number;
  payload_indexes: Array<{ field_name: string; field_schema: string }>;
  source: {
    fetched_at: string;
    base_url_redacted: string;
  };
}

interface MappingReport {
  kind: 'vectorize_to_qdrant_mapping';
  scope: 'DocListDB (Rada doc.txt catalog)';
  vectorize_config: VectorizePassport;
  qdrant_config: QdrantPassport;
  mapping_notes: {
    one_to_one: string[];
    equivalent: string[];
    importer_changes_later: string[];
  };
  smoke_test?: {
    ran: boolean;
    test_run_id?: string;
    inserted_ids?: string[];
    operations?: Record<string, unknown>;
  };
}

loadEnv();

const defaults = getDefaults();
const env = getEnv();
const paths = getPaths();
const VECTORIZE_BASE_URL = 'https://api.cloudflare.com/client/v4/accounts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPORT_PATH = path.join(__dirname, 'qdrant_schema_report.json');
const SMOKE_OUTPUT_PATH = path.join(__dirname, 'smoke_test_output.json');

function redactUrl(u: string): string {
  try {
    const url = new URL(u);
    // keep scheme + host + port only
    return `${url.protocol}//${url.host}`;
  } catch {
    return 'invalid_url';
  }
}

function requiredEnv(name: string, v: string | undefined): string {
  if (!v || !v.trim()) throw new Error(`${name} is missing`);
  return v.trim();
}

function qdrantBaseUrlFromEnv(overrides?: { qdrantUrl?: string; qdrantApiKey?: string }): { baseUrl: string; apiKey?: string } {
  // Per task:
  // - QDRANT_API (base URL), OR
  // - QDRANT_URL + QDRANT_API_KEY
  //
  // Reality check (observed in some envs):
  // - QDRANT_API may be used as an API key by mistake/legacy.
  // This function is defensive: if QDRANT_API is not a URL but QDRANT_URL exists, treat QDRANT_API as API key.
  
  let rawApi = (process.env.QDRANT_API || '').trim();
  const rawUrl = (overrides?.qdrantUrl || process.env.QDRANT_URL || '').trim();
  let rawKey = (overrides?.qdrantApiKey || process.env.QDRANT_API_KEY || '').trim();

  // Handle pipe format from some managed Qdrant envs (cluster_id|api_key)
  if (rawApi.includes('|') && !rawApi.startsWith('http')) {
    const parts = rawApi.split('|');
    if (parts.length >= 2) {
      if (!rawKey) rawKey = parts[1].trim();
      // It's definitely not a URL
      rawApi = ''; 
    }
  }

  const looksLikeUrl = (v: string) => /^https?:\/\//i.test(v);

  // 1) Preferred explicit URL var
  if (rawUrl && looksLikeUrl(rawUrl)) {
    const apiKey = rawKey || (rawApi && !looksLikeUrl(rawApi) ? rawApi : '') || undefined;
    return { baseUrl: rawUrl.replace(/\/+$/, ''), apiKey };
  }

  // 2) QDRANT_API as URL
  if (rawApi && looksLikeUrl(rawApi)) {
    const apiKey = rawKey || undefined;
    return { baseUrl: rawApi.replace(/\/+$/, ''), apiKey };
  }

  // 3) If we have a key-like QDRANT_API but no URL, fail loudly with guidance
  if (rawApi && !looksLikeUrl(rawApi)) {
    throw new Error(
      'Qdrant base URL missing or invalid. It looks like QDRANT_API contains a key, not a URL.\n' +
        'Set QDRANT_URL (e.g. https://<host>:6333) and optionally QDRANT_API_KEY, or set QDRANT_API to a URL.'
    );
  }

  throw new Error('Qdrant base URL missing. Set QDRANT_API (URL) or QDRANT_URL in .env');
}

function mapMetricToDistance(metric: VectorizeMetric): QdrantDistance {
  switch (metric) {
    case 'cosine':
      return 'Cosine';
    case 'dot-product':
      return 'Dot';
    case 'euclidean':
      return 'Euclid';
    default:
      // exhaustive
      return 'Cosine';
  }
}

async function cfFetchJson(url: string, token: string): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  const text = await res.text().catch(() => '');
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

async function fetchCloudflareAccountId(token: string): Promise<string> {
  const url = VECTORIZE_BASE_URL;
  const { status, json, text } = await cfFetchJson(url, token);
  if (status >= 400) {
    throw new Error(`Cloudflare /accounts failed: HTTP ${status} ${text.slice(0, 200)}`);
  }
  const result = json?.result;
  if (!Array.isArray(result) || result.length === 0 || typeof result[0]?.id !== 'string') {
    throw new Error('Cloudflare /accounts returned unexpected shape (missing result[0].id)');
  }
  return result[0].id;
}

function buildDefaultVectorizePassport(params: { indexName: string }): VectorizePassport {
  // DEPRECATED CONTEXT:
  // Cloudflare Vectorize is no longer used in prod, but this helper keeps the original
  // "Vectorize -> Qdrant mapping report" format. When VECTOR_DB_API is absent we fall
  // back to the known production contract (768 dims, cosine).
  const dimensions = 768;
  const metric: VectorizeMetric = 'cosine';

  const payloadShape: Record<string, string> = {
    nreg: 'keyword (string)',
    dokid: 'integer',
    nazva: 'string (truncated <=800 chars)',
    type: 'keyword (string, normalized first code; truncated <=200)',
    organ: 'keyword (string, normalized first code; truncated <=200)',
    status: 'keyword (string; truncated <=50)',
    year: 'integer | null',
    datred: 'string(YYYYMMDD) | null',
    minjust: 'bool',
    source_system: 'keyword (string)',
    is_in_supabase: 'bool',
    supabase_doc_id: 'keyword (string) | null',
    types_raw: 'string | undefined (truncated <=500)',
    organs_raw: 'string | undefined (truncated <=500)',
    is_test: 'bool | undefined',
    test_run_id: 'keyword (string) | undefined',
  };

  return {
    index_name: params.indexName,
    dimensions,
    metric,
    point_shape: {
      id: 'nreg',
      vector: { size: dimensions },
      payload: payloadShape,
      notes: [
        'Legacy note: Cloudflare Vectorize metadata indexes historically created for: type, organ, status, year.',
        'Importer additionally uses filters by nreg and is_test in audit/test flows.',
      ],
    },
    source: {
      fetched_at: new Date().toISOString(),
      method: 'static_defaults',
      endpoints: [],
    },
  };
}

async function fetchVectorizePassport(params: { indexName: string }): Promise<VectorizePassport> {
  const token = requiredEnv('VECTOR_DB_API', process.env.VECTOR_DB_API);
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || (await fetchCloudflareAccountId(token));

  const endpoints: string[] = [];
  endpoints.push(`${VECTORIZE_BASE_URL}/${accountId}/vectorize/indexes`);
  endpoints.push(`${VECTORIZE_BASE_URL}/${accountId}/vectorize/indexes/${params.indexName}`);

  // list (best effort, helps confirm naming)
  await cfFetchJson(endpoints[0], token).catch(() => null);

  // index info (required)
  const { status, json, text } = await cfFetchJson(endpoints[1], token);
  if (status >= 400) {
    throw new Error(`Cloudflare Vectorize index GET failed: HTTP ${status} ${text.slice(0, 400)}`);
  }
  const info = json?.result;
  const dimensions = info?.config?.dimensions;
  const metric = info?.config?.metric;
  if (typeof dimensions !== 'number' || !Number.isFinite(dimensions)) {
    throw new Error('Vectorize index info missing config.dimensions');
  }
  if (metric !== 'cosine' && metric !== 'euclidean' && metric !== 'dot-product') {
    throw new Error(`Vectorize index info has unexpected metric: ${String(metric)}`);
  }

  // Payload contract from the production importer (src/runner.ts)
  const payloadShape: Record<string, string> = {
    nreg: 'keyword (string)',
    dokid: 'integer',
    nazva: 'string (truncated <=800 chars)',
    type: 'keyword (string, normalized first code; truncated <=200)',
    organ: 'keyword (string, normalized first code; truncated <=200)',
    status: 'keyword (string; truncated <=50)',
    year: 'integer | null',
    datred: 'string(YYYYMMDD) | null',
    minjust: 'bool',
    source_system: 'keyword (string)',
    is_in_supabase: 'bool',
    supabase_doc_id: 'keyword (string) | null',
    types_raw: 'string | undefined (truncated <=500)',
    organs_raw: 'string | undefined (truncated <=500)',
    is_test: 'bool | undefined',
    test_run_id: 'keyword (string) | undefined',
  };

  return {
    index_name: params.indexName,
    account_id: accountId,
    dimensions,
    metric,
    point_shape: {
      id: 'nreg',
      vector: { size: dimensions },
      payload: payloadShape,
      notes: [
        'Vectorize metadata indexes historically created for: type, organ, status, year (legacy; see scripts/legislation/Documentation List DB/deprecated/vectorize/createIndex.ts).',
        'Importer additionally uses filters by nreg and is_test in audit/test flows.',
      ],
    },
    source: {
      fetched_at: new Date().toISOString(),
      method: 'cloudflare_api',
      endpoints,
    },
  };
}

async function ensureQdrantCollection(params: {
  logger: ReturnType<typeof createLogger>;
  client: QdrantClient;
  collectionName: string;
  vectors: { size: number; distance: QdrantDistance };
  shardNumber: number;
  replicationFactor: number;
}): Promise<void> {
  try {
    const info = await params.client.getCollection(params.collectionName);
    const size = info.config?.params?.vectors?.size;
    const distance = info.config?.params?.vectors?.distance;
    
    if (typeof size === 'number' && size !== params.vectors.size) {
      throw new Error(
        `Qdrant collection "${params.collectionName}" exists but vector size mismatch: expected ${params.vectors.size}, got ${size}`
      );
    }
    if (typeof distance === 'string' && distance !== params.vectors.distance) {
      throw new Error(
        `Qdrant collection "${params.collectionName}" exists but distance mismatch: expected ${params.vectors.distance}, got ${distance}`
      );
    }
    params.logger.info({ collection: params.collectionName }, 'qdrant collection already exists');
    return;
  } catch (e: any) {
    if (e.status === 404 || e?.message?.includes('Not Found')) {
      params.logger.info({ collection: params.collectionName }, 'creating qdrant collection');
      await params.client.createCollection(params.collectionName, {
        vectors: { size: params.vectors.size, distance: params.vectors.distance as any },
        shard_number: params.shardNumber,
        replication_factor: params.replicationFactor,
      });
      params.logger.info({ collection: params.collectionName }, 'qdrant collection created');
      return;
    }
    throw e;
  }
}

async function ensurePayloadIndex(params: {
  logger: ReturnType<typeof createLogger>;
  client: QdrantClient;
  collectionName: string;
  fieldName: string;
  fieldSchema: string;
}): Promise<void> {
  try {
    await params.client.createPayloadIndex(params.collectionName, {
      field_name: params.fieldName,
      field_schema: params.fieldSchema as any,
    });
    params.logger.info({ field: params.fieldName, schema: params.fieldSchema }, 'payload index ensured');
  } catch (e: any) {
     // Already exists tends to be 409 in some versions, or wrapped error
     const msg = String(e?.message || e).toLowerCase();
    if (e.status === 409 || msg.includes('already exists') || msg.includes('already_exists')) {
      params.logger.info({ field: params.fieldName }, 'payload index already exists');
      return;
    }
    throw e;
  }
}

async function getQdrantPassport(params: {
  baseUrl: string;
  apiKey?: string;
  collectionName: string;
  expected: { vectors: { size: number; distance: QdrantDistance }; shardNumber: number; replicationFactor: number };
  payloadIndexes: Array<{ field_name: string; field_schema: string }>;
}): Promise<QdrantPassport> {
  // For now we record the expected config we enforced; GET /collections/{name} is already validated in ensure step.
  return {
    collection_name: params.collectionName,
    vectors: params.expected.vectors,
    shard_number: params.expected.shardNumber,
    replication_factor: params.expected.replicationFactor,
    payload_indexes: params.payloadIndexes,
    source: { fetched_at: new Date().toISOString(), base_url_redacted: redactUrl(params.baseUrl) },
  };
}

async function readFirstValidRecords(limit: number): Promise<Array<{ nreg: string; embedding_text: string; payload: Record<string, any> }>> {
  // Ensure doc.txt exists (we only read a few lines; safe)
  const logger = createLogger({ level: 'info', pretty: true });
  try {
    await fsp.stat(paths.docTxtPath);
  } catch {
    logger.warn({ docTxtPath: paths.docTxtPath }, 'doc.txt missing; downloading doc.zip + extracting doc.txt');
    await downloadDocZip({
      url: defaults.sourceUrl,
      paths,
      logger,
      timeoutMs: defaults.defaultHttpTimeoutMs,
      maxRetries: defaults.defaultMaxRetries,
      backoffBaseMs: defaults.defaultBackoffBaseMs,
      backoffMaxMs: defaults.defaultBackoffMaxMs,
    });
    await extractDocTxtToUtf8({ paths, logger });
  }

  const out: Array<{ nreg: string; embedding_text: string; payload: Record<string, any> }> = [];
  const testRunId = `qdrant_smoke_${crypto.randomUUID()}`;
  const supaMap = new Map<string, string>();

  for await (const line of readLocalDocLines(paths.docTxtPath)) {
    if (!line || !line.trim()) continue;
    const parsed = parseDocTsvLine(line);
    if (!parsed.ok) continue;
    const normalized = normalizeRow(parsed.row);
    const supa = attachSupabaseFields(normalized.nreg, supaMap);

    const payload: Record<string, any> = {
      nreg: normalized.nreg,
      dokid: normalized.dokid,
      nazva: truncate(normalized.nazva, 800),
      type: truncate(normalized.type, 200),
      organ: truncate(normalized.organ, 200),
      status: truncate(normalized.status, 50),
      year: normalized.year ?? null,
      datred: normalized.datred ?? null,
      minjust: normalized.minjust,
      source_system: supa.source_system,
      is_in_supabase: supa.is_in_supabase,
      supabase_doc_id: supa.supabase_doc_id,
      is_test: true,
      test_run_id: testRunId,
    };
    if (normalized.types_raw) payload.types_raw = truncate(normalized.types_raw, 500);
    if (normalized.organs_raw) payload.organs_raw = truncate(normalized.organs_raw, 500);

    out.push({ nreg: normalized.nreg, embedding_text: normalized.embedding_text, payload });
    if (out.length >= limit) break;
  }

  if (out.length < limit) {
    throw new Error(`Could not read enough valid records from doc.txt. Wanted ${limit}, got ${out.length}`);
  }
  return out;
}

function truncate(v: string, max: number): string {
  if (v.length <= max) return v;
  return v.slice(0, max) + '…';
}

async function runSmokeTest(params: {
  logger: ReturnType<typeof createLogger>;
  client: QdrantClient;
  collectionName: string;
  expectedDims: number;
  limit: number;
}): Promise<{ testRunId: string; insertedIds: string[]; operations: Record<string, unknown> }> {
  const openRouterKey = requiredEnv('OPEN_ROUTER_API_RAG', env.openRouterApiKey);

  const testRecords = await readFirstValidRecords(params.limit);
  const testRunId = String(testRecords[0]?.payload?.test_run_id || '');
  if (!testRunId) throw new Error('internal: missing test_run_id in payload');

  // Use the same embedding provider as the importer (no truncation)
  const embedder = new OpenRouterEmbeddingProvider(params.logger, {
    apiKey: openRouterKey,
    model: defaults.defaultEmbeddingModel,
    dimensions: params.expectedDims,
    timeoutMs: defaults.defaultOpenRouterTimeoutMs,
    maxRetries: defaults.defaultMaxRetries,
    backoffBaseMs: defaults.defaultBackoffBaseMs,
    backoffMaxMs: defaults.defaultBackoffMaxMs,
  });

  params.logger.info({ count: testRecords.length, model: defaults.defaultEmbeddingModel }, 'smoke: generating embeddings');
  const vectors = await embedder.embedTexts(testRecords.map((r) => r.embedding_text));
  for (const v of vectors) {
    if (v.length !== params.expectedDims) {
      throw new Error(`smoke: embedding dims mismatch (got ${v.length}, expected ${params.expectedDims})`);
    }
  }

  const points = testRecords.map((r, i) => ({ id: nregToUuid(r.nreg), vector: vectors[i], payload: r.payload }));
  const insertedIds = points.map((p) => p.id);

  // Upsert
  params.logger.info({ count: points.length }, 'smoke: upsert 10 points');
  let upsert;
  try {
    upsert = await params.client.upsert(params.collectionName, {
      wait: true,
      points,
    });
  } catch (e: any) {
    params.logger.error({ err: e, msg: e.message, body: e.data || e.response?.data }, 'smoke: upsert failed');
    throw e;
  }

  // Vector search
  params.logger.info({ topK: 5 }, 'smoke: vector search');
  const search = await params.client.search(params.collectionName, {
    vector: vectors[0],
    limit: 5,
    with_payload: true,
  });

  // Filter scroll
  params.logger.info({ filter: { test_run_id: testRunId } }, 'smoke: filter scroll');
  const scroll = await params.client.scroll(params.collectionName, {
    limit: 10,
    with_payload: true,
    filter: { must: [{ key: 'test_run_id', match: { value: testRunId } }] },
  });

  // Delete by ids (cleanup)
  params.logger.info({ ids: insertedIds.length }, 'smoke: cleanup delete-by-ids');
  const del = await params.client.delete(params.collectionName, {
    wait: true,
    points: insertedIds,
  });

  // Verify deletion (scroll by test_run_id should return 0)
  const verify = await params.client.scroll(params.collectionName, {
    limit: 1,
    with_payload: false,
    filter: { must: [{ key: 'test_run_id', match: { value: testRunId } }] },
  });

  const remaining = verify.points.length;
  if (remaining !== 0) {
    throw new Error(`smoke: cleanup verification failed (expected 0 remaining points for test_run_id, got ${String(remaining)})`);
  }

  return {
    testRunId,
    insertedIds,
    operations: {
      upsert_status: upsert.status,
      search_status: 'ok',
      search_result_ids: search.map((r) => r.id),
      scroll_status: 'ok',
      scroll_result_ids: scroll.points.map((p) => p.id),
      delete_status: del.status,
      verify_status: 'ok',
    },
  };
}

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await fsp.writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function defaultPayloadIndexes(): Array<{ field_name: string; field_schema: string }> {
  // Based on fields actively used in filters/audit + high-value filter keys for future API.
  return [
    { field_name: 'nreg', field_schema: 'keyword' },
    { field_name: 'dokid', field_schema: 'integer' },
    { field_name: 'type', field_schema: 'keyword' },
    { field_name: 'organ', field_schema: 'keyword' },
    { field_name: 'status', field_schema: 'keyword' },
    { field_name: 'year', field_schema: 'integer' },
    { field_name: 'datred', field_schema: 'keyword' },
    { field_name: 'minjust', field_schema: 'bool' },
    { field_name: 'source_system', field_schema: 'keyword' },
    { field_name: 'is_in_supabase', field_schema: 'bool' },
    { field_name: 'supabase_doc_id', field_schema: 'keyword' },
    { field_name: 'is_test', field_schema: 'bool' },
    { field_name: 'test_run_id', field_schema: 'keyword' },
  ];
}

async function main() {
  const program = new Command();
  program
    .name('create-qdrant-collection')
    .description('Create Qdrant collection for DocListDB catalog (Qdrant schema; legacy Vectorize optional)')
    .option('--log-level <level>', 'Log level', 'info')
    .option('--log-pretty', 'Pretty logs', true);

  program
    .command('doctor')
    .description('Print env/connection diagnostics (no secrets) for Qdrant + OpenRouter (legacy Vectorize optional)')
    .option('--vectorize-index-name <name>', 'Legacy: Cloudflare Vectorize index name (passport fetch; optional)', defaults.defaultIndexName)
    .option('--qdrant-url <url>', 'Qdrant base URL override (http(s)://...)')
    .option('--qdrant-api-key <key>', 'Qdrant api-key override (if not in env)')
    .action(async (opts) => {
      const logger = createLogger({ level: opts.parent?.logLevel || 'info', pretty: Boolean(opts.parent?.logPretty) });

      const vectorToken = (process.env.VECTOR_DB_API || '').trim();
      const openRouterKey = (env.openRouterApiKey || '').trim();
      const cfAccount = (process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();

      const rawQdrantApi = (process.env.QDRANT_API || '').trim();
      const rawQdrantUrl = (process.env.QDRANT_URL || '').trim();
      const rawQdrantApiKey = (process.env.QDRANT_API_KEY || '').trim();

      const looksLikeUrl = (v: string) => /^https?:\/\//i.test(v);

      logger.info(
        {
          VECTOR_DB_API: vectorToken ? { present: true, len: vectorToken.length } : { present: false },
          CLOUDFLARE_ACCOUNT_ID: cfAccount ? { present: true } : { present: false },
          OPEN_ROUTER_API_RAG: openRouterKey ? { present: true, len: openRouterKey.length } : { present: false },
        },
        'env: core'
      );

      logger.info(
        {
          QDRANT_API: rawQdrantApi
            ? { present: true, len: rawQdrantApi.length, url_like: looksLikeUrl(rawQdrantApi), has_pipe: rawQdrantApi.includes('|') }
            : { present: false },
          QDRANT_URL: rawQdrantUrl ? { present: true, url_like: looksLikeUrl(rawQdrantUrl) } : { present: false },
          QDRANT_API_KEY: rawQdrantApiKey ? { present: true, len: rawQdrantApiKey.length } : { present: false },
        },
        'env: qdrant'
      );

      // Vectorize passport sanity-check (read-only)
      if (vectorToken) {
        try {
          const pass = await fetchVectorizePassport({ indexName: opts.vectorizeIndexName });
          logger.info(
            { index: pass.index_name, dims: pass.dimensions, metric: pass.metric, account_id_present: Boolean(pass.account_id) },
            'vectorize passport OK'
          );
        } catch (e) {
          logger.error({ err: e instanceof Error ? e.message : String(e) }, 'vectorize passport FAILED');
        }
      }

      // Qdrant connectivity check (best-effort)
      try {
        const { baseUrl, apiKey } = qdrantBaseUrlFromEnv({ qdrantUrl: opts.qdrantUrl, qdrantApiKey: opts.qdrantApiKey });
        const client = new QdrantClient({ url: baseUrl, apiKey, checkCompatibility: false });
        const res = await client.getCollections();
        logger.info({ qdrant: redactUrl(baseUrl), collections: res.collections.map(c => c.name) }, 'qdrant connectivity');
      } catch (e) {
        logger.warn({ err: e instanceof Error ? e.message : String(e) }, 'qdrant connectivity skipped/failed');
      }
    });

  program
    .command('create')
    .description('Create collection + payload indexes (idempotent); optionally run smoke-test')
    .option('--collection-name <name>', 'Qdrant collection name', defaults.defaultIndexName)
    .option('--vectorize-index-name <name>', 'Legacy: Cloudflare Vectorize index name (passport fetch; optional)', defaults.defaultIndexName)
    .option('--qdrant-url <url>', 'Qdrant base URL override (http(s)://...)')
    .option('--qdrant-api-key <key>', 'Qdrant api-key override (if not in env)')
    .option('--smoke-test', 'Run smoke test (upsert/search/scroll/delete) with 10 records', false)
    .option('--smoke-limit <n>', 'How many points to use in smoke-test', '10')
    .action(async (opts) => {
      const logger = createLogger({ level: opts.parent?.logLevel || 'info', pretty: Boolean(opts.parent?.logPretty) });

      const { baseUrl, apiKey } = qdrantBaseUrlFromEnv({ qdrantUrl: opts.qdrantUrl, qdrantApiKey: opts.qdrantApiKey });
      logger.info({ qdrant: redactUrl(baseUrl) }, 'qdrant endpoint');

      const client = new QdrantClient({ url: baseUrl, apiKey, checkCompatibility: false });

      const vectorToken = (process.env.VECTOR_DB_API || '').trim();
      const vectorizePassport = vectorToken
        ? await fetchVectorizePassport({ indexName: opts.vectorizeIndexName })
        : buildDefaultVectorizePassport({ indexName: opts.vectorizeIndexName });
      const qdrantDistance = mapMetricToDistance(vectorizePassport.metric);

      const collectionName = String(opts.collectionName || defaults.defaultIndexName);
      const shardNumber = 1;
      const replicationFactor = 1;

      await ensureQdrantCollection({
        logger,
        client,
        collectionName,
        vectors: { size: vectorizePassport.dimensions, distance: qdrantDistance },
        shardNumber,
        replicationFactor,
      });

      const payloadIndexes = defaultPayloadIndexes();
      for (const idx of payloadIndexes) {
        await ensurePayloadIndex({
          logger,
          client,
          collectionName,
          fieldName: idx.field_name,
          fieldSchema: idx.field_schema,
        });
      }

      const qdrantPassport = await getQdrantPassport({
        baseUrl,
        apiKey,
        collectionName,
        expected: { vectors: { size: vectorizePassport.dimensions, distance: qdrantDistance }, shardNumber, replicationFactor },
        payloadIndexes,
      });

      const report: MappingReport = {
        kind: 'vectorize_to_qdrant_mapping',
        scope: 'DocListDB (Rada doc.txt catalog)',
        vectorize_config: vectorizePassport,
        qdrant_config: qdrantPassport,
        mapping_notes: {
          one_to_one: [
            'Collection name matches Vectorize index name (default): legislation-catalog-index',
            'Vector size matches: 768',
            'Distance metric mapped: Vectorize cosine -> Qdrant Cosine',
            'Point id is string nreg (mapped to deterministic UUID)',
            'Payload keys preserved (same names as importer metadata)',
          ],
          equivalent: [
            'Vectorize "metadata indexes" -> Qdrant payload indexes (different internal mechanics, equivalent filter acceleration)',
            'Vectorize supports simple filter operators; Qdrant uses structured Filter DSL (must/must_not/should)',
          ],
          importer_changes_later: [
            'Replace Vectorize upsert/query/delete endpoints with Qdrant points upsert/search/scroll/delete',
            'Translate Vectorize filter objects to Qdrant Filter DSL (e.g., { nreg: id } -> must key=nreg match=value)',
            'Preserve idempotency: upsert by nreg',
            'Keep embedding dims safety checks (no silent truncation)',
          ],
        },
      };

      let smoke: any = null;
      if (Boolean(opts.smokeTest)) {
        const limit = Number.parseInt(String(opts.smokeLimit), 10) || 10;
        smoke = await runSmokeTest({
          logger,
          client,
          collectionName,
          expectedDims: vectorizePassport.dimensions,
          limit,
        });
        report.smoke_test = {
          ran: true,
          test_run_id: smoke.testRunId,
          inserted_ids: smoke.insertedIds,
          operations: smoke.operations,
        };
        await writeJsonFile(SMOKE_OUTPUT_PATH, report.smoke_test);
      } else {
        report.smoke_test = { ran: false };
      }

      await writeJsonFile(REPORT_PATH, report);
      logger.info({ reportPath: REPORT_PATH, smoke: Boolean(opts.smokeTest), smokeOutput: SMOKE_OUTPUT_PATH }, 'done');
    });

  await program.parseAsync(process.argv);
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  // Avoid leaking secrets; keep logs concise.
  console.error(`ERROR: ${msg}`);
  process.exit(1);
});
