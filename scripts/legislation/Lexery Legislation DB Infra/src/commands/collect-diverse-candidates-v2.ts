/**
 * Collect Diverse Candidates V2 — PHASE 2 REWORK
 * 
 * Реальна різноманітність через keyword mining + 3 джерела
 */

import { RadaClient } from '../lib/radaClient.js';
import { createSupabaseAdminClient } from '../lib/supabaseAdmin.js';
import { guessDocumentTypeV2 } from '../documentTypes/guessDocumentTypeV2.js';
import { detectPrefixClass, detectOrganSignal, DiverseCandidate } from './collect-diverse-candidates.js';
import { writeFile } from 'fs/promises';
import { resolve } from 'path';

/**
 * Seed keywords для keyword-driven mining
 */
const SEED_KEYWORDS = {
  international: [
    'конвенція', 'протокол', 'пакт', 'договір', 'статут',
    'міжнародний', 'ратифікація', 'угода'
  ],
  ccu: [
    'конституційний суд', 'рішення конституційного суду', 'окрема думка',
    'ксу', 'конституційний суд україни'
  ],
  rnbo: [
    'рада національної безпеки', 'рнбо', 'санкц', 'санкції',
    'національна безпека', 'оборони'
  ],
  cec: [
    'центральна виборча', 'цвк', 'виборча комісія',
    'вибори', 'виборчий процес'
  ],
  nbu: [
    'національний банк', 'нбу', 'облікова ставка', 'банківськ',
    'рефінансування', 'валютн', 'монетарн'
  ],
  defense: [
    'служба безпеки', 'сбу', 'збройн', 'зсу',
    'служба зовнішньої розвідки', 'сзр', 'міністерство оборони', 'моу',
    'генеральний штаб', 'контррозвідк', 'державна таємниця'
  ],
  vru: [
    'верховної ради', 'голова верховної ради', 'розпорядження голови',
    'вру', 'верховна рада україни'
  ],
  presidential_order: [
    'розпорядження президента', '-рп'
  ],
};

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
 * Перевіряє, чи title/summary містить keyword
 */
function matchesKeyword(text: string | null | undefined, keywords: string[]): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return keywords.some(kw => lower.includes(kw));
}

/**
 * Визначає category з keyword matching
 */
function detectCategoryFromKeywords(title: string, summary?: string | null): string | null {
  const combined = `${title} ${summary || ''}`.toLowerCase();
  
  if (matchesKeyword(combined, SEED_KEYWORDS.international)) {
    return 'international';
  }
  if (matchesKeyword(combined, SEED_KEYWORDS.ccu)) {
    return 'ccu';
  }
  if (matchesKeyword(combined, SEED_KEYWORDS.rnbo)) {
    return 'rnbo';
  }
  if (matchesKeyword(combined, SEED_KEYWORDS.cec)) {
    return 'cec';
  }
  if (matchesKeyword(combined, SEED_KEYWORDS.nbu)) {
    return 'nbu';
  }
  if (matchesKeyword(combined, SEED_KEYWORDS.defense)) {
    return 'defense';
  }
  if (matchesKeyword(combined, SEED_KEYWORDS.vru)) {
    return 'vru';
  }
  if (matchesKeyword(combined, SEED_KEYWORDS.presidential_order)) {
    return 'presidential_order';
  }
  
  return null;
}

/**
 * SOURCE 1: Rada feed (r.txt) — базовий пул
 */
async function collectFromFeed(
  rada: RadaClient,
  existingNregs: Set<string>,
  limit: number = 2000
): Promise<Array<{ nreg: string; title?: string }>> {
  console.log('📥 SOURCE 1: Завантажуємо feed (r.txt)...');
  
  try {
    const rTxt = await rada.fetchRTxt();
    const lines = rTxt.split('\n')
      .map(line => {
        const parts = line.trim().split(/\s+/);
        return { nreg: parts[0], title: parts.slice(1).join(' ') };
      })
      .filter(item => item.nreg && item.nreg.length > 2 && /\d/.test(item.nreg))
      .filter(item => !existingNregs.has(item.nreg))
      .slice(0, limit);
    
    console.log(`✅ Завантажено ${lines.length} NREGs з feed\n`);
    return lines;
  } catch (e) {
    console.warn(`⚠️  Не вдалося завантажити r.txt: ${e instanceof Error ? e.message : String(e)}\n`);
    return [];
  }
}

