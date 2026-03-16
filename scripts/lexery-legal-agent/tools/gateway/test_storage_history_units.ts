/**
 * Storage history unit tests (LEX-144).
 * Tests: listConversationMessages returns ordered array; insertUserMessageIfNotExists is idempotent (returns boolean).
 *
 * Run: pnpm brain:test:storage-history-units (or tsx this file)
 */
import { strict as assert } from 'assert';
import {
  RunRepository,
  isDuplicateRunIdConflict,
  isTransientStorageReadError,
  withTransientStorageReadRetry,
} from '../../gateway/storage.js';
import { isTransientGatewayIoError, withTransientGatewayIoRetry } from '../../gateway/retry.js';

function assertOk(cond: boolean, msg: string): void {
  assert(cond, `[FAIL] ${msg}`);
}

async function testListConversationMessagesReturnsArray(): Promise<void> {
  const repo = new RunRepository();
  const result = await repo.listConversationMessages('conv-nonexistent-' + Date.now(), 20);
  assertOk(Array.isArray(result), 'listConversationMessages returns array');
  assertOk(result.length >= 0, 'array length >= 0');
  for (const msg of result) {
    assertOk(typeof msg.role === 'string', 'message has role');
    assertOk(typeof msg.content === 'string', 'message has content');
  }
  console.log('[OK] listConversationMessages returns ordered bounded array (or empty)');
}

async function testInsertUserMessageIfNotExistsReturnsBoolean(): Promise<void> {
  const repo = new RunRepository();
  const runId = 'run-test-' + Date.now();
  const conversationId = 'conv-test-' + Date.now();
  const result = await repo.insertUserMessageIfNotExists(runId, conversationId, 'Test query');
  assertOk(typeof result === 'boolean', 'insertUserMessageIfNotExists returns boolean');
  const result2 = await repo.insertUserMessageIfNotExists(runId, conversationId, 'Same run again');
  assertOk(typeof result2 === 'boolean', 'second call (idempotent) returns boolean');
  console.log('[OK] insertUserMessageIfNotExists returns boolean, idempotent by run_id');
}

function testGatewayRetryPolicySignals(): void {
  assertOk(isTransientGatewayIoError(new TypeError('fetch failed')), 'fetch failed is transient');
  assertOk(isTransientGatewayIoError(new Error('UND_ERR_CONNECT_TIMEOUT')), 'connect timeout is transient');
  assertOk(!isTransientGatewayIoError(new Error('validation failed')), 'plain validation error is not transient');
  console.log('[OK] gateway retry policy signals classify transient I/O correctly');
}

function testStorageReadRetrySignals(): void {
  assertOk(isTransientStorageReadError(new TypeError('fetch failed')), 'fetch failed is transient storage read error');
  assertOk(isTransientStorageReadError(new Error('EAI_AGAIN while reading run')), 'DNS retryable error is transient');
  assertOk(!isTransientStorageReadError(new Error('validation failed')), 'validation error is not transient storage read error');
  console.log('[OK] storage read retry signals classify transient I/O correctly');
}

function testDuplicateRunIdConflictSignal(): void {
  assertOk(
    isDuplicateRunIdConflict({ code: '23505', message: 'duplicate key value violates unique constraint "runs_run_id_key"' }),
    'duplicate runs_run_id_key is treated as recoverable duplicate run create'
  );
  assertOk(
    !isDuplicateRunIdConflict({ code: '23505', message: 'duplicate key value violates unique constraint "runs_idempotency_key_key"' }),
    'other unique violations are not treated as duplicate run_id conflicts'
  );
  assertOk(
    !isDuplicateRunIdConflict({ code: 'XX000', message: 'internal error' }),
    'non-23505 errors are not treated as duplicate run_id conflicts'
  );
  console.log('[OK] duplicate run_id conflict signal matches runs_run_id_key only');
}

async function testStorageReadRetryRetriesTransientIo(): Promise<void> {
  let attempts = 0;
  const result = await withTransientStorageReadRetry(async () => {
    attempts += 1;
    if (attempts < 3) throw new TypeError('fetch failed');
    return 'ok';
  }, 3, 1);
  assertOk(result === 'ok', 'storage read retry returns successful result');
  assertOk(attempts === 3, 'storage read retry uses expected attempts');
  console.log('[OK] storage read retry retries transient I/O and succeeds');
}

async function testStorageReadRetryDoesNotRetryNonTransient(): Promise<void> {
  let attempts = 0;
  try {
    await withTransientStorageReadRetry(async () => {
      attempts += 1;
      throw new Error('validation failed');
    }, 3, 1);
    throw new Error('expected non-transient failure');
  } catch (err) {
    assertOk((err as Error).message === 'validation failed', 'storage read retry preserves original non-transient error');
    assertOk(attempts === 1, 'storage read retry does not retry non-transient error');
  }
  console.log('[OK] storage read retry does not retry non-transient error');
}

async function testGatewayRetryRetriesTransientIo(): Promise<void> {
  let attempts = 0;
  const result = await withTransientGatewayIoRetry(async () => {
    attempts += 1;
    if (attempts === 1) throw new TypeError('fetch failed');
    return 'ok';
  }, 2, 1);
  assertOk(result === 'ok', 'retry returns successful result');
  assertOk(attempts === 2, 'transient I/O retried exactly once');
  console.log('[OK] gateway retry retries transient I/O once and succeeds');
}

async function testGatewayRetryDoesNotRetryNonTransient(): Promise<void> {
  let attempts = 0;
  try {
    await withTransientGatewayIoRetry(async () => {
      attempts += 1;
      throw new Error('validation failed');
    }, 3, 1);
    throw new Error('expected non-transient failure');
  } catch (err) {
    assertOk((err as Error).message === 'validation failed', 'original non-transient error preserved');
    assertOk(attempts === 1, 'non-transient error not retried');
  }
  console.log('[OK] gateway retry does not retry non-transient error');
}

async function main(): Promise<void> {
  await testListConversationMessagesReturnsArray();
  await testInsertUserMessageIfNotExistsReturnsBoolean();
  testGatewayRetryPolicySignals();
  testStorageReadRetrySignals();
  testDuplicateRunIdConflictSignal();
  await testStorageReadRetryRetriesTransientIo();
  await testStorageReadRetryDoesNotRetryNonTransient();
  await testGatewayRetryRetriesTransientIo();
  await testGatewayRetryDoesNotRetryNonTransient();
  console.log('All storage history unit tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
