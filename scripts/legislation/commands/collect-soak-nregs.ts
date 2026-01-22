/**
 * Collect Soak NREGs — збір різноманітних документів для soak test
 * PHASE 20: Real Soak Tests (30-50 різних документів)
 */
import { writeFile } from 'fs/promises';
import { resolve } from 'path';
import { RadaClient } from '../radaClient.js';

interface DocCandidate {
  nreg: string;
  typ: number | null;
  organs: number[];
  title: string;
  source: string;
}

interface TypGroup {
  name: string;
  typ: number | null;
  organs?: number[];
  candidates: DocCandidate[];
  targetCount: number;
}

export async function collectSoakNregs(): Promise<void> {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('Collect Soak NREGs — PHASE 20');
  console.log('═══════════════════════════════════════════════════════════\n');
  
  const rada = new RadaClient();
  
  // Стратифікація: цілі для кожного класу
  const targetGroups: TypGroup[] = [
    { name: 'Закон (typ=1)', typ: 1, targetCount: 5 },
    { name: 'Кодекс (typ=21)', typ: 21, targetCount: 5 },
    { name: 'Постанова КМУ (typ=2, organs=2)', typ: 2, organs: [2], targetCount: 5 },
    { name: 'Постанова ВРУ (typ=2, organs=1)', typ: 2, organs: [1], targetCount: 3 },
    { name: 'Указ Президента (typ=3)', typ: 3, targetCount: 3 },
    { name: 'Наказ/Інструкція (typ=4)', typ: 4, targetCount: 3 },
    { name: 'Міжнародний договір (typ=6)', typ: 6, targetCount: 3 },
    { name: 'Рішення/Висновок (typ=7)', typ: 7, targetCount: 3 },
  ];
  
  // Ініціалізуємо групи
  for (const group of targetGroups) {
    group.candidates = [];
  }
  
  // Відомі різноманітні документи (як стартова база)
  const knownDiverse: Array<{ nreg: string; class: string; typ?: number; organs?: number[] }> = [
    { nreg: '3543-12', class: 'Закон', typ: 1 },
    { nreg: '2341-14', class: 'Кодекс', typ: 21 },
    { nreg: '80731-10', class: 'Кодекс (multi-part)', typ: 21 },
    { nreg: '80732-10', class: 'Кодекс (multi-part)', typ: 21 },
    { nreg: '254к/96-вр', class: 'Конституція', typ: 1 }, // Конституція може бути typ=1
    { nreg: '57-95-п', class: 'Постанова КМУ', typ: 2, organs: [2] },
    { nreg: '995_153', class: 'Міжнародна конвенція', typ: 6 },
    { nreg: 'nb07d710-25', class: 'Окрема думка судді КСУ', typ: 7 },
  ];
  
  console.log('📋 Збираємо різноманітні документи...\n');
  
  // Додаємо відомі документи
  for (const doc of knownDiverse) {
    const group = targetGroups.find(g => 
      g.typ === doc.typ && 
      (!g.organs || (doc.organs && g.organs.some(o => doc.organs!.includes(o))))
    );
    if (group && group.candidates.length < group.targetCount) {
      group.candidates.push({
        nreg: doc.nreg,
        typ: doc.typ || null,
        organs: doc.organs || [],
        title: doc.class,
        source: 'known',
      });
    }
  }
  
  // Спробуємо отримати більше з Rada feed
  try {
    console.log('📥 Завантажуємо feed з Rada...');
    const feedUrl = 'https://data.rada.gov.ua/laws/main/r.txt';
    const feedResponse = await fetch(feedUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10000),
    });
    
    if (feedResponse.ok) {
      const feedText = await feedResponse.text();
      const feedNregs = feedText
        .split('\n')
        .map(line => line.trim().split(/\s+/)[0])
        .filter(nreg => nreg && nreg.length > 2 && /\d/.test(nreg))
        .slice(0, 200); // Беремо перші 200 для аналізу
      
      console.log(`✅ Отримано ${feedNregs.length} nreg з feed\n`);
      
      // Для кожного nreg отримуємо card JSON (з обмеженням)
      let processed = 0;
      const maxProcess = 100; // Обмежуємо кількість запитів
      
      for (const nreg of feedNregs) {
        if (processed >= maxProcess) break;
        
        // Перевіряємо чи всі групи вже заповнені
        const allFull = targetGroups.every(g => g.candidates.length >= g.targetCount);
        if (allFull) break;
        
        try {
          // Отримуємо card JSON
          const cardUrl = `https://data.rada.gov.ua/laws/card/${encodeURIComponent(nreg)}.json`;
          const cardResponse = await fetch(cardUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            signal: AbortSignal.timeout(5000),
          });
          
          if (cardResponse.ok) {
            const card = await cardResponse.json();
            const typ = typeof card.typ === 'number' ? card.typ : 
                       typeof card.types === 'string' ? parseInt(card.types.split('|')[0] || '0', 10) : null;
            const organsRaw = card.organs || card.org || '';
            const organs = typeof organsRaw === 'string' 
              ? organsRaw.split(/[|:]/).map(o => parseInt(o, 10)).filter(n => !isNaN(n))
              : [];
            
            // Знаходимо відповідну групу
            const group = targetGroups.find(g => {
              if (g.typ !== typ) return false;
              if (g.organs && g.organs.length > 0) {
                return organs.some(o => g.organs!.includes(o));
              }
              return true;
            });
            
            if (group && group.candidates.length < group.targetCount) {
              // Перевіряємо чи не дублікат
              if (!group.candidates.find(c => c.nreg === nreg)) {
                group.candidates.push({
                  nreg,
                  typ,
                  organs,
                  title: card.nazva || nreg,
                  source: 'feed',
                });
                processed++;
              }
            }
          }
          
          // Rate limiting
          await new Promise(resolve => setTimeout(resolve, 100));
        } catch (e) {
          // Пропускаємо помилки
          continue;
        }
      }
      
      console.log(`✅ Оброблено ${processed} документів з feed\n`);
    }
  } catch (e) {
    console.warn(`⚠️  Не вдалося завантажити feed: ${e instanceof Error ? e.message : String(e)}`);
    console.warn('   Використовуємо тільки відомі документи\n');
  }
  
  // Збираємо всі унікальні nreg
  const allNregs = new Set<string>();
  for (const group of targetGroups) {
    for (const candidate of group.candidates) {
      allNregs.add(candidate.nreg);
    }
  }
  
  const uniqueNregs = Array.from(allNregs);
  
  console.log(`✅ Зібрано ${uniqueNregs.length} унікальних документів\n`);
  console.log('Розподіл по класах:');
  for (const group of targetGroups) {
    console.log(`  ${group.name}: ${group.candidates.length}/${group.targetCount}`);
  }
  
  // Формуємо файл
  const filePath = resolve(process.cwd(), 'scripts/legislation/test/soak_nregs.txt');
  const content = `# Soak Test Documents — PHASE 20
# Зібрано програмно: відомі різноманітні + feed з Rada API
# Стратифікація: Закони, Кодекси, Постанови (КМУ/ВРУ), Укази, Накази, Договори, Рішення
# Total: ${uniqueNregs.length} документів

${uniqueNregs.join('\n')}
`;
  
  await writeFile(filePath, content, 'utf-8');
  console.log(`\n📝 Записано в ${filePath}`);
  console.log(`\nДокументи (${uniqueNregs.length}):`);
  uniqueNregs.forEach(nreg => console.log(`  - ${nreg}`));
}

if (import.meta.url.endsWith(process.argv[1]) || process.argv[1]?.includes('collect-soak-nregs')) {
  collectSoakNregs().catch(console.error);
}
