/**
 * Form Diverse Batch — PHASE 2.3
 * 
 * Формує batch з diversity policy з існуючого списку кандидатів
 * БЕЗ завантаження JSON/TXT (швидко)
 */

import { createSupabaseAdminClient } from '../lib/supabaseAdmin.js';
import { readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';
import { detectPrefixClass, detectOrganSignal, DiverseCandidate, formDiverseBatch } from './collect-diverse-candidates.js';
import { DocumentTypeSlug } from '../documentTypes/documentTypes.js';

/**
 * Швидке визначення predicted slug з nreg pattern
 */
function guessSlugFromNreg(nreg: string, title?: string): DocumentTypeSlug {
  const nregUpper = nreg.toUpperCase();
  
  // Suffix-based rules (найнадійніші)
  if (nregUpper.includes('-РП')) {
    return 'presidential_order';
  }
  if (nregUpper.includes('-РГ')) {
    return 'vr_speaker_order';
  }
  
  // Pattern-based для президентських документів (X/2026)
  if (nregUpper.match(/^\d+\/202[56]$/)) {
    return 'presidential_decree';
  }
  
  // Pattern-based для КМУ (X-2026-р/п)
  if (nregUpper.match(/^\d+-\d{4}-[РП]$/)) {
    if (nregUpper.endsWith('-П')) {
      return 'cmu_resolution';
    }
    return 'cmu_order';
  }
  
  // Pattern-based для КСУ (v... або nb...)
  if (nregUpper.startsWith('V') || nregUpper.startsWith('NB')) {
    if (title?.toLowerCase().includes('окрема думка')) {
      return 'ccu_opinion';
    }
    return 'ccu_decision';
  }
  
  // Pattern-based для НБУ (n...)
  if (nregUpper.startsWith('N') && !nregUpper.startsWith('NB')) {
    return 'nbu_letter';
  }
  
  return 'unknown';
}

/**
 * Швидке визначення prefix class з nreg + title
 */
function guessPrefixClassFromNreg(nreg: string, title?: string): string {
  const nregUpper = nreg.toUpperCase();
  const titleUpper = (title || '').toUpperCase();
  
  // Suffix-based (найнадійніші)
  if (nregUpper.includes('-РП')) {
    return 'РОЗПОРЯДЖЕННЯ_ПРЕЗИДЕНТА';
  }
  if (nregUpper.includes('-РГ')) {
    return 'РОЗПОРЯДЖЕННЯ_ГОЛОВИ_ВРУ';
  }
  
  // Pattern-based для президентських документів (X/2026)
  if (nregUpper.match(/^\d+\/202[56]$/)) {
    // За замовчуванням - указ (частіше)
    return 'УКАЗ_ПРЕЗИДЕНТА';
  }
  
  // Pattern-based для КМУ (X-2026-р/п)
  if (nregUpper.match(/^\d+-\d{4}-[РП]$/)) {
    if (nregUpper.endsWith('-П')) {
      return 'ПОСТАНОВА_КМУ';
    }
    return 'РОЗПОРЯДЖЕННЯ_КМУ';
  }
  
  // Pattern-based для КСУ (v...)
  if (nregUpper.startsWith('V') || nregUpper.startsWith('NB')) {
    // Можливо КСУ або окрема думка
    if (titleUpper.includes('ОКРЕМА ДУМКА')) {
      return 'ОКРЕМА_ДУМКА_КСУ';
    }
    return 'РІШЕННЯ_КСУ';
  }
  
  // Title-based (якщо є title)
  if (titleUpper) {
    if (titleUpper.includes('КОНВЕНЦІЯ')) {
      return 'КОНВЕНЦІЯ';
    }
    if (titleUpper.includes('ПРОТОКОЛ')) {
      return 'ПРОТОКОЛ';
    }
    if (titleUpper.includes('ПАКТ')) {
      return 'ПАКТ';
    }
    if (titleUpper.includes('ЦВК') || titleUpper.includes('ЦЕНТРАЛЬНА ВИБОРЧА')) {
      return 'ПОСТАНОВА_ЦВК';
    }
    if (titleUpper.includes('РНБО') || titleUpper.includes('РАДА НАЦІОНАЛЬНОЇ БЕЗПЕКИ')) {
      return 'РІШЕННЯ_РНБО';
    }
    if (titleUpper.includes('КСУ') || titleUpper.includes('КОНСТИТУЦІЙНИЙ СУД')) {
      if (titleUpper.includes('ОКРЕМА ДУМКА')) {
        return 'ОКРЕМА_ДУМКА_КСУ';
      }
      return 'РІШЕННЯ_КСУ';
    }
    if (titleUpper.includes('НБУ') || titleUpper.includes('НАЦІОНАЛЬНИЙ БАНК')) {
      if (titleUpper.includes('ПОВІДОМЛЕННЯ') || titleUpper.includes('ЛИСТ')) {
        return 'НБУ_ПОВІДОМЛЕННЯ';
      }
      return 'НБУ_ПОСТАНОВА';
    }
  }
  
  return 'ІНШЕ';
}

/**
 * Швидке визначення organ signal з nreg + title
 */
function guessOrganSignalFromNreg(nreg: string, title?: string): string {
  const nregUpper = nreg.toUpperCase();
  const combined = `${nreg} ${title || ''}`.toLowerCase();
  
  // Suffix-based (найнадійніші)
  if (nregUpper.includes('-РП')) {
    return 'PRESIDENT';
  }
  if (nregUpper.includes('-РГ')) {
    return 'VRU';
  }
  
  // Pattern-based для президентських документів (X/2026)
  if (nregUpper.match(/^\d+\/202[56]$/)) {
    return 'PRESIDENT';
  }
  
  // Pattern-based для КМУ (X-2026-р/п)
  if (nregUpper.match(/^\d+-\d{4}-[РП]$/)) {
    return 'CMU';
  }
  
  // Pattern-based для КСУ (v... або nb...)
  if (nregUpper.startsWith('V') || nregUpper.startsWith('NB')) {
    return 'CCU';
  }
  
  // Pattern-based для НБУ (n...)
  if (nregUpper.startsWith('N') && !nregUpper.startsWith('NB')) {
    return 'NBU';
  }
  
  // Title-based (якщо є title)
  if (title) {
    if (combined.includes('рнбо') || combined.includes('рада національної безпеки')) {
      return 'RNBO';
    }
    if (combined.includes('цвк') || combined.includes('центральна виборча')) {
      return 'CEC';
    }
    if (combined.includes('конвенція') || combined.includes('протокол') || combined.includes('пакт')) {
      return 'INTERNATIONAL';
    }
  }
  
  return 'OTHER';
}

/**
 * Обчислює diversity score
 */
function calculateDiversityScore(candidate: DiverseCandidate): number {
  let score = 0;
  
  const rarePrefixes: string[] = [
    'УКАЗ_ПРЕЗИДЕНТА',
    'РОЗПОРЯДЖЕННЯ_ПРЕЗИДЕНТА',
    'РІШЕННЯ_РНБО',
    'ПОСТАНОВА_ЦВК',
    'РІШЕННЯ_КСУ',
    'ОКРЕМА_ДУМКА_КСУ',
    'КОНВЕНЦІЯ',
    'ПРОТОКОЛ',
    'ПАКТ',
    'НБУ_ПОВІДОМЛЕННЯ',
    'НБУ_ПОСТАНОВА',
    'РОЗПОРЯДЖЕННЯ_ГОЛОВИ_ВРУ',
  ];
  
  if (rarePrefixes.includes(candidate.prefix_class as string)) {
    score += 10;
  }
  
  const rareOrgans: string[] = ['PRESIDENT', 'RNBO', 'CEC', 'CCU', 'NBU', 'DEFENSE', 'INTERNATIONAL'];
  if (rareOrgans.includes(candidate.organ_signal as string)) {
    score += 5;
  }
  
  if (candidate.organ_signal !== 'CMU' && !candidate.predicted_slug.startsWith('cmu_')) {
    score += 3;
  }
  
  if (candidate.document_number) {
    const nreg = candidate.document_number.toUpperCase();
    if (nreg.includes('-РП') || nreg.includes('-РГ')) {
      score += 5;
    }
  }
  
  return score;
}

/**
 * Головна функція: формує golden diversity set з існуючого списку
 */
export async function formGoldenDiversitySetFromList(options?: {
  inputFile?: string;
  outputPath?: string;
  minCandidates?: number;
}): Promise<DiverseCandidate[]> {
  const { inputFile, outputPath, minCandidates = 30 } = options || {};
  
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Form Golden Diversity Set — PHASE 2.3 (Fast)`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  
  const supabase = createSupabaseAdminClient();
  
  // Отримуємо існуючі nreg
  const { data: existingDocs } = await supabase
    .from('legislation_documents')
    .select('rada_nreg');
  const existingNregs = new Set(existingDocs?.map(d => d.rada_nreg) || []);
  console.log(`📋 Виключено ${existingNregs.size} існуючих документів\n`);
  
  // Читаємо список кандидатів
  const inputPath = inputFile || resolve(process.env.LEXERY_LEGISLATION_WORKSPACE_ROOT || process.cwd(), 'data', 'hard_stream_200_candidates.txt');
  console.log(`📥 Читаємо список кандидатів з ${inputPath}...`);
  const content = await readFile(inputPath, 'utf-8');
  const allNregs = content.split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .filter(nreg => !existingNregs.has(nreg));
  
  console.log(`✅ Знайдено ${allNregs.length} доступних кандидатів\n`);
  
  // Створюємо кандидатів на основі nreg patterns (БЕЗ API calls)
  console.log(`🔍 Формуємо кандидатів на основі nreg patterns...\n`);
  const candidates: DiverseCandidate[] = [];
  
  for (const nreg of allNregs) {
    const predicted_slug = guessSlugFromNreg(nreg);
    const prefix_class = guessPrefixClassFromNreg(nreg) as any;
    const organ_signal = guessOrganSignalFromNreg(nreg) as any;
    
    const candidate: DiverseCandidate = {
      nreg,
      title: `[${nreg}]`, // Placeholder, буде оновлено після імпорту
      document_number: nreg,
      predicted_slug,
      prefix_class,
      organ_signal,
      diversity_score: 0,
      selection_reason: '',
    };
    
    candidate.diversity_score = calculateDiversityScore(candidate);
    candidates.push(candidate);
  }
  
  // Сортуємо за diversity_score
  candidates.sort((a, b) => b.diversity_score - a.diversity_score);
  
  // Формуємо golden set з різноманітністю
  const goldenSet: DiverseCandidate[] = [];
  const usedPrefixClasses = new Set<string>();
  const usedOrgans = new Set<string>();
  const requiredPrefixes: string[] = [
    'УКАЗ_ПРЕЗИДЕНТА',
    'РОЗПОРЯДЖЕННЯ_ПРЕЗИДЕНТА',
    'РІШЕННЯ_РНБО',
    'ПОСТАНОВА_ЦВК',
    'РІШЕННЯ_КСУ',
    'ОКРЕМА_ДУМКА_КСУ',
    'КОНВЕНЦІЯ',
    'ПРОТОКОЛ',
    'ПАКТ',
    'НБУ_ПОВІДОМЛЕННЯ',
    'НБУ_ПОСТАНОВА',
    'РОЗПОРЯДЖЕННЯ_ГОЛОВИ_ВРУ',
  ];
  
  // Спочатку додаємо по одному з кожного required prefix
  for (const prefix of requiredPrefixes) {
    const candidate = candidates.find(c => (c.prefix_class as string) === prefix && !usedPrefixClasses.has(prefix));
    if (candidate) {
      goldenSet.push(candidate);
      usedPrefixClasses.add(prefix);
      usedOrgans.add(candidate.organ_signal as string);
    }
  }
  
  // Обмежуємо президентські документи до 2-3 (навіть якщо їх багато)
  const presidentCount = goldenSet.filter(c => c.organ_signal === 'PRESIDENT').length;
  if (presidentCount > 3) {
    // Залишаємо тільки перші 3 президентські
    const presidentDocs = goldenSet.filter(c => c.organ_signal === 'PRESIDENT');
    const toRemove = presidentDocs.slice(3);
    for (const doc of toRemove) {
      const index = goldenSet.findIndex(c => c.nreg === doc.nreg);
      if (index >= 0) {
        goldenSet.splice(index, 1);
        usedPrefixClasses.delete(doc.prefix_class as string);
        usedOrgans.delete(doc.organ_signal as string);
      }
    }
  }
  
  // Додаємо решту до minCandidates (пріоритет: високий diversity_score + різноманітність)
  // Дозволяємо до 2 документів з одним prefix_class, якщо різні predicted_slug
  const prefixClassCounts = new Map<string, number>();
  const usedSlugs = new Map<string, number>();
  
  for (const candidate of candidates) {
    if (goldenSet.length >= minCandidates) break;
    if (goldenSet.find(c => c.nreg === candidate.nreg)) continue; // Вже додано
    
    const prefixKey = candidate.prefix_class as string;
    const prefixCount = prefixClassCounts.get(prefixKey) || 0;
    const slugCount = usedSlugs.get(candidate.predicted_slug) || 0;
    
    // Перевірка uniqueness (більш гнучка)
    if (prefixCount >= 2 && prefixKey !== 'ІНШЕ') continue; // Макс 2 з одним prefix_class
    if (slugCount >= 2) continue; // Макс 2 з одним slug
    if (usedOrgans.has(candidate.organ_signal as string) && goldenSet.length >= minCandidates * 0.7 && candidate.organ_signal === 'CMU') continue; // Обмежуємо CMU
    
    // Додаємо кандидата
    goldenSet.push(candidate);
    prefixClassCounts.set(prefixKey, prefixCount + 1);
    usedSlugs.set(candidate.predicted_slug, slugCount + 1);
    usedOrgans.add(candidate.organ_signal as string);
  }
  
  // Якщо все ще не вистачає - додаємо будь-яких з високим score (з обмеженням на CMU)
  if (goldenSet.length < minCandidates) {
    const cmuCount = goldenSet.filter(c => c.organ_signal === 'CMU').length;
    for (const candidate of candidates) {
      if (goldenSet.length >= minCandidates) break;
      if (goldenSet.find(c => c.nreg === candidate.nreg)) continue;
      
      // Обмежуємо CMU до 30% від загальної кількості
      if (candidate.organ_signal === 'CMU' && cmuCount >= Math.floor(minCandidates * 0.3)) continue;
      
      goldenSet.push(candidate);
    }
  }
  
  // Виводимо таблицю preview
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Golden Diversity Set Preview (${goldenSet.length} кандидатів)`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  console.log('NREG | Predicted Slug | Prefix Class | Organ | Score');
  console.log('-----|----------------|--------------|-------|------');
  
  for (const candidate of goldenSet.slice(0, 30)) {
    console.log(
      `${candidate.nreg.padEnd(10)} | ${candidate.predicted_slug.padEnd(15)} | ${(candidate.prefix_class as string).padEnd(13)} | ${(candidate.organ_signal as string).padEnd(5)} | ${candidate.diversity_score}`
    );
  }
  
  if (goldenSet.length > 30) {
    console.log(`\n... і ще ${goldenSet.length - 30} кандидатів\n`);
  }
  
  // Зберігаємо у файл
  const finalOutputPath = outputPath || resolve(process.env.LEXERY_LEGISLATION_WORKSPACE_ROOT || process.cwd(), 'data', 'golden_diversity_set.json');
  const output = {
    candidates: goldenSet.map(c => ({
      nreg: c.nreg,
      title: c.title,
      document_number: c.document_number,
      predicted_slug: c.predicted_slug,
      prefix_class: c.prefix_class,
      organ_signal: c.organ_signal,
      diversity_score: c.diversity_score,
    })),
    summary: {
      total: goldenSet.length,
      prefix_classes: Object.fromEntries(
        Object.entries(
          goldenSet.reduce((acc, c) => {
            const key = c.prefix_class as string;
            acc[key] = (acc[key] || 0) + 1;
            return acc;
          }, {} as Record<string, number>)
        )
      ),
      organ_signals: Object.fromEntries(
        Object.entries(
          goldenSet.reduce((acc, c) => {
            const key = c.organ_signal as string;
            acc[key] = (acc[key] || 0) + 1;
            return acc;
          }, {} as Record<string, number>)
        )
      ),
      predicted_slugs: Object.fromEntries(
        Object.entries(
          goldenSet.reduce((acc, c) => {
            acc[c.predicted_slug] = (acc[c.predicted_slug] || 0) + 1;
            return acc;
          }, {} as Record<string, number>)
        )
      ),
    },
  };
  
  await writeFile(finalOutputPath, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`\n💾 Збережено у ${finalOutputPath}\n`);
  
  return goldenSet;
}
