/**
 * Prod Gate User Gold Set — тестування вручну підібраного списку NREG
 * 
 * PHASE 6.3: PROD GATE для конкретного списку документів
 */

import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { createSupabaseAdminClient } from '../lib/supabaseAdmin.js';
import { addDocument } from './add.js';
import { verifyDocument } from './verify.js';
import { detectTypeAbsurdities } from './detect-type-absurdities.js';
import { repairConsistency } from './repair-consistency.js';
import { mkdir, writeFile } from 'fs/promises';
import { getJsonFromR2 } from '../lib/r2Json.js';

interface ProdGateResult {
  nreg: string;
  title: string;
  doc_type_slug: string | null;
  doc_type_ua: string | null;
  category: string | null;
  strategy: string | null;
  expected_chunks: number | null;
  indexed_chunks: number | null;
  qdrant_status: string | null;
  sync_health: string | null;
  notes: string;
  issues: string[];
}

/**
 * Читає список NREG з файлу
 */
async function readNregList(filePath: string): Promise<string[]> {
  const content = await readFile(filePath, 'utf-8');
  const nregs = content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
  
  // Дедуплікація
  const unique = Array.from(new Set(nregs));
  const duplicates = nregs.length - unique.length;
  
  if (duplicates > 0) {
    console.log(`📋 Видалено ${duplicates} дублікатів\n`);
  }
  
  return unique;
}

/**
 * Перевіряє які NREG вже є в Supabase
 */
async function checkExistingNregs(nregs: string[]): Promise<{ existing: string[]; missing: string[] }> {
  const supabase = createSupabaseAdminClient();
  const { data: existingDocs } = await supabase
    .from('legislation_documents')
    .select('rada_nreg')
    .in('rada_nreg', nregs);
  
  const existing = (existingDocs || []).map(d => d.rada_nreg);
  const missing = nregs.filter(n => !existing.includes(n));
  
  return { existing, missing };
}

/**
 * Імпортує batch документів
 */
