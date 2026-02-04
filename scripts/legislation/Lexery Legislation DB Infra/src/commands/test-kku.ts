/**
 * Test command для ККУ (2341-14) — end-to-end тест з resume evidence
 * 
 * PHASE 6: Real World Large Doc Test
 */
import { resolve } from 'path';
import { importOne } from '../lib/importer.js';
import { workspaceRoot } from '../lib/config.js';
import { createSupabaseAdminClient } from '../lib/supabaseAdmin.js';
import { createQdrantClient, countByNreg } from '../lib/qdrantAdmin.js';
import { getR2AdminClient, headObject } from '../lib/r2Admin.js';
import { getJsonFromR2 } from '../lib/r2Json.js';
import { searchDocuments } from './search.js';

const KKU_NREG = '2341-14';

interface TestMetrics {
  startTime: number;
  endTime?: number;
  stages: Array<{
    stage: string;
    timestamp: number;
    elapsed: number;
    details?: any;
  }>;
  batches: {
    embeddings: { count: number; avgTime?: number };
    qdrant: { count: number; avgTime?: number };
  };
  retries: number;
  errors: string[];
}

export async function testKkuImport(opts: { 
  resume?: boolean;
  failAfterBatch?: number;
}): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('PHASE 6: Real World Large Doc Test — ККУ (2341-14)');
  console.log('═══════════════════════════════════════════════════════════\n');
  
  const metrics: TestMetrics = {
    startTime: Date.now(),
    stages: [],
    batches: { embeddings: { count: 0 }, qdrant: { count: 0 } },
    retries: 0,
    errors: [],
  };
  
  const logStage = (stage: string, details?: any) => {
    const now = Date.now();
    const elapsed = now - metrics.startTime;
    metrics.stages.push({ stage, timestamp: now, elapsed, details });
    console.log(`[${(elapsed / 1000).toFixed(2)}s] ${stage}`);
    if (details) {
      console.log(`  ${JSON.stringify(details, null, 2).split('\n').join('\n  ')}`);
    }
  };
  
  try {
    // 1. Pre-flight check
    logStage('Pre-flight check');
    const supabase = createSupabaseAdminClient();
    const { data: existingDoc } = await supabase
      .from('legislation_documents')
      .select('rada_nreg,content_hash,qdrant_status,indexed_chunks,expected_chunks')
      .eq('rada_nreg', KKU_NREG)
      .maybeSingle();
    
    if (existingDoc) {
      console.log(`  Existing doc found: content_hash=${existingDoc.content_hash}, qdrant_status=${existingDoc.qdrant_status}, indexed_chunks=${existingDoc.indexed_chunks}/${existingDoc.expected_chunks}`);
    } else {
      console.log('  No existing doc found');
    }
    
    // Check for running jobs
    const { data: runningJobs } = await supabase
      .from('legislation_import_jobs')
      .select('id,status,progress_data')
      .eq('status', 'running')
      .like('config->>rada_nreg', KKU_NREG);
    
    if (runningJobs && runningJobs.length > 0) {
      console.log(`  Found ${runningJobs.length} running job(s) for ${KKU_NREG}`);
      if (opts.resume) {
        console.log('  Will attempt resume');
      } else {
        console.log('  WARNING: Running jobs exist. Use --resume to continue.');
      }
    }
    
    // 2. Import
    logStage('Starting import');
    const importStart = Date.now();
    
    const result = await importOne({
      mode: existingDoc ? 'update' : 'add',
      radaNreg: KKU_NREG,
      resume: opts.resume || false,
      dryRun: false,
    });
    
    const importElapsed = Date.now() - importStart;
    logStage('Import completed', {
      elapsed_seconds: (importElapsed / 1000).toFixed(2),
      expected_chunks: result.expected_chunks,
      qdrant_acts: result.qdrant.acts,
      qdrant_chunks: result.qdrant.chunks,
    });
    
    // 3. Verification
    logStage('Verification');
    
    // Supabase
    const { data: doc } = await supabase
      .from('legislation_documents')
      .select('*')
      .eq('rada_nreg', KKU_NREG)
      .single();
    
    if (!doc) {
      throw new Error('Document not found in Supabase after import');
    }
    
    console.log(`  Supabase:`);
    console.log(`    - title: ${doc.title}`);
    console.log(`    - category: ${doc.category}`);
    console.log(`    - document_type: ${doc.document_type}`);
    console.log(`    - expected_chunks: ${doc.expected_chunks}`);
    console.log(`    - indexed_chunks: ${doc.indexed_chunks}`);
    console.log(`    - qdrant_status: ${doc.qdrant_status}`);
    console.log(`    - act_group_key: ${doc.act_group_key || 'null'}`);
    console.log(`    - act_is_part: ${doc.act_is_part || false}`);
    
    // Qdrant
    const qdrant = createQdrantClient();
    const { QDRANT_COLLECTION_ACTS, QDRANT_COLLECTION_CHUNKS } = await import('../lib/qdrantAdmin.js');
    const qActs = await countByNreg(qdrant, QDRANT_COLLECTION_ACTS, KKU_NREG);
    const qChunks = await countByNreg(qdrant, QDRANT_COLLECTION_CHUNKS, KKU_NREG);
    
    console.log(`  Qdrant:`);
    console.log(`    - acts: ${qActs}`);
    console.log(`    - chunks: ${qChunks}`);
    
    // R2
    const { client: r2, bucket } = getR2AdminClient();
    const r2Key = doc.r2_key as string;
    const head = await headObject(r2, bucket, r2Key);
    
    console.log(`  R2:`);
    console.log(`    - key: ${r2Key}`);
    console.log(`    - exists: ${head.exists}`);
    console.log(`    - size: ${head.size || 'N/A'} bytes`);
    
    if (head.exists) {
      const canonical = await getJsonFromR2(r2Key);
      console.log(`    - canonical.chunks.length: ${canonical?.content?.chunks?.length || 'N/A'}`);
      console.log(`    - canonical.parsing_strategy: ${canonical?.content?.structure?.parsing_strategy || 'N/A'}`);
    }
    
    // 4. Search test
    logStage('Search test');
    const testQueries = [
      'кримінальна відповідальність',
      'умисне вбивство',
      'необхідна оборона',
    ];
    
    for (const query of testQueries) {
      console.log(`\n  Query: "${query}"`);
      try {
        await searchDocuments({ query, nreg: KKU_NREG, topk: 5 });
      } catch (e: any) {
        console.log(`    ERROR: ${e.message}`);
        metrics.errors.push(`Search "${query}": ${e.message}`);
      }
    }
    
    // 5. Final metrics
    metrics.endTime = Date.now();
    const totalTime = (metrics.endTime - metrics.startTime) / 1000;
    
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('Test Summary');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`Total time: ${totalTime.toFixed(2)}s`);
    console.log(`Expected chunks: ${doc.expected_chunks}`);
    console.log(`Indexed chunks: ${doc.indexed_chunks}`);
    console.log(`Qdrant chunks: ${qChunks}`);
    console.log(`Qdrant status: ${doc.qdrant_status}`);
    console.log(`Errors: ${metrics.errors.length}`);
    
    if (doc.indexed_chunks !== doc.expected_chunks) {
      console.log(`⚠️  WARNING: indexed_chunks (${doc.indexed_chunks}) != expected_chunks (${doc.expected_chunks})`);
    }
    
    if (qChunks !== doc.expected_chunks) {
      console.log(`⚠️  WARNING: Qdrant chunks (${qChunks}) != expected_chunks (${doc.expected_chunks})`);
    }
    
    if (doc.qdrant_status !== 'indexed') {
      console.log(`⚠️  WARNING: qdrant_status is "${doc.qdrant_status}", expected "indexed"`);
    }
    
    // Save report
    const reportPath = resolve(workspaceRoot(), 'runs', `kku_${KKU_NREG.replace(/-/g, '_')}_run_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
    const report = {
      nreg: KKU_NREG,
      timestamp: new Date().toISOString(),
      metrics,
      verification: {
        supabase: {
          exists: true,
          category: doc.category,
          document_type: doc.document_type,
          expected_chunks: doc.expected_chunks,
          indexed_chunks: doc.indexed_chunks,
          qdrant_status: doc.qdrant_status,
          act_group_key: doc.act_group_key,
        },
        qdrant: {
          acts: qActs,
          chunks: qChunks,
        },
        r2: {
          key: r2Key,
          exists: head.exists,
          size: head.size,
        },
      },
      errors: metrics.errors,
    };
    
    const { writeFile } = await import('fs/promises');
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(`\nReport saved: ${reportPath}`);
    
  } catch (e: any) {
    metrics.endTime = Date.now();
    metrics.errors.push(e.message);
    console.error(`\n❌ Test failed: ${e.message}`);
    throw e;
  }
}
