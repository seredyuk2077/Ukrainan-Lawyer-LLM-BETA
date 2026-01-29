/**
 * Document Type Regression Test — перевірка golden set
 * 
 * Проходить по golden set і перевіряє, що:
 * - В БД стоїть expected_slug
 * - enrichDocumentType повертає expected_slug
 * - Issuer signals відповідають expected_issuer_signal
 */

import { createSupabaseAdminClient } from '../lib/supabaseAdmin.js';
import { enrichDocumentType } from '../lib/documentTypeEnrichment.js';
import { getJsonFromR2 } from '../lib/r2Json.js';
import { extractIssuerSignals } from '../lib/signalExtractor.js';
import { getDocumentTypeInfo } from '../documentTypes/documentTypes.js';

interface GoldenTestResult {
  nreg: string;
  expected_slug: string;
  expected_ua_label: string;
  db_slug: string | null;
  db_ua_label: string | null;
  predicted_slug: string;
  predicted_ua_label: string;
  predicted_confidence: string;
  issuer_match: boolean;
  passed: boolean;
  error?: string;
}

/**
 * Перевіряє один документ з golden set
 */
async function testOneDocument(golden: {
  nreg: string;
  expected_slug: string;
  expected_ua_label: string;
  expected_issuer_signal?: string;
}): Promise<GoldenTestResult> {
  const supabase = createSupabaseAdminClient();
  
  // Отримуємо з Supabase
  const { data: doc, error } = await supabase
    .from('legislation_documents')
    .select('*')
    .eq('rada_nreg', golden.nreg)
    .maybeSingle();
  
  if (error || !doc) {
    return {
      nreg: golden.nreg,
      expected_slug: golden.expected_slug,
      expected_ua_label: golden.expected_ua_label,
      db_slug: null,
      db_ua_label: null,
      predicted_slug: '',
      predicted_ua_label: '',
      predicted_confidence: 'low',
      issuer_match: false,
      passed: false,
      error: `Document not found: ${error?.message || 'unknown'}`,
    };
  }
  
  // Отримуємо canonical з R2
  let jsonData: any = null;
  let summary: string | null = null;
  let snippet: string | null = null;
  
  try {
    if (doc.r2_key) {
      const canonical = await getJsonFromR2(doc.r2_key);
      jsonData = canonical.raw?.rada_api_json || null;
      summary = canonical.ai_enrichment?.summary || (doc.summary as string | null) || null;
      
      // ВАЖЛИВО: для декретів та НКРЕКП потрібно брати raw.rada_api_txt (priority ladder)
      let rawTxt: string | null = null;
      if (canonical.raw?.rada_api_txt) {
        rawTxt = canonical.raw.rada_api_txt.substring(0, 800);
        snippet = canonical.raw.rada_api_txt.substring(0, 600);
      } else if (canonical.content?.chunks?.[0]?.text) {
        snippet = canonical.content.chunks[0].text.substring(0, 600);
      }
    }
  } catch (e) {
    return {
      nreg: golden.nreg,
      expected_slug: golden.expected_slug,
      expected_ua_label: golden.expected_ua_label,
      db_slug: doc.document_type_slug || null,
      db_ua_label: doc.document_type || null,
      predicted_slug: '',
      predicted_ua_label: '',
      predicted_confidence: 'low',
      issuer_match: false,
      passed: false,
      error: `Failed to read R2: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  
  // Отримуємо predicted через enrichDocumentType (з raw_txt для priority ladder)
  const enrichment = await enrichDocumentType({
    title: doc.title,
    typ: jsonData?.typ || null,
    typn: jsonData?.typn || null,
    organs: jsonData?.organs || null,
    stru: jsonData?.stru || null,
    summary: summary,
    snippet: snippet,
    document_number: (doc as any).document_number || doc.rada_nreg || null,
    raw_txt: rawTxt || null,  // Додано для priority ladder
  });
  
  // Перевіряємо issuer signals (з raw_txt для priority ladder)
  const issuerSignals = extractIssuerSignals({
    title: doc.title,
    snippet: snippet || null,
    summary: summary || null,
    organs: jsonData?.organs || null,
    raw_txt: rawTxt || null,  // Додано для priority ladder
  });
  
  const issuerMatch = !golden.expected_issuer_signal || 
                      issuerSignals.includes(golden.expected_issuer_signal as any);
  
  // Перевіряємо чи все відповідає
  const dbMatches = doc.document_type_slug === golden.expected_slug && 
                    doc.document_type === golden.expected_ua_label;
  const predictedMatches = enrichment.slug === golden.expected_slug &&
                           enrichment.label_uk === golden.expected_ua_label;
  
  const passed = dbMatches && predictedMatches && issuerMatch;
  
  return {
    nreg: golden.nreg,
    expected_slug: golden.expected_slug,
    expected_ua_label: golden.expected_ua_label,
    db_slug: doc.document_type_slug || null,
    db_ua_label: doc.document_type || null,
    predicted_slug: enrichment.slug,
    predicted_ua_label: enrichment.label_uk,
    predicted_confidence: enrichment.confidence,
    issuer_match: issuerMatch,
    passed,
  };
}

/**
 * Головна функція — regression test для golden set
 */
export async function docTypeRegression(): Promise<void> {
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Document Type Regression Test`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  
  // Читаємо golden set
  const fs = await import('fs/promises');
  const goldenSetPath = 'scripts/legislation/test/doc_type_golden_set.json';
  const goldenSetContent = await fs.readFile(goldenSetPath, 'utf-8');
  const goldenSet = JSON.parse(goldenSetContent);
  
  console.log(`📋 Golden set: ${goldenSet.length} документів\n`);
  
  const results: GoldenTestResult[] = [];
  
  for (let i = 0; i < goldenSet.length; i++) {
    const golden = goldenSet[i];
    process.stdout.write(`[${i + 1}/${goldenSet.length}] ${golden.nreg}... `);
    
    try {
      const result = await testOneDocument(golden);
      results.push(result);
      
      if (result.error) {
        console.log(`❌ ${result.error}`);
      } else if (result.passed) {
        console.log(`✅`);
      } else {
        const issues: string[] = [];
        if (result.db_slug !== result.expected_slug) {
          issues.push(`DB: ${result.db_slug || 'NULL'} != ${result.expected_slug}`);
        }
        if (result.predicted_slug !== result.expected_slug) {
          issues.push(`Predicted: ${result.predicted_slug} != ${result.expected_slug}`);
        }
        if (!result.issuer_match) {
          issues.push(`Issuer mismatch`);
        }
        console.log(`❌ ${issues.join(', ')}`);
      }
    } catch (e) {
      console.log(`❌ ${e instanceof Error ? e.message : String(e)}`);
      results.push({
        nreg: golden.nreg,
        expected_slug: golden.expected_slug,
        expected_ua_label: golden.expected_ua_label,
        db_slug: null,
        db_ua_label: null,
        predicted_slug: '',
        predicted_ua_label: '',
        predicted_confidence: 'low',
        issuer_match: false,
        passed: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  
  // Статистика
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Summary`);
  console.log(`═══════════════════════════════════════════════════════════`);
  console.log(`   Total: ${results.length}`);
  console.log(`   ✅ Passed: ${passed}`);
  console.log(`   ❌ Failed: ${failed}\n`);
  
  if (failed > 0) {
    console.log(`❌ FAILED tests:\n`);
    results.filter(r => !r.passed).forEach(r => {
      console.log(`   ${r.nreg}:`);
      if (r.db_slug !== r.expected_slug) {
        console.log(`     DB: ${r.db_slug || 'NULL'} → expected ${r.expected_slug}`);
      }
      if (r.predicted_slug !== r.expected_slug) {
        console.log(`     Predicted: ${r.predicted_slug} → expected ${r.expected_slug}`);
      }
      if (!r.issuer_match) {
        console.log(`     Issuer mismatch`);
      }
      if (r.error) {
        console.log(`     Error: ${r.error}`);
      }
    });
  }
  
  // Зберігаємо результати
  const outputPath = 'scripts/legislation/runs/audit/DOC_TYPE_REGRESSION_RESULTS.json';
  await fs.writeFile(outputPath, JSON.stringify(results, null, 2), 'utf-8');
  console.log(`\n✅ Regression test results збережено: ${outputPath}`);
  
  // Генеруємо Markdown звіт
  const markdownFile = 'scripts/legislation/runs/audit/DOC_TYPE_REGRESSION_RESULTS.md';
  let md = `# Document Type Regression Test Results\n\n`;
  md += `**Дата:** ${new Date().toISOString()}\n\n`;
  md += `| NREG | Expected | DB | Predicted | Issuer | Status |\n`;
  md += `|------|----------|----|-----------|--------|--------|\n`;
  
  for (const result of results) {
    const status = result.passed ? '✅ PASS' : '❌ FAIL';
    md += `| ${result.nreg} | ${result.expected_slug} | ${result.db_slug || 'NULL'} | ${result.predicted_slug} | ${result.issuer_match ? '✅' : '❌'} | ${status} |\n`;
  }
  
  await fs.writeFile(markdownFile, md, 'utf-8');
  console.log(`✅ Regression test report (Markdown) збережено: ${markdownFile}`);
  
  if (failed > 0) {
    console.log(`\n❌ PROD READY = NO (${failed} tests failed)`);
    process.exit(1);
  } else {
    console.log(`\n✅ PROD READY = YES (all tests passed)`);
  }
}