/**
 * SOURCE 2: Keyword-driven candidate mining
 */
async function collectFromKeywords(
  feedCandidates: Array<{ nreg: string; title?: string }>,
  rada: RadaClient,
  existingNregs: Set<string>
): Promise<DiverseCandidate[]> {
  console.log('🔍 SOURCE 2: Keyword-driven mining...\n');
  
  const candidates: DiverseCandidate[] = [];
  const allKeywords = [
    ...SEED_KEYWORDS.international,
    ...SEED_KEYWORDS.ccu,
    ...SEED_KEYWORDS.rnbo,
    ...SEED_KEYWORDS.cec,
    ...SEED_KEYWORDS.nbu,
    ...SEED_KEYWORDS.defense,
    ...SEED_KEYWORDS.vru,
    ...SEED_KEYWORDS.presidential_order,
  ];
  
  let processed = 0;
  const maxProcess = Math.min(feedCandidates.length, 500); // Обмежуємо для швидкості
  
  for (const item of feedCandidates) {
    if (processed >= maxProcess) break;
    if (existingNregs.has(item.nreg)) continue;
    
    // Перевіряємо keyword match по nreg (suffix-based) - це швидко
    const nregUpper = item.nreg.toUpperCase();
    const hasSuffixMatch = nregUpper.includes('-РП') || nregUpper.includes('-РГ') || 
                           nregUpper.match(/^V/) || nregUpper.match(/^N/) ||
                           nregUpper.match(/^\d+\/202[56]$/); // Президентські X/2026
    
    // Якщо немає suffix match, перевіряємо title (якщо є)
    if (!hasSuffixMatch && item.title) {
      const lowerTitle = item.title.toLowerCase();
      const hasKeyword = allKeywords.some(kw => lowerTitle.includes(kw));
      if (!hasKeyword) continue;
    } else if (!hasSuffixMatch) {
      // Немає title і немає suffix match - пропускаємо
      continue;
    }
    
    // Отримуємо JSON для typ/organs та title
    let title = item.title || '';
    let jsonData: any;
    
    try {
      // Отримуємо JSON для typ/organs та title
      jsonData = await rada.fetchJson(item.nreg);
      if (!jsonData || !jsonData.nazva) continue;
      title = jsonData.nazva;
      
      const document_number = jsonData.n_vlas || item.nreg;
      const category = detectCategoryFromKeywords(jsonData.nazva, null);
      
      // Швидкий прохід: використовуємо тільки title для prefix class
      const guess = guessDocumentTypeV2({
        title: jsonData.nazva,
        typ: jsonData.typ,
        typn: jsonData.typn,
        organs: jsonData.organs,
        stru: jsonData.stru,
        snippet: null,
        summary: null,
        document_number: document_number,
      });
      
      const prefix_class = detectPrefixClass(null, jsonData.nazva);
      const organ_signal = detectOrganSignal(jsonData.nazva);
      
      const candidate: DiverseCandidate = {
        nreg: item.nreg,
        title: title,
        document_number,
        typ: jsonData.typ,
        typn: jsonData.typn,
        organs: jsonData.organs,
        predicted_slug: guess.slug,
        prefix_class,
        organ_signal,
        diversity_score: 0,
        selection_reason: category ? `keyword:${category}` : 'keyword:match',
      };
      
      candidate.diversity_score = calculateDiversityScore(candidate);
      candidates.push(candidate);
      
      processed++;
      if (processed % 20 === 0) {
        process.stdout.write(`\r   Оброблено: ${processed}/${maxProcess}`);
      }
    } catch (e) {
      // Пропускаємо помилки
      continue;
    }
  }
  
  console.log(`\n✅ Знайдено ${candidates.length} кандидатів через keyword mining\n`);
  return candidates;
}

