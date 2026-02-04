/**
 * Soak Test — тестування на різноманітних документах
 * PHASE 20: Soak Tests на різних типах документів
 */
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { importOne } from '../lib/importer.js';
import { verifyDocument } from './verify.js';
import { repairConsistency } from './repair-consistency.js';
import { repairQdrantDedup } from './repair-qdrant-dedup.js';

interface SoakResult {
  nreg: string;
  importStatus: 'success' | 'failed' | 'skipped';
  verifyStatus: 'pass' | 'fail';
  issues: string[];
  repairApplied: boolean;
}

export async function runSoakTest(opts: {
  file?: string;
  dryRun?: boolean;
  repairOnFail?: boolean;
}): Promise<void> {
  const { file = 'test/soak_nregs.txt', dryRun = false, repairOnFail = true } = opts;
  
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('Soak Test — PHASE 20B');
  console.log('═══════════════════════════════════════════════════════════\n');
  
  // Read nregs from file
  const filePath = resolve(process.env.LEXERY_LEGISLATION_WORKSPACE_ROOT || process.cwd(), file);
  console.log(`📄 Reading from: ${filePath}`);
  const content = await readFile(filePath, 'utf-8');
  const nregs = content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .filter(line => line.length > 0);
  
  console.log(`📋 Found ${nregs.length} documents to test\n`);
  
  const results: SoakResult[] = [];
  
  for (const nreg of nregs) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Testing: ${nreg}`);
    console.log(`${'='.repeat(60)}\n`);
    
    const result: SoakResult = {
      nreg,
      importStatus: 'skipped',
      verifyStatus: 'fail',
      issues: [],
      repairApplied: false,
    };
    
    try {
      // Import
      if (!dryRun) {
        try {
          await importOne({
            mode: 'add',
            radaNreg: nreg,
            resume: false,
          });
          result.importStatus = 'success';
          console.log(`✅ Import successful`);
        } catch (e: any) {
          result.importStatus = 'failed';
          result.issues.push(`Import failed: ${e.message}`);
          console.log(`❌ Import failed: ${e.message}`);
        }
      } else {
        console.log(`[DRY-RUN] Would import ${nreg}`);
        result.importStatus = 'skipped';
      }
      
      // Verify (тільки якщо імпорт успішний)
      if (result.importStatus === 'success') {
        try {
          const verifyResult = await verifyDocument(nreg, { writeHealth: true });
          if (verifyResult.pass) {
            result.verifyStatus = 'pass';
            console.log(`✅ Verify PASS`);
          } else {
            result.verifyStatus = 'fail';
            result.issues.push(...verifyResult.issues.map(i => `${i.check}: ${i.reason || ''}`));
            console.log(`❌ Verify FAIL: ${verifyResult.issues.length} issues`);
            
            // Repair if enabled
            if (repairOnFail && !dryRun) {
              console.log(`🔧 Attempting repair...`);
              try {
                // Спочатку repair-qdrant-dedup (якщо є acts/chunks mismatch)
                const hasActsMismatch = result.issues.some(i => i.includes('acts count'));
                const hasChunksMismatch = result.issues.some(i => i.includes('chunks count'));
                
                if (hasActsMismatch || hasChunksMismatch) {
                  console.log(`  → Running repair-qdrant-dedup...`);
                  await repairQdrantDedup(nreg, { dryRun: false });
                }
                
                // Потім repair-consistency
                await repairConsistency(nreg, { dryRun: false });
                result.repairApplied = true;
                
                // Re-verify
                const reVerifyResult = await verifyDocument(nreg, { writeHealth: true });
                if (reVerifyResult.pass) {
                  result.verifyStatus = 'pass';
                  result.issues = [];
                  console.log(`✅ Verify PASS after repair`);
                } else {
                  console.log(`⚠️  Verify still FAIL after repair`);
                }
              } catch (e: any) {
                result.issues.push(`Repair failed: ${e.message}`);
                console.log(`❌ Repair failed: ${e.message}`);
              }
            }
          }
        } catch (e: any) {
          result.verifyStatus = 'fail';
          result.issues.push(`Verify failed: ${e.message}`);
          console.log(`❌ Verify failed: ${e.message}`);
        }
      } else if (result.importStatus === 'skipped') {
        // Для dry-run просто перевіряємо чи документ вже є
        try {
          const verifyResult = await verifyDocument(nreg, { writeHealth: false });
          result.verifyStatus = verifyResult.pass ? 'pass' : 'fail';
          if (!verifyResult.pass) {
            result.issues.push(...verifyResult.issues.map(i => `${i.check}: ${i.reason || ''}`));
          }
        } catch (e: any) {
          result.verifyStatus = 'fail';
          result.issues.push(`Verify failed: ${e.message}`);
        }
      }
    } catch (e: any) {
      result.issues.push(`Unexpected error: ${e.message}`);
      console.log(`❌ Unexpected error: ${e.message}`);
    }
    
    results.push(result);
  }
  
  // Summary
  console.log(`\n${'='.repeat(60)}`);
  console.log('Soak Test Summary');
  console.log(`${'='.repeat(60)}\n`);
  
  const importSuccess = results.filter(r => r.importStatus === 'success').length;
  const importFailed = results.filter(r => r.importStatus === 'failed').length;
  const importSkipped = results.filter(r => r.importStatus === 'skipped').length;
  const verifyPass = results.filter(r => r.verifyStatus === 'pass').length;
  const verifyFail = results.filter(r => r.verifyStatus === 'fail').length;
  const repairsApplied = results.filter(r => r.repairApplied).length;
  
  console.log(`Total documents: ${results.length}`);
  console.log(`Import: ${importSuccess} success, ${importFailed} failed, ${importSkipped} skipped`);
  console.log(`Verify: ${verifyPass} PASS, ${verifyFail} FAIL`);
  console.log(`Repairs applied: ${repairsApplied}`);
  
  if (verifyFail > 0) {
    console.log(`\n❌ FAIL documents:`);
    results.filter(r => r.verifyStatus === 'fail').forEach(r => {
      console.log(`  - ${r.nreg}: ${r.issues.join('; ')}`);
    });
  }
  
  if (importFailed > 0) {
    console.log(`\n❌ Import failed documents:`);
    results.filter(r => r.importStatus === 'failed').forEach(r => {
      console.log(`  - ${r.nreg}: ${r.issues.join('; ')}`);
    });
  }
  
  // KPI: category distribution
  if (!dryRun && importSuccess > 0) {
    const { createSupabaseAdminClient } = await import('../lib/supabaseAdmin.js');
    const supabase = createSupabaseAdminClient();
    const { data: categoryStats } = await supabase
      .from('legislation_documents')
      .select('category')
      .in('rada_nreg', results.filter(r => r.importStatus === 'success').map(r => r.nreg));
    
    if (categoryStats) {
      const categoryCounts = new Map<string, number>();
      categoryStats.forEach(d => {
        const cat = d.category || 'unknown';
        categoryCounts.set(cat, (categoryCounts.get(cat) || 0) + 1);
      });
      
      const otherCount = categoryCounts.get('other') || 0;
      const otherPercent = ((otherCount / importSuccess) * 100).toFixed(1);
      
      console.log(`\n📊 Category Distribution:`);
      console.log(`  Total imported: ${importSuccess}`);
      console.log(`  'other' category: ${otherCount} (${otherPercent}%)`);
      
      if (otherPercent > 15) {
        console.log(`  ⚠️  WARNING: 'other' category > 15% - taxonomy/AI may need improvement`);
      }
      
      // Top 5 categories
      const topCategories = Array.from(categoryCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);
      console.log(`  Top 5 categories:`);
      topCategories.forEach(([cat, count]) => {
        console.log(`    - ${cat}: ${count}`);
      });
    }
  }
  
  if (verifyPass === results.length && importFailed === 0) {
    console.log(`\n✅ All documents PASS`);
  } else if (verifyFail > 0 || importFailed > 0) {
    console.log(`\n⚠️  Some documents need attention`);
  }
}
