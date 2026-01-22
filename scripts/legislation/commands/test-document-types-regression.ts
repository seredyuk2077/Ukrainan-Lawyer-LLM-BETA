/**
 * Test Document Types Regression — перевірка коректності document_type_slug для різних типів
 */

import { createSupabaseAdminClient } from '../lib/supabaseAdmin.js';
import { getJsonFromR2 } from '../lib/r2Json.js';
import { enrichDocumentType } from '../lib/documentTypeEnrichment.js';

const TEST_NREGS = [
  'nb07d710-25', // ccu_opinion
  '995_153', // convention
  '66/2026', // presidential_order
  '254к/96-вр', // constitution
  '2341-14', // code
  '435-15', // code
  '3543-12', // law
  '57-95-п', // cmu_resolution
  '80731-10', // code (multi-part)
  '80732-10', // code (multi-part)
];

export async function testDocumentTypesRegression(): Promise<void> {
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Document Types Regression Test`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  
  const supabase = createSupabaseAdminClient();
  
  const results: Array<{
    nreg: string;
    title: string;
    typ?: number | null;
    organs?: any;
    current_slug: string;
    current_ua: string;
    enriched_slug: string;
    enriched_ua: string;
    source: string;
    confidence: string;
    match: boolean;
  }> = [];
  
  for (const nreg of TEST_NREGS) {
    try {
      // Отримуємо з Supabase
      const { data: doc } = await supabase
        .from('legislation_documents')
        .select('rada_nreg, title, document_type_slug, document_type, r2_key')
        .eq('rada_nreg', nreg)
        .maybeSingle();
      
      if (!doc) {
        console.log(`⚠️  ${nreg}: Not found in Supabase`);
        continue;
      }
      
      // Отримуємо raw дані з R2
      let jsonData: any = null;
      try {
        if (doc.r2_key) {
          const canonical = await getJsonFromR2(doc.r2_key);
          jsonData = canonical.raw?.rada_api_json || null;
        }
      } catch (e) {
        console.warn(`⚠️  Failed to read R2 for ${nreg}`);
      }
      
      // Використовуємо enrichDocumentType
      const enrichment = await enrichDocumentType({
        title: doc.title,
        typ: jsonData?.typ || null,
        typn: jsonData?.typn || null,
        organs: jsonData?.organs || null,
        stru: jsonData?.stru || null,
      });
      
      const match = doc.document_type_slug === enrichment.slug;
      
      results.push({
        nreg,
        title: doc.title.substring(0, 60) + '...',
        typ: jsonData?.typ || null,
        organs: typeof jsonData?.organs === 'string' ? jsonData.organs : JSON.stringify(jsonData?.organs || {}).substring(0, 50),
        current_slug: doc.document_type_slug || 'NULL',
        current_ua: doc.document_type || 'NULL',
        enriched_slug: enrichment.slug,
        enriched_ua: enrichment.label_uk,
        source: enrichment.source,
        confidence: enrichment.confidence,
        match,
      });
      
      console.log(`${match ? '✅' : '❌'} ${nreg}: ${doc.document_type_slug || 'NULL'} → ${enrichment.slug} (${enrichment.source}, ${enrichment.confidence})`);
      if (!match) {
        console.log(`  Current UA: ${doc.document_type || 'NULL'}`);
        console.log(`  Enriched UA: ${enrichment.label_uk}`);
      }
    } catch (e: any) {
      console.error(`❌ ${nreg}: ${e.message}`);
    }
  }
  
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Summary`);
  console.log(`═══════════════════════════════════════════════════════════`);
  
  const matches = results.filter(r => r.match).length;
  const mismatches = results.filter(r => !r.match).length;
  
  console.log(`Total: ${results.length}`);
  console.log(`✅ Matches: ${matches}`);
  console.log(`❌ Mismatches: ${mismatches}`);
  
  if (mismatches > 0) {
    console.log(`\nMismatches:`);
    results.filter(r => !r.match).forEach(r => {
      console.log(`  - ${r.nreg}: ${r.current_slug} → ${r.enriched_slug} (${r.source}, ${r.confidence})`);
    });
  }
  
  // Evidence table
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Evidence Table`);
  console.log(`═══════════════════════════════════════════════════════════`);
  console.log(`NREG | Typ | Organs | Slug | UA Label | Source | Confidence`);
  console.log(`-----|-----|--------|------|----------|--------|------------`);
  results.forEach(r => {
    const typ = r.typ?.toString() || 'NULL';
    const organs = (r.organs || 'NULL').toString().substring(0, 20);
    console.log(`${r.nreg} | ${typ} | ${organs} | ${r.enriched_slug} | ${r.enriched_ua} | ${r.source} | ${r.confidence}`);
  });
}
