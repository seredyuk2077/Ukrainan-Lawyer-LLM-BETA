/**
 * Unit tests для actGrouping
 */
import { normalizeBaseTitle, detectPartLabel, generateActGroupKey, determineActGroup } from '../canonical/actGrouping.js';

const testCases: Array<{
  name: string;
  title: string;
  documentType: string;
  lawNumber?: string;
  expected: {
    isPart: boolean;
    partLabel: string | null;
    hasGroupKey: boolean;
  };
}> = [
  {
    name: 'Звичайний закон (не частина)',
    title: 'Закон України "Про мобілізаційну підготовку та мобілізацію"',
    documentType: 'Закон',
    lawNumber: '3543-XII',
    expected: { isPart: false, partLabel: null, hasGroupKey: true },
  },
  {
    name: 'Кодекс з частиною',
    title: 'Кодекс України про адміністративні правопорушення (частина перша)',
    documentType: 'Кодекс',
    expected: { isPart: true, partLabel: 'Частина перша', hasGroupKey: true },
  },
  {
    name: 'Кодекс з томом',
    title: 'Цивільний кодекс України (том ІІ)',
    documentType: 'Кодекс',
    expected: { isPart: true, partLabel: 'Том ІІ', hasGroupKey: true },
  },
  {
    name: 'Закон без частини',
    title: 'Про затвердження Правил перетинання державного кордону',
    documentType: 'Постанова КМУ',
    expected: { isPart: false, partLabel: null, hasGroupKey: true },
  },
];

function runTests() {
  console.log('Running actGrouping tests...\n');
  
  let passed = 0;
  let failed = 0;
  
  for (const testCase of testCases) {
    const result = determineActGroup({
      title: testCase.title,
      documentType: testCase.documentType,
      lawNumber: testCase.lawNumber,
    });
    
    const isPartMatch = result.act_is_part === testCase.expected.isPart;
    const partLabelMatch = result.act_part_label === testCase.expected.partLabel;
    const hasGroupKey = !!result.act_group_key;
    
    if (isPartMatch && partLabelMatch && hasGroupKey === testCase.expected.hasGroupKey) {
      console.log(`✅ ${testCase.name}`);
      console.log(`   act_is_part: ${result.act_is_part}, part_label: ${result.act_part_label || 'null'}, group_key: ${result.act_group_key.slice(0, 30)}...`);
      passed++;
    } else {
      console.log(`❌ ${testCase.name}`);
      console.log(`   Expected: isPart=${testCase.expected.isPart}, partLabel=${testCase.expected.partLabel}, hasGroupKey=${testCase.expected.hasGroupKey}`);
      console.log(`   Got: isPart=${result.act_is_part}, partLabel=${result.act_part_label}, hasGroupKey=${hasGroupKey}`);
      failed++;
    }
  }
  
  // Test normalizeBaseTitle
  console.log('\n--- Testing normalizeBaseTitle ---');
  const titleTests = [
    { input: 'Кодекс (частина перша)', expected: 'Кодекс' },
    { input: 'Закон (том ІІ)', expected: 'Закон' },
    { input: 'Про затвердження (в редакції від 2025)', expected: 'Про затвердження' },
  ];
  
  for (const { input, expected } of titleTests) {
    const result = normalizeBaseTitle(input);
    if (result === expected) {
      console.log(`✅ normalizeBaseTitle: "${input}" → "${result}"`);
      passed++;
    } else {
      console.log(`❌ normalizeBaseTitle: "${input}" → "${result}" (expected: "${expected}")`);
      failed++;
    }
  }
  
  // Test detectPartLabel
  console.log('\n--- Testing detectPartLabel ---');
  const partLabelTests = [
    { input: 'Кодекс (частина перша)', expected: 'Частина перша' },
    { input: 'Закон (том ІІ)', expected: 'Том ІІ' },
    { input: 'Про затвердження', expected: null },
  ];
  
  for (const { input, expected } of partLabelTests) {
    const result = detectPartLabel(input);
    if (result === expected) {
      console.log(`✅ detectPartLabel: "${input}" → ${result || 'null'}`);
      passed++;
    } else {
      console.log(`❌ detectPartLabel: "${input}" → ${result || 'null'} (expected: ${expected || 'null'})`);
      failed++;
    }
  }
  
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