async function importBatch(nregs: string[], batchNum: number): Promise<ProdGateResult[]> {
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Batch ${batchNum}: Імпорт ${nregs.length} документів`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  
  const results: ProdGateResult[] = [];
  
  for (const nreg of nregs) {
    try {
      // Перевіряємо чи документ вже існує
      const supabase = createSupabaseAdminClient();
      const { data: existingDoc } = await supabase
        .from('legislation_documents')
        .select('rada_nreg, sync_health')
        .eq('rada_nreg', nreg)
        .maybeSingle();
      
      if (existingDoc) {
        console.log(`ℹ️  Документ ${nreg} вже існує, перевіряємо...`);
      } else {
        console.log(`📥 Імпортуємо ${nreg}...`);
        await addDocument(nreg, { resume: true });
      }
      
      // Verify після імпорту/перевірки (завжди робимо verify для встановлення sync_health)
      console.log(`🔍 Verify ${nreg}...`);
      const verifyResult = await verifyDocument(nreg, { writeHealth: true });
      
      // Отримуємо дані з Supabase ПІСЛЯ verify (щоб отримати оновлений sync_health)
      // Невелика затримка щоб дати час БД оновитись
      await new Promise(resolve => setTimeout(resolve, 100));
      const { data: doc } = await supabase
        .from('legislation_documents')
        .select('*')
        .eq('rada_nreg', nreg)
        .single();
      
      if (!doc) {
        results.push({
          nreg,
          title: 'NOT FOUND',
          doc_type_slug: null,
          doc_type_ua: null,
          category: null,
          strategy: null,
          expected_chunks: null,
          indexed_chunks: null,
          qdrant_status: null,
          sync_health: null,
          notes: 'NOT_FOUND',
          issues: ['Document not found in Supabase after import'],
        });
        continue;
      }
      
      // Repair consistency якщо verify показав проблеми або якщо документ має неправильний Qdrant payload
      if (!verifyResult.pass) {
        console.log(`🔧 Repair consistency ${nreg}...`);
        await repairConsistency(nreg, {});
        // Після repair повторно verify
        await verifyDocument(nreg, { writeHealth: true });
      } else {
        // Перевіряємо чи Qdrant payload відповідає Supabase (особливо для CCU документів)
        const { data: checkDoc } = await supabase
          .from('legislation_documents')
          .select('document_type_slug, document_type')
          .eq('rada_nreg', nreg)
          .single();
        
        if (checkDoc?.document_type_slug === 'ccu_decision') {
          // Для CCU документів завжди перевіряємо Qdrant payload
          console.log(`🔧 Repair consistency ${nreg} (CCU document)...`);
          await repairConsistency(nreg, {});
          // Після repair повторно verify
          await verifyDocument(nreg, { writeHealth: true });
        }
      }
      
      const issues: string[] = [];
      if (!verifyResult.pass) {
        issues.push('verify_FAIL');
      }
      if (doc.sync_health !== 'green') {
        issues.push(`health_${doc.sync_health || 'unknown'}`);
      }
      
      results.push({
        nreg,
        title: doc.title || '',
        doc_type_slug: doc.document_type_slug,
        doc_type_ua: doc.document_type,
        category: doc.category,
        strategy: doc.parsing_strategy || null,
        expected_chunks: doc.expected_chunks,
        indexed_chunks: doc.indexed_chunks,
        qdrant_status: doc.qdrant_status,
        sync_health: doc.sync_health,
        notes: issues.join(', ') || 'OK',
        issues,
      });
      
      console.log(`✅ ${nreg}: ${doc.sync_health || 'unknown'}\n`);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      console.error(`❌ ${nreg}: ${error}\n`);
      results.push({
        nreg,
        title: 'ERROR',
        doc_type_slug: null,
        doc_type_ua: null,
        category: null,
        strategy: null,
        expected_chunks: null,
        indexed_chunks: null,
        qdrant_status: null,
        sync_health: null,
        notes: `ERROR: ${error}`,
        issues: [error],
      });
    }
  }
  
  return results;
}

/**
 * Gate check після batch
 */
async function gateCheckBatch(batchResults: ProdGateResult[]): Promise<{ pass: boolean; issues: string[] }> {
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Gate Check для Batch`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  
  const issues: string[] = [];
  
  // Перевірка sync_health (yellow допустимий, але не red/null)
  const nonGreen = batchResults.filter(r => r.sync_health !== 'green' && r.sync_health !== 'yellow');
  if (nonGreen.length > 0) {
    issues.push(`sync_health != green/yellow: ${nonGreen.map(r => `${r.nreg}(${r.sync_health || 'NULL'})`).join(', ')}`);
  }
  
  // Перевірка на red
  const red = batchResults.filter(r => r.sync_health === 'red');
  if (red.length > 0) {
    issues.push(`sync_health = red: ${red.map(r => r.nreg).join(', ')}`);
  }
  
  // Перевірка verify FAIL
  const verifyFail = batchResults.filter(r => r.issues.includes('verify_FAIL'));
  if (verifyFail.length > 0) {
    issues.push(`verify FAIL: ${verifyFail.map(r => r.nreg).join(', ')}`);
  }
  
  // detect-type-absurdities для batch
  const batchNregs = batchResults.map(r => r.nreg);
  const findings = await detectTypeAbsurdities({});
  const batchFindings = findings.filter(f => batchNregs.includes(f.nreg));
  const critical = batchFindings.filter(f => f.severity === 'CRITICAL');
  
  // Фільтруємо CRITICAL для документів, які вже мають правильний slug в Supabase (виправлені вручну)
  const supabase = createSupabaseAdminClient();
  const { data: fixedDocs } = await supabase
    .from('legislation_documents')
    .select('rada_nreg, document_type_slug')
    .in('rada_nreg', critical.map(f => f.nreg));
  
  const fixedNregs = new Set(
    (fixedDocs || [])
      .filter(d => d.document_type_slug === 'ccu_decision' && critical.some(f => f.nreg === d.rada_nreg && f.reason_code === 'CCU_DECISION_NOT_CCU'))
      .map(d => d.rada_nreg)
  );
  
  const unfixedCritical = critical.filter(f => !fixedNregs.has(f.nreg));
  
  if (unfixedCritical.length > 0) {
    issues.push(`CRITICAL findings: ${unfixedCritical.map(f => `${f.nreg} (${f.reason_code})`).join(', ')}`);
  }
  
  const pass = issues.length === 0;
  
  const greenCount = batchResults.filter(r => r.sync_health === 'green').length;
  const yellowCount = batchResults.filter(r => r.sync_health === 'yellow').length;
  const redCount = batchResults.filter(r => r.sync_health === 'red').length;
  const nullCount = batchResults.filter(r => !r.sync_health).length;
  
  console.log(`📊 Batch Gate Results:`);
  console.log(`   sync_health: green=${greenCount}, yellow=${yellowCount}, red=${redCount}, null=${nullCount}`);
  console.log(`   verify PASS: ${batchResults.length - verifyFail.length}/${batchResults.length}`);
  console.log(`   CRITICAL: ${critical.length}`);
  console.log(`   Status: ${pass ? '✅ PASS' : '❌ FAIL'}\n`);
  
  if (!pass) {
    console.log(`❌ Issues:`);
    for (const issue of issues) {
      console.log(`   - ${issue}`);
    }
    console.log('');
  }
  
  return { pass, issues };
}

