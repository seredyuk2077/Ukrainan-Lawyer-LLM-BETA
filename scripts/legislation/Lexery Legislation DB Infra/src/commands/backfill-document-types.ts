/**
 * Backfill Document Types — оновлення document_type_slug та document_type для всіх документів
 * 
 * Використовує нову систему: enrichDocumentType (heuristics + AI + cache)
 */

import { createSupabaseAdminClient, nowIso } from '../lib/supabaseAdmin.js';
import { enrichDocumentType } from '../lib/documentTypeEnrichment.js';
import { getJsonFromR2 } from '../lib/r2Json.js';

export interface BackfillResult {
  total: number;
  updated: number;
  skipped: number;
  errors: number;
  details: Array<{
    nreg: string;
    status: 'updated' | 'skipped' | 'error';
    old_slug?: string;
    new_slug?: string;
    old_type?: string;
    new_type?: string;
    error?: string;
  }>;
}

export async function backfillDocumentTypes(options?: {
  dryRun?: boolean;
  limit?: number;
}): Promise<BackfillResult> {
  const { dryRun = false, limit } = options || {};
  const supabase = createSupabaseAdminClient();
  
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Backfill Document Types${dryRun ? ' (DRY RUN)' : ''}`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  
  // Отримуємо всі документи
  let query = supabase
    .from('legislation_documents')
    .select('rada_nreg, title, document_type, document_type_slug, r2_key, document_number, summary')
    .order('rada_nreg');
  
  if (limit) {
    query = query.limit(limit);
  }
  
  const { data: docs, error } = await query;
  if (error) throw new Error(`Supabase query error: ${error.message}`);
  if (!docs || docs.length === 0) {
    return { total: 0, updated: 0, skipped: 0, errors: 0, details: [] };
  }
  
  console.log(`Found ${docs.length} documents to process\n`);
  
  const result: BackfillResult = {
    total: docs.length,
    updated: 0,
    skipped: 0,
    errors: 0,
    details: [],
  };
  
  for (const doc of docs) {
    try {
      // Отримуємо raw дані з R2 для typ/organs + summary/snippet
      let jsonData: any = null;
      let summary: string | null = null;
      let snippet: string | null = null;
      
      try {
        if (doc.r2_key) {
          const canonical = await getJsonFromR2(doc.r2_key);
          jsonData = canonical.raw?.rada_api_json || null;
          
          // Отримуємо summary з canonical або Supabase
          summary = canonical.ai_enrichment?.summary || (doc.summary as string | null) || null;
          
          // Отримуємо snippet з raw.rada_api_txt (для кращого виявлення декретів/НКРЕКП)
          // ВАЖЛИВО: для декретів та НКРЕКП потрібно брати raw.rada_api_txt, бо chunks можуть не містити заголовок
          let rawTxt: string | null = null;
          if (canonical.raw?.rada_api_txt) {
            rawTxt = canonical.raw.rada_api_txt.substring(0, 800);
            snippet = canonical.raw.rada_api_txt.substring(0, 600);
          } else if (canonical.content?.chunks?.[0]?.text) {
            snippet = canonical.content.chunks[0].text.substring(0, 600);
          }
        }
      } catch (e) {
        console.warn(`⚠️  Failed to read R2 for ${doc.rada_nreg}: ${e instanceof Error ? e.message : String(e)}`);
      }
      
      // Використовуємо enrichDocumentType з валідацією (з raw_txt для priority ladder)
      const enrichment = await enrichDocumentType({
        title: doc.title,
        typ: jsonData?.typ || null,
        typn: jsonData?.typn || null,
        organs: jsonData?.organs || null,
        stru: jsonData?.stru || null,
        summary: summary,
        snippet: snippet,
        document_number: doc.document_number || null,
        raw_txt: rawTxt || null,  // Додано для priority ladder
      });
      
      const newSlug = enrichment.slug;
      const newType = enrichment.label_uk;
      const oldSlug = doc.document_type_slug;
      const oldType = doc.document_type;
      
      // Перевіряємо чи потрібно оновлювати
      if (oldSlug === newSlug && oldType === newType) {
        result.skipped++;
        result.details.push({
          nreg: doc.rada_nreg,
          status: 'skipped',
          old_slug: oldSlug || undefined,
          new_slug: newSlug,
        });
        continue;
      }
      
      // Оновлюємо
      if (!dryRun) {
        const { error: updateError } = await supabase
          .from('legislation_documents')
          .update({
            document_type_slug: newSlug,
            document_type: newType,
            updated_at: nowIso(),
          })
          .eq('rada_nreg', doc.rada_nreg);
        
        if (updateError) {
          throw new Error(`Supabase update error: ${updateError.message}`);
        }
      }
      
              result.updated++;
              result.details.push({
                nreg: doc.rada_nreg,
                status: 'updated',
                old_slug: oldSlug || undefined,
                new_slug: newSlug,
                old_type: oldType || undefined,
                new_type: newType,
              });
              
              const validationInfo = enrichment.validation 
                ? ` [validation: ${enrichment.validation.status}, issues: ${enrichment.validation.issues.length}]`
                : '';
              console.log(`${dryRun ? '[DRY RUN] ' : ''}✓ ${doc.rada_nreg}: ${oldSlug || 'NULL'} → ${newSlug} (${oldType || 'NULL'} → ${newType})${validationInfo}`);
              
              if (enrichment.validation && enrichment.validation.issues.length > 0) {
                enrichment.validation.issues.forEach(issue => {
                  console.log(`  ⚠️  ${issue}`);
                });
              }
    } catch (e: any) {
      result.errors++;
      const errorMessage = e instanceof Error ? e.message : String(e);
      result.details.push({
        nreg: doc.rada_nreg,
        status: 'error',
        error: errorMessage,
      });
      console.error(`❌ ${doc.rada_nreg}: ${errorMessage}`);
    }
  }
  
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Summary`);
  console.log(`═══════════════════════════════════════════════════════════`);
  console.log(`Total: ${result.total}`);
  console.log(`Updated: ${result.updated}`);
  console.log(`Skipped: ${result.skipped}`);
  console.log(`Errors: ${result.errors}`);
  
  return result;
}