/**
 * SOURCE 3: Known hard seeds (знаходимо самі через keyword mining)
 */
async function collectKnownHardSeeds(
  feedCandidates: Array<{ nreg: string; title?: string }>,
  rada: RadaClient,
  existingNregs: Set<string>
): Promise<DiverseCandidate[]> {
  console.log('🎯 SOURCE 3: Known hard seeds (keyword mining)...\n');
  
  const seeds: DiverseCandidate[] = [];
  const targets = {
    international: { count: 2, keywords: SEED_KEYWORDS.international },
    ccu: { count: 2, keywords: SEED_KEYWORDS.ccu },
    rnbo: { count: 2, keywords: SEED_KEYWORDS.rnbo },
    cec: { count: 2, keywords: SEED_KEYWORDS.cec },
    nbu: { count: 2, keywords: SEED_KEYWORDS.nbu },
    vru_rg: { count: 2, keywords: ['-рг', 'голова верховної ради'] },
    defense: { count: 2, keywords: SEED_KEYWORDS.defense },
  };
  
  for (const [targetName, target] of Object.entries(targets)) {
    let found = 0;
    
    for (const item of feedCandidates) {
      if (found >= target.count) break;
      if (existingNregs.has(item.nreg)) continue;
      
      const title = item.title || '';
      const lowerTitle = title.toLowerCase();
      const nregUpper = item.nreg.toUpperCase();
      
      // Перевіряємо keyword match або suffix match
      const hasKeyword = target.keywords.some(kw => 
        lowerTitle.includes(kw) || nregUpper.includes(kw.toUpperCase())
      );
      if (!hasKeyword) continue;
      
      try {
        const jsonData = await rada.fetchJson(item.nreg);
        if (!jsonData || !jsonData.nazva) continue;
        
        const document_number = jsonData.n_vlas || item.nreg;
        
        const guess = guessDocumentTypeV2({
          title: jsonData.nazva,
          typ: jsonData.typ,
          typn: jsonData.typn,
          organs: jsonData.organs,
          stru: jsonData.stru,
          snippet: null,
          summary: null,
          document_number: document_number,
        });
        
        const prefix_class = detectPrefixClass(null, jsonData.nazva);
        const organ_signal = detectOrganSignal(jsonData.nazva);
        
        const candidate: DiverseCandidate = {
          nreg: item.nreg,
          title: jsonData.nazva,
          document_number,
          typ: jsonData.typ,
          typn: jsonData.typn,
          organs: jsonData.organs,
          predicted_slug: guess.slug,
          prefix_class,
          organ_signal,
          diversity_score: 0,
          selection_reason: `pinned:${targetName}`,
        };
        
        candidate.diversity_score = calculateDiversityScore(candidate);
        seeds.push(candidate);
        found++;
      } catch (e) {
        continue;
      }
    }
    
    console.log(`   ${targetName}: знайдено ${found}/${target.count}`);
  }
  
  console.log(`\n✅ Знайдено ${seeds.length} pinned candidates\n`);
  return seeds;
}

/**
 * Завантажує TXT/snippet тільки для топ-кандидатів
 */
