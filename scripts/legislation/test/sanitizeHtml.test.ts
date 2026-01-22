/**
 * Unit tests для sanitizeHtmlToText
 */
import { sanitizeHtmlToText } from '../canonical/contentUnits.js';

const testCases: Array<{
  name: string;
  input: string;
  expected: string;
}> = [
  {
    name: 'Простий HTML тег',
    input: '<p>Текст статті</p>',
    expected: 'Текст статті',
  },
  {
    name: 'HTML з entities',
    input: 'Стаття&nbsp;1.&nbsp;Назва',
    expected: 'Стаття 1. Назва',
  },
  {
    name: 'Збереження нумерації пунктів',
    input: '<div>1. Перший пункт</div><div>2. Другий пункт</div>',
    expected: '1. Перший пункт 2. Другий пункт', // HTML теги видаляються, <div> → пробіл
  },
  {
    name: 'Множинні пробіли нормалізуються',
    input: 'Текст   з    множинними    пробілами',
    expected: 'Текст з множинними пробілами',
  },
  {
    name: 'Переноси рядків зберігаються (обмежено)',
    input: 'Рядок 1\n\n\n\n\nРядок 2',
    expected: 'Рядок 1\n\n\nРядок 2',
  },
  {
    name: 'Числові HTML entities',
    input: 'Символ&#160;неразривного&#160;пробіла',
    expected: 'Символ неразривного пробіла',
  },
];

function runTests() {
  console.log('Running sanitizeHtmlToText tests...\n');
  
  let passed = 0;
  let failed = 0;
  
  for (const testCase of testCases) {
    const result = sanitizeHtmlToText(testCase.input);
    const match = result === testCase.expected;
    
    if (match) {
      console.log(`✅ ${testCase.name}`);
      passed++;
    } else {
      console.log(`❌ ${testCase.name}`);
      console.log(`   Expected: "${testCase.expected}"`);
      console.log(`   Got:      "${result}"`);
      failed++;
    }
  }
  
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
