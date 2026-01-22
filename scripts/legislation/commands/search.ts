/**
 * Search command — retrieval sanity test (Qdrant search → R2 extract).
 *
 * Тех-демо: показує top hits без чат-бота.
 */
import { createQdrantClient, QDRANT_COLLECTION_CHUNKS } from '../lib/qdrantAdmin.js';
import { generateEmbedding } from '../canonical/embeddings.js';
import { getJsonFromR2, extractTextByJsonPath } from '../lib/r2Json.js';

export interface SearchOptions {
  query: string;
  nreg?: string;
  topk?: number;
}

export async function searchDocuments(opts: SearchOptions): Promise<void> {
  const topk = opts.topk || 5;
  const apiKey = process.env.OPEN_ROUTER_API_RAG || process.env.OPEN_ROUTER_API_KEY;
  if (!apiKey) throw new Error('OPEN_ROUTER_API_RAG або OPEN_ROUTER_API_KEY не встановлено');

  console.log('## Search');
  console.log(`- query: ${opts.query}`);
  console.log(`- topk: ${topk}`);
  if (opts.nreg) console.log(`- filter_nreg: ${opts.nreg}`);

  // Embed query
  const queryEmbedding = await generateEmbedding(opts.query, apiKey);
  if (queryEmbedding.dimensions !== 1536) {
    throw new Error(`Query embedding dimensions mismatch: expected 1536, got ${queryEmbedding.dimensions}`);
  }

  // Qdrant search
  const qdrant = createQdrantClient();
  const filter = opts.nreg
    ? {
        must: [{ key: 'rada_nreg', match: { value: opts.nreg } }],
      }
    : undefined;

  const searchResults = await qdrant.search(QDRANT_COLLECTION_CHUNKS, {
    vector: queryEmbedding.embedding,
    limit: topk,
    filter: filter as any,
    with_payload: true,
  });

  console.log(`- qdrant_results_count: ${searchResults.length}`);

  // Extract text from R2
  const hits: Array<{
    score: number;
    rada_nreg: string;
    chunk_index: number;
    article_number: string | null;
    title: string;
    snippet: string;
    r2_key: string;
    json_path: string;
  }> = [];

  for (const result of searchResults) {
    const payload = (result as any).payload;
    const r2Key = payload?.r2_key;
    const jsonPath = payload?.json_path;

    if (!r2Key || !jsonPath) continue;

    try {
      const canonical = await getJsonFromR2(r2Key);
      const text = extractTextByJsonPath(canonical, jsonPath);
      if (!text) continue;

      hits.push({
        score: typeof (result as any).score === 'number' ? (result as any).score : 0,
        rada_nreg: payload.rada_nreg || 'unknown',
        chunk_index: typeof payload.chunk_index === 'number' ? payload.chunk_index : -1,
        article_number: payload.article_number || null,
        title: payload.title || 'unknown',
        snippet: text.slice(0, 300) + (text.length > 300 ? '...' : ''),
        r2_key: r2Key,
        json_path: jsonPath,
      });
    } catch (e) {
      console.warn(`⚠️  Failed to extract text from R2 key ${r2Key}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log('\n## Top hits');
  hits.forEach((hit, i) => {
    console.log(`\n[${i + 1}] score=${hit.score.toFixed(4)}`);
    console.log(`  rada_nreg: ${hit.rada_nreg}`);
    console.log(`  article_number: ${hit.article_number || 'N/A'}`);
    console.log(`  title: ${hit.title}`);
    console.log(`  snippet: ${hit.snippet}`);
    console.log(`  r2_key: ${hit.r2_key}`);
  });
}