async function enrichWithSnippet(
  candidates: DiverseCandidate[],
  rada: RadaClient,
  topN: number = 60
): Promise<void> {
  console.log(`📄 Завантажуємо TXT/snippet для топ-${topN} кандидатів...\n`);
  
  // Сортуємо за diversity_score
  const sorted = [...candidates].sort((a, b) => b.diversity_score - a.diversity_score);
  const topCandidates = sorted.slice(0, topN);
  
  let enriched = 0;
  for (const candidate of topCandidates) {
    try {
      const txt = await rada.fetchTxt(candidate.nreg);
      if (txt) {
        candidate.snippet15 = txt.substring(0, 15).trim();
        candidate.summary_prefix = txt.substring(0, 200).trim();
        
        // Оновлюємо prefix_class та organ_signal з snippet
        candidate.prefix_class = detectPrefixClass(candidate.snippet15, candidate.summary_prefix);
        candidate.organ_signal = detectOrganSignal(candidate.title, candidate.summary_prefix, candidate.snippet15);
        candidate.diversity_score = calculateDiversityScore(candidate);
      }
      enriched++;
      if (enriched % 10 === 0) {
        process.stdout.write(`\r   Оброблено: ${enriched}/${topN}`);
      }
    } catch (e) {
      // Пропускаємо помилки
      continue;
    }
  }
  
  console.log(`\n✅ Оброблено ${enriched} кандидатів\n`);
}

/**
 * Формує golden set з квотами
 */
function formGoldenSetWithQuotas(candidates: DiverseCandidate[]): DiverseCandidate[] {
  console.log('📊 Формуємо golden set з квотами...\n');
  
  const quotas = {
    presidential_decree: { min: 2, max: 4, current: 0 },
    presidential_order: { min: 1, max: 2, current: 0 },
    rnbo_decision: { min: 2, max: 4, current: 0 },
    vr_speaker_order: { min: 1, max: 2, current: 0 },
    vr_resolution: { min: 2, max: 4, current: 0 },
    cec_resolution: { min: 1, max: 2, current: 0 },
    ccu_opinion: { min: 1, max: 2, current: 0 },
    ccu_decision: { min: 1, max: 2, current: 0 },
    nbu_letter: { min: 2, max: 4, current: 0 },
    nbu_resolution: { min: 1, max: 2, current: 0 },
    international: { min: 2, max: 4, current: 0 },
    cmu_total: { max: 6, current: 0 },
    defense: { min: 4, current: 0 },
  };
  
  const goldenSet: DiverseCandidate[] = [];
  const usedNregs = new Set<string>();
  
  // Спочатку додаємо pinned candidates
  const pinned = candidates.filter(c => c.selection_reason?.startsWith('pinned:'));
  for (const candidate of pinned) {
    if (usedNregs.has(candidate.nreg)) continue;
    goldenSet.push(candidate);
    usedNregs.add(candidate.nreg);
    updateQuota(quotas, candidate);
  }
  
  // Сортуємо решту за diversity_score
  const remaining = candidates
    .filter(c => !usedNregs.has(c.nreg))
    .sort((a, b) => b.diversity_score - a.diversity_score);
  
  // Додаємо за квотами
  for (const candidate of remaining) {
    if (goldenSet.length >= 30) break;
    
    const slug = candidate.predicted_slug;
    const quota = getQuotaForSlug(quotas, slug, candidate);
    
    if (quota && quota.current < quota.max) {
      goldenSet.push(candidate);
      usedNregs.add(candidate.nreg);
      updateQuota(quotas, candidate);
    } else if (!quota) {
      // Додаємо якщо не перевищуємо загальні обмеження
      if (slug.startsWith('cmu_') && quotas.cmu_total.current >= quotas.cmu_total.max) {
        continue;
      }
      goldenSet.push(candidate);
      usedNregs.add(candidate.nreg);
      updateQuota(quotas, candidate);
    }
  }
  
  // Перевіряємо квоти
  console.log('📊 Квоти після формування:');
  for (const [key, quota] of Object.entries(quotas)) {
    if (key === 'defense') {
      const q = quota as { min: number; current: number };
      const status = q.current >= q.min ? '✅' : '❌';
      console.log(`   ${key}: ${q.current}/${q.min} ${status}`);
    } else if (key === 'cmu_total') {
      const q = quota as { max: number; current: number };
      console.log(`   ${key}: ${q.current}/${q.max}`);
    } else {
      const q = quota as { min: number; max: number; current: number };
      const status = q.current >= q.min ? '✅' : '❌';
      console.log(`   ${key}: ${q.current}/${q.min}-${q.max} ${status}`);
    }
  }
  console.log('');
  
  return goldenSet;
}

