/**
 * Import Diverse Batch — PHASE 3.1
 * 
 * Імпортує batch з diversity policy + Gate checks
 */

import { createSupabaseAdminClient } from '../lib/supabaseAdmin.js';
import { addDocument } from './add.js';
import { verifyDocument } from './verify.js';
import { detectTypeAbsurdities } from './detect-type-absurdities.js';
import { repairConsistency } from './repair-consistency.js';
import { readFile } from 'fs/promises';
import { resolve } from 'path';

/**
 * Імпортує batch з diversity policy
 */
export async function importDiverseBatch(options?: {
  batchSize?: number;
  startFrom?: number;
  inputFile?: string;
}): Promise<void> {
  const { batchSize = 10, startFrom = 0, inputFile } = options || {};
  
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Import Diverse Batch — PHASE 3.1`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  
  // Читаємо golden diversity set
  const inputPath = inputFile || resolve(process.cwd(), 'scripts/legislation/test/golden_diversity_set.json');
  console.log(`📥 Читаємо golden diversity set з ${inputPath}...`);
  const content = await readFile(inputPath, 'utf-8');
  const data = JSON.parse(content);
  const candidates = data.candidates || [];
  
  console.log(`✅ Завантажено ${candidates.length} кандидатів\n`);
  
  // Формуємо batch з diversity policy
  const batch = candidates.slice(startFrom, startFrom + batchSize);
  
  console.log(`📦 Batch ${Math.floor(startFrom / batchSize) + 1}: ${batch.length} документів\n`);
  console.log('NREG | Predicted Slug | Prefix Class | Organ');
  console.log('-----|----------------|--------------|-------');
  for (const candidate of batch) {
    console.log(
      `${candidate.nreg.padEnd(10)} | ${candidate.predicted_slug.padEnd(15)} | ${(candidate.prefix_class || 'ІНШЕ').padEnd(13)} | ${(candidate.organ_signal || 'OTHER').padEnd(5)}`
    );
  }
  console.log('');
  
  // Імпортуємо кожен документ
  const results: Array<{ nreg: string; success: boolean; error?: string }> = [];
  
  for (const candidate of batch) {
    try {
      console.log(`\n📥 Імпортуємо ${candidate.nreg}...`);
      await addDocument(candidate.nreg, { resume: true });
      
      // Verify після кожного документа
      console.log(`🔍 Verify ${candidate.nreg}...`);
      const verifyResult = await verifyDocument(candidate.nreg, { writeHealth: true });
      if (!verifyResult.pass) {
        throw new Error(`Verify FAIL для ${candidate.nreg}`);
      }
      
      // Repair consistency
      console.log(`🔧 Repair consistency ${candidate.nreg}...`);
      await repairConsistency(candidate.nreg, {});
      
      results.push({ nreg: candidate.nreg, success: true });
      console.log(`✅ ${candidate.nreg} успішно імпортовано\n`);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      console.error(`❌ ${candidate.nreg}: ${error}\n`);
      results.push({ nreg: candidate.nreg, success: false, error });
      
      // STOP RULE: якщо FAIL/CRITICAL → зупиняємося
      throw new Error(`STOP RULE: Помилка при імпорті ${candidate.nreg}: ${error}`);
    }
  }
  
  // Gate check після batch
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Gate Check після Batch`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  
  // 1) detect-type-absurdities
  console.log('🔍 detect-type-absurdities --all...');
  const findings = await detectTypeAbsurdities({});
  const criticalCount = findings.filter(f => f.severity === 'CRITICAL').length;
  const warnCount = findings.filter(f => f.severity === 'WARN').length;
  
  console.log(`   CRITICAL: ${criticalCount}`);
  console.log(`   WARN: ${warnCount}\n`);
  
  if (criticalCount > 0) {
    throw new Error(`STOP RULE: CRITICAL=${criticalCount} після batch. Потрібен root-fix.`);
  }
  
  // 2) verify --all
  console.log('🔍 verify --all --write-health...');
  const supabase = createSupabaseAdminClient();
  const { data: allDocs } = await supabase
    .from('legislation_documents')
    .select('rada_nreg')
    .order('rada_nreg', { ascending: true });
  
  let failCount = 0;
  for (const doc of allDocs || []) {
    try {
      const verifyResult = await verifyDocument(doc.rada_nreg, { writeHealth: true });
      if (!verifyResult.pass) {
        failCount++;
      }
    } catch (e) {
      failCount++;
    }
  }
  
  console.log(`   FAIL: ${failCount}\n`);
  
  if (failCount > 0) {
    throw new Error(`STOP RULE: verify FAIL=${failCount} після batch. Потрібен root-fix.`);
  }
  
  // 3) Health distribution
  const { data: healthData } = await supabase
    .from('legislation_documents')
    .select('sync_health');
  
  const healthDist = (healthData || []).reduce((acc, d) => {
    const health = d.sync_health || 'unknown';
    acc[health] = (acc[health] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  
  console.log('📊 Health distribution:');
  for (const [health, count] of Object.entries(healthDist)) {
    console.log(`   ${health}: ${count}`);
  }
  console.log('');
  
  if (healthDist.red > 0) {
    throw new Error(`STOP RULE: health_red=${healthDist.red} після batch. Потрібен root-fix.`);
  }
  
  // 4) Distribution snapshot
  const { data: typeData } = await supabase
    .from('legislation_documents')
    .select('document_type_slug');
  
  const typeDist = (typeData || []).reduce((acc, d) => {
    const slug = d.document_type_slug || 'unknown';
    acc[slug] = (acc[slug] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  
  const totalDocs = (allDocs || []).length;
  const cmuCount = Object.entries(typeDist)
    .filter(([slug]) => slug.startsWith('cmu_'))
    .reduce((sum, [, count]) => sum + count, 0);
  const cmuPercent = totalDocs > 0 ? ((cmuCount / totalDocs) * 100).toFixed(1) : '0.0';
  
  console.log('📊 Document type distribution (top 10):');
  const topTypes = Object.entries(typeDist)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10);
  for (const [slug, count] of topTypes) {
    console.log(`   ${slug}: ${count}`);
  }
  console.log(`\n   CMU total: ${cmuCount} (${cmuPercent}%)\n`);
  
  if (parseFloat(cmuPercent) > 70) {
    console.warn(`⚠️  WARN: CMU домінує ${cmuPercent}% (має бути <70%)`);
  }
  
  // 5) Semantic audit sample (10 нових + 10 random)
  console.log('📋 Semantic Audit Sample (10 нових з batch):');
  const batchNregs = batch.map(c => c.nreg);
  const { data: batchDocs } = await supabase
    .from('legislation_documents')
    .select('rada_nreg, title, document_number, document_type_slug, document_type, summary')
    .in('rada_nreg', batchNregs)
    .limit(10);
  
  console.log('nreg | title | document_number | slug | UA label | summary_prefix');
  console.log('-----|-------|-----------------|------|----------|----------------');
  for (const doc of batchDocs || []) {
    const titlePrefix = (doc.title || '').substring(0, 40).padEnd(40);
    const summaryPrefix = ((doc.summary as string) || '').substring(0, 80).padEnd(80);
    console.log(
      `${doc.rada_nreg.padEnd(10)} | ${titlePrefix} | ${(doc.document_number || '').padEnd(15)} | ${(doc.document_type_slug || '').padEnd(5)} | ${(doc.document_type || '').padEnd(9)} | ${summaryPrefix}`
    );
  }
  console.log('');
  
  // Summary
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Batch Summary`);
  console.log(`═══════════════════════════════════════════════════════════`);
  console.log(`Total: ${totalDocs}`);
  console.log(`Batch imported: ${results.filter(r => r.success).length}/${batch.length}`);
  console.log(`CRITICAL: ${criticalCount} ✅`);
  console.log(`FAIL: ${failCount} ✅`);
  console.log(`Health red: ${healthDist.red || 0} ✅`);
  console.log(`CMU %: ${cmuPercent}%`);
  console.log('');
}
