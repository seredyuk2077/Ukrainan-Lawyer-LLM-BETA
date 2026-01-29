/**
 * Collect Diverse Candidates V3 — PHASE 2.1 REWORK
 * 
 * Двоетапна модель: Stage A (ZERO API) + Stage B (LIMITED API)
 */

import { RadaClient } from '../lib/radaClient.js';
import { createSupabaseAdminClient } from '../lib/supabaseAdmin.js';
import { guessDocumentTypeV2 } from '../documentTypes/guessDocumentTypeV2.js';
import { detectPrefixClass, detectOrganSignal, DiverseCandidate } from './collect-diverse-candidates.js';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve } from 'path';

interface StageACandidate {
  nreg: string;
  matched_patterns: string[];
  source: string;
}

interface StageBCandidate extends DiverseCandidate {
  matched_patterns: string[];
  confidence: 'high' | 'medium';
  reasons: string[];
}

interface Metrics {
  stageA: {
    total_extracted_nreg: number;
    after_dedupe: number;
    after_exclude_existing: number;
    count_by_pattern: Record<string, number>;
  };
  stageB: {
    shortlist_size: number;
    enriched_count: number;
    cache_hits: number;
    api_calls: number;
  };
  goldenSet: {
    total: number;
    quota_status: Record<string, { current: number; min?: number; max?: number; status: 'ok' | 'missing' }>;
  };
}

/**
 * Stage A: Збір nreg з r.txt через regex/patterns (ZERO API)
 */
async function stageA_ExtractNregs(
  rada: RadaClient,
  existingNregs: Set<string>,
  limit: number = 5000
): Promise<{ candidates: StageACandidate[]; metrics: Metrics['stageA'] }> {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('Stage A: Extraction з r.txt (ZERO API)');
  console.log('═══════════════════════════════════════════════════════════\n');
  
  // Завантажуємо r.txt
  console.log('📥 Завантажуємо r.txt...');
  const rTxt = await rada.fetchRTxt();
  const lines = rTxt.split('\n').slice(0, limit);
  console.log(`✅ Завантажено ${lines.length} рядків\n`);
  
  // Патерни для витягування nreg (без глобального флагу для test)
  const patterns = {
    presidential_order: /[0-9]+\/[0-9]{4}-рп/i,
    vr_speaker_order: /[0-9]+\/[0-9]{2,4}-рг/i,
    cmu_resolution: /[0-9]+-[0-9]{4}-п/i,
    cmu_order: /[0-9]+-[0-9]{4}-р/i,
    presidential_decree: /^[0-9]+\/[0-9]{4}$/,
    international: /[0-9]{3,4}_[0-9]+/i,
    ccu_candidate: /^(nb|v0)[0-9]+-[0-9]{2,4}/i,
    nbu_candidate: /^n[0-9]{6,}-[0-9]{2,4}/i,
  };
  
  const candidates: StageACandidate[] = [];
  const seenNregs = new Set<string>();
  const countByPattern: Record<string, number> = {};
  
  // Витягуємо nreg з кожного рядка
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    
    // Пробуємо витягти nreg (перший токен)
    const parts = trimmed.split(/\s+/);
    const nreg = parts[0];
    
    if (!nreg || nreg.length < 2 || !/\d/.test(nreg)) continue;
    if (seenNregs.has(nreg)) continue;
    if (existingNregs.has(nreg)) continue;
    
    seenNregs.add(nreg);
    
    // Перевіряємо патерни (використовуємо match() замість test() щоб уникнути проблем з lastIndex)
    const matched: string[] = [];
    const nregUpper = nreg.toUpperCase();
    
    if (nreg.match(patterns.presidential_order)) {
      matched.push('presidential_order');
      countByPattern['presidential_order'] = (countByPattern['presidential_order'] || 0) + 1;
    }
    if (nreg.match(patterns.vr_speaker_order)) {
      matched.push('vr_speaker_order');
      countByPattern['vr_speaker_order'] = (countByPattern['vr_speaker_order'] || 0) + 1;
    }
    if (nreg.match(patterns.cmu_resolution)) {
      matched.push('cmu_resolution');
      countByPattern['cmu_resolution'] = (countByPattern['cmu_resolution'] || 0) + 1;
    }
    if (nreg.match(patterns.cmu_order)) {
      matched.push('cmu_order');
      countByPattern['cmu_order'] = (countByPattern['cmu_order'] || 0) + 1;
    }
    if (nreg.match(patterns.presidential_decree)) {
      matched.push('presidential_decree');
      countByPattern['presidential_decree'] = (countByPattern['presidential_decree'] || 0) + 1;
    }
    if (nreg.match(patterns.international)) {
      matched.push('international');
      countByPattern['international'] = (countByPattern['international'] || 0) + 1;
    }
    if (nreg.match(patterns.ccu_candidate)) {
      matched.push('ccu_candidate');
      countByPattern['ccu_candidate'] = (countByPattern['ccu_candidate'] || 0) + 1;
    }
    if (nreg.match(patterns.nbu_candidate)) {
      matched.push('nbu_candidate');
      countByPattern['nbu_candidate'] = (countByPattern['nbu_candidate'] || 0) + 1;
    }
    
    // Якщо є хоча б один match або це просто валідний nreg
    if (matched.length > 0 || nreg.match(/^[0-9\/а-яА-Я-]+$/)) {
      candidates.push({
        nreg,
        matched_patterns: matched.length > 0 ? matched : ['generic'],
        source: 'r.txt',
      });
    }
  }
  
  const metrics: Metrics['stageA'] = {
    total_extracted_nreg: seenNregs.size,
    after_dedupe: candidates.length,
    after_exclude_existing: candidates.length,
    count_by_pattern: countByPattern,
  };
  
  console.log(`📊 Stage A Metrics:`);
  console.log(`   Total extracted: ${metrics.total_extracted_nreg}`);
  console.log(`   After dedupe: ${metrics.after_dedupe}`);
  console.log(`   After exclude existing: ${metrics.after_exclude_existing}`);
  console.log(`\n📊 Count by pattern:`);
  for (const [pattern, count] of Object.entries(countByPattern)) {
    console.log(`   ${pattern}: ${count}`);
  }
  console.log('');
  
  return { candidates, metrics };
}

