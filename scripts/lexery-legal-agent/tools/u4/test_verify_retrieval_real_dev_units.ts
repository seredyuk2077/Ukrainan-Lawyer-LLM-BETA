/**
 * Unit tests for retrieval real-dev gate: smoke run must require 0 stable fails.
 * Run: pnpm exec tsx scripts/lexery-legal-agent/tools/u4/test_verify_retrieval_real_dev_units.ts
 */
import { getRetrievalGateThresholds } from './verify_retrieval_real_dev.js';
import { checkActFamilyHit } from './verify_retrieval_real_dev.js';
import { isRetrievalTraceReadyForScoring } from './verify_retrieval_real_dev.js';
import { evaluateArticleExpectations } from './verify_retrieval_real_dev.js';
import { buildFastResultsCaseProjection } from './verify_retrieval_real_dev.js';

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

function testActFamilyHitUsesStructuredSelectedActCategory(): void {
  const retrievalTrace = {
    hits: [],
    meta: {
      selected_acts: [{ rada_nreg: '2597-19', act_title: 'Кодекс України з процедур банкрутства', category: 'corporate' }],
    },
  };
  const hit = checkActFamilyHit(retrievalTrace as never, [{ family_id: 'corporate' }]);
  assert(hit === true, 'selected_acts category should satisfy family match for verifier');
  console.log('[OK] act family hit uses structured selected_acts category');
}

function testActFamilyHitNormalizesBusinessCorporateAlias(): void {
  const retrievalTrace = {
    hits: [],
    meta: {
      family_evidence_summary: { dominant_family_key: 'business_corporate' },
      selected_acts: [{ rada_nreg: '2597-19', act_title: 'Кодекс України з процедур банкрутства' }],
    },
  };
  const hit = checkActFamilyHit(retrievalTrace as never, [{ family_id: 'corporate' }]);
  assert(hit === true, 'business_corporate dominant family should satisfy corporate expectation');
  console.log('[OK] act family hit normalizes business_corporate alias');
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

function testRetrievalTraceReadyWithoutTerminalInRetrievalOnlyMode(): void {
  const retrievalTrace = {
    meta: {
      hits_count: 12,
    },
  };
  assert(
    isRetrievalTraceReadyForScoring('U4_DONE', retrievalTrace as never, false) === true,
    'retrieval-only mode should score as soon as retrieval_trace is present'
  );
  console.log('[OK] retrieval-only scoring can start before terminal status');
}

function testArticleExpectationOverlayReportsRankMiss(): void {
  const trace = {
    hits: [
      { rada_nreg: '2341-14', article_number: '185' },
      { rada_nreg: '2341-14', article_number: '186' },
      { rada_nreg: '2341-14', article_number: '115' },
    ],
  };
  const result = evaluateArticleExpectations(trace as never, {
    fingerprint: 'abc',
    expected_primary: {
      rada_nreg: '2341-14',
      article_numbers: ['115'],
      max_rank: 2,
    },
  });
  assert(result.applied === true, 'article overlay should be applied');
  assert(result.pass === false, 'late article rank must fail strict overlay');
  assert(
    result.reasons.some((reason) => reason.startsWith('rank_miss:primary')),
    'must report rank_miss for strict article overlay'
  );
  console.log('[OK] article strict overlay reports rank miss');
}

function testArticleExpectationOverlayNoopWithoutExpectation(): void {
  const result = evaluateArticleExpectations({ hits: [] } as never, null);
  assert(result.applied === false, 'missing overlay should not apply');
  assert(result.pass === true, 'missing overlay should not fail');
  console.log('[OK] article strict overlay stays noop when expectation is absent');
}

function testFastResultsProjectionIncludesMetricsAndCoverageGap(): void {
  const projected = buildFastResultsCaseProjection({
    index: 7,
    query: 'Кримінальна відповідальність за шахрайство і хто розслідує',
    result: {
      status: 'PASS',
      latencyMs: 8123,
      qdrantCalls: 7,
      plannerTier: 0,
      actListSize: 2,
      routingHintsUsed: false,
      articleExpectationApplied: true,
      articleTraceReady: true,
      articleTraceSource: 'r2',
      articleStrictPass: true,
      articlePrimaryRank: 2,
      articleExpectedHitRanks: { '2341-14:190': 2 },
      articleStrictReasons: [],
      retrievalTrace: {
        meta: {
          low_confidence: true,
          coverage_gap: 'weak_evidence',
          reason_codes: ['LOW_EVIDENCE'],
          selected_acts: [{ rada_nreg: '2341-14', act_title: 'Кримінальний кодекс України' }],
          family_evidence_summary: { dominant_family_key: 'criminal' },
          routing_hints: {
            called: false,
            not_used_reason_codes: ['NOT_CALLED'],
            routing_path: 'NONE',
          },
        },
      } as never,
    },
  });
  assert(projected.latency_ms === 8123, 'projection must keep latency_ms');
  assert(projected.qdrant_calls_count_total === 7, 'projection must keep qdrant call count');
  assert(projected.coverage_gap === 'weak_evidence', 'projection must keep coverage_gap');
  assert(projected.low_confidence === true, 'projection must keep low_confidence');
  assert(projected.selected_act_count === 1, 'projection must expose selected_act_count');
  assert(projected.dominant_family_key === 'criminal', 'projection must keep dominant family');
  console.log('[OK] fast results projection includes per-case metrics and coverage gap');
}

function main(): void {
  console.log('verify_retrieval_real_dev gate unit tests\n');
  testSmokeRunRequiresZeroStableFails();
  testSmokeRunAllPass();
  testLimitedRunNonSmokeProportional();
  testActFamilyHitUsesDominantFamilySummary();
  testActFamilyHitStillFallsBackToTitleSignals();
  testActFamilyHitUsesStructuredSelectedActCategory();
  testActFamilyHitNormalizesBusinessCorporateAlias();
  testRetrievalTraceReadyOnlyWhenTerminal();
  testRetrievalTraceReadyWithoutTerminalInRetrievalOnlyMode();
  testArticleExpectationOverlayReportsRankMiss();
  testArticleExpectationOverlayNoopWithoutExpectation();
  testFastResultsProjectionIncludesMetricsAndCoverageGap();
  console.log('\nAll verify_retrieval_real_dev gate unit tests passed.');
}

main();
