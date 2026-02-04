/**
 * Inspect Qdrant Acts — зняття evidence по acts count mismatch
 * PHASE 18.1b: FIX "ACTS COUNT MISMATCH" (BLOCKER)
 */
import { createSupabaseAdminClient } from '../lib/supabaseAdmin.js';
import { createQdrantClient, QDRANT_COLLECTION_ACTS } from '../lib/qdrantAdmin.js';

const TEST_NREGS = [
  '2341-14',
  '254к/96-вр',
  '3543-12',
  '57-95-п',
  '80731-10',
  '80732-10',
  '995_153',
  'nb07d710-25',
];

export async function inspectQdrantActs(): Promise<void> {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('Qdrant Acts Evidence — All 8 Test Documents');
  console.log('═══════════════════════════════════════════════════════════\n');
  
  const supabase = createSupabaseAdminClient();
  const qdrant = createQdrantClient();
  
  const evidence: Array<{
    nreg: string;
    contentHash: string;
    actsCount: number;
    pointIds: string[];
    payloads: Array<{ id: string; content_hash: string; document_type_slug?: string; category?: string }>;
  }> = [];
  
  for (const nreg of TEST_NREGS) {
    // Get content_hash from Supabase
    const { data: doc } = await supabase
      .from('legislation_documents')
      .select('content_hash')
      .eq('rada_nreg', nreg)
      .maybeSingle();
    
    if (!doc) {
      console.log(`⚠️  ${nreg}: Not found in Supabase`);
      continue;
    }
    
    const contentHash = doc.content_hash as string;
    
    // Count acts by nreg
    const countRes = await qdrant.count(QDRANT_COLLECTION_ACTS, {
      exact: true,
      filter: { must: [{ key: 'rada_nreg', match: { value: nreg } }] },
    } as any);
    const actsCount = (countRes as any)?.count || 0;
    
    // Get all acts points
    const scrollRes = await qdrant.scroll(QDRANT_COLLECTION_ACTS, {
      filter: {
        must: [{ key: 'rada_nreg', match: { value: nreg } }],
      },
      limit: 100,
      with_payload: true,
      with_vector: false,
    });
    
    const points = scrollRes.points || [];
    const pointIds = points.map((p: any) => String(p.id));
    const payloads = points.map((p: any) => ({
      id: String(p.id),
      content_hash: p.payload?.content_hash || 'MISSING',
      document_type_slug: p.payload?.document_type_slug,
      category: p.payload?.category,
    }));
    
    evidence.push({
      nreg,
      contentHash,
      actsCount,
      pointIds,
      payloads,
    });
    
    console.log(`\n${nreg}:`);
    console.log(`  Content Hash (Supabase): ${contentHash}`);
    console.log(`  Acts Count (Qdrant): ${actsCount}`);
    console.log(`  Point IDs: ${pointIds.length > 0 ? pointIds.join(', ') : 'NONE'}`);
    
    if (actsCount > 1) {
      console.log(`  ❌ MISMATCH: Expected 1, got ${actsCount}`);
      console.log(`  Payloads:`);
      payloads.forEach((p, i) => {
        console.log(`    [${i + 1}] ID: ${p.id}`);
        console.log(`        content_hash: ${p.content_hash}`);
        console.log(`        document_type_slug: ${p.document_type_slug || 'MISSING'}`);
        console.log(`        category: ${p.category || 'MISSING'}`);
        console.log(`        Match current hash: ${p.content_hash === contentHash ? '✅' : '❌'}`);
      });
    } else if (actsCount === 1) {
      console.log(`  ✅ OK: Exactly 1 act`);
      if (payloads[0]) {
        console.log(`    content_hash: ${payloads[0].content_hash}`);
        console.log(`    Match current hash: ${payloads[0].content_hash === contentHash ? '✅' : '❌'}`);
      }
    } else {
      console.log(`  ❌ MISSING: No acts found`);
    }
  }
  
  // Summary
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('Summary');
  console.log('═══════════════════════════════════════════════════════════');
  
  const mismatches = evidence.filter(e => e.actsCount !== 1);
  const correct = evidence.filter(e => e.actsCount === 1);
  
  console.log(`Total documents: ${evidence.length}`);
  console.log(`✅ Correct (acts=1): ${correct.length}`);
  console.log(`❌ Mismatches (acts≠1): ${mismatches.length}`);
  
  if (mismatches.length > 0) {
    console.log('\nMismatches:');
    mismatches.forEach(m => {
      console.log(`  - ${m.nreg}: ${m.actsCount} acts (expected 1)`);
      if (m.actsCount > 1) {
        const currentHashMatches = m.payloads.filter(p => p.content_hash === m.contentHash).length;
        const oldHashMatches = m.payloads.filter(p => p.content_hash !== m.contentHash).length;
        console.log(`    Current hash matches: ${currentHashMatches}`);
        console.log(`    Old hash matches: ${oldHashMatches}`);
      }
    });
  }
  
  return evidence as any;
}

// Run if called directly
if (import.meta.url.endsWith(process.argv[1]) || process.argv[1]?.includes('inspect-qdrant-acts')) {
  inspectQdrantActs().catch(console.error);
}
