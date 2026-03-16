import { applyMmDocsOnlyPlanOverride, isTransientPlanIoError, shouldPreferMmDocsOnlyPlan, withTransientPlanIoRetry } from '../../plan/consumer.js';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERT FAIL: ${message}`);
}

async function testTransientClassifier(): Promise<void> {
  assert(isTransientPlanIoError(new TypeError('fetch failed')), 'fetch failed is transient');
  assert(isTransientPlanIoError(new Error('ECONNRESET while updating run')), 'ECONNRESET is transient');
  assert(isTransientPlanIoError(new Error('UND_ERR_CONNECT_TIMEOUT')), 'connect timeout is transient');
  assert(!isTransientPlanIoError(new Error('validation error')), 'validation error is not transient');
  console.log('[OK] transient classifier');
}

async function testRetrySucceedsOnSecondAttempt(): Promise<void> {
  let attempts = 0;
  const result = await withTransientPlanIoRetry(async () => {
    attempts += 1;
    if (attempts === 1) throw new TypeError('fetch failed');
    return 'ok';
  });
  assert(result === 'ok', 'retry returns successful result');
  assert(attempts === 2, `expected 2 attempts, got ${attempts}`);
  console.log('[OK] retry succeeds on second attempt');
}

async function testNonTransientDoesNotRetry(): Promise<void> {
  let attempts = 0;
  try {
    await withTransientPlanIoRetry(async () => {
      attempts += 1;
      throw new Error('schema mismatch');
    });
    throw new Error('expected non-transient error to be thrown');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert(msg.includes('schema mismatch'), 'original non-transient error is preserved');
    assert(attempts === 1, `non-transient error should not retry (attempts=${attempts})`);
  }
  console.log('[OK] non-transient error does not retry');
}

async function testMmDocsOnlyPlanPreference(): Promise<void> {
  assert(
    shouldPreferMmDocsOnlyPlan({
      query: 'Що сказано у моєму договорі про штраф?',
      snapshot: null,
      attachmentsManifest: null,
    }),
    'explicit user-doc query should prefer MM Docs only plan even without explicit scope'
  );
  assert(
    shouldPreferMmDocsOnlyPlan({
      query: 'Повтори лише розмір штрафу за прострочення поставки яблук з мого документа.',
      snapshot: null,
      attachmentsManifest: null,
    }),
    'from-my-document phrasing should also prefer MM Docs only plan'
  );
  assert(
    shouldPreferMmDocsOnlyPlan({
      query: 'Завантажую великий договір проєкту.',
      snapshot: null,
      attachmentsManifest: [{ mm_doc_candidate: true }],
    }),
    'attachment-backed upload intent should prefer MM Docs only plan'
  );
  assert(
    shouldPreferMmDocsOnlyPlan({
      query: 'Яка арбітражна обмовка у цьому документі?',
      snapshot: null,
      attachmentsManifest: [{ mm_doc_candidate: true }],
    }),
    'current-run MM Docs attachment must prefer docs-only plan even without upload-intent phrasing'
  );
  assert(
    shouldPreferMmDocsOnlyPlan({
      query: 'Який строк передсудового врегулювання у моїй проектній таблиці?',
      snapshot: { project_context: { mm_doc_scope: 'project' } },
      attachmentsManifest: null,
    }),
    'explicit MM Docs scope must prefer docs-only plan for project-scope retrieval'
  );
  assert(
    !shouldPreferMmDocsOnlyPlan({
      query: 'Яка стаття закону застосовується до мого договору?',
      snapshot: { project_context: { mm_doc_scope: 'project' } },
      attachmentsManifest: null,
    }),
    'explicit legal-reference request must keep legal retrieval available'
  );
  console.log('[OK] MM Docs only-plan preference detection');
}

async function testMmDocsOnlyPlanOverride(): Promise<void> {
  const initial = {
    version: 1,
    sources: { use_lldbi: true, use_memory: false, use_doclist: true, use_web: false },
    thresholds: { top_k_chunks: 20, min_score: 0.5 },
    reason_codes: ['default_lldbi'],
    meta: { built_at: new Date().toISOString(), rules_version: 'u3-v1' },
  };
  const out = applyMmDocsOnlyPlanOverride({
    plan: initial,
    reasonCodes: ['default_lldbi'],
    query: 'Що сказано у моєму договорі про штраф?',
    contextMode: 'mixed',
    snapshot: null,
    attachmentsManifest: null,
  });
  assert(out.plan.sources.use_lldbi === false, 'override disables LLDBI');
  assert(out.plan.sources.use_doclist === false, 'override disables doclist');
  assert(out.plan.sources.use_memory === false, 'docs-only override must not preserve memory without explicit memory recall');
  assert(out.reasonCodes.includes('mm_docs_only_scope'), 'override reason code present');
  console.log('[OK] MM Docs only-plan override');
}

async function testMmDocsOnlyPlanKeepsMemoryForMixedRecall(): Promise<void> {
  const initial = {
    version: 1,
    sources: { use_lldbi: true, use_memory: false, use_doclist: true, use_web: false },
    thresholds: { top_k_chunks: 20, min_score: 0.5 },
    reason_codes: ['default_lldbi'],
    meta: { built_at: new Date().toISOString(), rules_version: 'u3-v1' },
  };
  const out = applyMmDocsOnlyPlanOverride({
    plan: initial,
    reasonCodes: ['default_lldbi'],
    query: 'Нагадай мій улюблений колір і скажи, коли повертається гарантійний платіж у моєму документі.',
    contextMode: 'memory',
    snapshot: null,
    attachmentsManifest: null,
  });
  assert(out.plan.sources.use_lldbi === false, 'mixed memory+docs still disables LLDBI');
  assert(out.plan.sources.use_doclist === false, 'mixed memory+docs disables doclist');
  assert(out.plan.sources.use_memory === true, 'mixed memory+docs must keep memory enabled');
  console.log('[OK] MM Docs only-plan keeps memory for memory/docs recall');
}

async function main(): Promise<void> {
  await testTransientClassifier();
  await testRetrySucceedsOnSecondAttempt();
  await testNonTransientDoesNotRetry();
  await testMmDocsOnlyPlanPreference();
  await testMmDocsOnlyPlanOverride();
  await testMmDocsOnlyPlanKeepsMemoryForMixedRecall();
  console.log('All U3 plan consumer unit tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
