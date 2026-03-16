/**
 * FocusSpec unit tests (DEV RUN v14).
 * Run: pnpm brain:test:focus-spec-units (add script) or tsx this file.
 */
import { buildFocusSpec, enforceFocusOnContextParts, resolveFocusContextMode } from '../../write/focusSpec.js';
import type { AssembledPrompt } from '../../lib/pipeline/contracts.js';

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`ASSERT FAIL: ${msg}`);
}

function testCrimeCompositionPicks115(): void {
  const meta: AssembledPrompt['meta'] = {
    lawSourceRefs: [
      {
        r2_key: 'acts/other.json',
        json_path: '$.content.chunks[0].text',
        score: 0.9,
        rank: 0,
        loaded: true,
        normRef: { articleNumber: 99, heading: 'Інший злочин' },
      },
      {
        r2_key: 'acts/kku_115.json',
        json_path: '$.content.chunks[0].text',
        score: 0.85,
        rank: 1,
        loaded: true,
        normRef: { articleNumber: 115, heading: 'Умисне вбивство' },
      },
    ],
    lawIndex: {
      'acts/other.json::$.content.chunks[0].text': { articleNumber: 99, heading: 'Інший злочин' },
      'acts/kku_115.json::$.content.chunks[0].text': { articleNumber: 115, heading: 'Умисне вбивство' },
    },
  };

  const spec = buildFocusSpec('Поясни склад злочину умисного вбивства за КК України і наведи статтю', meta, false);

  assert(spec.taskType === 'crime_composition', 'taskType=crime_composition');
  assert(
    spec.primaryNormSourceId === 'acts/kku_115.json::$.content.chunks[0].text',
    `primaryNorm=115 snippet (got ${spec.primaryNormSourceId})`
  );
  assert(spec.primaryNormConfidence === 'high', `primaryNormConfidence=high (got ${spec.primaryNormConfidence})`);
  assert(spec.requiredSections.includes('NormQuote'), 'requiredSections includes NormQuote');
  assert(spec.requiredSections.includes('Composition'), 'requiredSections includes Composition');
  assert(spec.maxLawSnippets >= 4 && spec.maxLawSnippets <= 6, 'maxLawSnippets min 4 for crime_composition');
  assert(spec.bannedPhrases.some((p) => p.includes('надані матеріали')), 'bannedPhrases includes naдані матеріали');
  console.log('[OK] FocusSpec: crime_composition picks art.115, requiredSections, bannedPhrases');
}

function testFallbackToFirstWhenNoMatch(): void {
  const meta: AssembledPrompt['meta'] = {
    lawSourceRefs: [
      {
        r2_key: 'acts/other.json',
        json_path: '$.content.chunks[0].text',
        score: 0.95,
        rank: 0,
        loaded: true,
        normRef: { articleNumber: 99 },
      },
    ],
    lawIndex: { 'acts/other.json::$.content.chunks[0].text': { articleNumber: 99 } },
  };

  const spec = buildFocusSpec('Умисне вбивство ст. 115', meta, false);

  assert(spec.primaryNormSourceId === null, 'primaryNormSourceId=null when confidence low (no forced reorder)');
  assert(spec.primaryNormConfidence === 'low', 'confidence=low when no match');
  console.log('[OK] FocusSpec: low-confidence primary not forced (primaryNormSourceId=null)');
}

function testComparisonQueryNotCutToFour(): void {
  const meta: AssembledPrompt['meta'] = {
    lawSourceRefs: Array.from({ length: 8 }, (_, i) => ({
      r2_key: `acts/law_${i}.json`,
      json_path: '$.content.chunks[0].text',
      score: 0.9 - i * 0.05,
      rank: i,
      loaded: true,
      normRef: { articleNumber: 185 + i },
    })),
    lawIndex: {},
  };

  const spec = buildFocusSpec('Чим відрізняється крадіжка від грабежу та яка відповідальність?', meta, false);
  assert(spec.maxLawSnippets >= 6, 'comparison-like query → min 6 law snippets');
  console.log('[OK] FocusSpec: comparison query not cut to 4');
}

function testMemoryRecallUsesZeroLawSnippets(): void {
  const spec = buildFocusSpec('Що ти пам\'ятаєш про мої попередні запити?', { lawSourceRefs: [], lawIndex: {} }, false, 'memory');
  assert(spec.taskType === 'memory_recall', 'memory context → taskType=memory_recall');
  assert(spec.maxLawSnippets === 0, 'memory_recall → maxLawSnippets=0');
  console.log('[OK] FocusSpec: memory_recall hard-zeroes law snippets');
}

function testDocBackedRecallDoesNotForceMemoryMode(): void {
  const resolved = resolveFocusContextMode({
    rawContextMode: 'memory',
    docCount: 1,
    memoryCount: 0,
  });
  assert(resolved === undefined, 'doc-backed recall without memory artifacts must not stay in memory mode');

  const stillMemory = resolveFocusContextMode({
    rawContextMode: 'memory',
    docCount: 1,
    memoryCount: 2,
  });
  assert(stillMemory === 'memory', 'real memory artifacts keep memory mode');
  console.log('[OK] FocusSpec: doc-backed recall does not force memory mode');
}

