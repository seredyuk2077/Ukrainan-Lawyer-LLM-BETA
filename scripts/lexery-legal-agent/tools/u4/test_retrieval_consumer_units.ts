import { strict as assert } from 'assert';
import { runU4IoRetry } from '../../retrieval/consumer.js';

async function testRetriesTransientFetchFailure(): Promise<void> {
  let attempts = 0;
  const result = await runU4IoRetry(async () => {
    attempts += 1;
    if (attempts === 1) throw new TypeError('fetch failed');
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(attempts, 2);
  console.log('[OK] U4 retries transient fetch failure once and succeeds');
}

async function testDoesNotRetryNonTransientFailure(): Promise<void> {
  let attempts = 0;
  await assert.rejects(
    () =>
      runU4IoRetry(async () => {
        attempts += 1;
        throw new Error('validation failed');
      }),
    /validation failed/
  );
  assert.equal(attempts, 1);
  console.log('[OK] U4 does not retry non-transient failure');
}

async function main(): Promise<void> {
  await testRetriesTransientFetchFailure();
  await testDoesNotRetryNonTransientFailure();
  console.log('All U4 retrieval consumer unit tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
