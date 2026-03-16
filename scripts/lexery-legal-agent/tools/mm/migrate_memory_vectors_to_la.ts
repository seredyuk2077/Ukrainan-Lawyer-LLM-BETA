/**
 * Migrate memory vectors from legislation Qdrant cluster to LEXERY-LA cluster.
 * Usage:
 *   tsx scripts/lexery-legal-agent/tools/mm/migrate_memory_vectors_to_la.ts --dry-run
 *   tsx scripts/lexery-legal-agent/tools/mm/migrate_memory_vectors_to_la.ts --execute
 *
 * Env: source = legislation (QDRANT_URL / QDRANT_API_KEY); target = memory (QDRANT_MEMORY_URL / QDRANT_MEMORY_API_KEY).
 * Override with SOURCE_QDRANT_URL, SOURCE_QDRANT_API_KEY, TARGET_QDRANT_URL, TARGET_QDRANT_API_KEY.
 */
import { config } from '../../lib/config.js';

const COLLECTION = 'lexery_memory_semantic_v1';
const SCROLL_BATCH = 256;
const VECTOR_SIZE = 1536;

const sourceUrl =
  process.env.SOURCE_QDRANT_URL ||
  process.env.QDRANT_URL ||
  process.env.QDRANT_CLUSTER_ENDPOINT_LEXERY_LEGISLATION_DB ||
  process.env.qdrant_clusterENDPOINT_LEXERY_LEGISLATION_DB ||
  '';
const sourceKey =
  process.env.SOURCE_QDRANT_API_KEY ||
  process.env.QDRANT_API_KEY ||
  process.env.QDRANT_CLUSTER_API_KEY_LEXERY_LEGISLATION_DB ||
  process.env.qdrant_clusterAPI_LEXERY_LEGISLATION_DB ||
  '';
const targetUrl = process.env.TARGET_QDRANT_URL || process.env.QDRANT_MEMORY_URL || config.memoryQdrantUrl || '';
const targetKey = process.env.TARGET_QDRANT_API_KEY || process.env.QDRANT_MEMORY_API_KEY || config.memoryQdrantApiKey || '';

interface ScrollResult {
  points: Array<{ id: string | number; vector?: number[]; payload?: Record<string, unknown> }>;
  next_page_offset: string | number | null;
}

async function checkSourceCollectionExists(): Promise<boolean> {
  const res = await fetch(`${sourceUrl}/collections/${COLLECTION}`, {
    method: 'GET',
    headers: { 'api-key': sourceKey },
  });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`Source collection check ${res.status}: ${await res.text()}`);
  return true;
}

async function scrollSource(offset: string | number | null): Promise<ScrollResult> {
  const body: Record<string, unknown> = {
    limit: SCROLL_BATCH,
    with_payload: true,
    with_vector: true,
  };
  if (offset != null) body.offset = offset;
  const res = await fetch(`${sourceUrl}/collections/${COLLECTION}/points/scroll`, {
    method: 'POST',
    headers: { 'api-key': sourceKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 404) throw new Error('source_collection_missing');
  if (!res.ok) throw new Error(`Scroll ${res.status}: ${await res.text()}`);
  return (await res.json()) as ScrollResult;
}

async function upsertBatch(points: Array<{ id: string | number; vector: number[]; payload: Record<string, unknown> }>): Promise<boolean> {
  if (!points.length) return true;
  const res = await fetch(`${targetUrl}/collections/${COLLECTION}/points?wait=true`, {
    method: 'PUT',
    headers: { 'api-key': targetKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ points: points.map((p) => ({ id: p.id, vector: p.vector, payload: p.payload })) }),
  });
  return res.ok;
}

async function ensureCollection(url: string, key: string): Promise<void> {
  const list = await fetch(`${url}/collections`, {
    headers: { 'api-key': key },
  });
  if (!list.ok) throw new Error(`List collections ${list.status}`);
  const data = (await list.json()) as { result?: { collections?: Array<{ name: string }> } };
  const names = data.result?.collections?.map((c) => c.name) ?? [];
  if (names.includes(COLLECTION)) return;
  const create = await fetch(`${url}/collections/${COLLECTION}`, {
    method: 'PUT',
    headers: { 'api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      vectors: { size: VECTOR_SIZE, distance: 'Cosine' },
    }),
  });
  if (!create.ok) throw new Error(`Create collection ${create.status}: ${await create.text()}`);
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const execute = process.argv.includes('--execute');

  const report: {
    dry_run: boolean;
    source_host?: string;
    target_host?: string;
    source_count?: number;
    target_count_before?: number;
    target_count_after?: number;
    moved_points: number;
    errors: string[];
    error_codes?: string[];
    duration_ms: number;
  } = { dry_run: dryRun, moved_points: 0, errors: [], duration_ms: 0 };

  const t0 = Date.now();

  if (!sourceUrl || !sourceKey) {
    report.errors.push('Source Qdrant not configured (SOURCE_QDRANT_URL, QDRANT_URL, QDRANT_CLUSTER_ENDPOINT_LEXERY_LEGISLATION_DB, qdrant_clusterENDPOINT_LEXERY_LEGISLATION_DB or API key env)');
    report.error_codes = ['source_not_configured'];
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }
  if (!targetUrl || !targetKey) {
    report.errors.push('Target Qdrant not configured (TARGET_QDRANT_URL, QDRANT_MEMORY_URL or LEXERY-LA env)');
    report.error_codes = ['target_not_configured'];
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  try {
    report.source_host = sourceUrl ? new URL(sourceUrl.replace(/\/$/, '') || 'http://x').hostname : undefined;
    report.target_host = targetUrl ? new URL(targetUrl.replace(/\/$/, '') || 'http://x').hostname : undefined;
    if (dryRun) console.log('[migrate_memory_vectors] dry-run resolved hosts (no keys):', { source_host: report.source_host, target_host: report.target_host });

    if (!dryRun && execute) await ensureCollection(targetUrl, targetKey);

    const sourceExists = await checkSourceCollectionExists();
    if (!sourceExists) {
      report.errors.push('Source collection does not exist');
      report.error_codes = ['source_collection_missing'];
      report.duration_ms = Date.now() - t0;
      console.log(JSON.stringify(report, null, 2));
      process.exit(1);
    }

    let offset: string | number | null = null;
    let total = 0;
    const seenIds = new Set<string>();

    for (;;) {
      const scroll = await scrollSource(offset);
      const points = scroll.points ?? [];
      if (points.length === 0) break;

      for (const p of points) {
        const id = String(p.id);
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        if (!p.vector || p.vector.length !== VECTOR_SIZE) {
          report.errors.push(`Point ${id} missing or invalid vector`);
          continue;
        }
        if (!dryRun && execute) {
          const ok = await upsertBatch([{ id: p.id, vector: p.vector, payload: p.payload ?? {} }]);
          if (!ok) report.errors.push(`Upsert failed for ${id}`);
          else total++;
        } else {
          total++;
        }
      }
      report.moved_points = total;
      offset = scroll.next_page_offset ?? null;
      if (offset === null) break;
    }

    report.duration_ms = Date.now() - t0;
    console.log(JSON.stringify(report, null, 2));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    report.errors.push(msg);
    if (msg === 'source_collection_missing') report.error_codes = ['source_collection_missing'];
    report.duration_ms = Date.now() - t0;
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }
}

main();