function testExplicitUserDocumentQueryZeroesLawSnippets(): void {
  const meta: AssembledPrompt['meta'] = {
    sources: { lawCount: 6, docCount: 1, memoryCount: 0, historyCount: 1 },
    lawSourceRefs: [
      {
        r2_key: 'laws/civil.json',
        json_path: '$.content.chunks[0].text',
        score: 0.91,
        rank: 0,
        loaded: true,
        normRef: { articleNumber: 530, heading: 'Строк виконання зобовʼязання' },
      },
    ],
    lawIndex: {
      'laws/civil.json::$.content.chunks[0].text': { articleNumber: 530, heading: 'Строк виконання зобовʼязання' },
    },
  };

  const docSpec = buildFocusSpec('Коли повертається гарантійний платіж у моїх документах цього проєкту?', meta, false);
  assert(docSpec.maxLawSnippets === 0, `explicit user-document query must zero law snippets (got ${docSpec.maxLawSnippets})`);

  const uploadedDocSpec = buildFocusSpec('Яка арбітражна обмовка в моїх завантажених документах?', meta, false);
  assert(uploadedDocSpec.maxLawSnippets === 0, 'uploaded-doc query in Cyrillic/plural form must zero law snippets');

  const fromMyDocSpec = buildFocusSpec('Повтори лише розмір штрафу за прострочення поставки яблук з мого документа.', meta, false);
  assert(fromMyDocSpec.maxLawSnippets === 0, 'from-my-document phrasing must zero law snippets');

  const legalSpec = buildFocusSpec('Яка норма закону регулює гарантійний платіж у моїх документах цього проєкту?', meta, false);
  assert(legalSpec.maxLawSnippets > 0, 'explicit legal-reference request must preserve law snippets');

  const scopedSpec = buildFocusSpec(
    'Що сказано про гарантійний платіж?',
    { lawSourceRefs: [], lawIndex: {}, sources: { docCount: 0, lawCount: 0, memoryCount: 0, historyCount: 0 } },
    false,
    undefined,
    { mmDocsOnlyPlan: true }
  );
  assert(scopedSpec.maxLawSnippets === 0, 'mm_docs_only_scope planner signal must zero law snippets even without explicit phrasing');
  console.log('[OK] FocusSpec: explicit user-document query zeroes law snippets unless law is explicitly requested');
}

/** PHASE 4: article number regex uses boundaries so "18" does not match inside "118". */
function testArticleNumberBoundaryNoFalsePositive(): void {
  const meta: AssembledPrompt['meta'] = {
    lawSourceRefs: [
      {
        r2_key: 'acts/art18.json',
        json_path: '$.content.chunks[0].text',
        score: 0.9,
        rank: 0,
        loaded: true,
        normRef: { articleNumber: 18, heading: 'Стаття 18' },
      },
      {
        r2_key: 'acts/art118.json',
        json_path: '$.content.chunks[0].text',
        score: 0.85,
        rank: 1,
        loaded: true,
        normRef: { articleNumber: 118, heading: 'Стаття 118' },
      },
    ],
    lawIndex: {
      'acts/art18.json::$.content.chunks[0].text': { articleNumber: 18, heading: 'Стаття 18' },
      'acts/art118.json::$.content.chunks[0].text': { articleNumber: 118, heading: 'Стаття 118' },
    },
  };
  const spec118 = buildFocusSpec('Яка відповідальність за статтю 118 ККУ?', meta, false);
  assert(
    spec118.primaryNormSourceId === 'acts/art118.json::$.content.chunks[0].text',
    `query "118" must select 118 snippet (got ${spec118.primaryNormSourceId})`
  );
  const spec18 = buildFocusSpec('Покажи статтю 18 ККУ', meta, false);
  assert(
    spec18.primaryNormSourceId === 'acts/art18.json::$.content.chunks[0].text',
    `query "18" must select 18 snippet (got ${spec18.primaryNormSourceId})`
  );
  console.log('[OK] FocusSpec: article number boundary (18 vs 118) no false positive');
}

function testEnforceFocusOnlyWhenHighConfidence(): void {
  const lawParts = [
    { type: 'law', text: 'A', sourceIds: ['k1', 'p1'] },
    { type: 'law', text: 'B', sourceIds: ['k2', 'p2'] },
    { type: 'law', text: 'C', sourceIds: ['k3', 'p3'] },
  ];
  const specLow = {
    taskType: 'general' as const,
    primaryNormSourceId: 'k2::p2',
    primaryNormConfidence: 'low' as const,
    maxLawSnippets: 4,
    requiredSections: [],
    citationStyle: '',
    bannedPhrases: [],
    tone: '',
  };
  const result = enforceFocusOnContextParts([...lawParts], specLow);
  const lawOrder = result.filter((p) => p.type === 'law').map((p) => p.text);
  assert(lawOrder[0] === 'A', 'low confidence: primary not forced to front (A first)');
  console.log('[OK] FocusSpec: enforceFocus does not reorder when primaryNormConfidence=low');
}

function main(): void {
  console.log('FocusSpec unit tests\n');
  testCrimeCompositionPicks115();
  testFallbackToFirstWhenNoMatch();
  testComparisonQueryNotCutToFour();
  testMemoryRecallUsesZeroLawSnippets();
  testDocBackedRecallDoesNotForceMemoryMode();
  testExplicitUserDocumentQueryZeroesLawSnippets();
  testArticleNumberBoundaryNoFalsePositive();
  testEnforceFocusOnlyWhenHighConfidence();
  console.log('\nAll FocusSpec unit tests passed.');
}

main();
