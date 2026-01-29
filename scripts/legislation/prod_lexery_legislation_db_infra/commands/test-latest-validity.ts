/**
 * Тест validity на останніх документах
 * 
 * Перевіряє чи validity_status відповідає Rada status object
 */

import { createSupabaseAdminClient } from '../lib/supabaseAdmin.js';
import { RadaClient } from '../lib/radaClient.js';
import { resolveValidityByNreg, bundleToResult } from '../lib/radaValidityResolver.js';

interface TestResult {
  nreg: string;
  title: string;
  db_status: string | null;
  db_source_code: string | null;
  db_location: string | null;
  rada_status: number | string | null;
  expected_status: string;
  match: boolean;
  error?: string;
}

export async function testLatestValidity(limit: number = 50): Promise<{
  total: number;
  passed: number;
  failed: number;
  results: TestResult[];
}> {
  const supabase = createSupabaseAdminClient();
  const rada = new RadaClient();
  
  // Отримуємо останні документи
  const { data: docs, error: docsError } = await supabase
    .from('legislation_documents')
    .select('rada_nreg, title, document_type_slug, validity_status, source_status_text, source_status_location, status_note, updated_at')
    .order('updated_at', { ascending: false })
    .limit(limit);
  
  if (docsError) {
    throw new Error(`Supabase query error: ${docsError.message}`);
  }
  
  if (!docs || docs.length === 0) {
    throw new Error('No documents found');
  }
  
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Testing Validity on Latest ${docs.length} Documents`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  
  const results: TestResult[] = [];
  let passed = 0;
  let failed = 0;
  
  for (const doc of docs) {
    try {
      // Отримуємо validity через resolver
      const bundle = await resolveValidityByNreg(doc.rada_nreg, rada, true);
      const resolverResult = bundleToResult(bundle);
      
      // Отримуємо raw Rada JSON для перевірки
      let radaJson: any;
      try {
        radaJson = await rada.fetchJson(doc.rada_nreg);
      } catch (error) {
        radaJson = null;
      }
      
      const radaStatus = radaJson?.status ?? null;
      const expectedStatus = resolverResult.validity_status;
      const dbStatus = doc.validity_status;
      
      const match = dbStatus === expectedStatus;
      
      if (match) {
        passed++;
        console.log(`✅ ${doc.rada_nreg}: ${dbStatus} (Rada status: ${radaStatus})`);
      } else {
        failed++;
        console.error(`❌ ${doc.rada_nreg}: DB=${dbStatus}, Expected=${expectedStatus}, Rada=${radaStatus}`);
        console.error(`   Title: ${doc.title}`);
        console.error(`   DB source: ${doc.source_status_text} @ ${doc.source_status_location}`);
        console.error(`   Resolver source: ${resolverResult.source_status_text} @ ${resolverResult.source_status_location}`);
      }
      
      results.push({
        nreg: doc.rada_nreg,
        title: doc.title || '',
        db_status: dbStatus,
        db_source_code: doc.source_status_text || null,
        db_location: doc.source_status_location || null,
        rada_status: radaStatus,
        expected_status: expectedStatus,
        match,
      });
    } catch (error) {
      failed++;
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`❌ ${doc.rada_nreg}: ERROR - ${errorMsg}`);
      results.push({
        nreg: doc.rada_nreg,
        title: doc.title || '',
        db_status: doc.validity_status,
        db_source_code: doc.source_status_text || null,
        db_location: doc.source_status_location || null,
        rada_status: null,
        expected_status: 'ERROR',
        match: false,
        error: errorMsg,
      });
    }
  }
  
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Test Results: ${passed} passed, ${failed} failed out of ${docs.length}`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  
  if (failed > 0) {
    console.error(`❌ CRITICAL: ${failed} documents have mismatched validity status!`);
    console.error(`\nFailed documents:`);
    results.filter(r => !r.match).forEach(r => {
      console.error(`  - ${r.nreg}: DB=${r.db_status}, Expected=${r.expected_status}, Rada=${r.rada_status}`);
    });
  } else {
    console.log(`✅ All ${docs.length} documents have correct validity status!`);
  }
  
  return { total: docs.length, passed, failed, results };
}
