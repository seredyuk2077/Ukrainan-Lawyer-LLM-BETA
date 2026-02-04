/**
 * Швидкий тест resolver на проблемних документах
 */

import { RadaClient } from './radaClient.js';
import { resolveValidityByNreg, bundleToResult } from './lib/radaValidityResolver.js';

const testDocs = [
  { nreg: '1150-98-п', expected: 'expired', reason: 'stan=1 → expired' },
  { nreg: '1178-2022-п', expected: 'in_force', reason: 'stan=5 → in_force' },
  { nreg: '100-95-п', expected: 'in_force', reason: 'stan=5 → in_force' },
  { nreg: '4651-17', expected: 'in_force', reason: 'stan=5 → in_force' },
];

async function main() {
  const rada = new RadaClient();
  
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('Quick Resolver Test');
  console.log('═══════════════════════════════════════════════════════════\n');
  
  for (const test of testDocs) {
    try {
      const bundle = await resolveValidityByNreg(test.nreg, rada, false);
      const result = bundleToResult(bundle);
      
      const match = result.validity_status === test.expected;
      const icon = match ? '✅' : '❌';
      
      console.log(`${icon} ${test.nreg}:`);
      console.log(`   Expected: ${test.expected}`);
      console.log(`   Actual: ${result.validity_status}`);
      console.log(`   Source: ${result.source_status_text} @ ${result.source_status_location}`);
      console.log(`   Note: ${result.status_note}`);
      console.log(`   Reason: ${test.reason}`);
      
      if (!match) {
        console.error(`   ❌ MISMATCH!`);
      }
      console.log('');
    } catch (error) {
      console.error(`❌ ${test.nreg}: ERROR - ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

main().catch(console.error);
