/**
 * Hard Soak Collector — збір 50 складних документів для тестування
 * 
 * PHASE 3: Підбір максимально підступних типів документів для stress-test
 */

import { RadaClient } from '../radaClient.js';
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
}): Promise<string[]> {
  const { limit = 50, outputPath } = options || {};
  
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Hard Soak Collector — збір ${limit} складних документів`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  
  // TODO: Реалізувати збір з Rada API feed
  // Зараз використовуємо статичний список з test/soak_nregs.txt як основу
  // і додаємо нові складні документи
  
  const rada = new RadaClient();
  const candidates: HardSoakCandidate[] = [];
  
  // Збираємо кандидатів (приклад: останні документи з різними typ)
  // В реальності тут має бути пошук через Rada API feed
  
  console.log(`⚠️  TODO: Реалізувати збір з Rada API feed`);
  console.log(`Зараз використовуємо статичний список з test/soak_nregs.txt\n`);
  
  // Читаємо існуючий список як основу
  const existingSoakPath = resolve(process.cwd(), 'scripts/legislation/test/soak_nregs.txt');
  let existingNregs: string[] = [];
  try {
    const { readFile } = await import('fs/promises');
    const content = await readFile(existingSoakPath, 'utf-8');
    existingNregs = content.split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));
  } catch (e) {
    // Файл не існує — починаємо з нуля
  }
  
  // Фільтруємо унікальні та збираємо hardness score
  const seenNregs = new Set<string>();
  const issuerFamilyCounts: Record<string, number> = {};
  const typeFamilyCounts: Record<string, number> = {};
  
  for (const nreg of existingNregs) {
    if (seenNregs.has(nreg)) continue;
    seenNregs.add(nreg);
    
    try {
      // Fetch metadata
      const jsonData = await rada.fetchJson(nreg);
      const hardness = calculateHardnessScore({
        typ: jsonData.typ,
        typn: jsonData.typn,
        organs: jsonData.organs,
        title: jsonData.nazva || '',
      });
      
      const issuerFamily = detectIssuerFamily({
        title: jsonData.nazva || '',
        organs: jsonData.organs,
      });
      const typeFamily = detectTypeFamily({
        title: jsonData.nazva || '',
        typ: jsonData.typ,
      });
      
      candidates.push({
        nreg,
        title: jsonData.nazva || '',
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
    } catch (e) {
      console.warn(`⚠️  Помилка при обробці ${nreg}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  
  // Сортуємо за hardness score (найскладніші спочатку)
  candidates.sort((a, b) => b.hardness_score - a.hardness_score);
  
  // Гарантуємо диверсифікацію: не менше N документів на кожен issuer/type
  const minPerIssuer = Math.floor(limit / 8); // ~6-7 на issuer
  const minPerType = Math.floor(limit / 10); // ~5 на type
  
  const selected: HardSoakCandidate[] = [];
  const selectedIssuerCounts: Record<string, number> = {};
  const selectedTypeCounts: Record<string, number> = {};
  
  // Спочатку додаємо по мінімуму для кожного issuer
  for (const candidate of candidates) {
    if (selected.length >= limit) break;
    
    const issuer = candidate.issuer_family || 'OTHER';
    const type = candidate.type_family || 'OTHER';
    
    if (selectedIssuerCounts[issuer] < minPerIssuer || selectedTypeCounts[type] < minPerType) {
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
  const output = outputPath || resolve(process.cwd(), 'scripts/legislation/test/hard_soak_nregs.txt');
  const content = `# Hard Soak Test Documents (${finalSelected.length} documents)
# Generated: ${new Date().toISOString()}
# Hardness score range: ${Math.min(...finalSelected.map(c => c.hardness_score))} - ${Math.max(...finalSelected.map(c => c.hardness_score))}

${nregs.join('\n')}
`;
  
  await writeFile(output, content, 'utf-8');
  console.log(`\n✅ Saved to: ${output}`);
  
  return nregs;
}
