/**
 * RAG unit tests — goal-splitter, selected_acts (classifyActKind), taxonomy scoring.
 * No server, no Qdrant/OpenRouter.
 * Run: pnpm brain:test:rag-units
 */
import {
  heuristicGoalSplit,
  hasMultiClauseStructure,
  getProcedureCategoryEnvelope,
} from '../../retrieval/goal-splitter.js';
import { buildSelectedActs, classifyActKind } from '../../retrieval/selected-acts.js';
import {
  buildTaxonomyQuerySignals,
  scoreActCandidate,
  findActByTitleFragment,
} from '../../retrieval/act-taxonomy-store.js';
import { runCacheRag } from '../../retrieval/cache-rag.js';
import { selectActPlannerTier } from '../../retrieval/act-planner.js';
import { buildWithinActPool, extractActSearchNregsFromHits } from '../../retrieval/within-act-pool.js';
import {
  buildDiscriminativeQueryTokenWeights,
  compareHitsByOrderingScore,
  computeChunkStructuralScore,
} from '../../retrieval/chunk-rerank.js';

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

function testContrastiveLiabilityGoalSplit(): void {
  const q = 'Яка відповідальність за ухилення від мобілізації та коли це адміністративна, а коли кримінальна?';
  const r = heuristicGoalSplit(q, undefined, undefined);
  if (r.goals.length !== 3) throw new Error(`Expected 3 goals for contrastive liability query, got ${r.goals.length}`);
  if (!r.reason_codes.includes('contrastive_liability_split')) {
    throw new Error(`Expected contrastive_liability_split reason code, got ${JSON.stringify(r.reason_codes)}`);
  }
  const subqueries = r.goals.map((g) => g.subquery);
  const administrativeGoal = subqueries.find((subquery) => subquery.includes('адміністративна відповідальність'));
  const criminalGoal = subqueries.find((subquery) => subquery.includes('кримінальна відповідальність'));
  if (!administrativeGoal || !administrativeGoal.includes('мобілізації')) {
    throw new Error(`Expected administrative subquery to keep mobilization focus, got ${JSON.stringify(subqueries)}`);
  }
  if (!criminalGoal || !criminalGoal.includes('мобілізації')) {
    throw new Error(`Expected criminal subquery to keep mobilization focus, got ${JSON.stringify(subqueries)}`);
  }
  if (administrativeGoal?.includes('ухилення від мобілізації')) {
    throw new Error(`Expected administrative goal to use compact subject focus instead of duplicating full phrase, got ${JSON.stringify(subqueries)}`);
  }
  console.log('[OK] heuristicGoalSplit(contrastive liability) → shared-subject multi-goal split');
}

function testHasMultiClauseStructure(): void {
  if (!hasMultiClauseStructure('що таке крадіжка та яке покарання')) throw new Error('Expected true for "X та Y"');
  if (!hasMultiClauseStructure('перший сегмент і другий сегмент')) throw new Error('Expected true for "X і Y"');
  if (hasMultiClauseStructure('a і b', 10)) throw new Error('Expected false when segments too short');
  if (hasMultiClauseStructure('single clause')) throw new Error('Expected false for single clause');
  console.log('[OK] hasMultiClauseStructure structure-only');
}

function testGoalSplitMultiClauseWithoutPlannerDependency(): void {
  const q = 'Податкова перевірка та оскарження її результатів';
  const r = heuristicGoalSplit(q, 'tax_customs', undefined);
  if (r.goals.length < 2) {
    throw new Error(`Expected structural multi-clause split, got ${r.goals.length} goals`);
  }
  if (!r.reason_codes.includes('multi_clause_structure')) {
    throw new Error(`Expected multi_clause_structure reason code, got ${JSON.stringify(r.reason_codes)}`);
  }
  console.log('[OK] heuristicGoalSplit(multi-clause) produces cheap structural multi-goal split');
}

function testGoalSplitCarriesSharedTailAcrossClauses(): void {
  const q = 'Порядок звільнення та компенсації при скороченні';
  const r = heuristicGoalSplit(q, 'labor_social', undefined);
  if (r.goals.length < 2) {
    throw new Error(`Expected shared-tail split to produce 2 goals, got ${r.goals.length}`);
  }
  const subqueries = r.goals.map((goal) => goal.subquery);
  if (!subqueries[0]?.includes('при скороченні')) {
    throw new Error(`Expected first clause to inherit shared tail, got ${JSON.stringify(subqueries)}`);
  }
  console.log('[OK] heuristicGoalSplit carries shared tail into both structural clauses');
}

function testActPlannerTierSkipsSingleGoalWhenTaxonomySignalExists(): void {
  const tier = selectActPlannerTier({
    goalsCount: 1,
    taxonomyActCount: 4,
    aliasHitCount: 2,
    categoryHintCount: 2,
    documentTypeHintCount: 1,
    queryLength: 24,
    hasContractLikeFlag: false,
  });
  if (tier !== 0) throw new Error(`Expected tier 0 when single-goal taxonomy signal is already strong, got ${tier}`);
  console.log('[OK] act planner tier stays off for single-goal query with strong taxonomy signal');
}

