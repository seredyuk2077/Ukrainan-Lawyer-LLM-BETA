#!/usr/bin/env node
/**
 * Analyze Manual Audit — автоматичний аналіз semantic correctness
 * 
 * Для кожного документа порівнює:
 * - canonical topBlock (1200 chars) з document_type_slug + document_type
 * - визначає KIND (постанова/наказ/рішення/указ/конвенція/тощо)
 * - визначає ISSUER (КМУ/ВРУ/Президент/НБУ/НКРЕКП/КСУ/міністерство/прокуратура/тощо)
 * - перевіряє, чи document_type_slug відповідає KIND+ISSUER
 */

import { createSupabaseAdminClient } from '../lib/supabaseAdmin.js';
import { getJsonFromR2 } from '../lib/r2Json.js';
import { enrichDocumentType } from '../lib/documentTypeEnrichment.js';
// Використовуємо просту нормалізацію для аналізу
function normalizeText(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/[^\u0400-\u04FF\s]/g, '')
    .toUpperCase()
    .trim();
}
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPORT_PATH = path.join(__dirname, '../../runs/manual_audit_analysis.md');

interface Mismatch {
  nreg: string;
  dokid: number | null;
  title: string;
  current_slug: string;
  current_label: string;
  canonical_topBlock: string;
  detected_kind: string;
  detected_issuer: string;
  expected_slug: string;
  expected_label: string;
  issue: string;
}

function detectKindAndIssuer(topBlock: string): { kind: string; issuer: string } {
  const normalized = normalizeText(topBlock);
  const upper = topBlock.toUpperCase();

  // KIND detection
  let kind = 'UNKNOWN';
  if (normalized.includes('ПОСТАНОВА')) kind = 'RESOLUTION';
  else if (normalized.includes('РОЗПОРЯДЖЕННЯ') || normalized.includes('РОЗПОРЯДЖЕННЯ')) kind = 'ORDER';
  else if (normalized.includes('НАКАЗ')) kind = 'ORDER';
  else if (normalized.includes('ДЕКРЕТ')) kind = 'DECREE';
  else if (normalized.includes('УКАЗ')) kind = 'DECREE';
  else if (normalized.includes('РІШЕННЯ')) kind = 'DECISION';
  else if (normalized.includes('КОНВЕНЦІЯ')) kind = 'CONVENTION';
  else if (normalized.includes('УГОДА')) kind = 'AGREEMENT';
  else if (normalized.includes('ПРОТОКОЛ')) kind = 'PROTOCOL';
  else if (normalized.includes('ДИРЕКТИВА')) kind = 'DIRECTIVE';
  else if (normalized.includes('РЕГЛАМЕНТ')) kind = 'REGULATION';
  else if (normalized.includes('КОДЕКС')) kind = 'CODE';
  else if (normalized.includes('ЗАКОН')) kind = 'LAW';
  else if (normalized.includes('РОЗ') && normalized.includes('ЯСНЕННЯ')) kind = 'EXPLANATION';

  // ISSUER detection (перевіряємо перші 400 символів)
  const prefix400 = upper.substring(0, 400);
  let issuer = 'UNKNOWN';
  
  if (prefix400.includes('КАБІНЕТ МІНІСТРІВ') || prefix400.includes('КАБІНЕТУ МІНІСТРІВ')) issuer = 'CMU';
  else if (prefix400.includes('ВЕРХОВНА РАДА') || prefix400.includes('ВЕРХОВНОЇ РАДИ')) issuer = 'VRU';
  else if (prefix400.includes('ПРЕЗИДЕНТ') && prefix400.includes('УКРАЇНИ')) issuer = 'PRESIDENT';
  else if (prefix400.includes('КОНСТИТУЦІЙНИЙ СУД') || prefix400.includes('КСУ')) issuer = 'CCU';
  else if (prefix400.includes('НАЦІОНАЛЬНИЙ БАНК') || prefix400.includes('НБУ') || prefix400.includes('ПРАВЛІННЯ НАЦІОНАЛЬНОГО БАНКУ')) issuer = 'NBU';
  else if (prefix400.includes('НАЦІОНАЛЬНА КОМІСІЯ') && (prefix400.includes('ЕНЕРГЕТИКИ') || prefix400.includes('НКРЕКП'))) issuer = 'NERC';
  else if (prefix400.includes('ЄВРОПЕЙСЬКИЙ ПАРЛАМЕНТ') || prefix400.includes('ЄВРОПЕЙСЬКОГО ПАРЛАМЕНТУ')) issuer = 'EU_PARLIAMENT';
  else if (prefix400.includes('ГЕНЕРАЛЬНА ПРОКУРАТУРА') || prefix400.includes('ПРОКУРАТУРА УКРАЇНИ')) issuer = 'PROSECUTOR';
  else if (prefix400.includes('МІНІСТЕРСТВО') || prefix400.includes('ДЕРЖАВНИЙ КОМІТЕТ') || prefix400.includes('СЛУЖБА') || prefix400.includes('АДМІНІСТРАЦІЯ') || prefix400.includes('АГЕНТСТВО') || prefix400.includes('ІНСПЕКЦІЯ')) issuer = 'MINISTRY';
  else if (prefix400.includes('ОРГАНІЗАЦІЯ ОБ') || prefix400.includes('ООН')) issuer = 'UN';
  else if (prefix400.includes('МІЖНАРОДНИЙ')) issuer = 'INTERNATIONAL';

  return { kind, issuer };
}

