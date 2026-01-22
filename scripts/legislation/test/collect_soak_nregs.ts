/**
 * Collect Soak NREGs — програмний збір 30-50 різноманітних документів
 * PHASE 20B: Real Soak Tests
 * 
 * Спрощена версія: використовує feed + відомі документи + додає різноманітні з feed
 */
import { writeFile } from 'fs/promises';
import { resolve } from 'path';

export async function collectSoakNregs(): Promise<void> {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('Collect Soak NREGs — PHASE 20B (30-50 docs)');
  console.log('═══════════════════════════════════════════════════════════\n');
  
  // Відомі різноманітні документи
  const known: string[] = [
    '3543-12', '435-15', '2341-14', '80731-10', '80732-10',
    '254к/96-вр', '57-95-п', '995_153', 'nb07d710-25',
  ];
  
  // Завантажуємо feed з Rada
  console.log('📥 Завантажуємо feed з Rada (r.txt)...');
  const feedUrl = 'https://data.rada.gov.ua/laws/main/r.txt';
  const feedResponse = await fetch(feedUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(10000),
  });
  
  if (!feedResponse.ok) {
    throw new Error(`Failed to fetch feed: ${feedResponse.status}`);
  }
  
  const feedText = await feedResponse.text();
  const feedNregs = feedText
    .split('\n')
    .map(line => line.trim().split(/\s+/)[0])
    .filter(nreg => nreg && nreg.length > 2 && /\d/.test(nreg))
    .filter(nreg => !known.includes(nreg)); // Виключаємо вже відомі
  
  console.log(`✅ Отримано ${feedNregs.length} nreg з feed (після виключення відомих)\n`);
  
  // Беремо перші 50 з feed для різноманітності
  const additional = feedNregs.slice(0, 50);
  
  // Об'єднуємо
  const allNregs = [...known, ...additional];
  const uniqueNregs = Array.from(new Set(allNregs));
  
  // Обмежуємо до 50 максимум
  const finalNregs = uniqueNregs.slice(0, 50);
  
  console.log(`✅ Зібрано ${finalNregs.length} документів\n`);
  console.log(`  Відомі: ${known.length}`);
  console.log(`  З feed: ${additional.length}`);
  console.log(`  Унікальних: ${finalNregs.length}`);
  
  // Формуємо файл
  const filePath = resolve(process.cwd(), 'scripts/legislation/test/soak_nregs.txt');
  const seed = Date.now();
  const date = new Date().toISOString().split('T')[0];
  const content = `# Soak Test Documents — PHASE 20B
# Зібрано програмно: ${date}
# Seed: ${seed}
# Джерело: відомі різноманітні (${known.length}) + Rada feed r.txt (${additional.length})
# Total: ${finalNregs.length} документів

${finalNregs.join('\n')}
`;
  
  await writeFile(filePath, content, 'utf-8');
  console.log(`\n📝 Записано в ${filePath}`);
  console.log(`\nПерші 20 документів:`);
  finalNregs.slice(0, 20).forEach(nreg => console.log(`  - ${nreg}`));
  if (finalNregs.length > 20) {
    console.log(`  ... та ще ${finalNregs.length - 20} документів`);
  }
}

if (import.meta.url.endsWith(process.argv[1]) || process.argv[1]?.includes('collect_soak_nregs')) {
  collectSoakNregs().catch(console.error);
}