function getQuotaForSlug(quotas: any, slug: string, candidate: DiverseCandidate): any {
  if (slug === 'presidential_decree') return quotas.presidential_decree;
  if (slug === 'presidential_order') return quotas.presidential_order;
  if (slug === 'rnbo_decision') return quotas.rnbo_decision;
  if (slug === 'vr_speaker_order') return quotas.vr_speaker_order;
  if (slug === 'vr_resolution') return quotas.vr_resolution;
  if (slug === 'cec_resolution') return quotas.cec_resolution;
  if (slug === 'ccu_opinion') return quotas.ccu_opinion;
  if (slug === 'ccu_decision') return quotas.ccu_decision;
  if (slug === 'nbu_letter') return quotas.nbu_letter;
  if (slug === 'nbu_resolution') return quotas.nbu_resolution;
  if (candidate.organ_signal === 'INTERNATIONAL') return quotas.international;
  if (candidate.organ_signal === 'DEFENSE') return quotas.defense;
  return null;
}

function updateQuota(quotas: any, candidate: DiverseCandidate): void {
  const slug = candidate.predicted_slug;
  
  if (slug === 'presidential_decree') quotas.presidential_decree.current++;
  else if (slug === 'presidential_order') quotas.presidential_order.current++;
  else if (slug === 'rnbo_decision') quotas.rnbo_decision.current++;
  else if (slug === 'vr_speaker_order') quotas.vr_speaker_order.current++;
  else if (slug === 'vr_resolution') quotas.vr_resolution.current++;
  else if (slug === 'cec_resolution') quotas.cec_resolution.current++;
  else if (slug === 'ccu_opinion') quotas.ccu_opinion.current++;
  else if (slug === 'ccu_decision') quotas.ccu_decision.current++;
  else if (slug === 'nbu_letter') quotas.nbu_letter.current++;
  else if (slug === 'nbu_resolution') quotas.nbu_resolution.current++;
  
  if (slug.startsWith('cmu_')) quotas.cmu_total.current++;
  if (candidate.organ_signal === 'INTERNATIONAL') quotas.international.current++;
  if (candidate.organ_signal === 'DEFENSE') quotas.defense.current++;
}

/**
 * Головна функція
 */
export async function collectDiverseCandidatesV2(options?: {
  outputPath?: string;
}): Promise<DiverseCandidate[]> {
  const { outputPath } = options || {};
  
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Collect Diverse Candidates V2 — PHASE 2 REWORK`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  
  const rada = new RadaClient();
  const supabase = createSupabaseAdminClient();
  
  // Отримуємо існуючі nreg
  const { data: existingDocs } = await supabase
    .from('legislation_documents')
    .select('rada_nreg');
  const existingNregs = new Set(existingDocs?.map(d => d.rada_nreg) || []);
  console.log(`📋 Виключено ${existingNregs.size} існуючих документів\n`);
  
  // SOURCE 1: Feed
  const feedCandidates = await collectFromFeed(rada, existingNregs, 2000);
  
  // SOURCE 2: Keyword mining
  const keywordCandidates = await collectFromKeywords(feedCandidates, rada, existingNregs);
  
  // SOURCE 3: Known hard seeds
  const seedCandidates = await collectKnownHardSeeds(feedCandidates, rada, existingNregs);
  
  // Об'єднуємо всі кандидати
  const allCandidates = [...keywordCandidates, ...seedCandidates];
  
  // Завантажуємо snippet для топ-60
  await enrichWithSnippet(allCandidates, rada, 60);
  
  // Формуємо golden set з квотами
  const goldenSet = formGoldenSetWithQuotas(allCandidates);
  
  // Зберігаємо
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
      selection_reason: c.selection_reason,
      summary_prefix: c.summary_prefix,
      snippet15: c.snippet15,
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
  console.log(`💾 Збережено у ${finalOutputPath}\n`);
  
  return goldenSet;
}