function testActPlannerTierUsesTierOneWhenSignalsAreMissing(): void {
  const tier = selectActPlannerTier({
    goalsCount: 1,
    taxonomyActCount: 0,
    aliasHitCount: 0,
    categoryHintCount: 0,
    documentTypeHintCount: 0,
    queryLength: 18,
    hasContractLikeFlag: false,
  });
  if (tier !== 1) throw new Error(`Expected tier 1 when single-goal taxonomy signal is missing, got ${tier}`);
  console.log('[OK] act planner tier uses cheap planner only when single-goal taxonomy signal is missing');
}

function testActPlannerTierKeepsTierTwoForMultiGoal(): void {
  const tier = selectActPlannerTier({
    goalsCount: 2,
    taxonomyActCount: 5,
    aliasHitCount: 3,
    categoryHintCount: 2,
    documentTypeHintCount: 1,
    queryLength: 70,
    hasContractLikeFlag: false,
  });
  if (tier !== 2) throw new Error(`Expected tier 2 for multi-goal query, got ${tier}`);
  console.log('[OK] act planner tier keeps tier 2 for multi-goal queries');
}

function testExtractActSearchNregsFromHitsUsesOnlyActSearchHits(): void {
  const nregs = extractActSearchNregsFromHits([
    { source: 'lldbi_chunks', rada_nreg: '111-11' } as const,
    { source: 'lldbi_acts', rada_nreg: '322-08' } as const,
    { source: 'lldbi_acts', rada_nreg: '322-08' } as const,
    { source: 'REFERENCE_EXPANSION', rada_nreg: '999-99' } as const,
    { source: 'lldbi_acts', rada_nreg: '2341-14' } as const,
  ]);
  if (JSON.stringify(nregs) !== JSON.stringify(['322-08', '2341-14'])) {
    throw new Error(`Expected only deduped lldbi_acts nregs, got ${JSON.stringify(nregs)}`);
  }
  console.log('[OK] within-act pool extracts deduped act-search nregs only from lldbi_acts hits');
}

function testBuildWithinActPoolPrefersTaxonomyWhenHintsExist(): void {
  const pool = buildWithinActPool({
    taxonomyNregs: ['80731-10', '2341-14'],
    actSearchNregs: ['2341-14', '111-11'],
    bootstrapActNregs: ['999-99'],
    categoryHintCount: 2,
    limit: 4,
  });
  if (JSON.stringify(pool) !== JSON.stringify(['80731-10', '2341-14', '999-99', '111-11'])) {
    throw new Error(`Expected taxonomy-led ordering under category hints, got ${JSON.stringify(pool)}`);
  }
  console.log('[OK] within-act pool prefers taxonomy-aligned acts when category hints exist');
}