function getExpectedSlug(kind: string, issuer: string, document_number?: string | null): string {
  // Suffix rules (найвищий пріоритет)
  if (document_number) {
    if (document_number.endsWith('-РП')) return 'presidential_order';
    if (document_number.endsWith('-РГ')) return 'vr_speaker_order';
    if (document_number.match(/^z\d{4}-\d{2}$/)) return 'minister_order';
    if (document_number.match(/^v\d+p\d+-\d{2}$/)) return 'ccu_decision';
    if (document_number.match(/^v0\d+p\d+-\d{2}$/)) {
      // Може бути CCU або інше
      if (issuer === 'CCU') return 'ccu_decision';
    }
    if (document_number.match(/^984_011-/)) {
      if (kind === 'DIRECTIVE') return 'eu_directive';
      if (kind === 'REGULATION') return 'eu_regulation';
    }
    if (document_number.match(/^984_006-/)) return 'eu_regulation';
    if (document_number.match(/^995_/)) {
      if (kind === 'CONVENTION') return 'convention';
      if (kind === 'AGREEMENT') return 'agreement';
      if (kind === 'PROTOCOL') return 'protocol';
    }
  }

  // KIND + ISSUER rules
  if (kind === 'RESOLUTION') {
    if (issuer === 'CMU') return 'cmu_resolution';
    if (issuer === 'VRU') return 'vr_resolution';
    if (issuer === 'NBU') return 'nbu_resolution';
    if (issuer === 'NERC') return 'nerc_resolution';
    return 'cmu_resolution'; // fallback
  }
  if (kind === 'ORDER') {
    if (issuer === 'CMU') return 'cmu_order';
    if (issuer === 'PRESIDENT') return 'presidential_order';
    if (issuer === 'MINISTRY' || issuer === 'PROSECUTOR') return 'minister_order';
    return 'minister_order'; // fallback
  }
  if (kind === 'DECREE') {
    if (issuer === 'CMU') return 'cmu_decree';
    if (issuer === 'PRESIDENT') return 'presidential_decree';
    return 'presidential_decree'; // fallback
  }
  if (kind === 'DECISION') {
    if (issuer === 'CCU') return 'ccu_decision';
    return 'ccu_decision'; // fallback
  }
  if (kind === 'EXPLANATION') {
    if (issuer === 'MINISTRY') return 'minister_explanation';
    return 'minister_explanation';
  }
  if (kind === 'CONVENTION') return 'convention';
  if (kind === 'AGREEMENT') return 'agreement';
  if (kind === 'PROTOCOL') return 'protocol';
  if (kind === 'DIRECTIVE' && issuer === 'EU_PARLIAMENT') return 'eu_directive';
  if (kind === 'REGULATION' && issuer === 'EU_PARLIAMENT') return 'eu_regulation';
  if (kind === 'CODE') return 'code';
  if (kind === 'LAW') return 'law';

  return 'unknown';
}

