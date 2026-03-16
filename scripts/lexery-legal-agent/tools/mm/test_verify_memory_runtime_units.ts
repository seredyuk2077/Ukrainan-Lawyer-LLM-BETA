/**
 * Unit tests for verify_memory_runtime (skip mode must not emit fake infra state).
 * Run: pnpm exec tsx scripts/lexery-legal-agent/tools/mm/test_verify_memory_runtime_units.ts
 */
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`ASSERT FAIL: ${msg}`);
}

async function testSkippedModeNoFakeFalse(): Promise<void> {
  const prev = process.env.MEMORY_SEMANTIC_ENABLED;
  process.env.MEMORY_SEMANTIC_ENABLED = 'false';
  try {
    const { runVerifyMemoryRuntime } = await import('./verify_memory_runtime.js');
    const { MM_OUTBOX_LEASE_SCHEMA_MISSING, MM_OUTBOX_SCHEMA_CHECK_FAILED } = await import('../../mm/outboxSchema.js');
    const report = await runVerifyMemoryRuntime();
    assert(
      report.status === 'skipped' || report.status === 'fail',
      'status is skipped when semantic disabled and schema ready, or fail when schema check fails'
    );
    assert(report.semantic_validation_skipped === true, 'semantic_validation_skipped is true');
    if (report.status === 'fail' && (report.degraded_reason_codes?.includes(MM_OUTBOX_LEASE_SCHEMA_MISSING) || report.degraded_reason_codes?.includes(MM_OUTBOX_SCHEMA_CHECK_FAILED))) {
      assert(true, 'fail with schema reason code when schema check fails');
    } else {
      assert(
        report.collection_exists !== false,
        'skipped mode must not claim collection_exists=false (use undefined when not checked)'
      );
      assert(
        report.bootstrap_ok !== false,
        'skipped mode must not claim bootstrap_ok=false (use undefined when not checked)'
      );
    }
    console.log('[OK] verify_memory_runtime skipped mode does not emit fake collection_exists/bootstrap_ok false');
  } finally {
    if (prev !== undefined) process.env.MEMORY_SEMANTIC_ENABLED = prev;
    else delete process.env.MEMORY_SEMANTIC_ENABLED;
  }
}

async function testOutboxSchemaContract(): Promise<void> {
  const {
    checkMmOutboxLeaseSchema,
    MM_OUTBOX_LEASE_SCHEMA_MISSING,
    MM_OUTBOX_SCHEMA_CHECK_FAILED,
    isTransientOutboxSchemaProbeError,
  } = await import('../../mm/outboxSchema.js');
  assert(typeof MM_OUTBOX_LEASE_SCHEMA_MISSING === 'string', 'MM_OUTBOX_LEASE_SCHEMA_MISSING is string');
  assert(MM_OUTBOX_LEASE_SCHEMA_MISSING.includes('LEASE'), 'reason code mentions LEASE');
  assert(isTransientOutboxSchemaProbeError('TypeError: fetch failed') === true, 'fetch failed is transient schema probe error');
  assert(isTransientOutboxSchemaProbeError('502 Bad gateway') === true, '502 bad gateway is transient schema probe error');
  assert(isTransientOutboxSchemaProbeError('column lease_expires_at does not exist') === false, 'missing column is not transient schema probe error');
  const result = await checkMmOutboxLeaseSchema();
  assert(typeof result.ready === 'boolean', 'checkMmOutboxLeaseSchema returns ready: boolean');
  if (!result.ready) {
    assert(
      result.reason_code === MM_OUTBOX_LEASE_SCHEMA_MISSING || result.reason_code === MM_OUTBOX_SCHEMA_CHECK_FAILED,
      'when not ready, reason_code is MM_OUTBOX_LEASE_SCHEMA_MISSING or MM_OUTBOX_SCHEMA_CHECK_FAILED'
    );
  }
  console.log('[OK] outbox schema contract (ready=%s)', result.ready);
}

async function main(): Promise<void> {
  console.log('verify_memory_runtime unit tests\n');
  await testSkippedModeNoFakeFalse();
  await testOutboxSchemaContract();
  console.log('\nAll verify_memory_runtime unit tests passed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
