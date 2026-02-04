/**
 * Collect Mismatch Evidence — збір "golden mismatch list" для валідації типів
 */

import { createSupabaseAdminClient } from '../lib/supabaseAdmin.js';
import { getJsonFromR2 } from '../lib/r2Json.js';

export interface MismatchEvidence {
  nreg: string;
  title: string;
  document_type_slug: string;
  document_type: string;
  typ?: number | null;
  organs?: any;
  summary_prefix?: string;
  snippet_200?: string;
}

export async function collectMismatchEvidence(limit: number = 20): Promise<MismatchEvidence[]> {
  const supabase = createSupabaseAdminClient();
  
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Collect Mismatch Evidence (top ${limit} suspicious)`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  
  // Отримуємо документи з summary (якщо є поле summary)
  const { data: docs } = await supabase
    .from('legislation_documents')
    .select('rada_nreg, title, document_type_slug, document_type, summary, r2_key')
    .order('rada_nreg')
    .limit(limit * 2); // Більше для фільтрації
  
  if (!docs || docs.length === 0) {
    console.log('No documents found');
    return [];
  }
  
  const mismatches: MismatchEvidence[] = [];
  
  for (const doc of docs) {
    try {
      // Перевіряємо summary на конфлікти
      const summary = doc.summary as string | null;
      const summaryPrefix = summary ? summary.substring(0, 120) : null;
      
      // Перевірка на очевидні конфлікти
      let hasConflict = false;
      let conflictReason = '';
      
      if (summaryPrefix) {
        // Розпорядження КМУ але не cmu_order
        if ((summaryPrefix.includes('Розпорядження') && summaryPrefix.includes('КМУ')) || 
            (summaryPrefix.includes('Розпорядження') && summaryPrefix.includes('Кабінет'))) {
          if (doc.document_type_slug !== 'cmu_order') {
            hasConflict = true;
            conflictReason = 'summary: Розпорядження КМУ, але slug != cmu_order';
          }
        }
        
        // Постанова ЦВК але не cec_resolution
        if (summaryPrefix.includes('Постанова') && 
            (summaryPrefix.includes('ЦВК') || summaryPrefix.includes('Центральна виборча'))) {
          if (doc.document_type_slug !== 'cec_resolution') {
            hasConflict = true;
            conflictReason = 'summary: Постанова ЦВК, але slug != cec_resolution';
          }
        }
        
        // НБУ але не nbu_*
        if (summaryPrefix.includes('НБУ') || summaryPrefix.includes('Національний банк')) {
          if (!doc.document_type_slug?.startsWith('nbu_')) {
            hasConflict = true;
            conflictReason = 'summary: НБУ, але slug не nbu_*';
          }
        }
        
        // Указ Президента але не presidential_decree
        if (summaryPrefix.includes('Указ') && summaryPrefix.includes('Президент')) {
          if (doc.document_type_slug !== 'presidential_decree') {
            hasConflict = true;
            conflictReason = 'summary: Указ Президента, але slug != presidential_decree';
          }
        }
      }
      
      // Перевірка title
      if (!hasConflict && doc.title) {
        if ((doc.title.includes('Розпорядження') && doc.title.includes('КМУ')) && 
            doc.document_type_slug !== 'cmu_order') {
          hasConflict = true;
          conflictReason = 'title: Розпорядження КМУ, але slug != cmu_order';
        }
      }
      
      if (!hasConflict) continue;
      
      // Отримуємо raw дані з R2
      let jsonData: any = null;
      let snippet200: string | null = null;
      
      try {
        if (doc.r2_key) {
          const canonical = await getJsonFromR2(doc.r2_key);
          jsonData = canonical.raw?.rada_api_json || null;
          
          // Отримуємо snippet з першого chunk
          if (canonical.content?.chunks?.[0]?.text) {
            snippet200 = canonical.content.chunks[0].text.substring(0, 200);
          } else if (canonical.raw?.rada_api_txt) {
            snippet200 = canonical.raw.rada_api_txt.substring(0, 200);
          }
        }
      } catch (e) {
        console.warn(`⚠️  Failed to read R2 for ${doc.rada_nreg}`);
      }
      
      mismatches.push({
        nreg: doc.rada_nreg,
        title: doc.title,
        document_type_slug: doc.document_type_slug || 'NULL',
        document_type: doc.document_type || 'NULL',
        typ: jsonData?.typ || null,
        organs: jsonData?.organs || null,
        summary_prefix: summaryPrefix || undefined,
        snippet_200: snippet200 || undefined,
      });
      
      console.log(`❌ ${doc.rada_nreg}: ${conflictReason}`);
      console.log(`   Title: ${doc.title.substring(0, 60)}...`);
      console.log(`   Current: ${doc.document_type_slug} (${doc.document_type})`);
      console.log(`   Summary: ${summaryPrefix || 'N/A'}`);
      
      if (mismatches.length >= limit) break;
    } catch (e: any) {
      console.error(`❌ Error processing ${doc.rada_nreg}: ${e.message}`);
    }
  }
  
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Summary`);
  console.log(`═══════════════════════════════════════════════════════════`);
  console.log(`Total mismatches found: ${mismatches.length}`);
  
  return mismatches;
}