/**
 * Stage B: Enrichment тільки для shortlist (LIMITED API)
 */
async function stageB_EnrichShortlist(
  stageACandidates: StageACandidate[],
  rada: RadaClient,
  cacheDir: string
): Promise<{ candidates: StageBCandidate[]; metrics: Metrics['stageB'] }> {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('Stage B: Enrichment для shortlist (LIMITED API)');
  console.log('═══════════════════════════════════════════════════════════\n');
  
  // Формуємо shortlist по квотах
  const shortlists: Record<string, StageACandidate[]> = {
    presidential_order: stageACandidates.filter(c => c.matched_patterns.includes('presidential_order')).slice(0, 10),
    vr_speaker_order: stageACandidates.filter(c => c.matched_patterns.includes('vr_speaker_order')).slice(0, 10),
    international: stageACandidates.filter(c => c.matched_patterns.includes('international')).slice(0, 20),
    ccu_candidate: stageACandidates.filter(c => c.matched_patterns.includes('ccu_candidate')).slice(0, 20),
    nbu_candidate: stageACandidates.filter(c => c.matched_patterns.includes('nbu_candidate')).slice(0, 20),
    presidential_decree: stageACandidates.filter(c => c.matched_patterns.includes('presidential_decree')).slice(0, 15),
    cmu_resolution: stageACandidates.filter(c => c.matched_patterns.includes('cmu_resolution')).slice(0, 10),
    cmu_order: stageACandidates.filter(c => c.matched_patterns.includes('cmu_order')).slice(0, 10),
    generic: stageACandidates.filter(c => c.matched_patterns.includes('generic')).slice(0, 50),
  };
  
  const totalShortlist = Object.values(shortlists).flat().length;
  console.log(`📋 Shortlist size: ${totalShortlist}\n`);
  
  // Об'єднуємо та дедуплікуємо
  const shortlistMap = new Map<string, StageACandidate>();
  for (const list of Object.values(shortlists)) {
    for (const candidate of list) {
      if (!shortlistMap.has(candidate.nreg)) {
        shortlistMap.set(candidate.nreg, candidate);
      }
    }
  }
  
  const uniqueShortlist = Array.from(shortlistMap.values());
  console.log(`📋 Unique shortlist: ${uniqueShortlist.length}\n`);
  
  // Enrichment з кешем
  const enriched: StageBCandidate[] = [];
  let cacheHits = 0;
  let apiCalls = 0;
  
  // Створюємо cache dir
  await mkdir(cacheDir, { recursive: true });
  
  for (const candidate of uniqueShortlist) {
    const cachePath = resolve(cacheDir, `${candidate.nreg.replace(/[\/\\]/g, '_')}.json`);
    
    let enrichedData: any = null;
    
    // Перевіряємо кеш
    if (existsSync(cachePath)) {
      try {
        const cached = await readFile(cachePath, 'utf-8');
        enrichedData = JSON.parse(cached);
        cacheHits++;
      } catch (e) {
        // Кеш пошкоджений, продовжуємо
      }
    }
    
    // Якщо немає в кеші — робимо API call
    if (!enrichedData) {
      try {
        apiCalls++;
        const jsonData = await rada.fetchJson(candidate.nreg);
        if (!jsonData || !jsonData.nazva) continue;
        
        const document_number = jsonData.n_vlas || candidate.nreg;
        
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
        
        // Пробуємо отримати snippet15 (тільки для топ-кандидатів)
        let snippet15: string | null = null;
        let summary_prefix: string | null = null;
        
        if (enriched.length < 80) {
          try {
            const txt = await rada.fetchTxt(candidate.nreg);
            if (txt) {
              snippet15 = txt.substring(0, 15).trim();
              summary_prefix = txt.substring(0, 200).trim();
              
              // Оновлюємо prefix_class та organ_signal з snippet
              const updatedPrefixClass = detectPrefixClass(snippet15, summary_prefix);
              const updatedOrganSignal = detectOrganSignal(jsonData.nazva, summary_prefix, snippet15);
              
              enrichedData = {
                nreg: candidate.nreg,
                title: jsonData.nazva,
                document_number,
                typ: jsonData.typ,
                typn: jsonData.typn,
                organs: jsonData.organs,
                predicted_slug: guess.slug,
                prefix_class: updatedPrefixClass || prefix_class,
                organ_signal: updatedOrganSignal || organ_signal,
                snippet15,
                summary_prefix,
                matched_patterns: candidate.matched_patterns,
                confidence: 'high' as const,
                reasons: candidate.matched_patterns,
              };
            }
          } catch (e) {
            // TXT недоступний, використовуємо тільки JSON
          }
        }
        
        if (!enrichedData) {
          enrichedData = {
            nreg: candidate.nreg,
            title: jsonData.nazva,
            document_number,
            typ: jsonData.typ,
            typn: jsonData.typn,
            organs: jsonData.organs,
            predicted_slug: guess.slug,
            prefix_class,
            organ_signal,
            matched_patterns: candidate.matched_patterns,
            confidence: 'medium' as const,
            reasons: candidate.matched_patterns,
          };
        }
        
        // Зберігаємо в кеш
        await writeFile(cachePath, JSON.stringify(enrichedData, null, 2), 'utf-8');
      } catch (e) {
        // Пропускаємо помилки
        continue;
      }
    }
    
    if (enrichedData) {
      enriched.push(enrichedData as StageBCandidate);
    }
    
    if (enriched.length % 10 === 0) {
      process.stdout.write(`\r   Оброблено: ${enriched.length}/${uniqueShortlist.length}`);
    }
  }
  
  console.log(`\n✅ Enriched: ${enriched.length}`);
  console.log(`   Cache hits: ${cacheHits}`);
  console.log(`   API calls: ${apiCalls}\n`);
  
  const metrics: Metrics['stageB'] = {
    shortlist_size: uniqueShortlist.length,
    enriched_count: enriched.length,
    cache_hits: cacheHits,
    api_calls: apiCalls,
  };
  
  return { candidates: enriched, metrics };
}

