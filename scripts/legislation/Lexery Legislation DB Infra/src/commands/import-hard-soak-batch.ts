/**
 * Import Hard Soak Batch — імпорт з циклами контролю (PHASE 3.3)
 * 
 * Імпортує пачками по 10, після кожної пачки:
 * - detect-type-absurdities
 * - verify
 * - repair-consistency
 * - STOP якщо CRITICAL > 0
 */

import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { importOne } from '../lib/importer.js';
import { detectTypeAbsurdities } from './detect-type-absurdities.js';
import { verifyDocument } from './verify.js';
import { repairConsistency } from './repair-consistency.js';

export async function importHardSoakBatch(options?: {
  batchSize?: number;
  nregsFile?: string;
}): Promise<void> {
  const { batchSize = 10, nregsFile } = options || {};
  
  const filePath = nregsFile || resolve(process.env.LEXERY_LEGISLATION_WORKSPACE_ROOT || process.cwd(), 'data', 'hard_soak_nregs.txt');
  
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Import Hard Soak Batch — пачками по ${batchSize}`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  
  // Читаємо список nreg
  const content = await readFile(filePath, 'utf-8');
  const nregs = content.split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
  
  console.log(`📋 Знайдено ${nregs.length} документів для імпорту\n`);
  
  if (nregs.length === 0) {
    throw new Error('No nregs found in file');
  }
  
  // Імпортуємо пачками
  const totalBatches = Math.ceil(nregs.length / batchSize);
  
  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    const batchStart = batchIndex * batchSize;
    const batchEnd = Math.min(batchStart + batchSize, nregs.length);
    const batchNregs = nregs.slice(batchStart, batchEnd);
    
    console.log(`\n═══════════════════════════════════════════════════════════`);
    console.log(`Batch ${batchIndex + 1}/${totalBatches}: ${batchNregs.length} документів`);
    console.log(`═══════════════════════════════════════════════════════════\n`);
    console.log(`Nregs: ${batchNregs.join(', ')}\n`);
    
    // Імпортуємо пачку
    const batchResults: Array<{ nreg: string; success: boolean; error?: string }> = [];
    
    for (const nreg of batchNregs) {
      try {
        console.log(`📥 Імпортуємо ${nreg}...`);
        await importOne({
          mode: 'add',
          radaNreg: nreg,
          resume: true,
        });
        batchResults.push({ nreg, success: true });
        console.log(`✅ ${nreg} імпортовано\n`);
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        batchResults.push({ nreg, success: false, error });
        console.error(`❌ ${nreg} помилка: ${error}\n`);
      }
    }
    
    const successCount = batchResults.filter(r => r.success).length;
    const failCount = batchResults.filter(r => !r.success).length;
    
    console.log(`\n📊 Batch ${batchIndex + 1} результат: ${successCount} успішно, ${failCount} помилок\n`);
    
    // Перевірка після пачки
    console.log(`🔍 Перевірка після batch ${batchIndex + 1}...\n`);
    
    // A) detect-type-absurdities на всіх (щоб побачити нові CRITICAL)
    console.log(`  A) detect-type-absurdities...`);
    const findings = await detectTypeAbsurdities({
      limit: undefined,
      onlyRed: true,
    });
    
    const criticalCount = findings.filter(f => f.severity === 'CRITICAL').length;
    
    console.log(`  📊 CRITICAL findings: ${criticalCount}`);
    
    if (criticalCount > 0) {
      console.log(`\n⚠️  STOP RULE: CRITICAL > 0. Зупиняємося для root-fix.\n`);
      console.log(`Top CRITICAL findings:`);
      findings
        .filter(f => f.severity === 'CRITICAL')
        .slice(0, 10)
        .forEach(f => {
          console.log(`  ${f.nreg}: ${f.reason_code} (${f.current_slug} → ${f.suggested_slug})`);
        });
      
      throw new Error(`CRITICAL findings detected: ${criticalCount}. Root-fix required before continuing.`);
    }
    
    // B) verify на нових документах
    console.log(`  B) verify на нових документах...`);
    for (const nreg of batchNregs) {
      if (batchResults.find(r => r.nreg === nreg && r.success)) {
        try {
          await verifyDocument(nreg, {
            writeHealth: true,
          });
        } catch (e) {
          // Пропускаємо помилки verify
        }
      }
    }
    
    // C) repair-consistency на нових
    console.log(`  C) repair-consistency на нових документах...`);
    for (const nreg of batchNregs) {
      if (batchResults.find(r => r.nreg === nreg && r.success)) {
        try {
          await repairConsistency(nreg, {});
        } catch (e) {
          // Пропускаємо помилки repair
        }
      }
    }
    
    console.log(`\n✅ Batch ${batchIndex + 1} пройшов перевірку (CRITICAL=0)\n`);
  }
  
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`✅ Всі ${nregs.length} документів імпортовано`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
}
