/**
 * Repair Document Type Consistency — виправляє document_type для консистентності з document_type_slug
 * 
 * Проблема: document_type (UA label) може не відповідати document_type_slug (EN slug)
 * Рішення: оновлюємо document_type на основі document_type_slug (source of truth)
 */

import { createSupabaseAdminClient } from '../lib/supabaseAdmin.js';
import { getDocumentTypeInfo } from '../documentTypes/documentTypes.js';

interface RepairOptions {
  nreg?: string;
  all?: boolean;
  dryRun?: boolean;
}

export async function repairDocumentTypeConsistency(options: RepairOptions): Promise<void> {
  const { nreg, all, dryRun = false } = options;
  
  if (!nreg && !all) {
    console.error('❌ Потрібно вказати --nreg або --all');
    process.exit(1);
  }
  
  const supabase = createSupabaseAdminClient();
  
  // Отримуємо документи для ремонту
  let query = supabase
    .from('legislation_documents')
    .select('rada_nreg,title,document_type,document_type_slug');
  
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
      if (!doc.document_type_slug) {
        console.log(`[${doc.rada_nreg}] ⚠️  Пропускаємо: немає document_type_slug`);
        unchanged++;
        continue;
      }
      
      // Отримуємо правильний UA label з taxonomy
      const typeInfo = getDocumentTypeInfo(doc.document_type_slug as any);
      const correctDocumentType = typeInfo.label_uk;
      
      if (doc.document_type === correctDocumentType) {
        unchanged++;
        continue;
      }
      
      console.log(`[${doc.rada_nreg}] ${doc.title.substring(0, 60)}...`);
      console.log(`  Old: document_type="${doc.document_type}", slug=${doc.document_type_slug}`);
      console.log(`  New: document_type="${correctDocumentType}" (з slug)`);
      
      if (dryRun) {
        console.log(`  → [DRY RUN] Would update`);
        updated++;
        continue;
      }
      
      // Оновлюємо Supabase
      const { data: updateData, error: updateErr } = await supabase
        .from('legislation_documents')
        .update({ document_type: correctDocumentType })
        .eq('rada_nreg', doc.rada_nreg)
        .select('rada_nreg, document_type')
        .maybeSingle();
      
      if (updateErr) {
        console.error(`  ❌ Supabase update error: ${updateErr.message}`);
        errors++;
        continue;
      }
      
      if (!updateData) {
        console.error(`  ❌ Update: no rows affected`);
        errors++;
        continue;
      }
      
      if (updateData.document_type !== correctDocumentType) {
        console.error(`  ❌ Update: value mismatch. Expected ${correctDocumentType}, got ${updateData.document_type}`);
        errors++;
        continue;
      }
      
      console.log(`  → Updated: document_type="${updateData.document_type}"`);
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
