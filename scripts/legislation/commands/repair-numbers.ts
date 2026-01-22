/**
 * Repair Document Numbers — PHASE 15
 * 
 * Заповнює document_number для всіх документів
 */

import { createSupabaseAdminClient } from '../lib/supabaseAdmin.js';
import { RadaClient } from '../radaClient.js';

interface RepairOptions {
  nreg?: string;
  all?: boolean;
  dryRun?: boolean;
}

export async function repairNumbers(options: RepairOptions): Promise<void> {
  const { nreg, all, dryRun = false } = options;
  
  if (!nreg && !all) {
    console.error('❌ Потрібно вказати --nreg або --all');
    process.exit(1);
  }
  
  const supabase = createSupabaseAdminClient();
  
  // Отримуємо документи без document_number
  let query = supabase
    .from('legislation_documents')
    .select('rada_nreg,title,document_number,law_number');
  
  if (nreg) {
    query = query.eq('rada_nreg', nreg);
  } else {
    query = query.or('document_number.is.null,document_number.eq.');
  }
  
  const { data: docs, error } = await query;
  if (error) throw new Error(`Supabase query error: ${error.message}`);
  if (!docs || docs.length === 0) {
    console.log('ℹ️  Всі документи вже мають document_number');
    return;
  }
  
  console.log(`📋 Знайдено ${docs.length} документів для оновлення\n`);
  
  const radaClient = new RadaClient();
  let updated = 0;
  let unchanged = 0;
  let errors = 0;
  
  for (const doc of docs) {
    try {
      // Пріоритет: orgnum, інакше nreg
      let documentNumber = doc.law_number || doc.rada_nreg;
      
      // Спробуємо отримати orgnum з Rada
      try {
        const jsonData = await radaClient.fetchJson(doc.rada_nreg);
        if (jsonData?.organs?.orgnum) {
          documentNumber = jsonData.organs.orgnum;
        }
      } catch (e) {
        // Якщо не вдалося — використовуємо nreg
        documentNumber = doc.rada_nreg;
      }
      
      if (doc.document_number === documentNumber) {
        unchanged++;
        continue;
      }
      
      console.log(`[${doc.rada_nreg}] ${doc.title.substring(0, 60)}...`);
      console.log(`  Old: document_number=${doc.document_number || 'null'}`);
      console.log(`  New: document_number=${documentNumber}`);
      
      if (dryRun) {
        console.log(`  → [DRY RUN] Would update`);
        updated++;
        continue;
      }
      
      const { data: updateData, error: updateErr } = await supabase
        .from('legislation_documents')
        .update({ document_number: documentNumber })
        .eq('rada_nreg', doc.rada_nreg)
        .select('rada_nreg, document_number')
        .maybeSingle();
      
      if (updateErr) {
        console.error(`  ❌ Update error: ${updateErr.message}`);
        errors++;
        continue;
      }
      
      if (!updateData) {
        console.error(`  ❌ Update: no rows affected`);
        errors++;
        continue;
      }
      
      if (updateData.document_number !== documentNumber) {
        console.error(`  ❌ Update: value mismatch. Expected ${documentNumber}, got ${updateData.document_number}`);
        errors++;
        continue;
      }
      
      console.log(`  → Updated: document_number=${updateData.document_number}`);
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
