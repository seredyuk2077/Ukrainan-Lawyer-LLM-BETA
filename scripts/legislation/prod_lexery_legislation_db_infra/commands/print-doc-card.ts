#!/usr/bin/env node
/**
 * Print Document Card — компактна картка документа для ручного аудиту
 * 
 * Показує:
 * - Supabase: nreg, title, document_type_slug, document_type, category
 * - Canonical topBlock (перші 600 символів)
 * - Qdrant: act payload + 2 chunks payload
 */

import { createSupabaseAdminClient } from '../lib/supabaseAdmin.js';
import { getJsonFromR2 } from '../lib/r2Json.js';
import { createQdrantClient, QDRANT_COLLECTION_ACTS, QDRANT_COLLECTION_CHUNKS } from '../lib/qdrantAdmin.js';
import { qdrantActId } from '../lib/qdrantIds.js';

export async function printDocCard(nreg: string): Promise<void> {
  const supabase = createSupabaseAdminClient();
  const qdrant = createQdrantClient();

  // 1. Supabase
  const { data: doc, error } = await supabase
    .from('legislation_documents')
    .select('*')
    .eq('rada_nreg', nreg)
    .maybeSingle();

  if (error || !doc) {
    console.log(`❌ Document not found: ${nreg}`);
    return;
  }

  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`📄 Document Card: ${nreg}`);
  console.log(`═══════════════════════════════════════════════════════════\n`);

  // Supabase fields
  console.log(`📊 Supabase:`);
  console.log(`   nreg: ${doc.rada_nreg}`);
  console.log(`   dokid: ${doc.rada_dokid || 'N/A'}`);
  console.log(`   title: ${doc.title}`);
  console.log(`   document_type_slug: ${doc.document_type_slug || 'NULL'}`);
  console.log(`   document_type: ${doc.document_type || 'NULL'}`);
  console.log(`   category: ${doc.category || 'NULL'}`);
  console.log(`   document_number: ${doc.document_number || 'NULL'}`);
  console.log(`   content_hash: ${doc.content_hash}`);

  // 2. Canonical topBlock
  let topBlock: string | null = null;
  let canonicalTyp: number | null = null;
  let canonicalOrgans: any = null;
  let summaryPrefix: string | null = null;

  if (doc.r2_key) {
    try {
      const canonical = await getJsonFromR2(doc.r2_key);
      
      if (canonical.raw?.rada_api_txt) {
        topBlock = canonical.raw.rada_api_txt.substring(0, 1200);
      } else if (canonical.content?.chunks?.[0]?.text) {
        topBlock = canonical.content.chunks[0].text.substring(0, 1200);
      }

      if (canonical.raw?.rada_api_json) {
        canonicalTyp = canonical.raw.rada_api_json.typ || null;
        canonicalOrgans = canonical.raw.rada_api_json.organs || null;
      }

      if (canonical.ai_enrichment?.summary) {
        summaryPrefix = canonical.ai_enrichment.summary.substring(0, 200);
      }
    } catch (e) {
      console.log(`   ⚠️  Failed to read R2: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log(`\n📝 Canonical (R2):`);
  console.log(`   typ: ${canonicalTyp || 'N/A'}`);
  console.log(`   organs: ${canonicalOrgans ? JSON.stringify(canonicalOrgans).substring(0, 100) : 'N/A'}`);
  if (topBlock) {
    console.log(`   topBlock (1200 chars, first 20 lines):`);
    const lines = topBlock.split('\n');
    const preview = lines.slice(0, 20).join('\n   ');
    console.log(`   ${preview}${lines.length > 20 ? '\n   ...' : ''}`);
  }
  if (summaryPrefix) {
    console.log(`   summary_prefix (200 chars): ${summaryPrefix}${summaryPrefix.length > 200 ? '...' : ''}`);
  }

  // 3. Qdrant
  const actPointId = qdrantActId({ radaNreg: nreg, contentHash: doc.content_hash });
  const { data: actPoint } = await qdrant.retrieve(QDRANT_COLLECTION_ACTS, {
    ids: [actPointId],
    with_payload: true,
    with_vector: false,
  });

  console.log(`\n🔍 Qdrant:`);
  if (actPoint && actPoint.length > 0) {
    const payload = actPoint[0].payload as any;
    console.log(`   Act payload:`);
    console.log(`     document_type_slug: ${payload?.document_type_slug || 'N/A'}`);
    console.log(`     document_type: ${payload?.document_type || 'N/A'}`);
    console.log(`     category: ${payload?.category || 'N/A'}`);
  } else {
    console.log(`   ⚠️  Act not found in Qdrant`);
  }

  // Chunks sample (2 chunks)
  const { data: chunks } = await qdrant.scroll(QDRANT_COLLECTION_CHUNKS, {
    filter: {
      must: [
        { key: 'rada_nreg', match: { value: nreg } },
        { key: 'content_hash', match: { value: doc.content_hash } },
      ],
    },
    limit: 2,
    with_payload: true,
    with_vector: false,
  });

  if (chunks && chunks.points && chunks.points.length > 0) {
    console.log(`   Chunks sample (${chunks.points.length}):`);
    for (const chunk of chunks.points.slice(0, 2)) {
      const payload = chunk.payload as any;
      console.log(`     [${payload?.chunk_index || 'N/A'}] article=${payload?.article_number || 'N/A'}, point=${payload?.unit_number || 'N/A'}`);
      console.log(`         document_type_slug: ${payload?.document_type_slug || 'N/A'}`);
      console.log(`         document_type: ${payload?.document_type || 'N/A'}`);
    }
  } else {
    console.log(`   ⚠️  Chunks not found in Qdrant`);
  }

  console.log(`\n═══════════════════════════════════════════════════════════\n`);
}
