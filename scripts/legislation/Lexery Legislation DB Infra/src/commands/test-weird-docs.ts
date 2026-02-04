/**
 * Test command для "weird docs" — окрема думка судді КСУ + міжнародна конвенція
 * 
 * PHASE 11: AI-assisted fallback parsing test
 */
import { importOne } from '../lib/importer.js';
import { createSupabaseAdminClient } from '../lib/supabaseAdmin.js';
import { createQdrantClient, countByNreg, QDRANT_COLLECTION_ACTS, QDRANT_COLLECTION_CHUNKS } from '../lib/qdrantAdmin.js';
import { searchDocuments } from './search.js';

interface TestResult {
  nreg: string;
  title: string;
  success: boolean;
  expected_chunks?: number;
  indexed_chunks?: number;
  category?: string;
  strategy?: string;
  errors: string[];
}

export async function testWeirdDocs(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('PHASE 11: Weird Docs Test — AI Parsing Assist');
  console.log('═══════════════════════════════════════════════════════════\n');
  
  // Тестові документи
  const testDocs: Array<{ nreg: string; description: string }> = [
    { nreg: '995_153', description: 'Женевська конвенція про поводження з військовополоненими' },
    { nreg: 'nb07d710-25', description: 'Окрема думка судді КСУ' },
  ];
  
  const results: TestResult[] = [];
  
  for (const doc of testDocs) {
    console.log(`\n[${doc.nreg}] ${doc.description}`);
    console.log('─'.repeat(60));
    
    const result: TestResult = {
      nreg: doc.nreg,
      title: doc.description,
      success: false,
      errors: [],
    };
    
    try {
      const importResult = await importOne({
        mode: 'add',
        radaNreg: doc.nreg,
        dryRun: false,
      });
      
      result.expected_chunks = importResult.expected_chunks;
      
      // Fetch from Supabase
      const supabase = createSupabaseAdminClient();
      const { data: dbDoc } = await supabase
        .from('legislation_documents')
        .select('rada_nreg,title,expected_chunks,indexed_chunks,category,qdrant_status')
        .eq('rada_nreg', doc.nreg)
        .maybeSingle();
      
      if (dbDoc) {
        result.title = dbDoc.title || doc.description;
        result.indexed_chunks = dbDoc.indexed_chunks || 0;
        result.category = dbDoc.category || undefined;
        result.success = dbDoc.qdrant_status === 'indexed' && (dbDoc.indexed_chunks || 0) > 0;
        
        console.log(`  ✅ Imported: ${dbDoc.expected_chunks} chunks, indexed=${dbDoc.indexed_chunks}, category=${dbDoc.category}, status=${dbDoc.qdrant_status}`);
        
        // Get parsing strategy from R2
        try {
          const { getJsonFromR2 } = await import('../lib/r2Json.js');
          const r2Key = dbDoc.r2_key as string;
          if (r2Key) {
            const canonical = await getJsonFromR2(r2Key);
            result.strategy = canonical?.content?.structure?.parsing_strategy || undefined;
            console.log(`  Strategy: ${result.strategy || 'N/A'}`);
          }
        } catch (e) {
          // Ignore
        }
      } else {
        result.errors.push('Document not found in Supabase after import');
        console.log(`  ❌ Document not found in Supabase`);
      }
      
    } catch (e: any) {
      result.errors.push(e.message);
      console.log(`  ❌ Failed: ${e.message}`);
    }
    
    results.push(result);
  }
  
  // Summary
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('Test Summary');
  console.log('═══════════════════════════════════════════════════════════\n');
  
  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  
  console.log(`Total: ${results.length}`);
  console.log(`Successful: ${successful}`);
  console.log(`Failed: ${failed}\n`);
  
  for (const r of results) {
    const status = r.success ? '✅' : '❌';
    console.log(`${status} [${r.nreg}] ${r.title}`);
    console.log(`   Expected chunks: ${r.expected_chunks || 0}`);
    console.log(`   Indexed chunks: ${r.indexed_chunks || 0}`);
    console.log(`   Category: ${r.category || 'N/A'}`);
    console.log(`   Strategy: ${r.strategy || 'N/A'}`);
    if (r.errors.length > 0) {
      console.log(`   Errors: ${r.errors.join(', ')}`);
    }
  }
  
  // Acceptance criteria
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('Acceptance Criteria');
  console.log('═══════════════════════════════════════════════════════════\n');
  
  const allPassed = results.every(r => 
    r.success && 
    (r.indexed_chunks || 0) > 0 && 
    r.category && 
    r.category !== 'other'
  );
  
  if (allPassed) {
    console.log('✅ All tests passed!');
  } else {
    console.log('❌ Some tests failed');
    results.filter(r => !r.success || (r.indexed_chunks || 0) === 0 || r.category === 'other').forEach(r => {
      console.log(`  - [${r.nreg}]: ${r.errors.join(', ') || 'chunks=0 or category=other'}`);
    });
  }
}