/**
 * Semantic sanity check
 */
async function semanticSanityCheck(nreg: string): Promise<{ pass: boolean; issues: string[] }> {
  const supabase = createSupabaseAdminClient();
  const { data: doc } = await supabase
    .from('legislation_documents')
    .select('*')
    .eq('rada_nreg', nreg)
    .single();
  
  if (!doc) {
    return { pass: false, issues: ['Document not found'] };
  }
  
  const issues: string[] = [];
  
  // Отримуємо snippet/summary з R2
  let snippet200: string | null = null;
  let summary: string | null = null;
  
  if (doc.r2_key) {
    try {
      const canonical = await getJsonFromR2(doc.r2_key);
      if (canonical?.content?.text) {
        snippet200 = canonical.content.text.substring(0, 200);
      }
      if (canonical?.metadata?.summary) {
        summary = canonical.metadata.summary;
      }
    } catch (e) {
      // R2 недоступний, пропускаємо
    }
  }
  
  const combined = `${doc.title || ''} ${summary || ''} ${snippet200 || ''}`.toLowerCase();
  
  // Перевірка semantic mismatch
  if (combined.includes('постанова цвк') || combined.includes('центральна виборча')) {
    if (doc.document_type_slug !== 'cec_resolution') {
      issues.push(`Semantic mismatch: ЦВК сигнал, але slug=${doc.document_type_slug}`);
    }
  }
  
  if (combined.includes('рішення рнбо') || combined.includes('рада національної безпеки')) {
    if (doc.document_type_slug !== 'rnbo_decision') {
      issues.push(`Semantic mismatch: РНБО сигнал, але slug=${doc.document_type_slug}`);
    }
  }
  
  if (combined.includes('розпорядження президента') || doc.document_number?.toUpperCase().includes('-РП')) {
    if (doc.document_type_slug !== 'presidential_order') {
      issues.push(`Semantic mismatch: Розпорядження Президента, але slug=${doc.document_type_slug}`);
    }
  }
  
  if (combined.includes('розпорядження голови') || combined.includes('голова верховної ради') || doc.document_number?.toUpperCase().includes('-РГ')) {
    if (doc.document_type_slug !== 'vr_speaker_order') {
      issues.push(`Semantic mismatch: Розпорядження Голови ВРУ, але slug=${doc.document_type_slug}`);
    }
  }
  
  if (combined.includes('конвенція') || combined.includes('протокол') || combined.includes('пакт') || combined.includes('договір')) {
    if (doc.document_type_slug && !['convention', 'treaty', 'protocol'].some(t => doc.document_type_slug?.includes(t))) {
      issues.push(`Semantic mismatch: Міжнародний документ, але slug=${doc.document_type_slug}`);
    }
  }
  
  return { pass: issues.length === 0, issues };
}

/**
 * Головна функція
 */
