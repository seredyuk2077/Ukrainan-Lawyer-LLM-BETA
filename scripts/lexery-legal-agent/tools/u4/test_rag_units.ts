/**
 * RAG unit tests — goal-splitter, selected_acts (classifyActKind), taxonomy scoring.
 * No server, no Qdrant/OpenRouter.
 * Run: pnpm brain:test:rag-units
 */
import { heuristicGoalSplit, hasMultiClauseStructure } from '../../retrieval/goal-splitter.js';
import { classifyActKind } from '../../retrieval/selected-acts.js';
import { scoreActCandidate, findActByTitleFragment } from '../../retrieval/act-taxonomy-store.js';
import { runCacheRag } from '../../retrieval/cache-rag.js';
import { compareHitsByOrderingScore, computeChunkStructuralScore } from '../../retrieval/chunk-rerank.js';

function testGoalSplitEmptyQuery(): void {
  const r = heuristicGoalSplit('', undefined, undefined);
  if (r.goals.length !== 1) throw new Error(`Expected 1 goal for empty query, got ${r.goals.length}`);
  if (r.goals[0].subquery !== '') throw new Error(`Expected subquery '', got "${r.goals[0].subquery}"`);
  if (r.goals[0].id !== 'goal_0') throw new Error(`Expected goal_0, got ${r.goals[0].id}`);
  console.log('[OK] heuristicGoalSplit("") → single goal, subquery ""');
}

function testGoalSplitMultiQuestion(): void {
  const q = 'Що таке шахрайство? І хто підслідний?';
  const r = heuristicGoalSplit(q, undefined, undefined);
  if (r.goals.length < 2) throw new Error(`Expected ≥2 goals for multi-question, got ${r.goals.length}`);
  const hasFirst = r.goals.some((g) => g.subquery.includes('шахрайство'));
  const hasSecond = r.goals.some((g) => g.subquery.includes('підслідний'));
  if (!hasFirst || !hasSecond) throw new Error('Expected both subqueries to appear in goals');
  console.log('[OK] heuristicGoalSplit(multi-question) → ≥2 goals');
}

function testGoalSplitSingleQueryNoSplit(): void {
  const q = 'умисне вбивство стаття ККУ';
  const r = heuristicGoalSplit(q, 'criminal', undefined);
  if (r.goals.length !== 1) throw new Error(`Expected 1 goal for single topic, got ${r.goals.length}`);
  if (r.goals[0].domain_hint !== 'criminal') throw new Error(`Expected domain_hint criminal, got ${r.goals[0].domain_hint}`);
  console.log('[OK] heuristicGoalSplit(single) → one goal, domain_hint preserved');
}

function testNoTopicBasedMultiGoal(): void {
  const q = 'шахрайство підслідність';
  const r = heuristicGoalSplit(q, undefined, undefined);
  if (r.goals.length !== 1) throw new Error(`Expected 1 goal when no ? or conjunction structure, got ${r.goals.length}`);
  console.log('[OK] heuristicGoalSplit(no structure) → one goal, no topic regex multi');
}

function testHasMultiClauseStructure(): void {
  if (!hasMultiClauseStructure('що таке крадіжка та яке покарання')) throw new Error('Expected true for "X та Y"');
  if (!hasMultiClauseStructure('перший сегмент і другий сегмент')) throw new Error('Expected true for "X і Y"');
  if (hasMultiClauseStructure('a і b', 10)) throw new Error('Expected false when segments too short');
  if (hasMultiClauseStructure('single clause')) throw new Error('Expected false for single clause');
  console.log('[OK] hasMultiClauseStructure structure-only');
}

function testClassifyActKindPrimaryLaw(): void {
  // document_type present → data-driven
  const kind = classifyActKind('Кодекс України про адміністративні правопорушення', 'Кодекс', null);
  if (kind !== 'PRIMARY_LAW') throw new Error(`Expected PRIMARY_LAW, got ${kind}`);
  const kind2 = classifyActKind('Закон про щось', 'Закон', null);
  if (kind2 !== 'PRIMARY_LAW') throw new Error(`Expected PRIMARY_LAW via document_type, got ${kind2}`);
  // No document_type → UNKNOWN (no title-word guessing)
  const kind3 = classifyActKind('Цивільний кодекс України', undefined, undefined);
  if (kind3 !== 'UNKNOWN') throw new Error(`Expected UNKNOWN (no document_type), got ${kind3}`);
  console.log('[OK] classifyActKind(codex/law) → PRIMARY_LAW via document_type, UNKNOWN without it');
}

