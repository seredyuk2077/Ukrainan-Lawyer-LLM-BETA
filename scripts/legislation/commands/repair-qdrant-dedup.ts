/**
 * Repair Qdrant Dedup — видалення старих версій acts/chunks
 * PHASE 18.1b: FIX "ACTS COUNT MISMATCH" (BLOCKER)
 */
import { createSupabaseAdminClient } from '../lib/supabaseAdmin.js';
import { createQdrantClient, QDRANT_COLLECTION_ACTS, QDRANT_COLLECTION_CHUNKS } from '../lib/qdrantAdmin.js';

export async function repairQdrantDedup(nreg: string, opts: { dryRun?: boolean }): Promise<void> {
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Repair Qdrant Dedup: ${nreg}`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  
  const supabase = createSupabaseAdminClient();
  const qdrant = createQdrantClient();
  
  // Get current content_hash from Supabase
  const { data: doc } = await supabase
    .from('legislation_documents')
    .select('content_hash')
    .eq('rada_nreg', nreg)
    .maybeSingle();
  
  if (!doc) {
    console.log(`❌ Document not found in Supabase`);
    return;
  }
  
  const currentContentHash = doc.content_hash as string;
  console.log(`Current content_hash (Supabase): ${currentContentHash}`);
  
  let deletedActs = 0;
  let deletedChunks = 0;
  
  // Fix acts: keep only current version
  const actsScroll = await qdrant.scroll(QDRANT_COLLECTION_ACTS, {
    filter: {
      must: [{ key: 'rada_nreg', match: { value: nreg } }],
    },
    limit: 100,
    with_payload: true,
    with_vector: false,
  });
  
  const actsPoints = actsScroll.points || [];
  const oldActs = actsPoints.filter((p: any) => p.payload?.content_hash !== currentContentHash);
  const currentActs = actsPoints.filter((p: any) => p.payload?.content_hash === currentContentHash);
  
  console.log(`\nActs:`);
  console.log(`  Total: ${actsPoints.length}`);
  console.log(`  Current hash: ${currentActs.length}`);
  console.log(`  Old hash: ${oldActs.length}`);
  
  if (oldActs.length > 0) {
    const oldActIds = oldActs.map((p: any) => p.id);
    console.log(`  Old act IDs to delete: ${oldActIds.join(', ')}`);
    
    if (!opts.dryRun) {
      await qdrant.delete(QDRANT_COLLECTION_ACTS, {
        wait: true,
        points: oldActIds,
      });
      deletedActs = oldActs.length;
      console.log(`  ✅ Deleted ${deletedActs} old acts`);
    } else {
      console.log(`  [DRY-RUN] Would delete ${oldActs.length} old acts`);
    }
  }
  
  // If we have more than 1 act with current hash, keep only one (deterministic ID)
  if (currentActs.length > 1) {
    console.log(`  ⚠️  Multiple acts with current hash: ${currentActs.length}`);
    // Keep the one with deterministic ID (should be only one, but if duplicates exist, keep first)
    const toKeep = currentActs[0];
    const toDelete = currentActs.slice(1);
    const toDeleteIds = toDelete.map((p: any) => p.id);
    
    if (!opts.dryRun) {
      await qdrant.delete(QDRANT_COLLECTION_ACTS, {
        wait: true,
        points: toDeleteIds,
      });
      deletedActs += toDelete.length;
      console.log(`  ✅ Deleted ${toDelete.length} duplicate acts with current hash`);
    } else {
      console.log(`  [DRY-RUN] Would delete ${toDelete.length} duplicate acts`);
    }
  }
  
  // Fix chunks: keep only current version
  const chunksScroll = await qdrant.scroll(QDRANT_COLLECTION_CHUNKS, {
    filter: {
      must: [{ key: 'rada_nreg', match: { value: nreg } }],
    },
    limit: 10000,
    with_payload: true,
    with_vector: false,
  });
  
  const chunksPoints = chunksScroll.points || [];
  const oldChunks = chunksPoints.filter((p: any) => p.payload?.content_hash !== currentContentHash);
  
  console.log(`\nChunks:`);
  console.log(`  Total: ${chunksPoints.length}`);
  console.log(`  Current hash: ${chunksPoints.length - oldChunks.length}`);
  console.log(`  Old hash: ${oldChunks.length}`);
  
  if (oldChunks.length > 0) {
    const oldChunkIds = oldChunks.map((p: any) => p.id);
    console.log(`  Old chunk IDs to delete: ${oldChunkIds.length} points`);
    
    // Delete in batches of 100
    if (!opts.dryRun) {
      const batchSize = 100;
      for (let i = 0; i < oldChunkIds.length; i += batchSize) {
        const batch = oldChunkIds.slice(i, i + batchSize);
        await qdrant.delete(QDRANT_COLLECTION_CHUNKS, {
          wait: true,
          points: batch,
        });
      }
      deletedChunks = oldChunks.length;
      console.log(`  ✅ Deleted ${deletedChunks} old chunks`);
    } else {
      console.log(`  [DRY-RUN] Would delete ${oldChunks.length} old chunks`);
    }
  }
  
  // Summary
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Summary`);
  console.log(`═══════════════════════════════════════════════════════════`);
  
  if (deletedActs === 0 && deletedChunks === 0) {
    console.log(`✅ No old versions found`);
  } else {
    console.log(`${opts.dryRun ? '[DRY-RUN] ' : ''}Deleted:`);
    console.log(`  Acts: ${deletedActs}`);
    console.log(`  Chunks: ${deletedChunks}`);
  }
}