export async function analyzeManualAudit(options: { nonCmu?: boolean }): Promise<void> {
  const supabase = createSupabaseAdminClient();
  
  let nregs: string[] = [];
  
  if (options.nonCmu) {
    const { data, error } = await supabase
      .from('legislation_documents')
      .select('rada_nreg, document_type_slug, document_number')
      .order('rada_datred', { ascending: true, nullsLast: true });
    
    if (error || !data) {
      console.error('❌ Failed to fetch documents:', error?.message);
      return;
    }

    const nonCmu = data.filter(d => 
      d.document_type_slug !== 'cmu_resolution' && 
      d.document_type_slug !== 'cmu_order' && 
      d.document_type_slug !== 'cmu_decree'
    );
    nregs = nonCmu.map(d => d.rada_nreg);
  }

  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`🔍 Автоматичний аналіз semantic correctness: ${nregs.length} документів`);
  console.log(`═══════════════════════════════════════════════════════════\n`);

  const mismatches: Mismatch[] = [];

  for (let i = 0; i < nregs.length; i++) {
    const nreg = nregs[i];
    if (i % 10 === 0) {
      console.log(`[${i + 1}/${nregs.length}] Перевірка...`);
    }

    try {
      const { data: doc } = await supabase
        .from('legislation_documents')
        .select('*')
        .eq('rada_nreg', nreg)
        .maybeSingle();

      if (!doc || !doc.r2_key) continue;

      const canonical = await getJsonFromR2(doc.r2_key);
      let topBlock: string | null = null;
      
      if (canonical.raw?.rada_api_txt) {
        topBlock = canonical.raw.rada_api_txt.substring(0, 1200);
      } else if (canonical.content?.chunks?.[0]?.text) {
        topBlock = canonical.content.chunks[0].text.substring(0, 1200);
      }

      if (!topBlock) continue;

      const { kind, issuer } = detectKindAndIssuer(topBlock);
      const expectedSlug = getExpectedSlug(kind, issuer, doc.document_number);
      const currentSlug = doc.document_type_slug || 'unknown';

      // Перевірка на mismatch
      if (currentSlug !== expectedSlug && expectedSlug !== 'unknown') {
        // Додаткові перевірки для edge cases
        let isMismatch = true;
        
        // Накази прокуратури можуть бути minister_order (технічно правильно)
        if (currentSlug === 'minister_order' && issuer === 'PROSECUTOR' && kind === 'ORDER') {
          isMismatch = false; // Технічно правильно, хоча label може бути неінформативним
        }

        if (isMismatch) {
          mismatches.push({
            nreg,
            dokid: doc.rada_dokid,
            title: doc.title || '',
            current_slug: currentSlug,
            current_label: doc.document_type || '',
            canonical_topBlock: topBlock.substring(0, 300),
            detected_kind: kind,
            detected_issuer: issuer,
            expected_slug: expectedSlug,
            expected_label: '', // Буде заповнено з taxonomy
            issue: `Canonical topBlock: ${kind} від ${issuer}, але в БД: ${currentSlug}`,
          });
        }
      }
    } catch (error) {
      console.error(`❌ Помилка при обробці ${nreg}:`, error);
    }
  }

  // Генерація звіту
  const reportDir = path.dirname(REPORT_PATH);
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }

  let report = `# Manual Audit Analysis — Semantic Correctness\n\n`;
  report += `**Дата:** ${new Date().toISOString()}\n`;
  report += `**Перевірено документів:** ${nregs.length}\n`;
  report += `**Знайдено mismatches:** ${mismatches.length}\n\n`;

  if (mismatches.length === 0) {
    report += `✅ **Всі документи мають правильну класифікацію!**\n\n`;
  } else {
    report += `## Mismatches\n\n`;
    report += `| NREG | Title | Current | Expected | Kind | Issuer | Issue |\n`;
    report += `|------|-------|--------|----------|------|--------|-------|\n`;
    
    for (const m of mismatches) {
      report += `| ${m.nreg} | ${m.title.substring(0, 50)}... | ${m.current_slug} | ${m.expected_slug} | ${m.detected_kind} | ${m.detected_issuer} | ${m.issue} |\n`;
    }

    report += `\n## Деталі\n\n`;
    for (const m of mismatches) {
      report += `### ${m.nreg}\n\n`;
      report += `- **Title:** ${m.title}\n`;
      report += `- **Current:** ${m.current_slug} / ${m.current_label}\n`;
      report += `- **Expected:** ${m.expected_slug}\n`;
      report += `- **Detected:** ${m.detected_kind} від ${m.detected_issuer}\n`;
      report += `- **Canonical topBlock (300 chars):**\n\`\`\`\n${m.canonical_topBlock}\n\`\`\`\n\n`;
    }
  }

  fs.writeFileSync(REPORT_PATH, report);
  console.log(`\n✅ Аналіз завершено. Знайдено ${mismatches.length} mismatches.`);
  console.log(`📄 Звіт: ${REPORT_PATH}`);
  
  if (mismatches.length > 0) {
    console.log(`\n⚠️  Знайдено mismatches! Перевір звіт для деталей.`);
  }
}