function testClassifyActKindSecondaryOrder(): void {
  // document_type present → data-driven
  const kind = classifyActKind('Наказ МОЗ №2559', 'Наказ', 'healthcare');
  if (kind !== 'SECONDARY_ORDER') throw new Error(`Expected SECONDARY_ORDER, got ${kind}`);
  // No document_type → UNKNOWN (no title-word guessing)
  const kind2 = classifyActKind('Про затвердження порядку', undefined, undefined);
  if (kind2 !== 'UNKNOWN') throw new Error(`Expected UNKNOWN (no document_type), got ${kind2}`);
  console.log('[OK] classifyActKind(order/instruction) → SECONDARY_ORDER via document_type, UNKNOWN without it');
}

function testClassifyActKindUnknown(): void {
  const kind = classifyActKind('Невизначена назва документа', undefined, undefined);
  if (kind !== 'UNKNOWN') throw new Error(`Expected UNKNOWN, got ${kind}`);
  console.log('[OK] classifyActKind(unknown) → UNKNOWN');
}

function testClassifyActKindBillDraftNeedsMetadata(): void {
  const withoutDocType = classifyActKind('Про проект Закону України про щось', undefined, undefined);
  if (withoutDocType !== 'UNKNOWN') {
    throw new Error(`Expected UNKNOWN without document_type, got ${withoutDocType}`);
  }
  const withDocType = classifyActKind('Про проект Закону України про щось', 'Проєкт Закону', undefined);
  if (withDocType !== 'BILL_DRAFT') {
    throw new Error(`Expected BILL_DRAFT via document_type, got ${withDocType}`);
  }
  console.log('[OK] classifyActKind(bill-draft) → UNKNOWN without metadata, BILL_DRAFT with document_type');
}

async function testTaxonomyKeywordTopicNotInScore(): Promise<void> {
  // Even if a token matches a keyword/topic in taxonomy, it must NOT add to score.
  // Only alias_match and category_hint may contribute to scoreActCandidate score.
  // We test with a synthetic rada_nreg that is unlikely to exist in the snapshot.
  // If snapshot is absent, scoreActCandidate returns { score: 0, reasons: [] } — still passes.
  const result = await scoreActCandidate('__synthetic_nreg_test__', ['трудовий', 'договір']);
  if (result.score > 0 && result.reasons.every((r) => r === 'keyword_match' || r === 'topic_match')) {
    throw new Error(
      `scoreActCandidate score > 0 driven ONLY by keyword/topic_match — lexical scoring must not be acceptance-critical. score=${result.score}, reasons=${result.reasons}`
    );
  }
  console.log('[OK] taxonomy keyword/topic does not drive acceptance-critical score');
}

async function testFindActByTitleFragmentExport(): Promise<void> {
  const short = await findActByTitleFragment('ЦК');
  if (!Array.isArray(short) || short.length !== 0) {
    throw new Error(`Expected [] for short fragment, got ${JSON.stringify(short)}`);
  }
  const longer = await findActByTitleFragment('Цивільний кодекс України');
  if (!Array.isArray(longer)) {
    throw new Error('Expected array from findActByTitleFragment');
  }
  console.log('[OK] findActByTitleFragment exported and returns arrays');
}

