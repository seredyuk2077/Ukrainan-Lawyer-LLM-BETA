import { parseContentUnits, parseUnitsFromTxt } from './parseUnits.js';

function assertOk(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function testArticleTxtParsingIgnoresAmendmentMentions(): void {
  const txt = [
    'Стаття 1. Загальна норма',
    'Текст першої статті з достатньою довжиною для індексації та перевірки.',
    '{Стаття 1 із змінами, внесеними згідно із Законом № 1}',
    'Стаття 2.',
    'Спеціальна норма',
    'Текст другої статті теж достатньо довгий для тесту і не повинен дублюватися.',
  ].join('\n');

  const units = parseUnitsFromTxt(txt, 'article-based');
  assertOk(units.length === 2, `Expected 2 parsed articles, got ${units.length}`);
  assertOk(units[0]?.number === '1', `Expected article 1 first, got ${units[0]?.number}`);
  assertOk(units[1]?.number === '2', `Expected article 2 second, got ${units[1]?.number}`);
  assertOk(units[0]?.title === 'Загальна норма', `Unexpected title for article 1: ${units[0]?.title}`);
  assertOk(units[1]?.title === 'Спеціальна норма', `Unexpected title for article 2: ${units[1]?.title}`);
  console.log('[OK] parseUnitsFromTxt ignores inline amendment references and keeps article headers');
}

async function testPointBasedStruPromotesTxtArticles(): Promise<void> {
  const stru = [
    {
      id: 'u1',
      typ: 'PU',
      stru: '1',
      line: 'Завдання кодексу',
      text: 'Короткий point-based текст 1, який не є справжньою статтею, але присутній у stru.',
    },
    {
      id: 'u2',
      typ: 'PU',
      stru: '40',
      line: 'Розірвання трудового договору',
      text: 'Короткий point-based текст 40, який імітує зламаний stru у кодексі.',
    },
  ];
  const txt = [
    'Стаття 1. Завдання кодексу',
    'Достатньо довгий текст першої статті для побудови індексованого unit.',
    'Стаття 2. Основні права працівників',
    'Достатньо довгий текст другої статті для побудови індексованого unit.',
    'Стаття 3. Регулювання трудових відносин',
    'Достатньо довгий текст третьої статті для побудови індексованого unit.',
    'Стаття 10. Додаткові гарантії',
    'Достатньо довгий текст десятої статті для побудови індексованого unit.',
    'Стаття 20. Робочий час',
    'Достатньо довгий текст двадцятої статті для побудови індексованого unit.',
    'Стаття 30. Відпустки',
    'Достатньо довгий текст тридцятої статті для побудови індексованого unit.',
    'Стаття 40. Розірвання трудового договору з ініціативи роботодавця',
    'Достатньо довгий текст сорокової статті для побудови індексованого unit.',
    'Стаття 41. Додаткові підстави для звільнення',
    'Достатньо довгий текст сорок першої статті для побудови індексованого unit.',
    'Стаття 50. Облік робочого часу',
    'Достатньо довгий текст пʼятдесятої статті для побудови індексованого unit.',
    'Стаття 60. Гарантії працівникам',
    'Достатньо довгий текст шістдесятої статті для побудови індексованого unit.',
  ].join('\n');

  const parsed = await parseContentUnits(stru, txt, 'Кодекс', {
    title: 'Кодекс законів про працю України',
    nreg: '322-08',
    lawNumber: '322-08',
  });
  const hasArticle40 = parsed.units.some((unit) => unit.unit_type === 'article' && unit.number === '40');
  assertOk(parsed.strategy === 'article-based', `Expected article-based salvage, got ${parsed.strategy}`);
  assertOk(parsed.requiresFallback, 'Expected requiresFallback=true after TXT article salvage');
  assertOk(hasArticle40, 'Expected article 40 to appear after TXT article salvage');
  console.log('[OK] parseContentUnits promotes point-based stru to article-based TXT salvage when article structure is strong');
}

async function main(): Promise<void> {
  testArticleTxtParsingIgnoresAmendmentMentions();
  await testPointBasedStruPromotesTxtArticles();
  console.log('All parseUnits tests passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
