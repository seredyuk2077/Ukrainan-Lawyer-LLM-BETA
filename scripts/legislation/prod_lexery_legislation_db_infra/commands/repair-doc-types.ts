/**
 * Repair Document Types — PHASE 14
 * 
 * Виправляє document_type_slug для документів з невалідними/legacy типами
 */

import { createSupabaseAdminClient } from '../lib/supabaseAdmin.js';
import { QdrantRagClient } from '../lib/qdrantRagClient.js';
import { enrichDocumentType } from '../lib/documentTypeEnrichment.js';
import { DocumentTypeSlug, normalizeDocumentType } from '../documentTypes/documentTypes.js';
import { RadaClient } from '../lib/radaClient.js';
import { getJsonFromR2 } from '../lib/r2Json.js';

interface RepairOptions {
  nreg?: string;
  all?: boolean;
  forceAi?: boolean;
  dryRun?: boolean;
}

export async function repairDocTypes(options: RepairOptions): Promise<void> {
  const { nreg, all, forceAi = false, dryRun = false } = options;
  
  if (!nreg && !all) {
    console.error('❌ Потрібно вказати --nreg або --all');
    process.exit(1);
  }
  
  const supabase = createSupabaseAdminClient();
  const qdrantClient = new QdrantRagClient();
  
  // Отримуємо документи для ремонту
  let query = supabase.from('legislation_documents').select('rada_nreg,title,document_type,document_type_slug,document_number,summary,r2_key');
  
  if (nreg) {
    query = query.eq('rada_nreg', nreg);
  }
  
  const { data: docs, error } = await query;
  if (error) throw new Error(`Supabase query error: ${error.message}`);
  if (!docs || docs.length === 0) {
    console.log('ℹ️  Документи не знайдено');
    return;
  }
  
  console.log(`📋 Знайдено ${docs.length} документів для перевірки\n`);
  
  let updated = 0;
  let unchanged = 0;
  let errors = 0;
  
  for (const doc of docs) {
    try {
      // Перевіряємо чи потрібен ремонт
      const needsRepair = 
        !doc.document_type_slug || 
        doc.document_type_slug === 'other' ||
        doc.document_type === 'Документ' ||
        doc.document_type === 'unknown' ||
        forceAi;
      
      if (!needsRepair && !forceAi) {
        unchanged++;
        continue;
      }
      
      // Отримуємо дані з Rada для heuristics
      const radaClient = new RadaClient();
      let jsonData: any = await radaClient.fetchJson(doc.rada_nreg);
      
      // Отримуємо snippet/summary з R2 (PHASE 1: для правил -РП/-РГ)
      let snippet: string | null = null;
      let summary: string | null = (doc.summary as string | null) || null;
      
      try {
        if (doc.r2_key) {
          const canonical = await getJsonFromR2(doc.r2_key);
          jsonData = canonical.raw?.rada_api_json || jsonData;
          
          // Отримуємо summary з canonical або Supabase
          summary = canonical.ai_enrichment?.summary || summary;
          
          // Отримуємо snippet з першого chunk або txt
          if (canonical.content?.chunks?.[0]?.text) {
            snippet = canonical.content.chunks[0].text.substring(0, 200);
          } else if (canonical.raw?.rada_api_txt) {
            snippet = canonical.raw.rada_api_txt.substring(0, 200);
          }
        }
      } catch (e) {
        console.warn(`  ⚠️  Failed to read R2 for ${doc.rada_nreg}: ${e instanceof Error ? e.message : String(e)}`);
      }
      
      // Визначаємо новий document_type_slug через enrichDocumentType (з валідацією)
      const enrichment = await enrichDocumentType({
        title: doc.title,
        typ: jsonData?.typ,
        typn: jsonData?.typn,
        organs: jsonData?.organs,
        stru: jsonData?.stru,
        summary: summary,
        snippet: snippet,
        document_number: doc.document_number || null,
      });
      
      const newSlug: DocumentTypeSlug = enrichment.slug;
      
      if (newSlug === doc.document_type_slug && !forceAi) {
        unchanged++;
        continue;
      }
      
      console.log(`[${doc.rada_nreg}] ${doc.title.substring(0, 60)}...`);
      console.log(`  Old: document_type="${doc.document_type}", slug=${doc.document_type_slug || 'null'}`);
      console.log(`  New: slug=${newSlug} (${enrichment.label_uk}) (${enrichment.confidence}, ${enrichment.source})`);
      if (enrichment.validation && enrichment.validation.issues.length > 0) {
        console.log(`  Validation: ${enrichment.validation.status}`);
        enrichment.validation.issues.forEach(issue => {
          console.log(`    ⚠️  ${issue}`);
        });
      }
      
      if (dryRun) {
        console.log(`  → [DRY RUN] Would update`);
        updated++;
        continue;
      }
      
      // Оновлюємо Supabase (slug + UA label)
      const { data: updateData, error: updateErr } = await supabase
        .from('legislation_documents')
        .update({ 
          document_type_slug: newSlug,
          document_type: enrichment.label_uk,  // UA label з taxonomy
        })
        .eq('rada_nreg', doc.rada_nreg)
        .select('rada_nreg, document_type_slug, document_type')
        .maybeSingle();
      
      if (updateErr) {
        console.error(`  ❌ Supabase update error: ${updateErr.message}`);
        errors++;
        continue;
      }
      
      if (!updateData) {
        console.error(`  ❌ Supabase update: no rows affected`);
        errors++;
        continue;
      }
      
      // Перевіряємо що оновлення спрацювало
      if (updateData.document_type_slug !== newSlug) {
        console.error(`  ❌ Supabase update: value mismatch. Expected ${newSlug}, got ${updateData.document_type_slug}`);
        errors++;
        continue;
      }
      
      // Оновлюємо Qdrant payloads (без перевставляння векторів)
      // TODO: реалізувати update payload in-place в QdrantRagClient
      // Поки що просто логуємо
      console.log(`  → Updated Supabase: document_type_slug=${updateData.document_type_slug}`);
      console.log(`  ⚠️  Qdrant payload update requires manual sync (use repair-consistency)`);
      
      updated++;
      
    } catch (e: any) {
      console.error(`  ❌ Error: ${e.message}`);
      errors++;
    }
  }
  
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('Summary');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`Updated: ${updated}`);
  console.log(`Unchanged: ${unchanged}`);
  console.log(`Errors: ${errors}`);
}
