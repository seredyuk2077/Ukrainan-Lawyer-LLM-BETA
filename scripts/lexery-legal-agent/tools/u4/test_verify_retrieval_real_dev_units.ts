/**
 * Unit tests for retrieval real-dev gate: smoke run must require 0 stable fails.
 * Run: pnpm exec tsx scripts/lexery-legal-agent/tools/u4/test_verify_retrieval_real_dev_units.ts
 */
import { getRetrievalGateThresholds } from './verify_retrieval_real_dev.js';
import { checkActFamilyHit } from './verify_retrieval_real_dev.js';
import { isRetrievalTraceReadyForScoring } from './verify_retrieval_real_dev.js';

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`ASSERT FAIL: ${msg}`);
}

function testSmokeRunRequiresZeroStableFails(): void {
  const total = 7;
  const { minHardPass, maxHardFail } = getRetrievalGateThresholds(total, true, true);
  assert(minHardPass === 7, 'smoke run minHardPass must equal total (7)');
  assert(maxHardFail === 0, 'smoke run maxHardFail must be 0');
  const hardPass = 4;
  const hardFailCount = 3;
  const gatePass = hardPass >= minHardPass && hardFailCount <= maxHardFail;
  assert(gatePass === false, '4/7 PASS with 3 FAIL_STABLE must not pass smoke gate');
  console.log('[OK] smoke gate: 4/7 with 3 stable fails -> gate FAIL');
}

function testSmokeRunAllPass(): void {
  const total = 7;
  const { minHardPass, maxHardFail } = getRetrievalGateThresholds(total, true, true);
  const hardPass = 7;
  const hardFailCount = 0;
  const gatePass = hardPass >= minHardPass && hardFailCount <= maxHardFail;
  assert(gatePass === true, '7/7 PASS with 0 stable fails must pass smoke gate');
  console.log('[OK] smoke gate: 7/7 PASS -> gate PASS');
}

function testLimitedRunNonSmokeProportional(): void {
  const total = 7;
  const { minHardPass, maxHardFail } = getRetrievalGateThresholds(total, false, true);
  assert(minHardPass === Math.max(1, Math.floor(total * 0.6)), 'limited run uses 60% min pass');
  assert(maxHardFail === Math.min(total, Math.max(1, Math.ceil(total * 0.3))), 'limited run uses 30% max fail');
  console.log('[OK] limited run (non-smoke) uses proportional thresholds');
}

function testActFamilyHitUsesDominantFamilySummary(): void {
  const retrievalTrace = {
    hits: [],
    meta: {
      family_evidence_summary: { dominant_family_key: 'civil' },
      selected_acts: [{ rada_nreg: '1023-12', act_title: 'Про захист прав споживачів' }],
    },
  };
  const hit = checkActFamilyHit(retrievalTrace as never, [{ family_id: 'civil' }]);
  assert(hit === true, 'dominant_family_key should satisfy act family hit even when titles are not civil-signaled');
  console.log('[OK] act family hit uses dominant_family_key summary');
}

function testActFamilyHitStillFallsBackToTitleSignals(): void {
  const retrievalTrace = {
    hits: [],
    meta: {
      selected_acts: [{ rada_nreg: '2341-14', act_title: 'Кримінальний кодекс України' }],
    },
  };
  const hit = checkActFamilyHit(retrievalTrace as never, [{ family_id: 'criminal' }]);
  assert(hit === true, 'title fallback should still work when dominant family summary is absent');
  console.log('[OK] act family hit still falls back to title signals');
}

function testRetrievalTraceReadyOnlyWhenTerminal(): void {
  const retrievalTrace = {
    meta: {
      hits_count: 30,
    },
  };
  assert(
    isRetrievalTraceReadyForScoring('U4_DONE', retrievalTrace as never) === false,
    'non-terminal run with hits_count must not be treated as final retrieval trace'
  );
  assert(
    isRetrievalTraceReadyForScoring('completed', retrievalTrace as never) === true,
    'terminal run with hits_count must be treated as final retrieval trace'
  );
  console.log('[OK] retrieval trace scoring waits for terminal status');
}

function main(): void {
  console.log('verify_retrieval_real_dev gate unit tests\n');
  testSmokeRunRequiresZeroStableFails();
  testSmokeRunAllPass();
  testLimitedRunNonSmokeProportional();
  testActFamilyHitUsesDominantFamilySummary();
  testActFamilyHitStillFallsBackToTitleSignals();
  testRetrievalTraceReadyOnlyWhenTerminal();
  console.log('\nAll verify_retrieval_real_dev gate unit tests passed.');
}

main();