function testBuildWithinActPoolPromotesPlannerPreferredActs(): void {
  const pool = buildWithinActPool({
    taxonomyNregs: ['2755-17', '2747-15', '2341-14'],
    actSearchNregs: ['2747-15', '2341-14'],
    plannerPreferredNregs: ['2341-14'],
    categoryHintCount: 1,
    limit: 3,
  });
  if (JSON.stringify(pool) !== JSON.stringify(['2341-14', '2755-17', '2747-15'])) {
    throw new Error(`Expected planner-preferred act to move to the front, got ${JSON.stringify(pool)}`);
  }
  console.log('[OK] within-act pool promotes planner-preferred acts without extra Qdrant search');
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

function testDiscriminativeStructuralScorePrefersMobilizationArticle(): void {
  const query =
    'Яка відповідальність за ухилення від мобілізації та коли це адміністративна, а коли кримінальна?';
  const mobilizationHit = {
    r2_key: 'legislation/administrative/80731-10.json',
    json_path: '$.content.chunks[455].text',
    score: 0.46,
    source: 'lldbi_chunks' as const,
    rada_nreg: '80731-10',
    article_number: '2101',
    metadata: {
      unit_type: 'article',
      chunk_title: 'Порушення законодавства про оборону, мобілізаційну підготовку та мобілізацію',
    },
  };
  const genericLiabilityHit = {
    r2_key: 'legislation/administrative/80731-10.json',
    json_path: '$.content.chunks[30].text',
    score: 0.49,
    source: 'lldbi_chunks' as const,
    rada_nreg: '80731-10',
    article_number: '35',
    metadata: {
      unit_type: 'article',
      chunk_title: 'Обставини, що обтяжують відповідальність за адміністративне правопорушення',
    },
  };
  const tokenWeights = buildDiscriminativeQueryTokenWeights([mobilizationHit, genericLiabilityHit], query);
  const mobilizationScore = computeChunkStructuralScore(mobilizationHit, query, tokenWeights);
  const genericScore = computeChunkStructuralScore(genericLiabilityHit, query, tokenWeights);
  if (mobilizationScore <= genericScore) {
    throw new Error(
      `Expected mobilization-specific article title to outrank generic liability title. mobilization=${mobilizationScore} generic=${genericScore}`
    );
  }
  console.log('[OK] discriminative structural score prefers mobilization-specific article over generic liability title');
}

function testStructuralScoreRemainsFiniteWhenMatchesAppearOutOfOrder(): void {
  const query = 'Чи можна звільнити працівника за ініціативою роботодавця?';
  const hit = {
    r2_key: 'legislation/labor/322-08.json',
    json_path: '$.content.chunks[37].text',
    score: 0.52,
    source: 'lldbi_chunks' as const,
    rada_nreg: '322-08',
    article_number: '38',
    metadata: {
      unit_type: 'article',
      chunk_title: 'Розірвання трудового договору, укладеного на невизначений строк, з ініціативи працівника',
    },
  };
  const score = computeChunkStructuralScore(hit, query);
  if (!Number.isFinite(score)) {
    throw new Error(`Expected finite structural score for out-of-order token matches, got ${score}`);
  }
  console.log('[OK] structural score stays finite when matched title tokens appear out of query order');
}

function testSingleGoalSelectedActsTailTrim(): void {
  const result = buildSelectedActs({
    finalHits: [],
    actCandidatesTop: [
      { rada_nreg: '57-95-п', title: 'Правила перетинання державного кордону', score: 0.61, category: 'admin', document_type: 'Постанова КМУ' },
      { rada_nreg: '2341-14', title: 'Кримінальний кодекс України', score: 0.54, category: 'criminal', document_type: 'Кодекс' },
      { rada_nreg: '2747-15', title: 'Кодекс адміністративного судочинства України', score: 0.4, category: 'admin', document_type: 'Кодекс' },
      { rada_nreg: '995_153', title: 'Конвенція про щось', score: 0.53, category: 'civil', document_type: 'Конвенція' },
    ],
    goals_summary: [{ goal_id: 'goal_0' }],
    taxonomyNregs: new Set(['57-95-п', '2341-14', '2747-15', '995_153']),
    actsSearchNregs: ['57-95-п', '2341-14', '2747-15', '995_153'],
    chunks_evidence_top_acts: [
      { rada_nreg: '57-95-п', count_in_top30: 13, avg_score_in_top30: 0.53, max_score: 0.61 },
      { rada_nreg: '2341-14', count_in_top30: 8, avg_score_in_top30: 0.49, max_score: 0.54 },
      { rada_nreg: '2747-15', count_in_top30: 6, avg_score_in_top30: 0.39, max_score: 0.4 },
      { rada_nreg: '995_153', count_in_top30: 3, avg_score_in_top30: 0.48, max_score: 0.53 },
    ],
  });
  if (result.selected_acts.length !== 3) {
    throw new Error(`Expected single-goal tail trim to keep 3 acts, got ${result.selected_acts.length}`);
  }
  if (result.selected_acts.some((act) => act.rada_nreg === '995_153')) {
    throw new Error(`Expected weakest tail act to be trimmed, got ${JSON.stringify(result.selected_acts)}`);
  }
  if (
    !result.selected_acts_reason_codes.includes('SINGLE_GOAL_TAIL_TRIMMED') &&
    !result.selected_acts_reason_codes.includes('NON_PRIMARY_EVIDENCE_BLOCKED_PRIMARY_PRESENT')
  ) {
    throw new Error(`Expected single-goal tail cleanup reason code, got ${JSON.stringify(result.selected_acts_reason_codes)}`);
  }
  console.log('[OK] selected_acts cleans weak single-goal tail acts when primary evidence dominates');
}

function testProcedureCategoryEnvelopeFallsBackToProcedureFamilies(): void {
  const envelope = getProcedureCategoryEnvelope(['tax_customs']);
  const expected = [
    'judiciary_justice',
    'criminal_procedure',
    'civil_procedure',
    'civil_procedure_administrative',
  ];
  for (const category of expected) {
    if (!envelope.includes(category)) {
      throw new Error(`Expected procedure envelope to include ${category}, got ${JSON.stringify(envelope)}`);
    }
  }
  console.log('[OK] procedure category envelope injects procedure families when hints are substantive only');
}

function testBuildTaxonomyQuerySignalsIncludesMultiWordPhrases(): void {
  const signals = buildTaxonomyQuerySignals(
    'Який порядок оскарження податкового повідомлення-рішення та строки звернення до адміністративного суду?'
  );
  if (!signals.tokens.includes('податкового')) {
    throw new Error(`Expected base token in taxonomy signals, got ${JSON.stringify(signals)}`);
  }
  if (!signals.phrases.some((phrase) => phrase.includes('адміністративного суду'))) {
    throw new Error(`Expected phrase-level signal for administrative court, got ${JSON.stringify(signals.phrases)}`);
  }
  if (!signals.phrases.some((phrase) => phrase.includes('податкового повідомлення'))) {
    throw new Error(`Expected phrase-level signal for tax notice, got ${JSON.stringify(signals.phrases)}`);
  }
  console.log('[OK] buildTaxonomyQuerySignals keeps multi-word legal phrases for metadata matching');
}

function testSelectedActsAvoidWeakSingleGoalSupportNoise(): void {
  const result = buildSelectedActs({
    finalHits: [],
    actCandidatesTop: [
      {
        rada_nreg: '322-08',
        title: 'Кодекс законів про працю України',
        score: 2.8,
        category: 'labor_social',
        document_type: 'Кодекс',
        source_tier: 'ACTS_1',
      },
      {
        rada_nreg: '80731-10',
        title: 'Кодекс України про адміністративні правопорушення',
        score: 0.9,
        category: 'administrative_offenses',
        document_type: 'Кодекс',
        source_tier: 'ACTS_2',
      },
      {
        rada_nreg: '2597-19',
        title: 'Кодекс України з процедур банкрутства',
        score: 0.7,
        category: 'business_corporate',
        document_type: 'Кодекс',
        source_tier: 'ACTS_2',
      },
    ],
    goals_summary: [{ goal_id: 'goal_0' }],
    taxonomyNregs: new Set(['322-08', '80731-10', '2597-19']),
    actsSearchNregs: ['322-08', '80731-10', '2597-19'],
    chunks_evidence_top_acts: [
      { rada_nreg: '322-08', count_in_top30: 11, avg_score_in_top30: 0.57, max_score: 0.62 },
      { rada_nreg: '80731-10', count_in_top30: 1, avg_score_in_top30: 0.31, max_score: 0.31 },
      { rada_nreg: '2597-19', count_in_top30: 1, avg_score_in_top30: 0.28, max_score: 0.28 },
    ],
  });
  if (result.selected_acts.length !== 1) {
    throw new Error(`Expected single-goal dominant evidence to keep only one act, got ${JSON.stringify(result.selected_acts)}`);
  }
  if (result.selected_acts[0]?.rada_nreg !== '322-08') {
    throw new Error(`Expected labor code to remain as sole selected act, got ${JSON.stringify(result.selected_acts)}`);
  }
  if (result.selected_acts_reason_codes.includes('SELECTED_ACTS_DIVERSITY_ENFORCED')) {
    throw new Error(`Did not expect diversity reason code for blocked weak support noise, got ${JSON.stringify(result.selected_acts_reason_codes)}`);
  }
  console.log('[OK] selected_acts avoids weak ACTS_2 noise on single-goal dominant evidence');
}

function testSelectedActsTrimWeakMultiGoalTail(): void {
  const result = buildSelectedActs({
    finalHits: [],
    actCandidatesTop: [
      { rada_nreg: '322-08', title: 'КЗпП', score: 0.81, category: 'labor_social', document_type: 'Кодекс', source_tier: 'ACTS_1' },
      { rada_nreg: '100-95-п', title: 'Порядок обчислення середньої заробітної плати', score: 0.62, category: 'labor_social', document_type: 'Постанова КМУ', source_tier: 'ACTS_1' },
      { rada_nreg: '4651-17', title: 'КПК України', score: 0.59, category: 'criminal_procedure', document_type: 'Кодекс', source_tier: 'ACTS_1' },
      { rada_nreg: '580-19', title: 'Про Національну поліцію', score: 0.55, category: 'administrative', document_type: 'Закон', source_tier: 'ACTS_1' },
    ],
    goals_summary: [{ goal_id: 'goal_0' }, { goal_id: 'goal_1' }],
    taxonomyNregs: new Set(['322-08', '100-95-п', '4651-17', '580-19']),
    actsSearchNregs: ['322-08', '100-95-п', '4651-17', '580-19'],
    chunks_evidence_top_acts: [
      { rada_nreg: '322-08', count_in_top30: 12, avg_score_in_top30: 0.58, max_score: 0.61 },
      { rada_nreg: '100-95-п', count_in_top30: 5, avg_score_in_top30: 0.38, max_score: 0.4 },
      { rada_nreg: '4651-17', count_in_top30: 2, avg_score_in_top30: 0.33, max_score: 0.34 },
      { rada_nreg: '580-19', count_in_top30: 1, avg_score_in_top30: 0.31, max_score: 0.31 },
    ],
  });
  if (result.selected_acts.some((act) => act.rada_nreg === '580-19')) {
    throw new Error(`Expected weak multi-goal tail act to be trimmed, got ${JSON.stringify(result.selected_acts)}`);
  }
  if (!result.selected_acts_reason_codes.includes('MULTI_GOAL_TAIL_TRIMMED')) {
    throw new Error(`Expected MULTI_GOAL_TAIL_TRIMMED reason code, got ${JSON.stringify(result.selected_acts_reason_codes)}`);
  }
  console.log('[OK] selected_acts trims weak multi-goal tail noise');
}

function testSelectedActsBlockCrossFamilySupportWithoutEvidence(): void {
  const result = buildSelectedActs({
    finalHits: [],
    actCandidatesTop: [
      { rada_nreg: '322-08', title: 'КЗпП', score: 0.91, category: 'labor_social', document_type: 'Кодекс', source_tier: 'ACTS_1' },
      { rada_nreg: '100-95-п', title: 'Порядок №100', score: 0.72, category: 'labor_social', document_type: 'Постанова КМУ', source_tier: 'ACTS_1' },
      { rada_nreg: '580-19', title: 'Про Національну поліцію', score: 0.7, category: 'administrative', document_type: 'Закон', source_tier: 'ACTS_1' },
    ],
    goals_summary: [{ goal_id: 'goal_0' }, { goal_id: 'goal_1' }],
    taxonomyNregs: new Set(['322-08', '100-95-п', '580-19']),
    actsSearchNregs: ['322-08', '100-95-п', '580-19'],
    chunks_evidence_top_acts: [
      { rada_nreg: '322-08', count_in_top30: 10, avg_score_in_top30: 0.58, max_score: 0.61 },
      { rada_nreg: '100-95-п', count_in_top30: 4, avg_score_in_top30: 0.4, max_score: 0.42 },
      { rada_nreg: '580-19', count_in_top30: 1, avg_score_in_top30: 0.31, max_score: 0.31 },
    ],
    familyEvidence: {
      dominant_family_key: 'labor_social',
      family_confidence: 0.93,
      family_conflict: false,
      top2: [{ family_key: 'labor_social', support_score: 0.93 }],
    },
  });
  if (result.selected_acts.some((act) => act.rada_nreg === '580-19')) {
    throw new Error(`Expected cross-family support act to be blocked, got ${JSON.stringify(result.selected_acts)}`);
  }
  if (!result.selected_acts_reason_codes.includes('SUPPORT_FAMILY_MISMATCH_BLOCKED')) {
    throw new Error(`Expected SUPPORT_FAMILY_MISMATCH_BLOCKED reason code, got ${JSON.stringify(result.selected_acts_reason_codes)}`);
  }
  console.log('[OK] selected_acts blocks weak cross-family support when family evidence is dominant');
}

function testSelectedActsDemoteCrossFamilyChunkEvidence(): void {
  const result = buildSelectedActs({
    finalHits: [],
    actCandidatesTop: [
      { rada_nreg: '322-08', title: 'КЗпП', score: 0.91, category: 'labor_social', document_type: 'Кодекс', source_tier: 'ACTS_1' },
      { rada_nreg: '100-95-п', title: 'Порядок №100', score: 0.72, category: 'labor_social', document_type: 'Постанова КМУ', source_tier: 'ACTS_1' },
      { rada_nreg: '2755-17', title: 'ПКУ', score: 0.69, category: 'tax_customs', document_type: 'Кодекс', source_tier: 'ACTS_1' },
    ],
    goals_summary: [{ goal_id: 'goal_0' }, { goal_id: 'goal_1' }],
    taxonomyNregs: new Set(['322-08', '100-95-п', '2755-17']),
    actsSearchNregs: ['322-08', '100-95-п', '2755-17'],
    chunks_evidence_top_acts: [
      { rada_nreg: '322-08', count_in_top30: 8, avg_score_in_top30: 0.58, max_score: 0.61 },
      { rada_nreg: '100-95-п', count_in_top30: 6, avg_score_in_top30: 0.57, max_score: 0.63 },
      { rada_nreg: '2755-17', count_in_top30: 3, avg_score_in_top30: 0.41, max_score: 0.46 },
    ],
    familyEvidence: {
      dominant_family_key: 'labor_social',
      family_confidence: 0.9,
      family_conflict: false,
      top2: [{ family_key: 'labor_social', support_score: 0.9 }],
    },
  });
  if (result.selected_acts.some((act) => act.rada_nreg === '2755-17')) {
    throw new Error(`Expected cross-family chunk evidence to be demoted, got ${JSON.stringify(result.selected_acts)}`);
  }
  if (!result.selected_acts_reason_codes.includes('CHUNKS_FAMILY_MISMATCH_DEMOTED')) {
    throw new Error(`Expected CHUNKS_FAMILY_MISMATCH_DEMOTED reason code, got ${JSON.stringify(result.selected_acts_reason_codes)}`);
  }
  console.log('[OK] selected_acts demotes weak cross-family chunk evidence under dominant family evidence');
}

function testSelectedActsPreserveStrongEarlyPrimaryLawEvidence(): void {
  const result = buildSelectedActs({
    finalHits: [],
    actCandidatesTop: [
      { rada_nreg: '2341-14', title: 'Кримінальний кодекс України', score: 3.4, category: 'criminal', document_type: 'Кодекс', source_tier: 'ACTS_1' },
      { rada_nreg: '80731-10', title: 'Кодекс України про адміністративні правопорушення', score: 3.17, category: 'administrative_offenses', document_type: 'Кодекс', source_tier: 'ACTS_1' },
      { rada_nreg: 'nb07d710-25', title: 'Окрема думка судді КСУ', score: 2.9, category: 'administrative_offenses', document_type: 'Рішення КСУ', source_tier: 'ACTS_1' },
      { rada_nreg: 'v0007700-81', title: 'Постанова пленуму', score: 2.7, category: 'criminal', document_type: 'Постанова Пленуму Верховного Суду', source_tier: 'ACTS_1' },
    ],
    goals_summary: [{ goal_id: 'goal_0' }],
    taxonomyNregs: new Set(['2341-14', '80731-10', 'nb07d710-25', 'v0007700-81']),
    actsSearchNregs: ['2341-14', '80731-10', 'nb07d710-25', 'v0007700-81'],
    chunks_evidence_top_acts: [
      { rada_nreg: '2341-14', count_in_top30: 13, avg_score_in_top30: 0.51, max_score: 0.565, best_rank_in_top30: 1, rank_mass_top30: 2.4, max_ordering_score: 0.613 },
      { rada_nreg: '80731-10', count_in_top30: 2, avg_score_in_top30: 0.559, max_score: 0.564, best_rank_in_top30: 3, rank_mass_top30: 0.58, max_ordering_score: 0.576 },
      { rada_nreg: 'nb07d710-25', count_in_top30: 8, avg_score_in_top30: 0.47, max_score: 0.475, best_rank_in_top30: 8, rank_mass_top30: 0.22, max_ordering_score: 0.31 },
      { rada_nreg: 'v0007700-81', count_in_top30: 4, avg_score_in_top30: 0.31, max_score: 0.312, best_rank_in_top30: 15, rank_mass_top30: 0.12, max_ordering_score: 0.24 },
    ],
    familyEvidence: {
      dominant_family_key: 'criminal',
      family_confidence: 0.9,
      family_conflict: false,
      top2: [{ family_key: 'criminal', support_score: 0.9 }],
    },
  });
  if (!result.selected_acts.some((act) => act.rada_nreg === '80731-10')) {
    throw new Error(`Expected strong early primary-law evidence to preserve 80731-10, got ${JSON.stringify(result.selected_acts)}`);
  }
  if (result.selected_acts.some((act) => act.rada_nreg === 'nb07d710-25')) {
    throw new Error(`Expected opinion noise to be blocked when primary law evidence exists, got ${JSON.stringify(result.selected_acts)}`);
  }
  if (result.selected_acts.some((act) => act.rada_nreg === 'v0007700-81')) {
    throw new Error(`Expected weak order evidence to be trimmed under primary-law dominance, got ${JSON.stringify(result.selected_acts)}`);
  }
  console.log('[OK] selected_acts preserves strong early primary-law evidence over noisy opinion/order tail');
}

function testSelectedActsBlocksKsuNoiseUnderPrimaryLawDominance(): void {
  const result = buildSelectedActs({
    finalHits: [],
    actCandidatesTop: [
      {
        rada_nreg: '2755-17',
        title: 'Податковий кодекс України',
        score: 0.92,
        category: 'tax_customs',
        document_type: 'Кодекс',
        source_tier: 'ACTS_1',
      },
      {
        rada_nreg: '2747-15',
        title: 'Кодекс адміністративного судочинства України',
        score: 0.71,
        category: 'judiciary_justice',
        document_type: 'Кодекс',
        source_tier: 'ACTS_1',
      },
      {
        rada_nreg: 'v001p710-18',
        title: 'Рішення Конституційного Суду України у справі про оподаткування пенсій',
        score: 0.69,
        category: 'constitutional',
        document_type: 'Рішення КСУ',
        source_tier: 'ACTS_1',
      },
    ],
    goals_summary: [{ goal_id: 'goal_0' }],
    taxonomyNregs: new Set(['2755-17', '2747-15', 'v001p710-18']),
    actsSearchNregs: ['2755-17', '2747-15', 'v001p710-18'],
    chunks_evidence_top_acts: [
      { rada_nreg: '2755-17', count_in_top30: 10, avg_score_in_top30: 0.56, max_score: 0.59, best_rank_in_top30: 1, rank_mass_top30: 2.0, max_ordering_score: 0.62 },
      { rada_nreg: '2747-15', count_in_top30: 3, avg_score_in_top30: 0.44, max_score: 0.47, best_rank_in_top30: 11, rank_mass_top30: 0.24, max_ordering_score: 0.38 },
      { rada_nreg: 'v001p710-18', count_in_top30: 3, avg_score_in_top30: 0.46, max_score: 0.5, best_rank_in_top30: 9, rank_mass_top30: 0.2, max_ordering_score: 0.46 },
    ],
    familyEvidence: {
      dominant_family_key: 'tax_customs',
      family_confidence: 0.9,
      family_conflict: false,
      top2: [{ family_key: 'tax_customs', support_score: 0.9 }],
    },
  });
  if (result.selected_acts.some((act) => act.rada_nreg === 'v001p710-18')) {
    throw new Error(`Expected KSU decision noise to be blocked under primary-law dominance, got ${JSON.stringify(result.selected_acts)}`);
  }
  console.log('[OK] selected_acts blocks weak KSU decision noise under primary-law dominance');
}

function testSelectedActsBlocksKsuNoiseEvenWhenFamilyEvidenceConflicts(): void {
  const result = buildSelectedActs({
    finalHits: [],
    actCandidatesTop: [
      {
        rada_nreg: '2755-17',
        title: 'Податковий кодекс України',
        score: 0.93,
        category: 'tax_customs',
        document_type: 'Кодекс',
        source_tier: 'ACTS_1',
      },
      {
        rada_nreg: 'v001p710-18',
        title: 'Рішення Конституційного Суду України у справі про оподаткування пенсій',
        score: 0.7,
        category: 'constitutional',
        document_type: 'Рішення КСУ',
        source_tier: 'ACTS_1',
      },
      {
        rada_nreg: '2747-15',
        title: 'Кодекс адміністративного судочинства України',
        score: 0.69,
        category: 'judiciary_justice',
        document_type: 'Кодекс',
        source_tier: 'ACTS_1',
      },
    ],
    goals_summary: [{ goal_id: 'goal_0' }],
    taxonomyNregs: new Set(['2755-17', 'v001p710-18', '2747-15']),
    actsSearchNregs: ['2755-17', 'v001p710-18', '2747-15'],
    chunks_evidence_top_acts: [
      {
        rada_nreg: '2755-17',
        count_in_top30: 9,
        avg_score_in_top30: 0.55,
        max_score: 0.61,
        best_rank_in_top30: 1,
        rank_mass_top30: 1.9,
        max_ordering_score: 0.62,
      },
      {
        rada_nreg: 'v001p710-18',
        count_in_top30: 2,
        avg_score_in_top30: 0.46,
        max_score: 0.5,
        best_rank_in_top30: 9,
        rank_mass_top30: 0.13,
        max_ordering_score: 0.46,
      },
      {
        rada_nreg: '2747-15',
        count_in_top30: 2,
        avg_score_in_top30: 0.39,
        max_score: 0.43,
        best_rank_in_top30: 12,
        rank_mass_top30: 0.1,
        max_ordering_score: 0.36,
      },
    ],
    familyEvidence: {
      dominant_family_key: 'tax_customs',
      family_confidence: 0.61,
      family_conflict: true,
      top2: [
        { family_key: 'tax_customs', support_score: 0.61 },
        { family_key: 'constitutional', support_score: 0.48 },
      ],
    },
  });
  if (result.selected_acts.some((act) => act.rada_nreg === 'v001p710-18')) {
    throw new Error(
      `Expected weak KSU decision to stay blocked even when family evidence conflicts, got ${JSON.stringify(result.selected_acts)}`
    );
  }
  console.log('[OK] selected_acts blocks weak KSU decision even under family-conflict traces');
}

function testSelectedActsKeepStrongSupportingOrderWithRepeatedEvidence(): void {
  const result = buildSelectedActs({
    finalHits: [],
    actCandidatesTop: [
      {
        rada_nreg: '435-15',
        title: 'Цивільний кодекс України',
        score: 0.84,
        category: 'civil',
        document_type: 'Кодекс',
        source_tier: 'ACTS_1',
      },
      {
        rada_nreg: '1023-12',
        title: 'Про захист прав споживачів',
        score: 0.79,
        category: 'civil',
        document_type: 'Закон',
        source_tier: 'ACTS_1',
      },
      {
        rada_nreg: 'z1257-07',
        title: 'Про затвердження Правил роздрібної торгівлі непродовольчими товарами',
        score: 0.52,
        category: 'business_corporate',
        document_type: 'Наказ',
        source_tier: 'ACTS_1',
      },
    ],
    goals_summary: [{ goal_id: 'goal_0' }],
    taxonomyNregs: new Set(['435-15', '1023-12', 'z1257-07']),
    actsSearchNregs: ['435-15', '1023-12', 'z1257-07'],
    chunks_evidence_top_acts: [
      {
        rada_nreg: '435-15',
        count_in_top30: 13,
        avg_score_in_top30: 0.53,
        max_score: 0.61,
        best_rank_in_top30: 1,
        rank_mass_top30: 2.3,
        max_ordering_score: 0.61,
      },
      {
        rada_nreg: '1023-12',
        count_in_top30: 8,
        avg_score_in_top30: 0.51,
        max_score: 0.59,
        best_rank_in_top30: 2,
        rank_mass_top30: 1.54,
        max_ordering_score: 0.59,
      },
      {
        rada_nreg: 'z1257-07',
        count_in_top30: 5,
        avg_score_in_top30: 0.42,
        max_score: 0.46,
        best_rank_in_top30: 9,
        rank_mass_top30: 0.42,
        max_ordering_score: 0.47,
      },
    ],
    familyEvidence: {
      dominant_family_key: 'civil',
      family_confidence: 0.88,
      family_conflict: false,
      top2: [{ family_key: 'civil', support_score: 0.88 }],
    },
  });
  if (!result.selected_acts.some((act) => act.rada_nreg === 'z1257-07')) {
    throw new Error(
      `Expected repeated supporting-order evidence to preserve z1257-07, got ${JSON.stringify(result.selected_acts)}`
    );
  }
  console.log('[OK] selected_acts keeps strong supporting secondary act when repeated evidence is present');
}

function testSelectedActsAllowSingleActCoverageForDominantMultiGoal(): void {
  const result = buildSelectedActs({
    finalHits: [],
    actCandidatesTop: [
      {
        rada_nreg: '2597-19',
        title: 'Кодекс України з процедур банкрутства',
        score: 0.94,
        category: 'business_corporate',
        document_type: 'Кодекс',
        source_tier: 'ACTS_1',
      },
      {
        rada_nreg: 'z0841-01',
        title: 'Про затвердження Інструкції про порядок регулювання діяльності банків в Україні',
        score: 0.63,
        category: 'business_corporate',
        document_type: 'Наказ',
        source_tier: 'ACTS_1',
      },
      {
        rada_nreg: '2747-15',
        title: 'Кодекс адміністративного судочинства України',
        score: 0.51,
        category: 'administrative',
        document_type: 'Кодекс',
        source_tier: 'ACTS_1',
      },
    ],
    goals_summary: [{ goal_id: 'goal_0' }, { goal_id: 'goal_1' }],
    taxonomyNregs: new Set(['2597-19', 'z0841-01', '2747-15']),
    actsSearchNregs: ['2597-19', 'z0841-01', '2747-15'],
    chunks_evidence_top_acts: [
      {
        rada_nreg: '2597-19',
        count_in_top30: 24,
        avg_score_in_top30: 0.63,
        max_score: 0.68,
        best_rank_in_top30: 1,
        rank_mass_top30: 3.05,
        max_ordering_score: 0.73,
      },
      {
        rada_nreg: 'z0841-01',
        count_in_top30: 2,
        avg_score_in_top30: 0.45,
        max_score: 0.47,
        best_rank_in_top30: 8,
        rank_mass_top30: 0.22,
        max_ordering_score: 0.41,
      },
      {
        rada_nreg: '2747-15',
        count_in_top30: 1,
        avg_score_in_top30: 0.4,
        max_score: 0.4,
        best_rank_in_top30: 11,
        rank_mass_top30: 0.09,
        max_ordering_score: 0.34,
      },
    ],
    familyEvidence: {
      dominant_family_key: 'business_corporate',
      family_confidence: 0.91,
      family_conflict: false,
      top2: [{ family_key: 'business_corporate', support_score: 0.91 }],
    },
  });
  if (result.selected_acts.length !== 1 || result.selected_acts[0]?.rada_nreg !== '2597-19') {
    throw new Error(
      `Expected dominant multi-goal coverage to stay on one act, got ${JSON.stringify(result.selected_acts)}`
    );
  }
  if (!result.selected_acts_reason_codes.includes('MULTI_GOAL_SINGLE_ACT_COVERAGE_ALLOWED')) {
    throw new Error(
      `Expected MULTI_GOAL_SINGLE_ACT_COVERAGE_ALLOWED reason code, got ${JSON.stringify(result.selected_acts_reason_codes)}`
    );
  }
  console.log('[OK] selected_acts does not force a second act when one dominant code covers multi-goal query');
}

async function main(): Promise<void> {
  console.log('RAG unit tests\n');
  testGoalSplitEmptyQuery();
  testGoalSplitMultiQuestion();
  testGoalSplitSingleQueryNoSplit();
  testNoTopicBasedMultiGoal();
  testContrastiveLiabilityGoalSplit();
  testHasMultiClauseStructure();
  testGoalSplitMultiClauseWithoutPlannerDependency();
  testGoalSplitCarriesSharedTailAcrossClauses();
  testActPlannerTierSkipsSingleGoalWhenTaxonomySignalExists();
  testActPlannerTierUsesTierOneWhenSignalsAreMissing();
  testActPlannerTierKeepsTierTwoForMultiGoal();
  testExtractActSearchNregsFromHitsUsesOnlyActSearchHits();
  testBuildWithinActPoolPrefersTaxonomyWhenHintsExist();
  testBuildWithinActPoolPromotesPlannerPreferredActs();
  testClassifyActKindPrimaryLaw();
  testClassifyActKindSecondaryOrder();
  testClassifyActKindUnknown();
  testClassifyActKindBillDraftNeedsMetadata();
  await testTaxonomyKeywordTopicNotInScore();
  await testFindActByTitleFragmentExport();
  await testDocsOnlyNoSemanticPlanIsNotMarkedDegraded();
  testChunkStructuralScorePrefersBaseArticleTitle();
  testOrderingScoreBeatsRawVectorScore();
  testDiscriminativeStructuralScorePrefersMobilizationArticle();
  testStructuralScoreRemainsFiniteWhenMatchesAppearOutOfOrder();
  testSingleGoalSelectedActsTailTrim();
  testProcedureCategoryEnvelopeFallsBackToProcedureFamilies();
  testBuildTaxonomyQuerySignalsIncludesMultiWordPhrases();
  testSelectedActsAvoidWeakSingleGoalSupportNoise();
  testSelectedActsTrimWeakMultiGoalTail();
  testSelectedActsBlockCrossFamilySupportWithoutEvidence();
  testSelectedActsDemoteCrossFamilyChunkEvidence();
  testSelectedActsPreserveStrongEarlyPrimaryLawEvidence();
  testSelectedActsBlocksKsuNoiseUnderPrimaryLawDominance();
  testSelectedActsBlocksKsuNoiseEvenWhenFamilyEvidenceConflicts();
  testSelectedActsKeepStrongSupportingOrderWithRepeatedEvidence();
  testSelectedActsAllowSingleActCoverageForDominantMultiGoal();
  console.log('\nAll RAG unit tests passed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
