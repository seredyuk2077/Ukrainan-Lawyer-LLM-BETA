#!/usr/bin/env node
/**
 * Quick verification script — перевірка Qdrant points для тестового імпорту
 */
import dotenv from 'dotenv';
import { resolve } from 'path';
import { createQdrantClient, QDRANT_COLLECTION_CHUNKS, QDRANT_COLLECTION_ACTS, countByNreg } from './lib/qdrantAdmin.js';

dotenv.config({ path: resolve(process.cwd(), '.env') });

async function main() {
  const nreg = '254к/96-вр';
  const contentHash = '3817b1176f6cf532cdfd04db50f6c761448d41357f392cebaf710c4d38178d3f';

  const qdrant = createQdrantClient();

  console.log('## Qdrant Verification\n');

  // Count by nreg
  const chunksCount = await countByNreg(qdrant, QDRANT_COLLECTION_CHUNKS, nreg);
  const actsCount = await countByNreg(qdrant, QDRANT_COLLECTION_ACTS, nreg);

  console.log(`- Count by rada_nreg="${nreg}":`);
  console.log(`  chunks: ${chunksCount}`);
  console.log(`  acts: ${actsCount}`);

  // Sample points
  const chunksScroll = await qdrant.scroll(QDRANT_COLLECTION_CHUNKS, {
    filter: {
      must: [
        { key: 'rada_nreg', match: { value: nreg } },
        { key: 'content_hash', match: { value: contentHash } },
      ],
    },
    limit: 3,
    with_payload: true,
    with_vector: false,
  });

  console.log(`\n- Sample chunks (first 3):`);
  (chunksScroll.points || []).forEach((p: any, i) => {
    console.log(`  [${i + 1}] ID: ${p.id}`);
    console.log(`      chunk_index: ${p.payload?.chunk_index}`);
    console.log(`      article_number: ${p.payload?.article_number}`);
    console.log(`      r2_key: ${p.payload?.r2_key}`);
    console.log(`      json_path: ${p.payload?.json_path}`);
  });

  // Acts sample
  const actsScroll = await qdrant.scroll(QDRANT_COLLECTION_ACTS, {
    filter: {
      must: [
        { key: 'rada_nreg', match: { value: nreg } },
        { key: 'content_hash', match: { value: contentHash } },
      ],
    },
    limit: 1,
    with_payload: true,
    with_vector: false,
  });

  if (actsScroll.points && actsScroll.points.length > 0) {
    const act = actsScroll.points[0] as any;
    console.log(`\n- Act point:`);
    console.log(`  ID: ${act.id}`);
    console.log(`  title: ${act.payload?.title}`);
    console.log(`  summary (length): ${String(act.payload?.summary || '').length}`);
    console.log(`  keywords count: ${Array.isArray(act.payload?.keywords) ? act.payload.keywords.length : 0}`);
    console.log(`  topics count: ${Array.isArray(act.payload?.topics) ? act.payload.topics.length : 0}`);
    console.log(`  aliases count: ${Array.isArray(act.payload?.aliases) ? act.payload.aliases.length : 0}`);
  }

  console.log('\n✅ Verification complete');
}

main().catch(console.error);
