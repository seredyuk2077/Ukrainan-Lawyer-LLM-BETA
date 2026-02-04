/**
 * Backfill Validity — заповнення validity полів для існуючих документів
 * 
 * PROD PIPELINE: автоматичне заповнення validity_status для всіх документів
 */
import { createSupabaseAdminClient } from '../lib/supabaseAdmin.js';
import { RadaClient } from '../lib/radaClient.js';
import { getJsonFromR2 } from '../lib/r2Json.js';
import { extractValidityAsync } from '../canonical/extractValidity.js';
import { repairConsistency } from './repair-consistency.js';
import { clearValidityCache } from '../lib/radaValidityResolver.js';

export interface BackfillValidityOptions {
  dryRun?: boolean;
  limit?: number;
  onlyNull?: boolean; // тільки документи з NULL validity_status
  nreg?: string; // конкретний документ
}

export interface BackfillValidityResult {
  total: number;
  processed: number;
  updated: number;
  skipped: number;
  errors: number;
  results: Array<{
    nreg: string;
    title: string;
    old_status: string | null;
    new_status: string;
    source_location: string | null;
    error?: string;
  }>;
}

export async function backfillValidity(options: BackfillValidityOptions = {}): Promise<BackfillValidityResult> {
  const supabase = createSupabaseAdminClient();
  const rada = new RadaClient();
  
  // Очищаємо кеш перед початком
  clearValidityCache();
  
  const result: BackfillValidityResult = {
    total: 0,
    processed: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
    results: [],
  };
  
  // 1. Отримуємо список документів (з пагінацією для повного backfill)
  // Фільтр: документи де будь-яке з validity полів NULL/порожнє
  const pageSize = 100;
  let page = 0;
  let hasMore = true;
  const allDocs: Array<{ rada_nreg: string; title: string; validity_status: string | null; r2_key: string | null }> = [];
  
  while (hasMore) {
    let query = supabase
      .from('legislation_documents')
      .select('rada_nreg, title, validity_status, r2_key, status_note, source_status_text, source_status_location, document_type_slug')
      .order('imported_at', { ascending: false })
      .range(page * pageSize, (page + 1) * pageSize - 1);
    
    if (options.onlyNull) {
      // Тільки документи з NULL validity_status
      query = query.is('validity_status', null);
    } else if (!options.nreg) {
      // BACKFILL ALL: всі документи (для повного перерахунку через resolver)
      // Не фільтруємо - обробляємо всі документи
    }
    
    if (options.nreg) {
      query = query.eq('rada_nreg', options.nreg);
    }
    
    if (options.limit && allDocs.length >= options.limit) {
      break;
    }
    
    const { data: docs, error: docsError } = await query;
    
    if (docsError) {
      throw new Error(`Supabase query error: ${docsError.message}`);
    }
    
    if (!docs || docs.length === 0) {
      hasMore = false;
      break;
    }
    
    allDocs.push(...docs);
    
    if (docs.length < pageSize) {
      hasMore = false;
    } else {
      page++;
    }
    
    // Якщо вказано limit — обмежуємо
    if (options.limit && allDocs.length >= options.limit) {
      allDocs.splice(options.limit);
      hasMore = false;
    }
  }
  
  if (allDocs.length === 0) {
    console.log('ℹ️  Немає документів для backfill');
    return result;
  }
  
  result.total = allDocs.length;
  const docs = allDocs;
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Backfill Validity: ${result.total} документів`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  
  // 2. Обробляємо кожен документ
  for (const doc of docs) {
    try {
      result.processed++;
      
      // BACKFILL ALL: обробляємо всі документи через resolver
      // Перевіряємо чи потрібно оновлювати (тільки якщо не dryRun і не nreg-specific)
      // Для повного backfill - завжди перераховуємо через resolver
      const needsUpdate = true; // Завжди перераховуємо через resolver
      
      // 3. Отримуємо дані для extractValidity
      let jsonData: any = null;
      let txtData: string | null = null;
      let canonicalTopBlock: string | null = null;
      
      try {
        // Завантажуємо JSON з Rada API
        jsonData = await rada.fetchJson(doc.rada_nreg);
        
        // Спробуємо завантажити TXT
        try {
          txtData = await rada.fetchTxt(doc.rada_nreg);
        } catch {
          txtData = null;
        }
        
        // Якщо є r2_key — спробуємо отримати canonical topBlock (розширений для status=5)
        if (doc.r2_key) {
          try {
            const canonical = await getJsonFromR2(doc.r2_key);
            if (canonical?.raw?.rada_api_txt) {
              // Для ZERO-UNKNOWN: розширюємо до 20k якщо status=5 або немає статусу
              const jsonStatus = jsonData?.status;
              const isStatus5 = jsonStatus === 5 || jsonStatus === '5';
              canonicalTopBlock = canonical.raw.rada_api_txt.substring(0, isStatus5 ? 20000 : 2500);
            }
          } catch {
            // Ігноруємо помилки R2
          }
        }
        
        // Якщо canonicalTopBlock не отримано з R2, але є txtData — використовуємо його
        if (!canonicalTopBlock && txtData) {
          const jsonStatus = jsonData?.status;
          const isStatus5 = jsonStatus === 5 || jsonStatus === '5';
          canonicalTopBlock = txtData.substring(0, isStatus5 ? 20000 : 2500);
        }
      } catch (error) {
        console.warn(`⚠️  Не вдалося завантажити дані для ${doc.rada_nreg}: ${error instanceof Error ? error.message : String(error)}`);
        result.errors++;
        result.results.push({
          nreg: doc.rada_nreg,
          title: doc.title,
          old_status: doc.validity_status,
          new_status: 'unknown',
          source_location: 'error.fetch_failed',
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      
      // 4. Отримуємо document_type_slug з Supabase для policy-by-type
      const { data: docMeta } = await supabase
        .from('legislation_documents')
        .select('document_type_slug, title')
        .eq('rada_nreg', doc.rada_nreg)
        .single();
      
      // 5. Витягуємо validity через resolver (authoritative source)
      const validity = await extractValidityAsync(
        doc.rada_nreg,
        rada,
        jsonData, 
        txtData, 
        canonicalTopBlock,
        docMeta?.document_type_slug || null,
        docMeta?.title || doc.title || null
      );
      
      // 5. Оновлюємо в Supabase
      if (!options.dryRun) {
        const { error: updateError } = await supabase
          .from('legislation_documents')
          .update({
            validity_status: validity.validity_status,
            status_note: validity.status_note,
            source_status_text: validity.source_status_text,
            source_status_location: validity.source_status_location,
          })
          .eq('rada_nreg', doc.rada_nreg);
        
        if (updateError) {
          throw new Error(`Supabase update error: ${updateError.message}`);
        }
        
        // Синхронізуємо з Qdrant (repair-consistency)
        try {
          await repairConsistency(doc.rada_nreg, { dryRun: false });
        } catch (repairError) {
          console.warn(`⚠️  Не вдалося синхронізувати з Qdrant для ${doc.rada_nreg}: ${repairError instanceof Error ? repairError.message : String(repairError)}`);
        }
      }
      
      result.updated++;
      result.results.push({
        nreg: doc.rada_nreg,
        title: doc.title,
        old_status: doc.validity_status,
        new_status: validity.validity_status,
        source_location: validity.source_status_location,
      });
      
      if (result.processed % 10 === 0) {
        console.log(`  Processed: ${result.processed}/${result.total} (updated: ${result.updated}, skipped: ${result.skipped}, errors: ${result.errors})`);
      }
    } catch (error) {
      result.errors++;
      result.results.push({
        nreg: doc.rada_nreg,
        title: doc.title,
        old_status: doc.validity_status,
        new_status: 'unknown',
        source_location: 'error.exception',
        error: error instanceof Error ? error.message : String(error),
      });
      console.error(`❌ Помилка обробки ${doc.rada_nreg}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  // 6. Перевірка unknown=0 (HARD ASSERT)
  if (!options.dryRun) {
    const { data: unknownDocs, error: unknownErr } = await supabase
      .from('legislation_documents')
      .select('rada_nreg, title, validity_status')
      .eq('validity_status', 'unknown');
    
    if (unknownErr) {
      throw new Error(`Supabase query error for unknown check: ${unknownErr.message}`);
    }
    
    const unknownCount = unknownDocs?.length || 0;
    
    console.log(`\n═══════════════════════════════════════════════════════════`);
    console.log(`Backfill Validity: Завершено`);
    console.log(`═══════════════════════════════════════════════════════════`);
    console.log(`Total: ${result.total}`);
    console.log(`Processed: ${result.processed}`);
    console.log(`Updated: ${result.updated}`);
    console.log(`Skipped: ${result.skipped}`);
    console.log(`Errors: ${result.errors}`);
    console.log(`\n🔍 Unknown status check: ${unknownCount} документів з validity_status='unknown'`);
    
    if (unknownCount > 0) {
      console.error(`\n❌ CRITICAL: Знайдено ${unknownCount} документів з unknown статусом!`);
      console.error(`Перші 10 unknown документів:`);
      unknownDocs?.slice(0, 10).forEach(doc => {
        console.error(`  - ${doc.rada_nreg}: ${doc.title}`);
      });
      throw new Error(`ZERO-UNKNOWN violation: ${unknownCount} documents still have unknown status`);
    } else {
      console.log(`✅ ZERO-UNKNOWN: Всі документи мають визначений статус чинності`);
    }
  } else {
    console.log(`\n═══════════════════════════════════════════════════════════`);
    console.log(`Backfill Validity: Завершено (DRY RUN)`);
    console.log(`═══════════════════════════════════════════════════════════`);
    console.log(`Total: ${result.total}`);
    console.log(`Processed: ${result.processed}`);
    console.log(`Updated: ${result.updated}`);
    console.log(`Skipped: ${result.skipped}`);
    console.log(`Errors: ${result.errors}`);
    console.log(`\n⚠️  DRY RUN: зміни не застосовано`);
  }
  
  return result;
}