/**
 * Quota solver для формування golden set
 */
function solveQuotas(candidates: StageBCandidate[]): { goldenSet: StageBCandidate[]; metrics: Metrics['goldenSet'] } {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('Quota Solver: Формування golden set');
  console.log('═══════════════════════════════════════════════════════════\n');
  
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
  
  const goldenSet: StageBCandidate[] = [];
  const usedNregs = new Set<string>();
  const usedSlugs = new Map<string, number>();
  const usedOrgans = new Map<string, number>();
  
  // Сортуємо кандидатів за пріоритетом (рідкісні спочатку)
  const priority = [
    'international', 'ccu_opinion', 'ccu_decision', 'cec_resolution', 'rnbo_decision',
    'nbu_letter', 'nbu_resolution', 'vr_resolution', 'vr_speaker_order',
    'presidential_order', 'presidential_decree', 'cmu_resolution', 'cmu_order',
  ];
  
  const sorted = [...candidates].sort((a, b) => {
    const aPriority = priority.findIndex(p => a.predicted_slug.includes(p) || a.matched_patterns.includes(p));
    const bPriority = priority.findIndex(p => b.predicted_slug.includes(p) || b.matched_patterns.includes(p));
    if (aPriority !== bPriority) return aPriority - bPriority;
    return (b.confidence === 'high' ? 1 : 0) - (a.confidence === 'high' ? 1 : 0);
  });
  
  // Заповнюємо квоти
  for (const candidate of sorted) {
    if (goldenSet.length >= 30) break;
    if (usedNregs.has(candidate.nreg)) continue;
    
    const slug = candidate.predicted_slug;
    const organ = candidate.organ_signal as string;
    
    // Перевіряємо квоти
    const quota = getQuotaForSlug(quotas, slug, candidate);
    if (quota && quota.current >= quota.max) continue;
    
    // Перевіряємо uniqueness
    const slugCount = usedSlugs.get(slug) || 0;
    if (slugCount >= 2 && !slug.startsWith('cmu_')) continue;
    
    const organCount = usedOrgans.get(organ) || 0;
    if (organCount >= 2 && organ !== 'CMU') continue;
    
    // Додаємо
    goldenSet.push(candidate);
    usedNregs.add(candidate.nreg);
    usedSlugs.set(slug, slugCount + 1);
    usedOrgans.set(organ, organCount + 1);
    updateQuota(quotas, candidate);
  }
  
  // Перевіряємо квоти
  const quotaStatus: Record<string, { current: number; min?: number; max?: number; status: 'ok' | 'missing' }> = {};
  for (const [key, quota] of Object.entries(quotas)) {
    if (key === 'cmu_total') {
      const q = quota as { max: number; current: number };
      quotaStatus[key] = { current: q.current, max: q.max, status: q.current <= q.max ? 'ok' : 'missing' };
    } else if (key === 'defense') {
      const q = quota as { min: number; current: number };
      quotaStatus[key] = { current: q.current, min: q.min, status: q.current >= q.min ? 'ok' : 'missing' };
    } else {
      const q = quota as { min: number; max: number; current: number };
      quotaStatus[key] = { current: q.current, min: q.min, max: q.max, status: q.current >= q.min && q.current <= q.max ? 'ok' : 'missing' };
    }
  }
  
  console.log('📊 Quota Status:');
  for (const [key, status] of Object.entries(quotaStatus)) {
    const icon = status.status === 'ok' ? '✅' : '❌';
    if (status.min !== undefined && status.max !== undefined) {
      console.log(`   ${icon} ${key}: ${status.current}/${status.min}-${status.max}`);
    } else if (status.min !== undefined) {
      console.log(`   ${icon} ${key}: ${status.current}/${status.min}`);
    } else {
      console.log(`   ${icon} ${key}: ${status.current}/${status.max}`);
    }
  }
  console.log('');
  
  const metrics: Metrics['goldenSet'] = {
    total: goldenSet.length,
    quota_status: quotaStatus,
  };
  
  return { goldenSet, metrics };
}

