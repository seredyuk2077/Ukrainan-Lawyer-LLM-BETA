/**
 * Inspect command — evidence summary for one document across Supabase/R2/Qdrant.
 */
import { createSupabaseAdminClient } from '../lib/supabaseAdmin.js';
import { getR2AdminClient, headObject } from '../lib/r2Admin.js';
import { isCanonicalKey, isCacheOrLogKey } from '../lib/r2Guardrails.js';
import { createQdrantClient, countByNreg, QDRANT_COLLECTION_ACTS, QDRANT_COLLECTION_CHUNKS } from '../lib/qdrantAdmin.js';

export async function inspectDocument(radaNreg: string): Promise<void> {
  const supabase = createSupabaseAdminClient();
  const { data: doc, error } = await supabase
    .from('legislation_documents')
    .select(
      'rada_nreg,title,content_hash,previous_hash,r2_key,rada_datred,chunks_count,expected_chunks,indexed_chunks,qdrant_status,indexed_content_hash,last_checked_at,last_sync_error,summary,keywords,topics,aliases'
    )
    .eq('rada_nreg', radaNreg)
    .maybeSingle();
  if (error) throw new Error(`Supabase inspect error: ${error.message}`);

  console.log('## Inspect');
  console.log(`- rada_nreg: ${radaNreg}`);
  console.log(`- supabase.document_found: ${String(Boolean(doc))}`);

  const qdrant = createQdrantClient();
  const qActs = await countByNreg(qdrant, QDRANT_COLLECTION_ACTS, radaNreg);
  const qChunks = await countByNreg(qdrant, QDRANT_COLLECTION_CHUNKS, radaNreg);
  console.log(`- qdrant.counts_by_nreg: acts=${qActs} chunks=${qChunks}`);

  if (!doc) {
    return;
  }

  console.log(`- title: ${doc.title}`);
  console.log(`- content_hash: ${doc.content_hash}`);
  console.log(`- previous_hash: ${doc.previous_hash || 'null'}`);
  console.log(`- qdrant_status: ${doc.qdrant_status || 'null'}`);
  console.log(`- indexed_content_hash: ${doc.indexed_content_hash || 'null'}`);
  console.log(`- expected_chunks: ${String(doc.expected_chunks ?? doc.chunks_count ?? 0)}`);
  console.log(`- indexed_chunks: ${String(doc.indexed_chunks ?? 0)}`);
  console.log(`- last_checked_at: ${doc.last_checked_at || 'null'}`);
  console.log(`- last_sync_error: ${doc.last_sync_error || 'null'}`);

  const r2Key = doc.r2_key as string;
  console.log(`- r2_key: ${r2Key}`);
  console.log(`- r2.is_canonical_key: ${String(isCanonicalKey(r2Key))}`);
  console.log(`- r2.is_cache_or_log_key: ${String(isCacheOrLogKey(r2Key))}`);

  const { client: r2, bucket } = getR2AdminClient();
  const head = await headObject(r2, bucket, r2Key);
  console.log(`- r2.head.exists: ${String(head.exists)}`);
  if (head.exists) {
    console.log(`- r2.head.size: ${String(head.size)}`);
    console.log(`- r2.head.lastModified: ${String(head.lastModified)}`);
  }

  const exp = Number(doc.expected_chunks ?? doc.chunks_count ?? 0);
  const discrepancy = {
    qdrant_chunks_vs_expected: qChunks - exp,
    indexed_chunks_vs_expected: Number(doc.indexed_chunks ?? 0) - exp,
  };
  console.log(`- discrepancies: ${JSON.stringify(discrepancy)}`);
  
  // Debug: analyze stru types if R2 canonical exists
  if (head.exists && r2Key) {
    try {
      const { getJsonFromR2 } = await import('../lib/r2Json.js');
      const canonical = await getJsonFromR2(r2Key);
      const stru = canonical?.raw?.rada_api_json?.stru;
      
      if (stru && Array.isArray(stru)) {
        const { analyzeStruTypes, determineParsingStrategy, mapTypToUnitType } = await import('../canonical/contentUnits.js');
        const dist = analyzeStruTypes(stru);
        const docType = doc.document_type || 'Документ';
        const strategyResult = determineParsingStrategy(dist, docType);
        
        console.log(`\n## Debug: Parsing Strategy`);
        console.log(`- strategy: ${strategyResult.strategy}`);
        console.log(`- reason: ${strategyResult.reason}`);
        console.log(`- stru.distribution: ST=${dist.articles} PU=${dist.points} PP=${dist.subpoints} RZ=${dist.sections} GL=${dist.chapters} KN=${dist.books} CH=${dist.parts} ABZ=${dist.paragraphs} ANNEX=${dist.annexes} TB=${dist.tables} other=${dist.other} total=${dist.total}`);
        
        // Show sample stru items (TOP-10 різних типів)
        const allTypes = new Set(stru.map((s: any) => s?.typ).filter(Boolean));
        const typedSamples: Array<{ typ: string; items: any[] }> = [];
        
        for (const typ of Array.from(allTypes).slice(0, 5)) {
          const samples = stru.filter((s: any) => s?.typ === typ).slice(0, 2);
          if (samples.length > 0) {
            typedSamples.push({ typ, items: samples });
          }
        }
        
        if (typedSamples.length > 0) {
          console.log(`\n- Sample stru items (TOP-2 per type):`);
          for (const { typ, items } of typedSamples) {
            for (const [i, s] of items.entries()) {
              const unitType = mapTypToUnitType(s);
              console.log(`  [${typ}-${i + 1}] unit_type=${unitType || 'unknown'} stru="${s.stru || ''}" tree_id="${s.tree_id || ''}" line="${String(s.line || '').slice(0, 60)}"`);
            }
          }
        }
        
        // Show units та chunks з canonical
        if (canonical?.content) {
          const units = canonical.content.chunks || [];
          if (units.length > 0) {
            console.log(`\n- Sample units/chunks (TOP-5):`);
            units.slice(0, 5).forEach((chunk: any, i: number) => {
              console.log(`  [chunk-${i + 1}] idx=${chunk.chunk_index} article="${chunk.article_number || 'N/A'}" tokens=${chunk.token_count || 'N/A'} title="${String(chunk.title || '').slice(0, 50)}"`);
            });
          }
        }
      }
    } catch (e) {
      // Ignore errors in debug section
    }
  }
}

