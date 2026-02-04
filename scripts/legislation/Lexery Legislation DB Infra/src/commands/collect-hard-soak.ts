/**
 * Hard Soak Collector — збір 50 складних документів для тестування
 * 
 * PHASE 3: Підбір максимально підступних типів документів для stress-test
 */

import { RadaClient } from '../lib/radaClient.js';
import { writeFile } from 'fs/promises';
import { resolve } from 'path';

interface HardSoakCandidate {
  nreg: string;
  title: string;
  typ?: number;
  typn?: string;
  organs?: any;
  hardness_score: number;
  hardness_reasons: string[];
  issuer_family?: string;
  type_family?: string;
}

/**
 * Ранжує "складність" документа
 */
function calculateHardnessScore(doc: {
  typ?: number;
  typn?: string;
  organs?: any;
  title: string;
}): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  
  const lowerTitle = doc.title.toLowerCase();
  
  // Typ не з базових (1=law, 2=resolution, 21=code, 216=constitution)
  if (doc.typ && ![1, 2, 21, 216].includes(doc.typ)) {
    score += 3;
    reasons.push(`typ=${doc.typ} (нестандартний)`);
  }
  
  // Organs нестандартні або відсутні
  if (!doc.organs || doc.organs === '' || doc.organs === null) {
    score += 2;
    reasons.push('organs відсутні');
  } else if (typeof doc.organs === 'string' && !doc.organs.match(/^[0-9]+:/)) {
    score += 2;
    reasons.push('organs нестандартний формат');
  }
  
  // Title/summary містить складні слова
  const complexWords = [
    'рішення', 'постанова', 'розпорядження', 'повідомлення', 'лист',
    'указ', 'протокол', 'конвенція', 'пакт', 'статут', 'договір'
  ];
  const foundWords = complexWords.filter(w => lowerTitle.includes(w));
  if (foundWords.length > 0) {
    score += foundWords.length;
    reasons.push(`складні слова: ${foundWords.join(', ')}`);
  }
  
  // Issuer-сигнали
  const issuers = ['нбу', 'цвк', 'рнбо', 'президент', 'ксу', 'кму', 'вру'];
  const foundIssuers = issuers.filter(i => lowerTitle.includes(i));
  if (foundIssuers.length > 0) {
    score += foundIssuers.length * 2;
    reasons.push(`issuer: ${foundIssuers.join(', ')}`);
  }
  
  return { score, reasons };
}

/**
 * Визначає issuer family
 */
function detectIssuerFamily(doc: { title: string; organs?: any }): string | undefined {
  const lowerTitle = doc.title.toLowerCase();
  const organsStr = typeof doc.organs === 'string' ? doc.organs.toLowerCase() : '';
  
  if (lowerTitle.includes('нбу') || lowerTitle.includes('національний банк') || organsStr.includes('нбу')) {
    return 'NBU';
  }
  if (lowerTitle.includes('цвк') || lowerTitle.includes('центральна виборча') || organsStr.includes('цвк')) {
    return 'CEC';
  }
  if (lowerTitle.includes('рнбо') || lowerTitle.includes('рада національної безпеки')) {
    return 'RNBO';
  }
  if (lowerTitle.includes('президент') || lowerTitle.includes('указ')) {
    return 'PRESIDENT';
  }
  if (lowerTitle.includes('кму') || lowerTitle.includes('кабінет міністрів')) {
    return 'CMU';
  }
  if (lowerTitle.includes('вру') || lowerTitle.includes('верховна рада')) {
    return 'VRU';
  }
  if (lowerTitle.includes('ксу') || lowerTitle.includes('конституційний суд')) {
    return 'CCU';
  }
  if (lowerTitle.includes('конвенція') || lowerTitle.includes('протокол') || lowerTitle.includes('договір')) {
    return 'INTERNATIONAL';
  }
  
  return undefined;
}

/**
 * Визначає type family
 */
