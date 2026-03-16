/**
 * Queue unit tests: InMemoryQueue async buffered behavior.
 * - enqueue returns before handler completion
 * - ordering preserved (FIFO)
 * - no cross-contamination between events
 *
 * Run: pnpm exec tsx scripts/lexery-legal-agent/tools/gateway/test_queue_units.ts
 */
import { strict as assert } from 'assert';
import { InMemoryQueue } from '../../gateway/queue.js';
import type { RunEvent } from '../../gateway/types.js';

function assertOk(cond: boolean, msg: string): void {
  assert(cond, `[FAIL] ${msg}`);
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, pollMs = 5): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

async function testEnqueueReturnsBeforeHandlerCompletion(): Promise<void> {
  const q = new InMemoryQueue();
  let handlerStarted = false;
  let handlerFinished = false;
  q.onEvent(async () => {
    handlerStarted = true;
    await new Promise((r) => setTimeout(r, 50));
    handlerFinished = true;
  });
  const enqueueDone = q.enqueue({
    run_id: 'run-1',
    step: 'U2',
    created_at: new Date().toISOString(),
    trace_id: 'trace-1',
  });
  await enqueueDone;
  assertOk(!handlerFinished, 'enqueue resolved before handler finished');
  assertOk(handlerStarted || !handlerStarted, 'handler may have started (async)');
  await waitUntil(() => handlerFinished, 250);
  assertOk(handlerFinished, 'handler eventually finished');
  console.log('[OK] enqueue returns before handler completion');
}

async function testOrderingPreserved(): Promise<void> {
  const q = new InMemoryQueue();
  const order: string[] = [];
  q.onEvent(async (event: RunEvent) => {
    order.push(event.run_id);
    await new Promise((r) => setTimeout(r, 5));
  });
  await q.enqueue({
    run_id: 'first',
    step: 'U2',
    created_at: new Date().toISOString(),
    trace_id: 't1',
  });
  await q.enqueue({
    run_id: 'second',
    step: 'U2',
    created_at: new Date().toISOString(),
    trace_id: 't2',
  });
  await q.enqueue({
    run_id: 'third',
    step: 'U2',
    created_at: new Date().toISOString(),
    trace_id: 't3',
  });
  await waitUntil(() => order.length === 3, 250);
  assertOk(order.length === 3, 'all three events processed');
  assertOk(order[0] === 'first' && order[1] === 'second' && order[2] === 'third', 'FIFO order preserved');
  console.log('[OK] ordering preserved');
}

async function testNoCrossContamination(): Promise<void> {
  const q = new InMemoryQueue();
  const seen: RunEvent[] = [];
  q.onEvent(async (event: RunEvent) => {
    seen.push({ ...event });
    await new Promise((r) => setTimeout(r, 2));
  });
  await q.enqueue({
    run_id: 'run-a',
    step: 'U2',
    created_at: '2020-01-01T00:00:00Z',
    trace_id: 'trace-a',
  });
  await q.enqueue({
    run_id: 'run-b',
    step: 'U3',
    created_at: '2020-01-02T00:00:00Z',
    trace_id: 'trace-b',
  });
  await waitUntil(() => seen.length === 2, 250);
  assertOk(seen.length === 2, 'two events seen');
  assertOk(seen[0].run_id === 'run-a' && seen[0].step === 'U2', 'first event intact');
  assertOk(seen[1].run_id === 'run-b' && seen[1].step === 'U3', 'second event intact');
  console.log('[OK] no cross-contamination');
}

async function main(): Promise<void> {
  await testEnqueueReturnsBeforeHandlerCompletion();
  await testOrderingPreserved();
  await testNoCrossContamination();
  console.log('All queue unit tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
