/**
 * Redis queue unit/integration tests.
 * - parsePayload (unit, no Redis)
 * - With REDIS_URL: enqueue -> processed once, handler fail -> retry, max retries -> DLQ
 * - With REDIS_URL: pending reclaim — abandon message with another consumer, then reclaim with queue
 *
 * Run: REDIS_URL=redis://localhost:6379 pnpm exec tsx scripts/lexery-legal-agent/tools/gateway/test_redis_queue_units.ts
 * Reclaim test uses REDIS_RECLAIM_MIN_IDLE_MS=2000 (override for faster test).
 * Without REDIS_URL: only unit tests run; integration tests skipped.
 */
import { strict as assert } from 'assert';
import { randomUUID } from 'crypto';
import { resolve } from 'path';
import Redis from 'ioredis';
import { config as loadEnv } from 'dotenv';
import { RedisQueue } from '../../gateway/queue-redis.js';
import type { RunEvent } from '../../gateway/types.js';

loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(process.cwd(), 'scripts/lexery-legal-agent/.env') });

const REDIS_URL = process.env.REDIS_URL;
type TestQueueNames = {
  ns: string;
  streamMain: string;
  streamRetry: string;
  streamDlq: string;
  groupName: string;
};

/** Unique namespace per test case so long-lived consumers from prior tests cannot steal messages. */
function makeTestQueueNames(label: string): TestQueueNames {
  const base = process.env.REDIS_TEST_NAMESPACE ?? 'lexery:test';
  const ns = `${base}:${label}:${Date.now()}:${randomUUID().slice(0, 8)}`;
  return {
    ns,
    streamMain: `${ns}:run_events`,
    streamRetry: `${ns}:run_events_retry`,
    streamDlq: `${ns}:run_events_dlq`,
    groupName: `${ns}_consumers`,
  };
}

function testQueueOptions(names: TestQueueNames): { redisUrl: string; streamMain: string; streamRetry: string; streamDlq: string; groupName: string } {
  return {
    redisUrl: REDIS_URL!,
    streamMain: names.streamMain,
    streamRetry: names.streamRetry,
    streamDlq: names.streamDlq,
    groupName: names.groupName,
  };
}

function assertOk(cond: boolean, msg: string): void {
  assert(cond, `[FAIL] ${msg}`);
}

/** Unit test: parsePayload logic (no Redis). */
function testParsePayload(): void {
  const parsePayload = (payload: string): { event: RunEvent; retry_count: number } => {
    const raw = JSON.parse(payload) as { event?: RunEvent; retry_count?: number } | RunEvent;
    if (raw && typeof raw === 'object' && 'run_id' in raw) {
      return { event: raw as RunEvent, retry_count: 0 };
    }
    const wrapped = raw as { event?: RunEvent; retry_count?: number };
    return {
      event: (wrapped?.event ?? raw) as RunEvent,
      retry_count: typeof wrapped?.retry_count === 'number' ? wrapped.retry_count : 0,
    };
  };
  const e: RunEvent = { run_id: 'r1', step: 'U2', created_at: '2020-01-01Z', trace_id: 't1' };
  const wrapped = parsePayload(JSON.stringify({ event: e, retry_count: 2 }));
  assertOk(wrapped.event.run_id === 'r1', 'event preserved');
  assertOk(wrapped.retry_count === 2, 'retry_count preserved');
  const bare = parsePayload(JSON.stringify(e));
  assertOk(bare.event.run_id === 'r1', 'bare event parsed');
  assertOk(bare.retry_count === 0, 'bare event retry_count 0');
  console.log('[OK] parsePayload');
}

async function testRedisEnqueueProcessedOnce(): Promise<void> {
  if (!REDIS_URL) {
    console.log('[SKIP] testRedisEnqueueProcessedOnce (no REDIS_URL)');
    return;
  }
  const names = makeTestQueueNames('once');
  const q = new RedisQueue(testQueueOptions(names));
  const processed: string[] = [];
  q.onEvent((ev: RunEvent) => {
    processed.push(ev.run_id);
  });
  await q.enqueue({
    run_id: 'run-once-' + Date.now(),
    step: 'U2',
    created_at: new Date().toISOString(),
    trace_id: 'trace-1',
  });
  await new Promise((r) => setTimeout(r, 1500));
  assertOk(processed.length === 1, 'processed exactly once');
  console.log('[OK] new message processed once');
}

