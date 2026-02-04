/**
 * Regression тести для validity pipeline
 * 
 * Перевіряє очікувані статуси для відомих документів
 */

import { createSupabaseAdminClient } from '../lib/supabaseAdmin.js';
import { RadaClient } from '../lib/radaClient.js';
import { extractValidityAsync } from '../canonical/extractValidity.js';

interface RegressionTest {
  nreg: string;
  expectedStatus: 'in_force' | 'expired' | 'not_in_force' | 'suspended';
  description: string;
}

const REGRESSION_TESTS: RegressionTest[] = [
  {
    nreg: '1178-2022-п',
    expectedStatus: 'in_force',
    description: 'Постанова КМУ (чинна)',
  },
  {
    nreg: '100-95-п',
    expectedStatus: 'in_force',
    description: 'Постанова КМУ (чинна)',
  },
  {
    nreg: '1150-98-п',
    expectedStatus: 'expired',
    description: 'Постанова КМУ (втратив чинність)',
  },
  {
    nreg: '639/99',
    expectedStatus: 'not_in_force',
    description: 'Документ що не набрав чинності',
  },
  {
    nreg: '4651-17',
    expectedStatus: 'in_force',
    description: 'Кримінальний процесуальний кодекс (чинний)',
  },
];

export async function runValidityRegressionTests(): Promise<{
  passed: number;
  failed: number;
  results: Array<{
    nreg: string;
    expected: string;
    actual: string;
    passed: boolean;
    error?: string;
  }>;
}> {
  const supabase = createSupabaseAdminClient();
  const rada = new RadaClient();
  
  const results: Array<{
    nreg: string;
    expected: string;
    actual: string;
    passed: boolean;
    error?: string;
  }> = [];
  
  let passed = 0;
  let failed = 0;
  
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Regression Tests: Validity Pipeline`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  
  for (const test of REGRESSION_TESTS) {
    try {
      // Отримуємо validity через resolver
      const validity = await extractValidityAsync(
        test.nreg,
        rada,
        undefined, // jsonData
        null, // txtData
        null, // canonicalTopBlock
        null, // documentTypeSlug
        null // title
      );
      
      const actualStatus = validity.validity_status;
      const testPassed = actualStatus === test.expectedStatus;
      
      if (testPassed) {
        passed++;
        console.log(`✅ ${test.nreg}: ${actualStatus} (очікувано: ${test.expectedStatus}) - ${test.description}`);
      } else {
        failed++;
        console.error(`❌ ${test.nreg}: ${actualStatus} (очікувано: ${test.expectedStatus}) - ${test.description}`);
        console.error(`   source_status_location: ${validity.source_status_location}`);
        console.error(`   status_note: ${validity.status_note}`);
      }
      
      results.push({
        nreg: test.nreg,
        expected: test.expectedStatus,
        actual: actualStatus,
        passed: testPassed,
      });
    } catch (error) {
      failed++;
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`❌ ${test.nreg}: ERROR - ${errorMsg}`);
      results.push({
        nreg: test.nreg,
        expected: test.expectedStatus,
        actual: 'ERROR',
        passed: false,
        error: errorMsg,
      });
    }
  }
  
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Regression Tests: Завершено`);
  console.log(`═══════════════════════════════════════════════════════════`);
  console.log(`Passed: ${passed}/${REGRESSION_TESTS.length}`);
  console.log(`Failed: ${failed}/${REGRESSION_TESTS.length}`);
  
  if (failed > 0) {
    console.error(`\n❌ CRITICAL: ${failed} тестів не пройдено!`);
    throw new Error(`Regression tests failed: ${failed} out of ${REGRESSION_TESTS.length}`);
  } else {
    console.log(`\n✅ Всі regression тести пройдено успішно!`);
  }
  
  return { passed, failed, results };
}
