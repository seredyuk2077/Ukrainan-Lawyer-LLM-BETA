/**
 * Test command для КУпАП (multi-part акт)
 * 
 * PHASE 10: Real World Multi-Part Test
 */
import { importOne } from '../lib/importer.js';
import { createSupabaseAdminClient } from '../lib/supabaseAdmin.js';
import { createQdrantClient, countByNreg, QDRANT_COLLECTION_ACTS, QDRANT_COLLECTION_CHUNKS } from '../lib/qdrantAdmin.js';
import { searchDocuments } from './search.js';

const KUPAP_PARTS = [
  { nreg: '80731-10', expectedLabel: 'статті 1 - 212-24' },
  { nreg: '80732-10', expectedLabel: 'статті 213 - 330' },
];

export async function testKupap(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('PHASE 10: Real World Multi-Part Test — КУпАП');
  console.log('═══════════════════════════════════════════════════════════\n');
  
  const supabase = createSupabaseAdminClient();
  const results: Array<{
    nreg: string;
    success: boolean;
    act_group_key?: string | null;
    act_is_part?: boolean;
    act_part_label?: string | null;
    errors: string[];
  }> = [];
  
  // Import обох частин
  for (const part of KUPAP_PARTS) {
    console.log(`\n[${part.nreg}] Importing...`);
    
    try {
      const result = await importOne({
        mode: 'add',
        radaNreg: part.nreg,
        dryRun: false,
      });
      
      // Fetch from Supabase
      const { data: doc } = await supabase
        .from('legislation_documents')
        .select('rada_nreg,title,act_group_key,act_is_part,act_part_label,expected_chunks,indexed_chunks,qdrant_status')
        .eq('rada_nreg', part.nreg)
        .single();
      
      if (!doc) {
        throw new Error('Document not found in Supabase after import');
      }
      
      console.log(`  ✅ Imported: ${doc.expected_chunks} chunks, status=${doc.qdrant_status}`);
      console.log(`  act_group_key: ${doc.act_group_key || 'NULL'}`);
      console.log(`  act_is_part: ${doc.act_is_part}`);
      console.log(`  act_part_label: ${doc.act_part_label || 'NULL'}`);
      
      results.push({
        nreg: part.nreg,
        success: true,
        act_group_key: doc.act_group_key,
        act_is_part: doc.act_is_part,
        act_part_label: doc.act_part_label,
        errors: [],
      });
      
    } catch (e: any) {
      console.log(`  ❌ Failed: ${e.message}`);
      results.push({
        nreg: part.nreg,
        success: false,
        errors: [e.message],
      });
    }
  }
  
  // Verification
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('Verification');
  console.log('═══════════════════════════════════════════════════════════\n');
  
  if (results.filter(r => r.success).length < 2) {
    console.log('❌ Not all parts imported successfully');
    return;
  }
  
  const part1 = results.find(r => r.nreg === KUPAP_PARTS[0].nreg)!;
  const part2 = results.find(r => r.nreg === KUPAP_PARTS[1].nreg)!;
  
  // Check 1: act_is_part = true
  if (!part1.act_is_part || !part2.act_is_part) {
    console.log(`❌ FAIL: act_is_part must be true for both parts`);
    console.log(`  Part 1: ${part1.act_is_part}`);
    console.log(`  Part 2: ${part2.act_is_part}`);
  } else {
    console.log(`✅ act_is_part = true for both parts`);
  }
  
  // Check 2: act_group_key однаковий
  if (!part1.act_group_key || !part2.act_group_key) {
    console.log(`❌ FAIL: act_group_key must be set for both parts`);
    console.log(`  Part 1: ${part1.act_group_key || 'NULL'}`);
    console.log(`  Part 2: ${part2.act_group_key || 'NULL'}`);
  } else if (part1.act_group_key !== part2.act_group_key) {
    console.log(`❌ FAIL: act_group_key must be the same for both parts`);
    console.log(`  Part 1: ${part1.act_group_key}`);
    console.log(`  Part 2: ${part2.act_group_key}`);
  } else {
    console.log(`✅ act_group_key matches: ${part1.act_group_key}`);
  }
  
  // Check 3: act_part_label різний
  if (!part1.act_part_label || !part2.act_part_label) {
    console.log(`❌ FAIL: act_part_label must be set for both parts`);
    console.log(`  Part 1: ${part1.act_part_label || 'NULL'}`);
    console.log(`  Part 2: ${part2.act_part_label || 'NULL'}`);
  } else if (part1.act_part_label === part2.act_part_label) {
    console.log(`❌ FAIL: act_part_label must be different for parts`);
    console.log(`  Part 1: ${part1.act_part_label}`);
    console.log(`  Part 2: ${part2.act_part_label}`);
  } else {
    console.log(`✅ act_part_label different:`);
    console.log(`  Part 1: ${part1.act_part_label}`);
    console.log(`  Part 2: ${part2.act_part_label}`);
  }
  
  // Check 4: Qdrant payloads
  console.log(`\nChecking Qdrant payloads...`);
  const qdrant = createQdrantClient();
  
  for (const part of KUPAP_PARTS) {
    const result = results.find(r => r.nreg === part.nreg);
    if (!result?.success || !result.act_group_key) continue;
    
    // Check chunks
    const chunks = await qdrant.scroll(QDRANT_COLLECTION_CHUNKS, {
      filter: {
        must: [{ key: 'rada_nreg', match: { value: part.nreg } }],
      },
      limit: 5,
      with_payload: true,
    });
    
    if (chunks.points && chunks.points.length > 0) {
      const samplePayload = chunks.points[0].payload as any;
      if (samplePayload.act_group_key !== result.act_group_key) {
        console.log(`  ❌ [${part.nreg}] Chunk payload act_group_key mismatch`);
      } else {
        console.log(`  ✅ [${part.nreg}] Chunk payloads have act_group_key=${result.act_group_key}`);
      }
      if (samplePayload.act_part_label !== result.act_part_label) {
        console.log(`  ❌ [${part.nreg}] Chunk payload act_part_label mismatch`);
      }
    }
    
    // Check acts
    const acts = await qdrant.scroll(QDRANT_COLLECTION_ACTS, {
      filter: {
        must: [{ key: 'rada_nreg', match: { value: part.nreg } }],
      },
      limit: 1,
      with_payload: true,
    });
    
    if (acts.points && acts.points.length > 0) {
      const actPayload = acts.points[0].payload as any;
      if (actPayload.act_group_key !== result.act_group_key) {
        console.log(`  ❌ [${part.nreg}] Act payload act_group_key mismatch`);
      } else {
        console.log(`  ✅ [${part.nreg}] Act payload has act_group_key=${result.act_group_key}`);
      }
    }
  }
  
  // Check 5: Search test
  console.log(`\nSearch test: "адміністративна відповідальність"...`);
  try {
    await searchDocuments({ 
      query: 'адміністративна відповідальність', 
      topk: 10 
    });
  } catch (e: any) {
    console.log(`  ⚠️  Search failed: ${e.message}`);
  }
  
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('Test Summary');
  console.log('═══════════════════════════════════════════════════════════');
  
  const allPassed = 
    part1.act_is_part && part2.act_is_part &&
    part1.act_group_key && part2.act_group_key &&
    part1.act_group_key === part2.act_group_key &&
    part1.act_part_label && part2.act_part_label &&
    part1.act_part_label !== part2.act_part_label;
  
  if (allPassed) {
    console.log('✅ All checks passed!');
  } else {
    console.log('❌ Some checks failed');
  }
}