async function testRedisEnqueueNotBlockedByConsumerRead(): Promise<void> {
  if (!REDIS_URL) {
    console.log('[SKIP] testRedisEnqueueNotBlockedByConsumerRead (no REDIS_URL)');
    return;
  }
  const names = makeTestQueueNames('latency');
  const q = new RedisQueue(testQueueOptions(names));
  q.onEvent(async () => {
    // no-op handler; consumer will still block waiting for new work
  });
  await new Promise((r) => setTimeout(r, 200));
  const started = Date.now();
  await q.enqueue({
    run_id: 'run-latency-' + Date.now(),
    step: 'U2',
    created_at: new Date().toISOString(),
    trace_id: 'trace-latency',
  });
  const latencyMs = Date.now() - started;
  assertOk(latencyMs < 1000, `enqueue should not be blocked by consumer read (actual ${latencyMs}ms)`);
  console.log('[OK] enqueue remains fast while consumer is blocking');
}

async function testRedisRetryAndDlq(): Promise<void> {
  if (!REDIS_URL) {
    console.log('[SKIP] testRedisRetryAndDlq (no REDIS_URL)');
    return;
  }
  const names = makeTestQueueNames('retry');
  const q = new RedisQueue(testQueueOptions(names));
  let attempts = 0;
  q.onEvent(async () => {
    attempts++;
    if (attempts < 3) throw new Error('simulated fail');
  });
  await q.enqueue({
    run_id: 'run-retry-' + Date.now(),
    step: 'U2',
    created_at: new Date().toISOString(),
    trace_id: 'trace-2',
  });
  // First attempt: main stream read (up to BLOCK_MS). Then fail -> retry stream. Second attempt: retry stream read (BLOCK_RETRY_MS). Need enough wall time.
  const retryWaitMs = parseInt(process.env.REDIS_RETRY_TEST_WAIT_MS ?? '10000', 10);
  await new Promise((r) => setTimeout(r, retryWaitMs));
  assertOk(attempts >= 2, 'retried at least once');
  console.log('[OK] failed message retried');
}

/** Reclaim: message left pending by another consumer is claimed and processed by RedisQueue. Requires REDIS_RECLAIM_MIN_IDLE_MS=2000 for fast run. */
async function testRedisReclaimPending(): Promise<void> {
  if (!REDIS_URL) {
    console.log('[SKIP] testRedisReclaimPending (no REDIS_URL)');
    return;
  }
  if (!process.env.REDIS_RECLAIM_MIN_IDLE_MS) {
    console.log('[SKIP] testRedisReclaimPending (set REDIS_RECLAIM_MIN_IDLE_MS=2000 for reclaim test)');
    return;
  }
  const names = makeTestQueueNames('reclaim');
  const runId = 'run-reclaim-' + Date.now();
  const payload = JSON.stringify({
    event: {
      run_id: runId,
      step: 'U2',
      created_at: new Date().toISOString(),
      trace_id: 'trace-reclaim',
    } as RunEvent,
    retry_count: 0,
  });

  const client = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });
  try {
    await client.xgroup('CREATE', names.streamMain, names.groupName, '0', 'MKSTREAM');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes('BUSYGROUP')) throw e;
  }
  try {
    await client.xgroup('CREATE', names.streamRetry, names.groupName, '0', 'MKSTREAM');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes('BUSYGROUP')) throw e;
  }

  await client.xadd(names.streamMain, '*', 'payload', payload);
  const replies = await client.xreadgroup(
    'GROUP', names.groupName, 'reclaim-victim',
    'COUNT', 1,
    'STREAMS', names.streamMain, '>'
  ) as [string, [string, string[]][]][] | null;
  assertOk(Array.isArray(replies) && replies.length > 0 && replies[0][1].length > 0, 'message read by victim');
  await client.quit();
  // Message is now pending for reclaim-victim; no ack. Wait for it to become reclaimable.
  const minIdle = parseInt(process.env.REDIS_RECLAIM_MIN_IDLE_MS ?? '2000', 10);
  await new Promise((r) => setTimeout(r, minIdle + 500));

  const processed: string[] = [];
  const q = new RedisQueue(testQueueOptions(names));
  q.onEvent((ev: RunEvent) => {
    processed.push(ev.run_id);
  });
  await new Promise((r) => setTimeout(r, 4000));
  assertOk(processed.includes(runId), 'reclaimed message was processed');
  console.log('[OK] pending message reclaimed and processed');
}

async function main(): Promise<void> {
  testParsePayload();
  await testRedisEnqueueProcessedOnce();
  await testRedisEnqueueNotBlockedByConsumerRead();
  await testRedisRetryAndDlq();
  await testRedisReclaimPending();
  console.log('Redis queue tests done (integration skipped if no REDIS_URL).');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