function detectTypeFamily(doc: { title: string; typ?: number }): string | undefined {
  const lowerTitle = doc.title.toLowerCase();
  
  if (lowerTitle.includes('лист') || lowerTitle.includes('повідомлення')) {
    return 'LETTER';
  }
  if (lowerTitle.includes('рішення')) {
    return 'DECISION';
  }
  if (lowerTitle.includes('постанова')) {
    return 'RESOLUTION';
  }
  if (lowerTitle.includes('розпорядження')) {
    return 'ORDER';
  }
  if (lowerTitle.includes('указ')) {
    return 'DECREE';
  }
  if (lowerTitle.includes('конвенція')) {
    return 'CONVENTION';
  }
  if (lowerTitle.includes('протокол')) {
    return 'PROTOCOL';
  }
  if (lowerTitle.includes('окрема думка')) {
    return 'OPINION';
  }
  
  return undefined;
}

export async function collectHardSoak(options?: {
  limit?: number;
  outputPath?: string;
  excludeExisting?: boolean;
}): Promise<string[]> {
  const { limit = 50, outputPath, excludeExisting = true } = options || {};
  
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Hard Soak Collector — збір ${limit} складних документів`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  
  const rada = new RadaClient();
  const candidates: HardSoakCandidate[] = [];
  
  // Отримуємо існуючі nreg з Supabase (якщо excludeExisting)
  let existingNregs: Set<string> = new Set();
  if (excludeExisting) {
    const { createSupabaseAdminClient } = await import('../lib/supabaseAdmin.js');
    const supabase = createSupabaseAdminClient();
    const { data: existingDocs } = await supabase
      .from('legislation_documents')
      .select('rada_nreg');
    if (existingDocs) {
      existingNregs = new Set(existingDocs.map(d => d.rada_nreg));
      console.log(`📋 Виключено ${existingNregs.size} існуючих документів\n`);
    }
  }
  
  // Читаємо статичний список як основу
  const existingSoakPath = resolve(process.env.LEXERY_LEGISLATION_WORKSPACE_ROOT || process.cwd(), 'data', 'soak_nregs.txt');
  let feedNregs: string[] = [];
  try {
    const { readFile } = await import('fs/promises');
    const content = await readFile(existingSoakPath, 'utf-8');
    feedNregs = content.split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));
  } catch (e) {
    // Файл не існує — починаємо з feed
  }
  
  // PHASE 3.1: Feed-only збір (швидкий, без card-json)
  console.log('📥 Завантажуємо feed з Rada (r.txt)...');
  const feedCandidates: Array<{ nreg: string; title?: string; pre_score: number }> = [];
  
  try {
    const feedUrl = 'https://data.rada.gov.ua/laws/main/r.txt';
    const feedResponse = await fetch(feedUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10000),
    });
    
    if (feedResponse.ok) {
      const feedText = await feedResponse.text();
      const feedLines = feedText.split('\n')
        .map(line => {
          const parts = line.trim().split(/\s+/);
          const nreg = parts[0];
          const title = parts.slice(1).join(' ').trim();
          return { nreg, title };
        })
        .filter(item => item.nreg && item.nreg.length > 2 && /\d/.test(item.nreg))
        .filter(item => !existingNregs.has(item.nreg));
      
      console.log(`✅ Отримано ${feedLines.length} нових nreg з feed\n`);
      
      // PHASE 3.1: Hardness pre-score на feed-only (дешево)
      for (const item of feedLines) {
        const lowerTitle = (item.title || '').toLowerCase();
        let preScore = 0;
        
        // Складні слова
        const complexWords = [
          'рішення', 'указ', 'розпорядження', 'постанова', 'лист', 'повідомлення',
          'конвенція', 'пакт', 'статут', 'протокол', 'договір'
        ];
        const foundWords = complexWords.filter(w => lowerTitle.includes(w));
        preScore += foundWords.length * 2;
        
        // Issuer-сигнали
        const issuers = ['рнбо', 'цвк', 'нбу', 'ксу', 'президент', 'кму', 'вру'];
        const foundIssuers = issuers.filter(i => lowerTitle.includes(i));
        preScore += foundIssuers.length * 3;
        
        feedCandidates.push({
          nreg: item.nreg,
          title: item.title,
          pre_score: preScore,
        });
      }
      
      // Сортуємо за pre_score
      feedCandidates.sort((a, b) => b.pre_score - a.pre_score);
      console.log(`📊 Pre-scored ${feedCandidates.length} кандидатів\n`);
    }
  } catch (e) {
    console.warn(`⚠️  Помилка завантаження feed: ${e instanceof Error ? e.message : String(e)}\n`);
  }
  
  // Беремо top 80-120 для точкового збагачення
  const topCandidates = feedCandidates.slice(0, Math.min(120, feedCandidates.length));
  console.log(`🎯 Вибрано ${topCandidates.length} топ-кандидатів для збагачення\n`);
  
  // PHASE 3.2: Точкове збагачення top 80-120 (card-json fetch)
  console.log('📥 Збагачуємо топ-кандидатів (card-json fetch)...\n');
  const seenNregs = new Set<string>();
  const issuerFamilyCounts: Record<string, number> = {};
  const typeFamilyCounts: Record<string, number> = {};
  
  for (const item of topCandidates) {
    if (seenNregs.has(item.nreg)) continue;
    if (candidates.length >= limit * 2) break; // Зупиняємося коли маємо достатньо кандидатів
    
    seenNregs.add(item.nreg);
    
    try {
      // Fetch metadata (card-json)
      const jsonData = await rada.fetchJson(item.nreg);
      
      // Отримуємо snippet (перші 200 символів txt, якщо доступно) - ОПТИМІЗАЦІЯ: тільки для топ-кандидатів
      let snippet = '';
      // Пропускаємо TXT fetch для швидкості - використовуємо тільки title для hardness
      // TXT буде завантажено під час імпорту
      
      const hardness = calculateHardnessScore({
        typ: jsonData.typ,
        typn: jsonData.typn,
        organs: jsonData.organs,
        title: jsonData.nazva || item.title || '',
      });
      
      // Додаткові бали за title (якщо містить додатки/таблиці)
      const lowerTitle = (jsonData.nazva || item.title || '').toLowerCase();
      if (lowerTitle.includes('додаток') || lowerTitle.includes('таблиця') || 
          lowerTitle.includes('форма') || lowerTitle.includes('перелік') ||
          lowerTitle.includes('додатки')) {
        hardness.score += 2;
        hardness.reasons.push('title: додатки/таблиці');
      }
      
      const issuerFamily = detectIssuerFamily({
        title: jsonData.nazva || item.title || '',
        organs: jsonData.organs,
      });
      const typeFamily = detectTypeFamily({
        title: jsonData.nazva || item.title || '',
        typ: jsonData.typ,
      });
      
      candidates.push({
        nreg: item.nreg,
        title: jsonData.nazva || item.title || '',
        typ: jsonData.typ,
        typn: jsonData.typn,
        organs: jsonData.organs,
        hardness_score: hardness.score,
        hardness_reasons: hardness.reasons,
        issuer_family: issuerFamily,
        type_family: typeFamily,
      });
      
      if (issuerFamily) issuerFamilyCounts[issuerFamily] = (issuerFamilyCounts[issuerFamily] || 0) + 1;
      if (typeFamily) typeFamilyCounts[typeFamily] = (typeFamilyCounts[typeFamily] || 0) + 1;
      
      // Показуємо прогрес кожні 10 документів
      if (candidates.length % 10 === 0) {
        console.log(`  Збагачено ${candidates.length} кандидатів...`);
      }
    } catch (e) {
      // Пропускаємо биті/недоступні документи
      if (candidates.length % 20 === 0) {
        console.warn(`  ⚠️  Помилка при обробці ${item.nreg} (пропущено)`);
      }
    }
  }
  
  console.log(`\n✅ Збагачено ${candidates.length} кандидатів\n`);
  
  // PHASE 3.2: Сортуємо за hardness score (найскладніші спочатку)
  candidates.sort((a, b) => b.hardness_score - a.hardness_score);
  
  // PHASE 3.2: Диверсифікація (мінімуми)
  const minPerIssuer: Record<string, number> = {
    'RNBO': 5,
    'PRESIDENT': 5,
    'NBU': 8,
    'CEC': 5,
    'INTERNATIONAL': 5,
    'CCU': 3,
    'CMU': 8,
    'VRU': 5,
  };
  
  const selected: HardSoakCandidate[] = [];
  const selectedIssuerCounts: Record<string, number> = {};
  const selectedTypeCounts: Record<string, number> = {};
  
  // Спочатку додаємо по мінімуму для кожного issuer
  for (const candidate of candidates) {
    if (selected.length >= limit) break;
    
    const issuer = candidate.issuer_family || 'OTHER';
    const type = candidate.type_family || 'OTHER';
    const minRequired = minPerIssuer[issuer] || 0;
    
    if (selectedIssuerCounts[issuer] < minRequired) {
      selected.push(candidate);
      selectedIssuerCounts[issuer] = (selectedIssuerCounts[issuer] || 0) + 1;
      selectedTypeCounts[type] = (selectedTypeCounts[type] || 0) + 1;
    }
  }
  
  // Додаємо решту за hardness score
  for (const candidate of candidates) {
    if (selected.length >= limit) break;
    if (selected.some(s => s.nreg === candidate.nreg)) continue;
    
    selected.push(candidate);
    const issuer = candidate.issuer_family || 'OTHER';
    const type = candidate.type_family || 'OTHER';
    selectedIssuerCounts[issuer] = (selectedIssuerCounts[issuer] || 0) + 1;
    selectedTypeCounts[type] = (selectedTypeCounts[type] || 0) + 1;
  }
  
  // Якщо не вистачає якогось класу — додаємо відомі nreg
  const knownHardNregs: Record<string, string[]> = {
    'RNBO': ['n0002525-26'], // вже є, але якщо потрібно більше
    'PRESIDENT': ['60/2026'],
    'NBU': [], // додати відомі
    'CEC': ['v0003359-26'], // вже є
    'INTERNATIONAL': ['995_153'], // вже є
    'CCU': ['nb07d710-25'], // вже є
  };
  
  // Додаємо відомі якщо не вистачає (тільки якщо не в existingNregs)
  for (const [issuer, nregs] of Object.entries(knownHardNregs)) {
    const currentCount = selectedIssuerCounts[issuer] || 0;
    const minRequired = minPerIssuer[issuer] || 0;
    
    if (currentCount < minRequired) {
      for (const nreg of nregs) {
        if (selected.length >= limit) break;
        if (existingNregs.has(nreg)) continue;
        if (selected.some(s => s.nreg === nreg)) continue;
        
        // Швидкий fetch для відомого
        try {
          const jsonData = await rada.fetchJson(nreg);
          const hardness = calculateHardnessScore({
            typ: jsonData.typ,
            typn: jsonData.typn,
            organs: jsonData.organs,
            title: jsonData.nazva || '',
          });
          
          selected.push({
            nreg,
            title: jsonData.nazva || '',
            typ: jsonData.typ,
            typn: jsonData.typn,
            organs: jsonData.organs,
            hardness_score: hardness.score,
            hardness_reasons: hardness.reasons,
            issuer_family: issuer as any,
            type_family: detectTypeFamily({ title: jsonData.nazva || '', typ: jsonData.typ }),
          });
          
          selectedIssuerCounts[issuer] = (selectedIssuerCounts[issuer] || 0) + 1;
        } catch (e) {
          // Пропускаємо
        }
      }
    }
  }
  
  // Обмежуємо до limit
  const finalSelected = selected.slice(0, limit);
  const nregs = finalSelected.map(c => c.nreg);
  
  // Виводимо статистику
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Selected ${finalSelected.length} documents`);
  console.log(`═══════════════════════════════════════════════════════════`);
  console.log(`\nIssuer Family Distribution:`);
  Object.entries(selectedIssuerCounts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([issuer, count]) => {
      console.log(`  ${issuer}: ${count}`);
    });
  
  console.log(`\nType Family Distribution:`);
  Object.entries(selectedTypeCounts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([type, count]) => {
      console.log(`  ${type}: ${count}`);
    });
  
  console.log(`\nTop 10 Hardest Documents:`);
  finalSelected.slice(0, 10).forEach((c, i) => {
    console.log(`  ${i + 1}. ${c.nreg} (score=${c.hardness_score}): ${c.title.substring(0, 60)}...`);
  });
  
  // Зберігаємо у файл
  const output = outputPath || resolve(process.env.LEXERY_LEGISLATION_WORKSPACE_ROOT || process.cwd(), 'data', 'hard_soak_nregs.txt');
  const content = `# Hard Soak Test Documents (${finalSelected.length} documents)
# Generated: ${new Date().toISOString()}
# Hardness score range: ${Math.min(...finalSelected.map(c => c.hardness_score))} - ${Math.max(...finalSelected.map(c => c.hardness_score))}

${nregs.join('\n')}
`;
  
  await writeFile(output, content, 'utf-8');
  console.log(`\n✅ Saved to: ${output}`);
  
  return nregs;
}