function getQuotaForSlug(quotas: any, slug: string, candidate: StageBCandidate): any {
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

function updateQuota(quotas: any, candidate: StageBCandidate): void {
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
export async function collectDiverseCandidatesV3(options?: {
  outputPath?: string;
  runsDir?: string;
}): Promise<{ goldenSet: StageBCandidate[]; metrics: Metrics }> {
  const { outputPath, runsDir } = options || {};
  
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Collect Diverse Candidates V3 — PHASE 2.1 REWORK`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  
  const rada = new RadaClient();
  const supabase = createSupabaseAdminClient();
  
  // Отримуємо існуючі nreg
  const { data: existingDocs } = await supabase
    .from('legislation_documents')
    .select('rada_nreg');
  const existingNregs = new Set(existingDocs?.map(d => d.rada_nreg) || []);
  console.log(`📋 Виключено ${existingNregs.size} існуючих документів\n`);
  
  // Stage A
  const { candidates: stageACandidates, metrics: stageAMetrics } = await stageA_ExtractNregs(rada, existingNregs, 5000);
  
  if (stageACandidates.length < 200) {
    console.warn(`⚠️  WARN: Stage A дає лише ${stageACandidates.length} кандидатів. Розширюємо до 20000 рядків...\n`);
    const { candidates: moreCandidates, metrics: moreMetrics } = await stageA_ExtractNregs(rada, existingNregs, 20000);
    stageACandidates.push(...moreCandidates);
    Object.assign(stageAMetrics, moreMetrics);
  }
  
  // Stage B
  const cacheDir = runsDir || resolve(process.cwd(), 'scripts/legislation/runs/diverse_cache');
  const { candidates: stageBCandidates, metrics: stageBMetrics } = await stageB_EnrichShortlist(stageACandidates, rada, cacheDir);
  
  // Quota solver
  const { goldenSet, metrics: goldenMetrics } = solveQuotas(stageBCandidates);
  
  // Зберігаємо
  const finalOutputPath = outputPath || resolve(process.cwd(), 'scripts/legislation/runs/diverse/golden_diversity_set.json');
  const metricsPath = resolve(process.cwd(), 'scripts/legislation/runs/diverse/metrics.json');
  const runsDiverseDir = resolve(process.cwd(), 'scripts/legislation/runs/diverse');
  
  await mkdir(runsDiverseDir, { recursive: true });
  
  const output = {
    candidates: goldenSet.map(c => ({
      nreg: c.nreg,
      title: c.title,
      document_number: c.document_number,
      predicted_slug: c.predicted_slug,
      prefix_class: c.prefix_class,
      organ_signal: c.organ_signal,
      diversity_score: c.diversity_score || 0,
      selection_reason: c.selection_reason || c.reasons.join(', '),
      summary_prefix: c.summary_prefix,
      snippet15: c.snippet15,
      matched_patterns: c.matched_patterns,
      confidence: c.confidence,
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
  
  const metrics: Metrics = {
    stageA: stageAMetrics,
    stageB: stageBMetrics,
    goldenSet: goldenMetrics,
  };
  
  await writeFile(metricsPath, JSON.stringify(metrics, null, 2), 'utf-8');
  
  console.log(`💾 Збережено:`);
  console.log(`   Golden set: ${finalOutputPath}`);
  console.log(`   Metrics: ${metricsPath}\n`);
  
  return { goldenSet, metrics };
}