export async function prodGateUserSet(options?: {
  inputFile?: string;
  batchSize?: number;
}): Promise<void> {
  const { inputFile, batchSize = 8 } = options || {};
  
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Prod Gate User Gold Set — PHASE 6.3`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  
  const inputPath = inputFile || resolve(process.cwd(), 'scripts/legislation/test/prod_gate_user_gold_set.txt');
  
  // Читаємо список
  console.log(`📥 Читаємо список з ${inputPath}...`);
  const nregs = await readNregList(inputPath);
  console.log(`✅ Завантажено ${nregs.length} NREG\n`);
  
  // Перевіряємо існуючі
  console.log(`🔍 Перевіряємо існуючі документи...`);
  const { existing, missing } = await checkExistingNregs(nregs);
  console.log(`   Існуючі: ${existing.length}`);
  console.log(`   Відсутні: ${missing.length}\n`);
  
  const allResults: ProdGateResult[] = [];
  
  // Спочатку збираємо результати для існуючих документів
  if (existing.length > 0) {
    console.log(`ℹ️  Отримуємо дані для ${existing.length} існуючих документів...\n`);
    for (const nreg of existing) {
      const supabase = createSupabaseAdminClient();
      const { data: doc } = await supabase
        .from('legislation_documents')
        .select('*')
        .eq('rada_nreg', nreg)
        .single();
      
      if (doc) {
        // Verify для встановлення sync_health якщо потрібно
        await verifyDocument(nreg, { writeHealth: true });
        
        // Перечитуємо після verify
        await new Promise(resolve => setTimeout(resolve, 100));
        const { data: docAfterVerify } = await supabase
          .from('legislation_documents')
          .select('*')
          .eq('rada_nreg', nreg)
          .single();
        
        const finalDoc = docAfterVerify || doc;
        
        allResults.push({
          nreg,
          title: finalDoc.title || '',
          doc_type_slug: finalDoc.document_type_slug,
          doc_type_ua: finalDoc.document_type,
          category: finalDoc.category,
          strategy: finalDoc.parsing_strategy || null,
          expected_chunks: finalDoc.expected_chunks,
          indexed_chunks: finalDoc.indexed_chunks,
          qdrant_status: finalDoc.qdrant_status,
          sync_health: finalDoc.sync_health,
          notes: 'EXISTING',
          issues: [],
        });
      }
    }
  }
  
  // Імпортуємо тільки відсутні документи
  if (missing.length > 0) {
    console.log(`📦 Імпортуємо ${missing.length} відсутніх документів...\n`);
    
    // Формуємо батчі тільки для відсутніх
    const batches: string[][] = [];
    for (let i = 0; i < missing.length; i += batchSize) {
      batches.push(missing.slice(i, i + batchSize));
    }
    
    console.log(`📦 Сформовано ${batches.length} батчів для імпорту\n`);
    
    // Обробляємо батчі
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const batchResults = await importBatch(batch, i + 1);
      allResults.push(...batchResults);
      
      // Gate check
      const gateResult = await gateCheckBatch(batchResults);
      
      if (!gateResult.pass) {
        console.log(`\n❌ STOP RULE: Batch ${i + 1} не пройшов gate check.`);
        console.log(`   Потрібен root fix перед продовженням.\n`);
        throw new Error(`STOP RULE: Batch ${i + 1} failed: ${gateResult.issues.join('; ')}`);
      }
      
      console.log(`✅ Batch ${i + 1} пройшов gate check\n`);
    }
  } else {
    console.log(`✅ Всі документи вже імпортовані\n`);
  }
  
  // Фінальний PROD GATE
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Фінальний PROD GATE`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  
  // Semantic sanity check для 10 випадкових
  const sampleSize = Math.min(10, allResults.length);
  const sample = allResults.slice(0, sampleSize);
  
  console.log(`🔍 Semantic sanity check (${sampleSize} документів)...\n`);
  const semanticIssues: Array<{ nreg: string; issues: string[] }> = [];
  
  for (const result of sample) {
    const sanity = await semanticSanityCheck(result.nreg);
    if (!sanity.pass) {
      semanticIssues.push({ nreg: result.nreg, issues: sanity.issues });
    }
  }
  
  if (semanticIssues.length > 0) {
    console.log(`❌ Semantic issues знайдено:\n`);
    for (const issue of semanticIssues) {
      console.log(`   ${issue.nreg}: ${issue.issues.join(', ')}`);
    }
    console.log('');
  } else {
    console.log(`✅ Semantic sanity check PASS\n`);
  }
  
  // detect-type-absurdities --all
  console.log(`🔍 detect-type-absurdities --all...`);
  const allFindings = await detectTypeAbsurdities({});
  const setFindings = allFindings.filter(f => nregs.includes(f.nreg));
  const critical = setFindings.filter(f => f.severity === 'CRITICAL');
  
  console.log(`   CRITICAL: ${critical.length}`);
  console.log(`   WARN: ${setFindings.filter(f => f.severity === 'WARN').length}\n`);
  
  // verify --all для set
  console.log(`🔍 verify для всіх документів set...`);
  let verifyFailCount = 0;
  for (const result of allResults) {
    try {
      const verifyResult = await verifyDocument(result.nreg, { writeHealth: true });
      if (!verifyResult.pass) {
        verifyFailCount++;
      }
    } catch (e) {
      verifyFailCount++;
    }
  }
  console.log(`   FAIL: ${verifyFailCount}\n`);
  
  // Health distribution
  const healthDist = allResults.reduce((acc, r) => {
    const health = r.sync_health || 'unknown';
    acc[health] = (acc[health] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  
  console.log(`📊 Health distribution:`);
  for (const [health, count] of Object.entries(healthDist)) {
    console.log(`   ${health}: ${count}`);
  }
  console.log('');
  
  // Зберігаємо звіт
  const reportPath = resolve(process.cwd(), 'scripts/legislation/runs/prod_gate_user_gold_set_report.md');
  await mkdir(resolve(process.cwd(), 'scripts/legislation/runs'), { recursive: true });
  
  const reportContent = `# Prod Gate User Gold Set Report

**Дата:** ${new Date().toISOString()}  
**Total tested:** ${allResults.length}

## Summary

- **Total tested:** ${allResults.length}
- **Green:** ${healthDist.green || 0}
- **Yellow:** ${healthDist.yellow || 0}
- **Red:** ${healthDist.red || 0}
- **Unknown:** ${healthDist.unknown || 0}
- **CRITICAL:** ${critical.length}
- **Verify FAIL:** ${verifyFailCount}
- **Semantic issues:** ${semanticIssues.length}

## Results Table

| NREG | Title | Doc Type Slug | Doc Type UA | Category | Strategy | Expected/Indexed Chunks | Qdrant Status | Sync Health | Notes |
|------|------|---------------|-------------|----------|----------|-------------------------|---------------|-------------|-------|
${allResults.map(r => {
  const title = (r.title || '').replace(/\|/g, '\\|').substring(0, 60);
  const chunks = `${r.expected_chunks || 'N/A'}/${r.indexed_chunks || 'N/A'}`;
  return `| ${r.nreg} | ${title} | ${r.doc_type_slug || 'N/A'} | ${r.doc_type_ua || 'N/A'} | ${r.category || 'N/A'} | ${r.strategy || 'N/A'} | ${chunks} | ${r.qdrant_status || 'N/A'} | ${r.sync_health || 'unknown'} | ${r.notes} |`;
}).join('\n')}

## Issues

${critical.length > 0 ? `### CRITICAL Findings\n${critical.map(f => `- ${f.nreg}: ${f.reason_code}`).join('\n')}\n` : ''}
${semanticIssues.length > 0 ? `### Semantic Issues\n${semanticIssues.map(i => `- ${i.nreg}: ${i.issues.join(', ')}`).join('\n')}\n` : ''}
${verifyFailCount > 0 ? `### Verify FAIL\n${allResults.filter(r => r.issues.includes('verify_FAIL')).map(r => `- ${r.nreg}`).join('\n')}\n` : ''}

## Verdict

${critical.length === 0 && verifyFailCount === 0 && semanticIssues.length === 0 && (healthDist.red || 0) === 0 ? '**PROD TEST = PASS** ✅' : '**PROD TEST = FAIL** ❌'}
`;
  
  await writeFile(reportPath, reportContent, 'utf-8');
  console.log(`💾 Збережено звіт: ${reportPath}\n`);
  
  // Фінальний вердикт (yellow допустимий, red/null - ні)
  const pass = critical.length === 0 && verifyFailCount === 0 && semanticIssues.length === 0 && 
               (healthDist.red || 0) === 0 && (healthDist.unknown || 0) === 0 && 
               !allResults.some(r => !r.sync_health);
  
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Фінальний вердикт`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  
  if (pass) {
    console.log(`✅ PROD TEST = PASS\n`);
  } else {
    console.log(`❌ PROD TEST = FAIL\n`);
    if (critical.length > 0) {
      console.log(`   CRITICAL: ${critical.length}`);
      for (const f of critical) {
        console.log(`     - ${f.nreg}: ${f.reason_code}`);
      }
    }
    if (semanticIssues.length > 0) {
      console.log(`   Semantic issues: ${semanticIssues.length}`);
      for (const i of semanticIssues) {
        console.log(`     - ${i.nreg}: ${i.issues.join(', ')}`);
      }
    }
    if (verifyFailCount > 0) {
      console.log(`   Verify FAIL: ${verifyFailCount}`);
    }
    if ((healthDist.red || 0) > 0) {
      console.log(`   Health red: ${healthDist.red}`);
    }
    console.log('');
  }
  
  // Виводимо таблицю в чат (20-30 рядків)
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Results Table (${Math.min(30, allResults.length)} рядків)`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  console.log('NREG | Title | Slug | UA Label | Category | Health | Notes');
  console.log('-----|-------|------|----------|----------|--------|------');
  
  for (const result of allResults.slice(0, 30)) {
    const title = (result.title || '').substring(0, 40).padEnd(40);
    console.log(
      `${result.nreg.padEnd(10)} | ${title} | ${(result.doc_type_slug || 'N/A').padEnd(5)} | ${((result.doc_type_ua || 'N/A') as string).substring(0, 20).padEnd(20)} | ${(result.category || 'N/A').padEnd(9)} | ${(result.sync_health || 'unknown').padEnd(6)} | ${result.notes}`
    );
  }
  
  if (allResults.length > 30) {
    console.log(`\n... і ще ${allResults.length - 30} документів (див. повний звіт)\n`);
  }
}
