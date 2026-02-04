/**
 * Collect Diverse Candidates Fast — PHASE 2 (оптимізована версія)
 * 
 * Використовує існуючий список кандидатів + обробляє їх з diversity scoring
 */

import { RadaClient } from '../lib/radaClient.js';
import { createSupabaseAdminClient } from '../lib/supabaseAdmin.js';
import { guessDocumentTypeV2 } from '../documentTypes/guessDocumentTypeV2.js';
import { detectPrefixClass, detectOrganSignal, DiverseCandidate, formDiverseBatch } from './collect-diverse-candidates.js';
import { writeFile } from 'fs/promises';
import { resolve } from 'path';
import { readFile } from 'fs/promises';

/**
 * Обчислює diversity score (копія з collect-diverse-candidates.ts)
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
 * Швидкий збір golden diversity set з існуючого списку
 */
export async function collectGoldenDiversitySetFast(options?: {
  minCandidates?: number;
  inputFile?: string;
  outputPath?: string;
}): Promise<DiverseCandidate[]> {
  const { minCandidates = 30, inputFile, outputPath } = options || {};
  
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Golden Diversity Set Fast — PHASE 2.3`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  
  const rada = new RadaClient();
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
  
  // Обробляємо кандидатів (швидко, без TXT на першому проході)
  console.log(`🔍 Обробляємо кандидатів...\n`);
  const candidates: DiverseCandidate[] = [];
  let processed = 0;
  
  for (const nreg of allNregs) {
    try {
      const jsonData = await rada.fetchJson(nreg);
      if (!jsonData || !jsonData.nazva) continue;
      
      const title = jsonData.nazva;
      const document_number = jsonData.n_vlas || nreg;
      
      // Швидкий прохід: використовуємо тільки title для prefix class
      const guess = guessDocumentTypeV2({
        title,
        typ: jsonData.typ,
        typn: jsonData.typn,
        organs: jsonData.organs,
        stru: jsonData.stru,
        snippet: null,
        summary: null,
        document_number: document_number,
      });
      
      // Визначаємо prefix class та organ signal з title
      const prefix_class = detectPrefixClass(null, title); // Використовуємо title як summary
      const organ_signal = detectOrganSignal(title);
      
      const candidate: DiverseCandidate = {
        nreg,
        title,
        document_number,
        typ: jsonData.typ,
        typn: jsonData.typn,
        organs: jsonData.organs,
        predicted_slug: guess.slug,
        prefix_class,
        organ_signal,
        diversity_score: 0,
        selection_reason: '',
      };
      
      candidate.diversity_score = calculateDiversityScore(candidate);
      candidates.push(candidate);
      
      processed++;
      if (processed % 20 === 0) {
        process.stdout.write(`\r   Оброблено: ${processed}/${allNregs.length}`);
      }
    } catch (e) {
      // Пропускаємо помилки
      continue;
    }
  }
  
  console.log(`\n✅ Оброблено ${processed} кандидатів\n`);
  
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
  
  // Додаємо решту до minCandidates
  for (const candidate of candidates) {
    if (goldenSet.length >= minCandidates) break;
    if (usedPrefixClasses.has(candidate.prefix_class as string)) continue;
    if (usedOrgans.has(candidate.organ_signal as string) && goldenSet.length >= minCandidates * 0.7) continue;
    
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
      `${candidate.nreg.padEnd(10)} | ${titlePrefix} | ${candidate.predicted_slug.padEnd(15)} | ${(candidate.prefix_class as string).padEnd(13)} | ${(candidate.organ_signal as string).padEnd(5)} | ${candidate.diversity_score}`
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
      selection_reason: c.selection_reason,
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
