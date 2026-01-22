/**
 * Repair Document Types — PHASE 14
 * 
 * Виправляє document_type_slug для документів з невалідними/legacy типами
 */

import { createSupabaseAdminClient } from '../lib/supabaseAdmin.js';
import { QdrantRagClient } from '../lib/qdrantRagClient.js';
import { guessDocumentTypeV2 } from '../documentTypes/guessDocumentTypeV2.js';
import { DocumentTypeSlug, normalizeDocumentType } from '../documentTypes/documentTypes.js';
import { RadaClient } from '../radaClient.js';

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
  let query = supabase.from('legislation_documents').select('rada_nreg,title,document_type,document_type_slug');
  
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
      const jsonData = await radaClient.fetchJson(doc.rada_nreg);
      
      // Визначаємо новий document_type_slug
      const guess = guessDocumentTypeV2({
        title: doc.title,
        typ: jsonData?.typ,
        typn: jsonData?.typn,
        organs: jsonData?.organs,
        stru: jsonData?.stru,
      });
      
      const newSlug: DocumentTypeSlug = guess.slug;
      
      if (newSlug === doc.document_type_slug && !forceAi) {
        unchanged++;
        continue;
      }
      
      console.log(`[${doc.rada_nreg}] ${doc.title.substring(0, 60)}...`);
      console.log(`  Old: document_type="${doc.document_type}", slug=${doc.document_type_slug || 'null'}`);
      console.log(`  New: slug=${newSlug} (${guess.confidence}, ${guess.source})`);
      
      if (dryRun) {
        console.log(`  → [DRY RUN] Would update`);
        updated++;
        continue;
      }
      
      // Оновлюємо Supabase
      const { data: updateData, error: updateErr } = await supabase
        .from('legislation_documents')
        .update({ document_type_slug: newSlug })
        .eq('rada_nreg', doc.rada_nreg)
        .select('rada_nreg, document_type_slug')
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