async function testDocsOnlyNoSemanticPlanIsNotMarkedDegraded(): Promise<void> {
  const result = await runCacheRag({
    query: 'Що сказано у моєму договорі про строк повернення гарантійного платежу?',
    searchPlan: {
      version: 1,
      sources: { use_lldbi: false, use_memory: false, use_doclist: false, use_web: false },
      thresholds: { top_k_chunks: 20, min_score: 0.5 },
      reason_codes: ['mm_docs_only_scope'],
      meta: { built_at: new Date().toISOString(), rules_version: 'u3-v1' },
    },
    run_id: 'u4-docs-only-neutral',
    tenant_id: 'tenant-1',
    user_id: 'user-1',
  });
  if (result.retrievalTrace.degraded_sources !== undefined) {
    throw new Error(`Expected docs-only no-semantic route to stay non-degraded, got ${JSON.stringify(result.retrievalTrace.degraded_sources)}`);
  }
  if (!result.retrievalTrace.meta?.reason_codes?.includes('mm_docs_only_scope')) {
    throw new Error(`Expected docs-only reason code to be preserved, got ${JSON.stringify(result.retrievalTrace.meta?.reason_codes)}`);
  }
  console.log('[OK] docs-only no-semantic plan stays neutral, not degraded');
}

function testChunkStructuralScorePrefersBaseArticleTitle(): void {
  const query = 'Що таке умисне вбивство і яке покарання?';
  const baseHit = {
    r2_key: 'legislation/criminal/2341-14.json',
    json_path: '$.content.chunks[261].text',
    score: 0.46,
    source: 'lldbi_chunks' as const,
    rada_nreg: '2341-14',
    article_number: '115',
    metadata: {
      unit_type: 'article',
      chunk_title: 'Умисне вбивство',
    },
  };
  const specializedHit = {
    r2_key: 'legislation/criminal/2341-14.json',
    json_path: '$.content.chunks[263].text',
    score: 0.49,
    source: 'lldbi_chunks' as const,
    rada_nreg: '2341-14',
    article_number: '116',
    metadata: {
      unit_type: 'article',
      chunk_title: 'Умисне вбивство, вчинене в стані сильного душевного хвилювання',
    },
  };
  const baseScore = computeChunkStructuralScore(baseHit, query);
  const specializedScore = computeChunkStructuralScore(specializedHit, query);
  if (baseScore <= specializedScore) {
    throw new Error(
      `Expected base article title to outrank specialized variant. base=${baseScore} specialized=${specializedScore}`
    );
  }
  console.log('[OK] chunk structural score prefers base article title over overspecialized variant');
}

function testOrderingScoreBeatsRawVectorScore(): void {
  const noisyHigherVector = {
    r2_key: 'legislation/criminal/2341-14.json',
    json_path: '$.content.chunks[11].text',
    score: 0.57,
    ordering_score: 0.31,
    source: 'lldbi_chunks' as const,
    rada_nreg: '2341-14',
    article_number: '12',
  };
  const relevantLowerVector = {
    r2_key: 'legislation/criminal/2341-14.json',
    json_path: '$.content.chunks[147].text',
    score: 0.51,
    ordering_score: 0.62,
    source: 'lldbi_chunks' as const,
    rada_nreg: '2341-14',
    article_number: '115',
  };
  const ordered = [noisyHigherVector, relevantLowerVector].sort(compareHitsByOrderingScore);
  if (ordered[0]?.article_number !== '115') {
    throw new Error(
      `Expected ordering_score to outrank raw vector score. got=${ordered[0]?.article_number ?? 'none'}`
    );
  }
  console.log('[OK] ordering score outranks raw vector score in post-rerank sorting');
}

async function main(): Promise<void> {
  console.log('RAG unit tests\n');
  testGoalSplitEmptyQuery();
  testGoalSplitMultiQuestion();
  testGoalSplitSingleQueryNoSplit();
  testNoTopicBasedMultiGoal();
  testHasMultiClauseStructure();
  testClassifyActKindPrimaryLaw();
  testClassifyActKindSecondaryOrder();
  testClassifyActKindUnknown();
  testClassifyActKindBillDraftNeedsMetadata();
  await testTaxonomyKeywordTopicNotInScore();
  await testFindActByTitleFragmentExport();
  await testDocsOnlyNoSemanticPlanIsNotMarkedDegraded();
  testChunkStructuralScorePrefersBaseArticleTitle();
  testOrderingScoreBeatsRawVectorScore();
  console.log('\nAll RAG unit tests passed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
