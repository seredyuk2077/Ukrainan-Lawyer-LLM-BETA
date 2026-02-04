/**
 * Test Validation on Mismatches — тестування валідації на знайдених місматчах
 */

import { createSupabaseAdminClient } from '../lib/supabaseAdmin.js';
import { getJsonFromR2 } from '../lib/r2Json.js';
import { enrichDocumentType } from '../lib/documentTypeEnrichment.js';

const TEST_NREGS = [
  '29-2026-р', // Розпорядження КМУ → regulation (має бути cmu_order)
  '30-2026-р', // Розпорядження КМУ → regulation (має бути cmu_order)
  '31-2026-р', // Розпорядження КМУ → regulation (має бути cmu_order)
  '60/2026',   // Указ Президента → regulation (має бути presidential_decree)
  '66/2026',   // Указ Президента → presidential_order (має бути presidential_decree)
];

export async function testValidationOnMismatches(): Promise<void> {
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Test Validation on Mismatches`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  
  const supabase = createSupabaseAdminClient();
  
  for (const nreg of TEST_NREGS) {
    try {
      // Отримуємо з Supabase
      const { data: doc } = await supabase
        .from('legislation_documents')
        .select('rada_nreg, title, document_type_slug, document_type, summary, r2_key')
        .eq('rada_nreg', nreg)
        .maybeSingle();
      
      if (!doc) {
        console.log(`⚠️  ${nreg}: Not found in Supabase`);
        continue;
      }
      
      // Отримуємо raw дані з R2
      let jsonData: any = null;
      let snippet: string | null = null;
      
      try {
        if (doc.r2_key) {
          const canonical = await getJsonFromR2(doc.r2_key);
          jsonData = canonical.raw?.rada_api_json || null;
          
          // Отримуємо snippet
          if (canonical.content?.chunks?.[0]?.text) {
            snippet = canonical.content.chunks[0].text.substring(0, 200);
          } else if (canonical.raw?.rada_api_txt) {
            snippet = canonical.raw.rada_api_txt.substring(0, 200);
          }
        }
      } catch (e) {
        console.warn(`⚠️  Failed to read R2 for ${nreg}`);
      }
      
      // Використовуємо enrichDocumentType з валідацією
      const enrichment = await enrichDocumentType({
        title: doc.title,
        typ: jsonData?.typ || null,
        typn: jsonData?.typn || null,
        organs: jsonData?.organs || null,
        stru: jsonData?.stru || null,
        summary: doc.summary as string | null,
        snippet: snippet,
      });
      
      console.log(`\n${nreg}:`);
      console.log(`  Title: ${doc.title.substring(0, 60)}...`);
      console.log(`  Current: ${doc.document_type_slug} (${doc.document_type})`);
      console.log(`  Enriched: ${enrichment.slug} (${enrichment.label_uk})`);
      console.log(`  Confidence: ${enrichment.confidence}, Source: ${enrichment.source}`);
      
      if (enrichment.validation) {
        console.log(`  Validation: ${enrichment.validation.status}`);
        enrichment.validation.issues.forEach(issue => {
          console.log(`    ⚠️  ${issue}`);
        });
      } else {
        console.log(`  Validation: ok`);
      }
      
      const match = doc.document_type_slug === enrichment.slug;
      console.log(`  Match: ${match ? '✅' : '❌'}`);
      
    } catch (e: any) {
      console.error(`❌ ${nreg}: ${e.message}`);
    }
  }
}
