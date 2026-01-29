/**
 * Collect Diverse Candidates — PHASE 2
 * 
 * Збір кандидатів з diversity scoring та batch/uniqueness policy
 */

import { RadaClient } from '../lib/radaClient.js';
import { createSupabaseAdminClient } from '../lib/supabaseAdmin.js';
import { guessDocumentTypeV2 } from '../documentTypes/guessDocumentTypeV2.js';
import { DocumentTypeSlug } from '../documentTypes/documentTypes.js';
import { writeFile } from 'fs/promises';
import { resolve } from 'path';

export interface DiverseCandidate {
  nreg: string;
  title: string;
  document_number?: string;
  typ?: number;
  typn?: string;
  organs?: any;
  summary_prefix?: string;
  snippet15?: string;
  predicted_slug: DocumentTypeSlug;
  prefix_class: string;
  organ_signal: string;
  diversity_score: number;
  selection_reason: string;
}

export type PrefixClass =
  | 'УКАЗ_ПРЕЗИДЕНТА'
  | 'РОЗПОРЯДЖЕННЯ_ПРЕЗИДЕНТА'
  | 'РІШЕННЯ_РНБО'
  | 'ПОСТАНОВА_ЦВК'
  | 'ПОСТАНОВА_КМУ'
  | 'РОЗПОРЯДЖЕННЯ_КМУ'
  | 'РІШЕННЯ_КСУ'
  | 'ОКРЕМА_ДУМКА_КСУ'
  | 'КОНВЕНЦІЯ'
  | 'ПРОТОКОЛ'
  | 'ПАКТ'
  | 'НБУ_ПОВІДОМЛЕННЯ'
  | 'НБУ_ПОСТАНОВА'
  | 'РОЗПОРЯДЖЕННЯ_ГОЛОВИ_ВРУ'
  | 'ПОСТАНОВА_ВРУ'
  | 'КОДЕКС'
  | 'ЗАКОН'
  | 'ІНШЕ';

export type OrganSignal =
  | 'PRESIDENT'
  | 'RNBO'
  | 'CEC'
  | 'CMU'
  | 'VRU'
  | 'CCU'
  | 'NBU'
  | 'DEFENSE' // ЗСУ/СБУ/СЗР
  | 'INTERNATIONAL'
  | 'OTHER';

/**
 * Нормалізує текст для prefix class detection
 */
