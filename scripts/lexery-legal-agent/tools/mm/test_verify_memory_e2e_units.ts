/**
 * Unit tests for memory-e2e acceptance: law presence and CONTEXT_MODE_UNRESOLVED.
 * Run: pnpm exec tsx scripts/lexery-legal-agent/tools/mm/test_verify_memory_e2e_units.ts
 */
import type { MemoryE2ERunRow } from './verify_memory_e2e.js';
import { computeLawPresenceAndUnresolvedAcceptance, shouldRetryRunPollFailure } from './verify_memory_e2e.js';

function mkRow(overrides: Partial<MemoryE2ERunRow> = {}): MemoryE2ERunRow {
  return {
    run_id: '',
    query: '',
    metrics_source: 'source_summary',
    context_mode: 'memory',
    use_memory: true,
    use_lldbi: false,
    historyCount: 0,
    memoryCount: 0,
    lawCount: 0,
    prompt_tokens: 100,
    triage_used: false,
    verdict: 'completed',
    ...overrides,
  };
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`ASSERT FAIL: ${msg}`);
}

function testMixedLawCountZeroFails(): void {
  const runs: MemoryE2ERunRow[] = [
    mkRow({ lawCount: 0 }),
    mkRow({ lawCount: 0 }),
    mkRow({ lawCount: 0 }),
    mkRow({ context_mode: 'mixed', use_memory: true, use_lldbi: true, lawCount: 0 }),
    mkRow({ context_mode: 'law', use_memory: false, use_lldbi: true, lawCount: 2 }),
  ];
  const acc = computeLawPresenceAndUnresolvedAcceptance(runs);
  assert(acc.acceptance_mixed_law_presence_ok === false, 'mixed run with lawCount=0 must fail mixed law presence');
  assert(acc.acceptance_law_law_presence_ok === true, 'law run has lawCount>=1');
  assert(acc.acceptance_no_context_mode_unresolved === true, 'no unresolved in reason_codes');
  console.log('[OK] mixed run lawCount=0 -> acceptance_mixed_law_presence_ok false');
}

function testLawRunLawCountZeroFails(): void {
  const runs: MemoryE2ERunRow[] = [
    mkRow({ lawCount: 0 }),
    mkRow({ lawCount: 0 }),
    mkRow({ lawCount: 0 }),
    mkRow({ context_mode: 'mixed', use_memory: true, use_lldbi: true, lawCount: 2 }),
    mkRow({ context_mode: 'law', use_memory: false, use_lldbi: true, lawCount: 0 }),
  ];
  const acc = computeLawPresenceAndUnresolvedAcceptance(runs);
  assert(acc.acceptance_mixed_law_presence_ok === true, 'mixed run has lawCount>=1');
  assert(acc.acceptance_law_law_presence_ok === false, 'law run with lawCount=0 must fail law presence');
  assert(acc.acceptance_no_context_mode_unresolved === true, 'no unresolved');
  console.log('[OK] law run lawCount=0 -> acceptance_law_law_presence_ok false');
}

function testContextModeUnresolvedFails(): void {
  const runs: MemoryE2ERunRow[] = [
    mkRow({ lawCount: 0 }),
    mkRow({ lawCount: 0 }),
    mkRow({ lawCount: 0 }),
    mkRow({
      context_mode: 'mixed',
      use_memory: true,
      use_lldbi: true,
      lawCount: 1,
      search_plan_reason_codes: ['CONTEXT_MODE_UNRESOLVED', 'mixed_mode'],
    }),
    mkRow({ context_mode: 'law', use_memory: false, use_lldbi: true, lawCount: 1 }),
  ];
  const acc = computeLawPresenceAndUnresolvedAcceptance(runs);
  assert(acc.acceptance_mixed_law_presence_ok === true, 'mixed has law');
  assert(acc.acceptance_law_law_presence_ok === true, 'law has law');
  assert(acc.acceptance_no_context_mode_unresolved === false, 'CONTEXT_MODE_UNRESOLVED must fail acceptance');
  console.log('[OK] CONTEXT_MODE_UNRESOLVED in reason_codes -> acceptance_no_context_mode_unresolved false');
}

function testAllPass(): void {
  const runs: MemoryE2ERunRow[] = [
    mkRow({ lawCount: 0 }),
    mkRow({ lawCount: 0 }),
    mkRow({ lawCount: 0 }),
    mkRow({ context_mode: 'mixed', use_memory: true, use_lldbi: true, lawCount: 2 }),
    mkRow({ context_mode: 'law', use_memory: false, use_lldbi: true, lawCount: 3 }),
  ];
  const acc = computeLawPresenceAndUnresolvedAcceptance(runs);
  assert(acc.acceptance_mixed_law_presence_ok === true, 'mixed law presence ok');
  assert(acc.acceptance_law_law_presence_ok === true, 'law law presence ok');
  assert(acc.acceptance_no_context_mode_unresolved === true, 'no unresolved');
  console.log('[OK] all pass when mixed/law have lawCount>=1 and no CONTEXT_MODE_UNRESOLVED');
}

function testTransientRunPollFailuresRetry(): void {
  assert(shouldRetryRunPollFailure(503) === true, '503 should be retried');
  assert(shouldRetryRunPollFailure(429) === true, '429 should be retried');
  assert(shouldRetryRunPollFailure(500) === false, '500 is not in the bounded retry set');
  assert(
    shouldRetryRunPollFailure(undefined, { code: 'ECONNRESET' }) === true,
    'ECONNRESET transport error should be retried'
  );
  assert(
    shouldRetryRunPollFailure(undefined, { code: 'ETIMEDOUT' }) === true,
    'ETIMEDOUT transport error should be retried'
  );
  const fetchFailed = new TypeError('fetch failed') as TypeError & { cause?: { code: string } };
  fetchFailed.cause = { code: 'ECONNRESET' };
  assert(
    shouldRetryRunPollFailure(undefined, fetchFailed) === true,
    'fetch failed with transient cause should be retried'
  );
  assert(
    shouldRetryRunPollFailure(undefined, { code: 'SOMETHING_ELSE' }) === false,
    'non-transient transport error should not be retried'
  );
  console.log('[OK] transient run poll failures use bounded retry set');
}

function main(): void {
  console.log('verify_memory_e2e acceptance unit tests\n');
  testMixedLawCountZeroFails();
  testLawRunLawCountZeroFails();
  testContextModeUnresolvedFails();
  testAllPass();
  testTransientRunPollFailuresRetry();
  console.log('\nAll verify_memory_e2e acceptance unit tests passed.');
}

main();
