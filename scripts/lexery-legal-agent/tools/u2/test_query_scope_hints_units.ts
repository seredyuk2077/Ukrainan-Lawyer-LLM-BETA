import {
  inferExplicitMmDocScope,
  hasExplicitMemoryRecallRequest,
  hasExplicitLegalReferenceRequest,
  isExplicitUserDocumentQuery,
  shouldUseDocsOnlyFastPath,
} from '../../lib/queryScopeHints.js';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERT FAIL: ${message}`);
}

function testExplicitDocQueryDetection(): void {
  assert(
    isExplicitUserDocumentQuery('Що в моєму документі сказано про гарантійний платіж?'),
    'explicit user-document query must be detected'
  );
  assert(
    isExplicitUserDocumentQuery('Який строк передсудового врегулювання у моїй проектній таблиці?'),
    'project-table phrasing must be treated as explicit user-document query'
  );
  assert(
    !isExplicitUserDocumentQuery('Яка відповідальність за прострочення за ЦК України?'),
    'plain legal query must not be treated as explicit user-document query'
  );
  console.log('[OK] explicit user-document query detection');
}

function testDocsOnlyFastPath(): void {
  assert(
    shouldUseDocsOnlyFastPath('Що в моєму документі сказано про гарантійний платіж?'),
    'explicit docs-only query should use fast path'
  );
  assert(
    hasExplicitLegalReferenceRequest('Що в моєму документі і які норми ЦК це підтверджують?'),
    'mixed docs+law query should retain explicit legal-reference signal'
  );
  assert(
    !shouldUseDocsOnlyFastPath('Що в моєму документі і які норми ЦК це підтверджують?'),
    'explicit legal-reference request must not use docs-only fast path'
  );
  console.log('[OK] docs-only fast path respects explicit legal-reference requests');
}

function testExplicitMemoryRecallDetection(): void {
  assert(
    hasExplicitMemoryRecallRequest('Нагадай мій улюблений колір і що ми вже обговорювали.'),
    'explicit memory recall phrasing must be detected'
  );
  assert(
    hasExplicitMemoryRecallRequest('З урахуванням того, що ми обговорювали, скажи що памʼятаєш про мене.'),
    'conversation-memory phrasing must be detected'
  );
  assert(
    !hasExplicitMemoryRecallRequest('Коли повертається гарантійний платіж у моїх документах цього проєкту?'),
    'plain docs-only question must not be treated as explicit memory recall'
  );
  console.log('[OK] explicit memory recall detection');
}

function testExplicitMmDocScopeInference(): void {
  assert(
    inferExplicitMmDocScope('Яка арбітражна обмовка у цьому документі?') === 'conversation',
    'single-document phrasing should prefer conversation scope'
  );
  assert(
    inferExplicitMmDocScope('Який строк передсудового врегулювання у моїй проектній таблиці?') === 'project',
    'project-table phrasing should prefer project scope'
  );
  assert(
    inferExplicitMmDocScope('Що сказано у моїх завантажених документах про арбітраж?') === 'user_global',
    'multi-document phrasing should prefer user-global scope'
  );
  console.log('[OK] explicit MM Docs scope inference');
}

function main(): void {
  console.log('query scope hints unit tests\n');
  testExplicitDocQueryDetection();
  testDocsOnlyFastPath();
  testExplicitMemoryRecallDetection();
  testExplicitMmDocScopeInference();
  console.log('\nAll query scope hints unit tests passed.');
}

main();