function normalizePrefix(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .replace(/[\n\t\r]/g, ' ')
    .replace(/["'«»]/g, '')
    .substring(0, 200);
}

/**
 * Визначає prefix class з snippet15 або summary_prefix
 */
export function detectPrefixClass(snippet15?: string | null, summary_prefix?: string | null): PrefixClass {
  const normalized = normalizePrefix(snippet15 || summary_prefix || '');
  
  if (!normalized) return 'ІНШЕ';
  
  // Указ Президента
  if (normalized.includes('УКАЗ') && normalized.includes('ПРЕЗИДЕНТ')) {
    return 'УКАЗ_ПРЕЗИДЕНТА';
  }
  
  // Розпорядження Президента
  if (normalized.includes('РОЗПОРЯДЖЕННЯ') && normalized.includes('ПРЕЗИДЕНТ')) {
    return 'РОЗПОРЯДЖЕННЯ_ПРЕЗИДЕНТА';
  }
  
  // Рішення РНБО
  if (normalized.includes('РІШЕННЯ') && (normalized.includes('РНБО') || normalized.includes('РАДА НАЦІОНАЛЬНОЇ БЕЗПЕКИ'))) {
    return 'РІШЕННЯ_РНБО';
  }
  
  // Постанова ЦВК
  if (normalized.includes('ПОСТАНОВА') && (normalized.includes('ЦВК') || normalized.includes('ЦЕНТРАЛЬНА ВИБОРЧА'))) {
    return 'ПОСТАНОВА_ЦВК';
  }
  
  // Постанова КМУ
  if (normalized.includes('ПОСТАНОВА') && (normalized.includes('КМУ') || normalized.includes('КАБІНЕТ МІНІСТРІВ'))) {
    return 'ПОСТАНОВА_КМУ';
  }
  
  // Розпорядження КМУ
  if (normalized.includes('РОЗПОРЯДЖЕННЯ') && (normalized.includes('КМУ') || normalized.includes('КАБІНЕТ МІНІСТРІВ'))) {
    return 'РОЗПОРЯДЖЕННЯ_КМУ';
  }
  
  // Рішення КСУ
  if (normalized.includes('РІШЕННЯ') && (normalized.includes('КСУ') || normalized.includes('КОНСТИТУЦІЙНИЙ СУД'))) {
    return 'РІШЕННЯ_КСУ';
  }
  
  // Окрема думка КСУ
  if ((normalized.includes('ОКРЕМА ДУМКА') || normalized.includes('ОКРЕМА ДУМКА СУДДІ')) && 
      (normalized.includes('КСУ') || normalized.includes('КОНСТИТУЦІЙНИЙ СУД'))) {
    return 'ОКРЕМА_ДУМКА_КСУ';
  }
  
  // Конвенція
  if (normalized.includes('КОНВЕНЦІЯ')) {
    return 'КОНВЕНЦІЯ';
  }
  
  // Протокол
  if (normalized.includes('ПРОТОКОЛ')) {
    return 'ПРОТОКОЛ';
  }
  
  // Пакт
  if (normalized.includes('ПАКТ')) {
    return 'ПАКТ';
  }
  
  // НБУ Повідомлення
  if ((normalized.includes('ПОВІДОМЛЕННЯ') || normalized.includes('ЛИСТ')) && 
      (normalized.includes('НБУ') || normalized.includes('НАЦІОНАЛЬНИЙ БАНК'))) {
    return 'НБУ_ПОВІДОМЛЕННЯ';
  }
  
  // НБУ Постанова
  if (normalized.includes('ПОСТАНОВА') && (normalized.includes('НБУ') || normalized.includes('НАЦІОНАЛЬНИЙ БАНК'))) {
    return 'НБУ_ПОСТАНОВА';
  }
  
  // Розпорядження Голови ВРУ
  if (normalized.includes('РОЗПОРЯДЖЕННЯ') && 
      (normalized.includes('ГОЛОВА') || normalized.includes('ГОЛОВИ')) &&
      (normalized.includes('ВРУ') || normalized.includes('ВЕРХОВНОЇ РАДИ'))) {
    return 'РОЗПОРЯДЖЕННЯ_ГОЛОВИ_ВРУ';
  }
  
  // Постанова ВРУ
  if (normalized.includes('ПОСТАНОВА') && (normalized.includes('ВРУ') || normalized.includes('ВЕРХОВНА РАДА'))) {
    return 'ПОСТАНОВА_ВРУ';
  }
  
  // Кодекс
  if (normalized.includes('КОДЕКС')) {
    return 'КОДЕКС';
  }
  
  // Закон
  if (normalized.includes('ЗАКОН')) {
    return 'ЗАКОН';
  }
  
  return 'ІНШЕ';
}

/**
 * Визначає organ signal
 */
export function detectOrganSignal(title: string, summary?: string | null, snippet?: string | null): OrganSignal {
  const combined = `${title} ${summary || ''} ${snippet || ''}`.toLowerCase();
  
  if (combined.includes('президент') || combined.includes('указ') || combined.includes('розпорядження президента')) {
    return 'PRESIDENT';
  }
  if (combined.includes('рнбо') || combined.includes('рада національної безпеки')) {
    return 'RNBO';
  }
  if (combined.includes('цвк') || combined.includes('центральна виборча')) {
    return 'CEC';
  }
  if (combined.includes('кму') || combined.includes('кабінет міністрів')) {
    return 'CMU';
  }
  if (combined.includes('вру') || combined.includes('верховна рада') || combined.includes('голова вр')) {
    return 'VRU';
  }
  if (combined.includes('ксу') || combined.includes('конституційний суд')) {
    return 'CCU';
  }
  if (combined.includes('нбу') || combined.includes('національний банк')) {
    return 'NBU';
  }
  if (combined.includes('зсу') || combined.includes('збройні сили') || 
      combined.includes('сбу') || combined.includes('служба безпеки') ||
      combined.includes('сзр') || combined.includes('служба зовнішньої розвідки') ||
      combined.includes('генеральний штаб') || combined.includes('міністерство оборони')) {
    return 'DEFENSE';
  }
  if (combined.includes('конвенція') || combined.includes('протокол') || 
      combined.includes('пакт') || combined.includes('договір') ||
      combined.includes('міжнародний')) {
    return 'INTERNATIONAL';
  }
  
  return 'OTHER';
}

/**
 * Обчислює diversity score
 */
function calculateDiversityScore(candidate: DiverseCandidate): number {
  let score = 0;
  
  // Rare prefix classes
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
  
  // Rare organ signals
  const rareOrgans: string[] = ['PRESIDENT', 'RNBO', 'CEC', 'CCU', 'NBU', 'DEFENSE', 'INTERNATIONAL'];
  if (rareOrgans.includes(candidate.organ_signal as string)) {
    score += 5;
  }
  
  // Non-CMU bonus
  if (candidate.organ_signal !== 'CMU' && !candidate.predicted_slug.startsWith('cmu_')) {
    score += 3;
  }
  
  // Document number suffix bonus (-РП, -РГ)
  if (candidate.document_number) {
    const nreg = candidate.document_number.toUpperCase();
    if (nreg.includes('-РП') || nreg.includes('-РГ')) {
      score += 5;
    }
  }
  
  return score;
}

/**
 * Збирає кандидатів з feed та обробляє їх
 */
export async function collectDiverseCandidates(options?: {
  limit?: number;
  excludeExisting?: boolean;
  minDiversityScore?: number;
}): Promise<DiverseCandidate[]> {
  const { limit = 200, excludeExisting = true, minDiversityScore = 0 } = options || {};
  
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Collect Diverse Candidates — PHASE 2`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  
  const rada = new RadaClient();
  const candidates: DiverseCandidate[] = [];
  
  // Отримуємо існуючі nreg
  let existingNregs: Set<string> = new Set();
  if (excludeExisting) {
    const supabase = createSupabaseAdminClient();
    const { data: existingDocs } = await supabase
      .from('legislation_documents')
      .select('rada_nreg');
    if (existingDocs) {
      existingNregs = new Set(existingDocs.map(d => d.rada_nreg));
      console.log(`📋 Виключено ${existingNregs.size} існуючих документів\n`);
    }
  }
  
  // Читаємо feed (r.txt)
  console.log('📥 Завантажуємо feed з Rada (r.txt)...');
  let feedNregs: string[] = [];
  try {
    const rTxt = await rada.fetchRTxt();
    // Парсимо r.txt: формат "nreg title" або просто "nreg"
    feedNregs = rTxt.split('\n')
      .map(line => {
        const parts = line.trim().split(/\s+/);
        return parts[0]; // Перший елемент - це nreg
      })
      .filter(nreg => nreg && nreg.length > 2 && /\d/.test(nreg) && !nreg.startsWith('#'))
      .filter(nreg => !existingNregs.has(nreg))
      .slice(0, limit * 3); // Беремо більше, щоб було з чого вибирати
    console.log(`✅ Завантажено ${feedNregs.length} NREGs з feed\n`);
  } catch (e) {
    console.warn(`⚠️  Не вдалося завантажити r.txt: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
  
  // Обробляємо кандидатів (з обмеженням на API calls)
  console.log(`🔍 Обробляємо кандидатів (макс ${limit * 2} для різноманітності)...\n`);
  let processed = 0;
  const maxProcess = Math.min(feedNregs.length, limit * 2);
  
  for (const nreg of feedNregs) {
    if (processed >= maxProcess) break;
    if (existingNregs.has(nreg)) continue;
    
    try {
      // Отримуємо card JSON для title/typ/organs
      const jsonData = await rada.fetchJson(nreg);
      if (!jsonData || !jsonData.nazva) continue;
      
      const title = jsonData.nazva;
      const document_number = jsonData.n_vlas || nreg;
      
      // Пробуємо отримати snippet15 з txt (тільки для топ-кандидатів після першого проходу)
      // На першому проході використовуємо тільки title для швидкості
      let snippet15: string | null = null;
      let summary_prefix: string | null = null;
      
      // Для швидкості: завантажуємо TXT тільки якщо title містить рідкісні сигнали
      const lowerTitle = title.toLowerCase();
      const hasRareSignal = 
        lowerTitle.includes('указ') || lowerTitle.includes('розпорядження президента') ||
        lowerTitle.includes('рнбо') || lowerTitle.includes('рада національної безпеки') ||
        lowerTitle.includes('цвк') || lowerTitle.includes('центральна виборча') ||
        lowerTitle.includes('ксу') || lowerTitle.includes('конституційний суд') ||
        lowerTitle.includes('конвенція') || lowerTitle.includes('протокол') || lowerTitle.includes('пакт') ||
        lowerTitle.includes('нбу') || lowerTitle.includes('національний банк') ||
        document_number?.toUpperCase().includes('-РП') || document_number?.toUpperCase().includes('-РГ');
      
      if (hasRareSignal) {
        try {
          const txt = await rada.fetchTxt(nreg);
          if (txt) {
            snippet15 = txt.substring(0, 15).trim();
            summary_prefix = txt.substring(0, 200).trim();
          }
        } catch {
          // Txt недоступний - використовуємо тільки title
        }
      }
      
      // Визначаємо predicted slug через heuristics
      const guess = guessDocumentTypeV2({
        title,
        typ: jsonData.typ,
        typn: jsonData.typn,
        organs: jsonData.organs,
        stru: jsonData.stru,
        snippet: snippet15 || null,
        summary: summary_prefix || null,
        document_number: document_number,
      });
      
      const prefix_class = detectPrefixClass(snippet15, summary_prefix);
      const organ_signal = detectOrganSignal(title, summary_prefix, snippet15);
      
      const candidate: DiverseCandidate = {
        nreg,
        title,
        document_number,
        typ: jsonData.typ,
        typn: jsonData.typn,
        organs: jsonData.organs,
        summary_prefix: summary_prefix || undefined,
        snippet15: snippet15 || undefined,
        predicted_slug: guess.slug,
        prefix_class,
        organ_signal,
        diversity_score: 0, // буде обчислено пізніше
        selection_reason: '',
      };
      
      candidate.diversity_score = calculateDiversityScore(candidate);
      
      if (candidate.diversity_score >= minDiversityScore) {
        candidates.push(candidate);
      }
      
      processed++;
      if (processed % 10 === 0) {
        process.stdout.write(`\r   Оброблено: ${processed}/${maxProcess}`);
      }
    } catch (e) {
      // Пропускаємо помилки (документ недоступний)
      continue;
    }
  }
  
  console.log(`\n✅ Оброблено ${processed} кандидатів, знайдено ${candidates.length} з diversity_score >= ${minDiversityScore}\n`);
  
  // Сортуємо за diversity_score (спочатку найрідкісніші)
  candidates.sort((a, b) => b.diversity_score - a.diversity_score);
  
  return candidates;
}

/**
 * Формує batch з diversity policy
 */
export function formDiverseBatch(
  candidates: DiverseCandidate[],
  batchSize: number = 10,
  existingInBatch: DiverseCandidate[] = []
): DiverseCandidate[] {
  const batch: DiverseCandidate[] = [];
  const usedPrefixClasses = new Set<string>();
  const usedOrgans = new Set<string>();
  const usedSlugs = new Map<string, number>();
  let cmuCount = 0;
  let nonCmuCount = 0;
  let rareCount = 0;
  
  // Підраховуємо вже використані в batch
  for (const existing of existingInBatch) {
    usedPrefixClasses.add(existing.prefix_class);
    usedOrgans.add(existing.organ_signal);
    const slugCount = usedSlugs.get(existing.predicted_slug) || 0;
    usedSlugs.set(existing.predicted_slug, slugCount + 1);
    if (existing.predicted_slug.startsWith('cmu_')) cmuCount++;
    else nonCmuCount++;
    if (['PRESIDENT', 'RNBO', 'CEC', 'CCU', 'NBU', 'DEFENSE', 'INTERNATIONAL'].includes(existing.organ_signal)) {
      rareCount++;
    }
  }
  
  // Відбираємо кандидатів
  for (const candidate of candidates) {
    if (batch.length >= batchSize) break;
    
    // Перевірка uniqueness
    if (usedPrefixClasses.has(candidate.prefix_class)) continue;
    if (usedOrgans.has(candidate.organ_signal)) continue;
    const slugCount = usedSlugs.get(candidate.predicted_slug) || 0;
    if (slugCount >= 2) continue;
    
    // Перевірка batch policy
    const isCmu = candidate.predicted_slug.startsWith('cmu_');
    if (isCmu && cmuCount >= 2) continue;
    
    const isRare = ['PRESIDENT', 'RNBO', 'CEC', 'CCU', 'NBU', 'DEFENSE', 'INTERNATIONAL'].includes(candidate.organ_signal as string);
    
    // Додаємо кандидата
    batch.push(candidate);
    usedPrefixClasses.add(candidate.prefix_class);
    usedOrgans.add(candidate.organ_signal);
    usedSlugs.set(candidate.predicted_slug, slugCount + 1);
    if (isCmu) cmuCount++;
    else nonCmuCount++;
    if (isRare) rareCount++;
    
    candidate.selection_reason = `diversity_score=${candidate.diversity_score}, prefix=${candidate.prefix_class}, organ=${candidate.organ_signal}`;
  }
  
  return batch;
}

/**
 * Головна функція для збору golden diversity set
 */
export async function collectGoldenDiversitySet(options?: {
  minCandidates?: number;
  outputPath?: string;
}): Promise<DiverseCandidate[]> {
  const { minCandidates = 30, outputPath } = options || {};
  
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Golden Diversity Set — PHASE 2.3`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  
  // Збираємо кандидатів з високим diversity score
  const allCandidates = await collectDiverseCandidates({
    limit: 400, // Беремо більше для вибору
    excludeExisting: true,
    minDiversityScore: 3, // Мінімальний score для включення
  });
  
  // Сортуємо за diversity_score
  allCandidates.sort((a, b) => b.diversity_score - a.diversity_score);
  
  // Формуємо golden set з різноманітністю
  const goldenSet: DiverseCandidate[] = [];
  const usedPrefixClasses = new Set<string>();
  const usedOrgans = new Set<string>();
  const requiredPrefixes: PrefixClass[] = [
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
    const candidate = allCandidates.find(c => c.prefix_class === prefix && !usedPrefixClasses.has(prefix));
    if (candidate) {
      goldenSet.push(candidate);
      usedPrefixClasses.add(prefix as string);
      usedOrgans.add(candidate.organ_signal as string);
    }
  }
  
  // Додаємо решту до minCandidates
  for (const candidate of allCandidates) {
    if (goldenSet.length >= minCandidates) break;
    if (usedPrefixClasses.has(candidate.prefix_class)) continue;
    if (usedOrgans.has(candidate.organ_signal) && goldenSet.length >= minCandidates * 0.7) continue; // Дозволяємо деякі дублікати органів після 70%
    
    goldenSet.push(candidate);
    usedPrefixClasses.add(candidate.prefix_class as string);
    usedOrgans.add(candidate.organ_signal as string);
  }
  
  // Виводимо таблицю preview
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Golden Diversity Set Preview (${goldenSet.length} кандидатів)`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  console.log('NREG | Title (prefix) | Predicted Slug | Prefix Class | Organ | Score');
  console.log('-----|----------------|----------------|--------------|-------|------');
  
  for (const candidate of goldenSet.slice(0, 30)) {
    const titlePrefix = candidate.title.substring(0, 40).padEnd(40);
    console.log(
      `${candidate.nreg.padEnd(10)} | ${titlePrefix} | ${candidate.predicted_slug.padEnd(15)} | ${candidate.prefix_class.padEnd(13)} | ${candidate.organ_signal.padEnd(5)} | ${candidate.diversity_score}`
    );
  }
  
  if (goldenSet.length > 30) {
    console.log(`\n... і ще ${goldenSet.length - 30} кандидатів\n`);
  }
  
  // Зберігаємо у файл якщо потрібно
  if (outputPath) {
    const output = {
      candidates: goldenSet.map(c => ({
        nreg: c.nreg,
        title: c.title,
        document_number: c.document_number,
        predicted_slug: c.predicted_slug,
        prefix_class: c.prefix_class,
        organ_signal: c.organ_signal,
        diversity_score: c.diversity_score,
        selection_reason: c.selection_reason,
      })),
      summary: {
        total: goldenSet.length,
        prefix_classes: Object.fromEntries(
          Object.entries(
            goldenSet.reduce((acc, c) => {
              acc[c.prefix_class] = (acc[c.prefix_class] || 0) + 1;
              return acc;
            }, {} as Record<string, number>)
          )
        ),
        organ_signals: Object.fromEntries(
          Object.entries(
            goldenSet.reduce((acc, c) => {
              acc[c.organ_signal] = (acc[c.organ_signal] || 0) + 1;
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
    
    await writeFile(outputPath, JSON.stringify(output, null, 2), 'utf-8');
    console.log(`\n💾 Збережено у ${outputPath}\n`);
  }
  
  return goldenSet;
}

// CLI entry point видалено - використовується через admin-cli.ts
