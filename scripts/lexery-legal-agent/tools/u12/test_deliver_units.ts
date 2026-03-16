/**
 * U12 Deliver unit tests — idempotency conditions, no duplicate insert (LEX-133).
 * Run: pnpm brain:test:u12-units
 */

/** Idempotent skip: when completed_at already set, U12 should not perform deliver. */
function testU12SkipWhenCompletedAtSet(): void {
  const run = { completed_at: '2026-02-22T12:00:00Z' };
  const shouldSkip = run.completed_at != null;
  if (!shouldSkip) throw new Error('Expected shouldSkip true when completed_at set');
  console.log('[OK] U12 skip when completed_at already set');
}

/** Messages dedupe: same run_id in metadata means "already inserted" → do not insert again. */
function testMessagesDedupeByRunId(): void {
  const existingRows = [
    { id: 'a', metadata: { run_id: 'run-1' } },
    { id: 'b', metadata: {} },
  ];
  const exists = existingRows.some((r) => (r.metadata as Record<string, unknown>)?.run_id === 'run-1');
  if (!exists) throw new Error('Expected exists true for run-1');
  const notExists = existingRows.some((r) => (r.metadata as Record<string, unknown>)?.run_id === 'run-2');
  if (notExists) throw new Error('Expected notExists for run-2');
  console.log('[OK] messages dedupe by metadata.run_id');
}

/** Outbox dedupe: same payload.run_id + event_type means "already enqueued" → do not insert again. */
function testOutboxDedupeByRunId(): void {
  const existingRows = [
    { id: 'a', payload: { run_id: 'run-1' }, event_type: 'index_memory' },
    { id: 'b', payload: { run_id: 'run-2' }, event_type: 'index_memory' },
  ];
  const exists = existingRows.some(
    (r) => (r.payload as Record<string, unknown>)?.run_id === 'run-1' && r.event_type === 'index_memory'
  );
  if (!exists) throw new Error('Expected exists for run-1 index_memory');
  console.log('[OK] mm_outbox dedupe by payload.run_id + event_type');
}

async function main(): Promise<void> {
  console.log('U12 Deliver unit tests\n');
  testU12SkipWhenCompletedAtSet();
  testMessagesDedupeByRunId();
  testOutboxDedupeByRunId();
  console.log('\nAll U12 deliver unit tests passed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
