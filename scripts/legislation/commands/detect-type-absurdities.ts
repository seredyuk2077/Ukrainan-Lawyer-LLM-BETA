/**
 * Detect Type Absurdities — системний детектор абсурдних класифікацій document_type
 * 
 * PHASE 1: Self-correcting система для виявлення semantic mismatches
 */

import { createSupabaseAdminClient } from '../lib/supabaseAdmin.js';
import { getJsonFromR2 } from '../lib/r2Json.js';
import { DocumentTypeSlug } from '../documentTypes/documentTypes.js';

export interface AbsurdityFinding {
  nreg: string;
  dokid?: number;
  severity: 'CRITICAL' | 'WARN';
  reason_code: string;
  current_slug: DocumentTypeSlug | null;
  current_ua_label: string | null;
  suggested_slug?: DocumentTypeSlug;
  evidence: {
    title: string;
    summary_prefix?: string;
    snippet200?: string;
    typ?: number | null;
    organs?: any;
  };
}

/**
 * Ruleset абсурдності (10+ правил)
 */
export function detectAbsurdities(params: {
  title: string;
  summary?: string | null;
  snippet?: string | null;
  typ?: number | null;
  organs?: any;
  current_slug: DocumentTypeSlug | null;
  current_ua_label: string | null;
  document_number?: string | null;  // Для nreg suffix check
}): AbsurdityFinding[] {
  const findings: AbsurdityFinding[] = [];
  const { title, summary, snippet, typ, organs, current_slug, current_ua_label } = params;
  
  const lowerTitle = title.toLowerCase();
  const lowerSummary = (summary || '').toLowerCase();
  const lowerSnippet = (snippet || '').toLowerCase();
  const combined = `${lowerTitle} ${lowerSummary} ${lowerSnippet}`;
  
  // A) RNBO decision (КРИТИЧНЕ: має найвищий пріоритет)
  if (combined.includes('рада національної безпеки') || 
      combined.includes('ради національної безпеки') ||
      combined.includes('рнбо') ||
      combined.includes('рішення рнбо') ||
      combined.includes('рішення ради національної')) {
    // Виняток: "Указ про введення в дію рішення РНБО" → presidential_decree OK
    if (combined.includes('указ про введення в дію') || combined.includes('указом президента')) {
      // Це указ про введення в дію рішення РНБО → presidential_decree правильний
      if (current_slug !== 'presidential_decree') {
        findings.push({
          nreg: '',
          severity: 'CRITICAL',
          reason_code: 'RNBO_AS_LAW',
          current_slug,
          current_ua_label,
          suggested_slug: 'presidential_decree',
          evidence: { title, summary_prefix: summary?.substring(0, 120), snippet200: snippet?.substring(0, 200), typ, organs },
        });
      }
    } else if (current_slug === 'law' || current_slug === 'code') {
      findings.push({
        nreg: '', // буде заповнено пізніше
        severity: 'CRITICAL',
        reason_code: 'RNBO_AS_LAW',
        current_slug,
        current_ua_label,
        suggested_slug: 'rnbo_decision',
        evidence: { title, summary_prefix: summary?.substring(0, 120), snippet200: snippet?.substring(0, 200), typ, organs },
      });
    } else if (current_slug !== 'rnbo_decision') {
      findings.push({
        nreg: '',
        severity: 'CRITICAL',
        reason_code: 'RNBO_NOT_RNBO_DECISION',
        current_slug,
        current_ua_label,
        suggested_slug: 'rnbo_decision',
        evidence: { title, summary_prefix: summary?.substring(0, 120), snippet200: snippet?.substring(0, 200), typ, organs },
      });
    }
  }
  
  // B) NBU
  if (combined.includes('національний банк') || 
      combined.includes('нбу') ||
      combined.includes('правління нбу')) {
    if (current_slug === 'law' || current_slug === 'code' || current_slug === 'cmu_resolution') {
      findings.push({
        nreg: '',
        severity: 'CRITICAL',
        reason_code: 'NBU_AS_LAW',
        current_slug,
        current_ua_label,
        suggested_slug: combined.includes('повідомлення') || combined.includes('лист') ? 'nbu_letter' : 'nbu_resolution',
        evidence: { title, summary_prefix: summary?.substring(0, 120), snippet200: snippet?.substring(0, 200), typ, organs },
      });
    } else if (!current_slug?.startsWith('nbu_')) {
      findings.push({
        nreg: '',
        severity: 'WARN',
        reason_code: 'NBU_NOT_NBU_TYPE',
        current_slug,
        current_ua_label,
        suggested_slug: combined.includes('повідомлення') || combined.includes('лист') ? 'nbu_letter' : 'nbu_resolution',
        evidence: { title, summary_prefix: summary?.substring(0, 120), snippet200: snippet?.substring(0, 200), typ, organs },
      });
    }
  }
  
  // C) CEC/ЦВК
  if (combined.includes('цвк') || 
      combined.includes('центральна виборча') ||
      combined.includes('центральної виборчої')) {
    if (current_slug === 'cmu_resolution' || current_slug === 'vr_resolution') {
      findings.push({
        nreg: '',
        severity: 'CRITICAL',
        reason_code: 'CEC_AS_CMU',
        current_slug,
        current_ua_label,
        suggested_slug: 'cec_resolution',
        evidence: { title, summary_prefix: summary?.substring(0, 120), snippet200: snippet?.substring(0, 200), typ, organs },
      });
    } else if (current_slug !== 'cec_resolution') {
      findings.push({
        nreg: '',
        severity: 'WARN',
        reason_code: 'CEC_NOT_CEC_RESOLUTION',
        current_slug,
        current_ua_label,
        suggested_slug: 'cec_resolution',
        evidence: { title, summary_prefix: summary?.substring(0, 120), snippet200: snippet?.substring(0, 200), typ, organs },
      });
    }
  }
  
  // D) Президент
  if ((combined.includes('указ') && combined.includes('президент')) ||
      (combined.includes('розпорядження') && combined.includes('президент'))) {
    if (current_slug === 'regulation' || current_slug === 'law' || current_slug === 'code') {
      findings.push({
        nreg: '',
        severity: 'CRITICAL',
        reason_code: 'PRESIDENT_AS_REGULATION',
        current_slug,
        current_ua_label,
        suggested_slug: combined.includes('указ') ? 'presidential_decree' : 'presidential_order',
        evidence: { title, summary_prefix: summary?.substring(0, 120), snippet200: snippet?.substring(0, 200), typ, organs },
      });
    }
  }
  
  // E) КМУ
  if (combined.includes('кабінет міністрів') || 
      combined.includes('кму') ||
      (combined.includes('постанова') && combined.includes('кму'))) {
    if (current_slug === 'law' || current_slug === 'nbu_letter') {
      findings.push({
        nreg: '',
        severity: 'CRITICAL',
        reason_code: 'CMU_AS_LAW',
        current_slug,
        current_ua_label,
        suggested_slug: combined.includes('розпорядження') ? 'cmu_order' : 'cmu_resolution',
        evidence: { title, summary_prefix: summary?.substring(0, 120), snippet200: snippet?.substring(0, 200), typ, organs },
      });
    }
  }
  
  // F) ВРУ
  if (combined.includes('верховна рада') || 
      combined.includes('вр ') ||
      (combined.includes('постанова') && combined.includes('верховна'))) {
    if (current_slug === 'cmu_resolution') {
      findings.push({
        nreg: '',
        severity: 'CRITICAL',
        reason_code: 'VRU_AS_CMU',
        current_slug,
        current_ua_label,
        suggested_slug: 'vr_resolution',
        evidence: { title, summary_prefix: summary?.substring(0, 120), snippet200: snippet?.substring(0, 200), typ, organs },
      });
    }
  }
  
  // G) Судові думки
  if (combined.includes('окрема думка') || 
      (combined.includes('судді') && combined.includes('конституційного суду'))) {
    // ВИНЯТОК: якщо slug=ccu_opinion і є сигнали "окрема думка" + "Конституційного Суду" → це правильна класифікація, НЕ CRITICAL
    if (current_slug === 'ccu_opinion' && 
        (combined.includes('окрема думка') || combined.includes('окрема думка судді')) &&
        (combined.includes('конституційного суду') || combined.includes('ксу') || combined.includes('конституційний суд'))) {
      // Це правильна класифікація "окрема думка" → ccu_opinion, НЕ CRITICAL
      // Можливо WARN якщо є "рішення" в title, але це не CRITICAL
      if (combined.includes('рішення') && !combined.includes('щодо рішення')) {
        // Якщо title містить "рішення" але це "окрема думка щодо рішення" → це все одно opinion
        // Тільки якщо це явно "Рішення КСУ" без "окрема думка" → тоді має бути ccu_decision
        // Але якщо slug=ccu_opinion і є "окрема думка" → це правильна класифікація
        // НЕ додаємо finding
      }
    } else if (current_slug === 'code' || current_slug === 'law') {
      findings.push({
        nreg: '',
        severity: 'CRITICAL',
        reason_code: 'COURT_OPINION_AS_CODE',
        current_slug,
        current_ua_label,
        suggested_slug: combined.includes('конституційного суду') ? 'ccu_opinion' : 'court_opinion',
        evidence: { title, summary_prefix: summary?.substring(0, 120), snippet200: snippet?.substring(0, 200), typ, organs },
      });
    } else if (current_slug === 'ccu_opinion' && combined.includes('рішення') && !combined.includes('окрема думка')) {
      // Якщо slug=ccu_opinion але немає "окрема думка" і є "рішення" → можливо має бути ccu_decision
      // Але це не CRITICAL, бо може бути "окрема думка щодо рішення"
      // Тільки якщо явно "Рішення КСУ" без "окрема думка"
      if (combined.includes('рішення') && combined.includes('ксу') && !combined.includes('окрема думка')) {
        findings.push({
          nreg: '',
          severity: 'WARN',
          reason_code: 'CCU_DECISION_NOT_CCU',
          current_slug,
          current_ua_label,
          suggested_slug: 'ccu_decision',
          evidence: { title, summary_prefix: summary?.substring(0, 120), snippet200: snippet?.substring(0, 200), typ, organs },
        });
      }
    }
  }
  
  // H) Міжнародні договори
  if (combined.includes('конвенція') || 
      combined.includes('протокол') ||
      combined.includes('договір') ||
      combined.includes('пакт') ||
      combined.includes('статут')) {
    if (current_slug === 'law' || current_slug === 'cmu_resolution') {
      // Перевіряємо чи це не ВРУ (ВРУ може приймати закони про ратифікацію)
      if (!combined.includes('верховна рада') && !combined.includes('закон про ратифікацію')) {
        findings.push({
          nreg: '',
          severity: 'WARN',
          reason_code: 'TREATY_AS_LAW',
          current_slug,
          current_ua_label,
          suggested_slug: combined.includes('конвенція') ? 'convention' : 'international_treaty',
          evidence: { title, summary_prefix: summary?.substring(0, 120), snippet200: snippet?.substring(0, 200), typ, organs },
        });
      }
    }
  }
  
  // I) Положення/Порядок/Інструкція
  if (combined.includes('положення') || 
      combined.includes('порядок') ||
      combined.includes('інструкція')) {
    if (current_slug === 'law' && !combined.includes('закон про затвердження')) {
      findings.push({
        nreg: '',
        severity: 'WARN',
        reason_code: 'REGULATION_AS_LAW',
        current_slug,
        current_ua_label,
        suggested_slug: 'regulation',
        evidence: { title, summary_prefix: summary?.substring(0, 120), snippet200: snippet?.substring(0, 200), typ, organs },
      });
    }
  }
  
  // J) Розпорядження Голови ВРУ (КРИТИЧНЕ: має найвищий пріоритет)
  // Нормалізуємо snippet для перевірки prefix
  const normalizePrefix = (text: string | null | undefined): string => {
    if (!text) return '';
    return text
      .trim()
      .toUpperCase()
      .replace(/\s+/g, ' ')
      .replace(/[\n\t\r]/g, ' ')
      .replace(/["'«»]/g, '')
      .substring(0, 200);
  };
  
  const normalizedSnippet = normalizePrefix(snippet || title);
  const normalizedTitle = normalizePrefix(title);
  
  // Правило 1: Prefix-based (найнадійніше)
  if ((normalizedSnippet.includes('РОЗПОРЯДЖЕННЯ') && 
       normalizedSnippet.includes('ГОЛОВИ') && 
       (normalizedSnippet.includes('ВЕРХОВНОЇ РАДИ') || normalizedSnippet.includes('ВРУ'))) ||
      (normalizedTitle.includes('РОЗПОРЯДЖЕННЯ') && 
       normalizedTitle.includes('ГОЛОВИ') && 
       (normalizedTitle.includes('ВЕРХОВНОЇ РАДИ') || normalizedTitle.includes('ВРУ')))) {
    if (current_slug !== 'vr_speaker_order') {
      findings.push({
        nreg: '',
        severity: 'CRITICAL',
        reason_code: 'VR_SPEAKER_ORDER_PREFIX',
        current_slug,
        current_ua_label,
        suggested_slug: 'vr_speaker_order',
        evidence: { title, summary_prefix: summary?.substring(0, 120), snippet200: snippet?.substring(0, 200), typ, organs },
      });
    }
  }
  
  // Правило 2: UA label = "Положення" але snippet починається з "РОЗПОРЯДЖЕННЯ"
  if (normalizedSnippet.startsWith('РОЗПОРЯДЖЕННЯ') || normalizedSnippet.includes('РОЗПОРЯДЖЕННЯ ГОЛОВИ')) {
    if (current_ua_label === 'Положення' || current_slug === 'regulation') {
      // Перевіряємо чи це не просто "Положення про розпорядження"
      if (normalizedSnippet.includes('ГОЛОВИ') && (normalizedSnippet.includes('ВЕРХОВНОЇ') || normalizedSnippet.includes('ВРУ'))) {
        findings.push({
          nreg: '',
          severity: 'CRITICAL',
          reason_code: 'VR_SPEAKER_ORDER_AS_REGULATION',
          current_slug,
          current_ua_label,
          suggested_slug: 'vr_speaker_order',
          evidence: { title, summary_prefix: summary?.substring(0, 120), snippet200: snippet?.substring(0, 200), typ, organs },
        });
      }
    }
  }
  
  // Правило 3: document_number має суфікс -РГ (case-insensitive)
  if (params.document_number) {
    const normalizedNreg = params.document_number.toUpperCase().trim();
    if (normalizedNreg.endsWith('-РГ') || normalizedNreg.endsWith('-РГ')) {
      if (current_slug !== 'vr_speaker_order') {
        // Додаткова перевірка: чи title/snippet підтверджує
        if (normalizedSnippet.includes('РОЗПОРЯДЖЕННЯ') || normalizedTitle.includes('РОЗПОРЯДЖЕННЯ')) {
          findings.push({
            nreg: '',
            severity: 'CRITICAL',
            reason_code: 'VR_SPEAKER_ORDER_NREG_SUFFIX',
            current_slug,
            current_ua_label,
            suggested_slug: 'vr_speaker_order',
            evidence: { title, summary_prefix: summary?.substring(0, 120), snippet200: snippet?.substring(0, 200), typ, organs },
          });
        }
      }
    }
  }
  
  // J) Рішення без органу (деталізація)
  if (combined.includes('рішення')) {
    if (combined.includes('рнбо') && current_slug !== 'rnbo_decision' && current_slug !== 'presidential_decree') {
      findings.push({
        nreg: '',
        severity: 'CRITICAL',
        reason_code: 'RNBO_DECISION_NOT_RNBO',
        current_slug,
        current_ua_label,
        suggested_slug: 'rnbo_decision',
        evidence: { title, summary_prefix: summary?.substring(0, 120), snippet200: snippet?.substring(0, 200), typ, organs },
      });
    } else if (combined.includes('конституційного суду') || combined.includes('ксу')) {
      // ВИНЯТОК: якщо це "окрема думка щодо рішення" → ccu_opinion правильний
      if (combined.includes('окрема думка') && current_slug === 'ccu_opinion') {
        // Це правильна класифікація "окрема думка" → ccu_opinion, НЕ CRITICAL
        // НЕ додаємо finding
      } else if (combined.includes('рішення') && !combined.includes('окрема думка') && current_slug !== 'ccu_decision') {
        // Якщо це "Рішення КСУ" (не "окрема думка") → має бути ccu_decision
        findings.push({
          nreg: '',
          severity: 'CRITICAL',
          reason_code: 'CCU_DECISION_NOT_CCU',
          current_slug,
          current_ua_label,
          suggested_slug: 'ccu_decision',
          evidence: { title, summary_prefix: summary?.substring(0, 120), snippet200: snippet?.substring(0, 200), typ, organs },
        });
      } else if (current_slug === 'ccu_opinion' && combined.includes('рішення') && !combined.includes('окрема думка')) {
        // Якщо slug=ccu_opinion але немає "окрема думка" і є "рішення" → можливо має бути ccu_decision
        // Але це не CRITICAL, бо може бути "окрема думка щодо рішення" (перевірка вже вище)
        // Тільки якщо явно "Рішення КСУ" без "окрема думка"
        if (combined.includes('рішення') && combined.includes('ксу') && !combined.includes('окрема думка') && !combined.includes('щодо')) {
          findings.push({
            nreg: '',
            severity: 'WARN',
            reason_code: 'CCU_DECISION_NOT_CCU',
            current_slug,
            current_ua_label,
            suggested_slug: 'ccu_decision',
            evidence: { title, summary_prefix: summary?.substring(0, 120), snippet200: snippet?.substring(0, 200), typ, organs },
          });
        }
      }
    } else if (combined.includes('нбу') && combined.includes('рішення') && current_slug !== 'nbu_resolution') {
      findings.push({
        nreg: '',
        severity: 'WARN',
        reason_code: 'NBU_DECISION_NOT_NBU',
        current_slug,
        current_ua_label,
        suggested_slug: 'nbu_resolution',
        evidence: { title, summary_prefix: summary?.substring(0, 120), snippet200: snippet?.substring(0, 200), typ, organs },
      });
    }
  }
  
  return findings;
}

export async function detectTypeAbsurdities(options?: {
  limit?: number;
  onlyRed?: boolean;
}): Promise<AbsurdityFinding[]> {
  const { limit, onlyRed } = options || {};
  const supabase = createSupabaseAdminClient();
  
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Detect Type Absurdities${onlyRed ? ' (CRITICAL only)' : ''}`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  
  // Отримуємо документи
  let query = supabase
    .from('legislation_documents')
    .select('rada_nreg, rada_dokid, title, document_type_slug, document_type, summary, r2_key, document_number')
    .order('rada_nreg');
  
  if (limit) {
    query = query.limit(limit);
  }
  
  const { data: docs, error } = await query;
  if (error) throw new Error(`Supabase query error: ${error.message}`);
  if (!docs || docs.length === 0) {
    return [];
  }
  
  console.log(`Processing ${docs.length} documents...\n`);
  
  const allFindings: AbsurdityFinding[] = [];
  
  for (const doc of docs) {
    try {
      // Отримуємо snippet з R2
      let snippet: string | null = null;
      let jsonData: any = null;
      
      try {
        if (doc.r2_key) {
          const canonical = await getJsonFromR2(doc.r2_key);
          jsonData = canonical.raw?.rada_api_json || null;
          
          if (canonical.content?.chunks?.[0]?.text) {
            snippet = canonical.content.chunks[0].text.substring(0, 200);
          } else if (canonical.raw?.rada_api_txt) {
            snippet = canonical.raw.rada_api_txt.substring(0, 200);
          }
        }
      } catch (e) {
        // Пропускаємо якщо не вдалося прочитати R2
      }
      
      // Детектуємо абсурди
      const findings = detectAbsurdities({
        title: doc.title,
        summary: doc.summary as string | null,
        snippet: snippet,
        typ: jsonData?.typ || null,
        organs: jsonData?.organs || null,
        current_slug: doc.document_type_slug as DocumentTypeSlug | null,
        current_ua_label: doc.document_type as string | null,
        document_number: (doc as any).document_number || doc.rada_nreg || null,  // Для nreg suffix check
      });
      
      // Заповнюємо nreg/dokid
      for (const finding of findings) {
        finding.nreg = doc.rada_nreg;
        finding.dokid = doc.rada_dokid || undefined;
        
        // Фільтр по severity якщо потрібно
        if (!onlyRed || finding.severity === 'CRITICAL') {
          allFindings.push(finding);
        }
      }
    } catch (e: any) {
      console.warn(`⚠️  Error processing ${doc.rada_nreg}: ${e.message}`);
    }
  }
  
  // Сортуємо: CRITICAL спочатку, потім по reason_code
  allFindings.sort((a, b) => {
    if (a.severity !== b.severity) {
      return a.severity === 'CRITICAL' ? -1 : 1;
    }
    return a.reason_code.localeCompare(b.reason_code);
  });
  
  // Виводимо топ-20 CRITICAL
  const critical = allFindings.filter(f => f.severity === 'CRITICAL').slice(0, 20);
  
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Top 20 CRITICAL Findings`);
  console.log(`═══════════════════════════════════════════════════════════`);
  console.log(`NREG | Reason | Current | Suggested | Title`);
  console.log(`-----|--------|---------|-----------|------`);
  critical.forEach(f => {
    const title = f.evidence.title.substring(0, 40);
    console.log(`${f.nreg} | ${f.reason_code} | ${f.current_slug || 'NULL'} | ${f.suggested_slug || 'N/A'} | ${title}...`);
  });
  
  // Статистика
  const reasonCounts: Record<string, number> = {};
  allFindings.forEach(f => {
    reasonCounts[f.reason_code] = (reasonCounts[f.reason_code] || 0) + 1;
  });
  
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Statistics`);
  console.log(`═══════════════════════════════════════════════════════════`);
  console.log(`Total documents processed: ${docs.length}`);
  console.log(`Total findings: ${allFindings.length}`);
  console.log(`CRITICAL: ${allFindings.filter(f => f.severity === 'CRITICAL').length}`);
  console.log(`WARN: ${allFindings.filter(f => f.severity === 'WARN').length}`);
  console.log(`\nTop 5 reason codes:`);
  Object.entries(reasonCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .forEach(([code, count]) => {
      console.log(`  ${code}: ${count}`);
    });
  
  return allFindings;
}
