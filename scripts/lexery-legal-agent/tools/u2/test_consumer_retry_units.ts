import { OpenRouterError } from '../../lib/openrouter.js';
import {
  isTransientU2ClassifierError,
  loadRunForU2,
  withTransientU2ClassifierRetry,
} from '../../classify/consumer.js';
import { RunRepository, StorageError } from '../../gateway/storage.js';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERT FAIL: ${message}`);
}

async function testLoadRunForU2RetriesTransientReadFailure(): Promise<void> {
  const original = RunRepository.prototype.findByRunId;
  let attempts = 0;
  try {
    RunRepository.prototype.findByRunId = async function mockedFindByRunId() {
      attempts++;
      if (attempts < 3) throw new StorageError('DB_READ_FAIL', 'TypeError: fetch failed');
      return { run_id: 'retry-ok' } as Awaited<ReturnType<RunRepository['findByRunId']>>;
    };
    const run = await loadRunForU2('retry-ok');
    assert(run != null, 'loadRunForU2 must eventually return the run after transient failures');
    assert(attempts === 3, 'loadRunForU2 must retry transient DB read failures');
    console.log('[OK] loadRunForU2 retries transient DB read failures');
  } finally {
    RunRepository.prototype.findByRunId = original;
  }
}

async function testTransientClassifierErrorDetection(): Promise<void> {
  assert(isTransientU2ClassifierError(new TypeError('fetch failed')), 'raw fetch failure should be transient');
  assert(
    isTransientU2ClassifierError(new OpenRouterError('provider overloaded', 'HTTP_ERROR', 503)),
    'OpenRouter 503 should be transient'
  );
  assert(
    !isTransientU2ClassifierError(new OpenRouterError('bad request', 'HTTP_ERROR', 400)),
    'OpenRouter 400 should not be transient'
  );
  console.log('[OK] U2 transient classifier error detection');
}

async function testTransientClassifierRetry(): Promise<void> {
  let attempts = 0;
  const result = await withTransientU2ClassifierRetry(async () => {
    attempts += 1;
    if (attempts < 3) throw new TypeError('fetch failed');
    return 'ok';
  }, 3, 1);
  assert(result === 'ok', 'U2 transient retry should eventually succeed');
  assert(attempts === 3, 'U2 transient retry should use bounded retries');
  console.log('[OK] U2 transient classifier retry');
}

async function main(): Promise<void> {
  console.log('U2 consumer retry unit tests\n');
  await testLoadRunForU2RetriesTransientReadFailure();
  await testTransientClassifierErrorDetection();
  await testTransientClassifierRetry();
  console.log('\nAll U2 consumer retry unit tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
