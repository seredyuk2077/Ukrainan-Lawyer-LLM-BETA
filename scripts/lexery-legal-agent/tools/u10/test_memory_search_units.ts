/**
 * U10 Memory Search Tool unit tests (DEV RUN v12).
 * Run: pnpm brain:test:u10-memory-search-units (or add to brain:test:u10-units)
 *
 * Tests:
 *   M1) stubForDryRun returns fast with deterministic stub (no real fetch)
 *   M2) formatMemorySearchSection empty result → ''
 *   M3) formatMemorySearchSection with facts → section contains header and facts
 *   M4) tenant_id / user_id passed through (tenant isolation is enforced in fetchRecentMemory)
 */
import {
  searchMemoryTool,
  formatMemorySearchSection,
  shouldTriggerMemorySearchTool,
} from '../../write/memorySearch.js';

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`ASSERT FAIL: ${msg}`);
}

async function runTests(): Promise<void> {
  // M1: stub mode returns quickly with deterministic result
  const t0 = Date.now();
  const stubResult = await searchMemoryTool({
    tenant_id: 'tenant-1',
    conversation_id: 'conv-1',
    user_id: 'user-1',
    queryText: 'Andrii',
    stubForDryRun: true,
  });
  const elapsed = Date.now() - t0;
  assert(stubResult.summaries.length === 0, 'Stub: no summaries');
  assert(stubResult.facts.length >= 1, 'Stub: at least one fact (stub message)');
  assert(
    stubResult.facts.some((f) => f.includes('stub') || f.includes('MEMORY')),
    'Stub: fact contains stub or MEMORY'
  );
  assert(stubResult.trace.qdrant_used === false, 'Stub: qdrant_used false');
  assert(elapsed < 100, 'Stub: returns in < 100ms');
  console.log('[OK] M1: stub mode deterministic and fast');

  // M2: format empty result
  const emptySection = formatMemorySearchSection({ summaries: [], facts: [], trace: { latency_ms: 0, qdrant_used: false } });
  assert(emptySection === '', 'Empty result → empty string');
  console.log('[OK] M2: format empty → ""');

  // M3: format with facts
  const withFacts = formatMemorySearchSection({
    summaries: ['User is Andrii.'],
    facts: ['Preferred language: Ukrainian.', 'Jurisdiction: Ukraine.'],
    trace: { latency_ms: 10, qdrant_used: true },
  });
  assert(withFacts.includes('=== MEMORY SEARCH RESULTS ==='), 'Section has header');
  assert(withFacts.includes('Ukrainian'), 'Section contains fact text');
  assert(withFacts.includes('Summaries:'), 'Section has Summaries label');
  assert(withFacts.includes('Facts:'), 'Section has Facts label');
  console.log('[OK] M3: format with facts → section with header and content');

  // M4: different tenant_id/user_id passed through (no cross-tenant; we only check params are accepted)
  const stub2 = await searchMemoryTool({
    tenant_id: 'other-tenant',
    conversation_id: 'other-conv',
    user_id: 'other-user',
    queryText: 'test',
    stubForDryRun: true,
  });
  assert(stub2.trace.latency_ms >= 0, 'Stub accepts any tenant/user ids');
  console.log('[OK] M4: tenant/user params accepted (isolation in fetchRecentMemory)');

  // M5: legal-only path must not trigger memory tool even when evidence is insufficient
  const noLawFallback = shouldTriggerMemorySearchTool({
    userIdPresent: true,
    useMemorySource: false,
    evidenceInsufficient: true,
    memoryChannelEmpty: true,
    memoryAvailableInTrace: true,
  });
  assert(noLawFallback === false, 'Law-only path must not trigger memory tool');
  console.log('[OK] M5: law-only path blocks memory tool fallback');

  // M6: mixed/memory path may trigger memory tool when memory is an approved source
  const mixedFallback = shouldTriggerMemorySearchTool({
    userIdPresent: true,
    useMemorySource: true,
    evidenceInsufficient: true,
    memoryChannelEmpty: true,
    memoryAvailableInTrace: false,
  });
  assert(mixedFallback === true, 'Mixed/memory path may trigger memory tool when evidence is insufficient');
  console.log('[OK] M6: approved memory source may trigger memory tool');
}

runTests()
  .then(() => {
    console.log('\nAll U10 Memory Search unit tests passed.');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
