/**
 * Unit tests для extractLawNumber
 */
import { extractLawNumber } from '../canonical/extractLawNumber.js';

const testCases: Array<{
  name: string;
  nazva: string;
  nreg: string;
  jsonData: any;
  expected: { law_number: string | null; source: string; confidence: string };
}> = [
  {
    name: 'Конституція (немає номера)',
    nazva: 'Конституція України',
    nreg: '254к/96-вр',
    jsonData: { orgnum: '254к/96-ВР' },
    expected: { law_number: null, source: 'none', confidence: 'low' },
  },
  {
    name: 'Закон з номером в назві',
    nazva: 'Закон України № 435-15',
    nreg: '435-15',
    jsonData: {}, // немає orgnum, тому nreg має пріоритет
    expected: { law_number: '435-15', source: 'nreg', confidence: 'high' },
  },
  {
    name: 'Закон з orgnum',
    nazva: 'Про мобілізаційну підготовку',
    nreg: '3543-12',
    jsonData: { orgnum: '3543-XII' },
    expected: { law_number: '3543-XII', source: 'orgnum', confidence: 'high' },
  },
  {
    name: 'Постанова з номером в дужках',
    nazva: 'Постанова КМУ (57-95-п)',
    nreg: '57-95-п',
    jsonData: { typ: 2 },
    expected: { law_number: '57-95-п', source: 'nreg', confidence: 'high' },
  },
  {
    name: 'Кодекс з номером',
    nazva: 'Кримінальний кодекс України 2341-III',
    nreg: '2341-14',
    jsonData: { orgnum: '2341-III' },
    expected: { law_number: '2341-III', source: 'orgnum', confidence: 'high' },
  },
];

function runTests() {
  console.log('Running extractLawNumber tests...\n');
  
  let passed = 0;
  let failed = 0;
  
  for (const testCase of testCases) {
    const result = extractLawNumber({
      nazva: testCase.nazva,
      nreg: testCase.nreg,
      jsonData: testCase.jsonData,
    });
    
    const lawMatch = result.law_number === testCase.expected.law_number;
    const sourceMatch = result.source === testCase.expected.source;
    const confidenceMatch = result.confidence === testCase.expected.confidence;
    
    if (lawMatch && sourceMatch && confidenceMatch) {
      console.log(`✅ ${testCase.name}`);
      console.log(`   law_number: ${result.law_number || 'null'}, source: ${result.source}, confidence: ${result.confidence}\n`);
      passed++;
    } else {
      console.log(`❌ ${testCase.name}`);
      console.log(`   Expected: ${JSON.stringify(testCase.expected)}`);
      console.log(`   Got: ${JSON.stringify(result)}\n`);
      failed++;
    }
  }
  
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
