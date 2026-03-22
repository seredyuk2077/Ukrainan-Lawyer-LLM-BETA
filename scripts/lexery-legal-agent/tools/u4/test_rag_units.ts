/**
 * RAG unit tests — goal-splitter, selected_acts (classifyActKind), taxonomy scoring.
 * No server, no Qdrant/OpenRouter.
 * Run: pnpm brain:test:rag-units
 */
import {
  heuristicGoalSplit,
  countStrongActScopeCues,
  hasMultiClauseStructure,
  hasExplicitActScopeCue,
  getProcedureCategoryEnvelope,
  tryCategoryClusterSplitV2,
} from '../../retrieval/goal-splitter.js';
import { buildSelectedActs, classifyActKind } from '../../retrieval/selected-acts.js';
import {
  buildTaxonomyQuerySignals,
  extractCuedNumericActReferences,
  extractActReferenceSignals,
  extractStructuredActIdentifiers,
  getActMeta,
  getTaxonomyCandidates,
  isAmendmentLikeActTitle,
  queryLooksAmendmentFocused,
  scoreActCandidate,
  findActByTitleFragment,
} from '../../retrieval/act-taxonomy-store.js';
import { extractEntities } from '../../classify/entity-extractor.js';
import { runCacheRag } from '../../retrieval/cache-rag.js';
import { selectActPlannerTier } from '../../retrieval/act-planner.js';
import {
  buildWithinActPool,
  extractActSearchNregsFromHits,
  extractChunkEvidenceNregsFromHits,
} from '../../retrieval/within-act-pool.js';
import {
  buildSingleGoalFirstPassPlan,
} from '../../retrieval/single-goal-first-pass.js';
import {
  deriveTopScoreFromHits,
  shouldSkipReferenceExpansionForStrongCoverage,
} from '../../retrieval/single-goal-hit-postprocess.js';
import {
  buildDiscriminativeQueryTokenWeights,
  compareHitsByOrderingScore,
  computeChunkStructuralScore,
} from '../../retrieval/chunk-rerank.js';
import { decideQueryRewritePolicy } from '../../retrieval/query-rewrite-policy.js';
import {
  buildGroundedRetrievalQuery,
  filterGroundingSignalsForQuery,
} from '../../retrieval/grounded-query-builder.js';
import {
  buildHitCitationKey,
  extractQueryCitationSelectors,
  getHitCitationSelectors,
  countCitationMatches,
} from '../../retrieval/structural-citation.js';
import { decideWithinActExpansion } from '../../retrieval/within-act-expansion-policy.js';
import {
  buildArticleBackfillFilter,
  buildStructuralOnlyBackfillFilter,
  deriveArticleBackfillPreferredNreg,
  hitSatisfiesBackfillExpectation,
  hitSatisfiesStructuralSelectors,
} from '../../retrieval/article-backfill.js';
import {
  finalizeSelectedActsAfterRouting,
  summarizeSelectedActs,
} from '../../retrieval/selected-acts-finalizer.js';
import { deriveCoverageGap } from '../../retrieval/coverage-gap.js';
import {
  isDomainHintAlignedFamily,
  normalizeFinalReasonCodes,
  resolveSingleGoalSelectedActs,
} from '../../retrieval/single-goal-selected-acts.js';
import {
  canRelaxCoverageGuardWithActGrounding,
  hasStickySingleGoalLowConfidenceReason,
  shouldFlagProceduralPrimaryWithoutActGrounding,
} from '../../retrieval/single-goal-honesty.js';
import { hasStrongSingleGoalTaxonomySignal } from '../../retrieval/taxonomy-strength.js';
import { buildBestProbe } from './audit_lldbi_act_coverage.js';

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
  if (r.goals.length !== 2) throw new Error(`Expected 2 goals for contrastive liability query, got ${r.goals.length}`);
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

function testFamilyGuardDoesNotInjectUnsupportedPrimaryLaw(): void {
  const result = buildSelectedActs({
    finalHits: [
      {
        rada_nreg: '2341-14',
        r2_key: 'r2://1',
        json_path: '$.content.chunks[0].text',
        score: 0.76,
        ordering_score: 0.76,
        source: 'lldbi_chunks',
        article_number: '190',
      } as never,
    ],
    actCandidatesTop: [
      {
        rada_nreg: '2341-14',
        title: 'Кримінальний кодекс України',
        category: 'criminal',
        document_type: 'кодекс',
        score: 0.8,
      },
      {
        rada_nreg: '4651-17',
        title: 'Кримінальний процесуальний кодекс України',
        category: 'criminal_procedure',
        document_type: 'кодекс',
        score: 0.79,
      },
    ],
    goals_summary: [{ goal_id: 'goal_0' }, { goal_id: 'goal_1' }],
    taxonomyNregs: new Set(['2341-14', '4651-17']),
    actsSearchNregs: [],
    familyEvidence: {
      dominant_family_key: 'criminal',
      family_confidence: 0.7,
      family_conflict: true,
      top2: [
        { family_key: 'criminal', support_score: 0.9 },
        { family_key: 'criminal_procedure', support_score: 0.7 },
      ],
    },
  });
  const selectedNregs = result.selected_acts.map((act) => act.rada_nreg);
  if (selectedNregs.includes('4651-17')) {
    throw new Error(`Expected family guard to avoid unsupported primary-law injection, got ${JSON.stringify(selectedNregs)}`);
  }
  if (!result.selected_acts_reason_codes.includes('FAMILY_GUARD_NO_EVIDENCE')) {
    throw new Error(`Expected FAMILY_GUARD_NO_EVIDENCE reason code, got ${JSON.stringify(result.selected_acts_reason_codes)}`);
  }
  console.log('[OK] selected_acts family guard does not inject unsupported primary law');
}

function testHasMultiClauseStructure(): void {
  if (!hasMultiClauseStructure('що таке крадіжка та яке покарання')) throw new Error('Expected true for "X та Y"');
  if (!hasMultiClauseStructure('перший сегмент і другий сегмент')) throw new Error('Expected true for "X і Y"');
  if (hasMultiClauseStructure('що передбачено пунктом 12 Правил роздрібної торгівлі та які документи потрібні')) {
    throw new Error('Expected false for anchored structural citation query even with conjunction');
  }
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

function testExplicitActScopeCueCoversStructuredIdsAndSubordinateActs(): void {
  if (!hasExplicitActScopeCue('Які документи подаються за постановою № 1178?')) {
    throw new Error('Expected subordinate act number cue to count as explicit act scope');
  }
  if (!hasExplicitActScopeCue('2811-20 які документи подаються для реєстрації?')) {
    throw new Error('Expected structured act identifier to count as explicit act scope');
  }
  if (!hasExplicitActScopeCue('Що регулює Наказ про скасування Правил торгівлі транспортними засобами?')) {
    throw new Error('Expected descriptive subordinate-act title to count as explicit act scope');
  }
  if (hasExplicitActScopeCue('Який порядок реєстрації і які документи подаються?')) {
    throw new Error('Expected generic procedural query without grounded act cue to remain non-grounded');
  }
  console.log('[OK] hasExplicitActScopeCue handles structured ids and subordinate act anchors');
}

function testStrongActScopeCueCountDistinguishesSingleAndMixedActScope(): void {
  if (countStrongActScopeCues('За постановою №1178 які документи подаються для участі?') !== 1) {
    throw new Error('Expected one strong act-scope cue for single subordinate-act query');
  }
  if (countStrongActScopeCues('Що регулює Наказ про скасування Правил торгівлі транспортними засобами?') !== 1) {
    throw new Error('Expected one strong act-scope cue for descriptive subordinate-act title query');
  }
  if (
    countStrongActScopeCues(
      'За законом про публічні закупівлі які підстави відхилення і за постановою №1178 які документи подаються?'
    ) < 2
  ) {
    throw new Error('Expected mixed act-scope bundle to expose multiple strong act cues');
  }
  console.log('[OK] strong act-scope cue counting distinguishes single-act and mixed-act bundles');
}

function testGoalSplitDoesNotCompactMixedActScopeBundle(): void {
  const q =
    'За законом про публічні закупівлі які підстави відхилення і за постановою №1178 які документи подаються?';
  const r = heuristicGoalSplit(q, 'administrative', undefined);
  if (r.goals.length < 2) {
    throw new Error(`Expected mixed act-scope bundle to remain multi-goal, got ${r.goals.length}`);
  }
  console.log('[OK] heuristicGoalSplit keeps mixed act-scope bundle split');
}

function testGoalSplitCompactsSingleStrongActScopeBundle(): void {
  const q = 'За постановою №1178 які документи подаються та які підстави відхилення пропозиції?';
  const r = heuristicGoalSplit(q, 'administrative', undefined);
  if (r.goals.length !== 1) {
    throw new Error(`Expected single strong act-scope bundle to compact back to one goal, got ${r.goals.length}`);
  }
  console.log('[OK] heuristicGoalSplit compacts same-act bundle only on strong single-act grounding');
}

function testGoalSplitCarriesSubjectIntoProceduralQuestion(): void {
  const q = 'Що таке шахрайство? Хто розслідує цю статтю?';
  const r = heuristicGoalSplit(q, 'criminal', undefined);
  if (r.goals.length < 2) {
    throw new Error(`Expected multi-question split for procedural follow-up, got ${r.goals.length}`);
  }
  const procedureGoal = r.goals.find((goal) => goal.goal_type === 'procedure');
  if (!procedureGoal) {
    throw new Error(`Expected procedural follow-up goal, got ${JSON.stringify(r.goals)}`);
  }
  if (!procedureGoal.subquery.toLowerCase().includes('шахрайств')) {
    throw new Error(`Expected procedural follow-up to carry substantive subject, got ${procedureGoal.subquery}`);
  }
  if (!procedureGoal.must_have_signals?.includes('підслідність')) {
    throw new Error(`Expected procedural follow-up to include must-have procedural signal, got ${JSON.stringify(procedureGoal.must_have_signals)}`);
  }
  console.log('[OK] heuristicGoalSplit carries subject into procedural multi-question follow-up');
}

function testGoalSplitCarriesSubjectIntoYesNoFollowUp(): void {
  const q =
    'У який строк треба сплатити суму за податковим повідомленням-рішенням? Чи зупиняє подання скарги обов`язок сплати?';
  const r = heuristicGoalSplit(q, 'tax_customs', undefined);
  if (r.goals.length < 2) {
    throw new Error(`Expected multi-question split for tax follow-up, got ${r.goals.length}`);
  }
  const followUpGoal = r.goals[1];
  if (!followUpGoal?.subquery.toLowerCase().includes('податков')) {
    throw new Error(`Expected yes/no follow-up to inherit shared tax subject, got ${followUpGoal?.subquery}`);
  }
  console.log('[OK] heuristicGoalSplit carries subject into yes/no follow-up question');
}

function testGoalSplitAddsSpecificTaxAppealSignals(): void {
  const q =
    'У який строк треба сплатити суму за податковим повідомленням-рішенням? Чи зупиняє подання скарги обов`язок сплати?';
  const r = heuristicGoalSplit(q, 'tax_customs', undefined);
  if (r.goals.length < 2) {
    throw new Error(`Expected split tax appeal query to produce 2 goals, got ${r.goals.length}`);
  }
  const followUpSignals = r.goals[1]?.must_have_signals ?? [];
  if (!followUpSignals.includes("грошове зобов'язання")) {
    throw new Error(`Expected tax payment follow-up to add money-obligation signal, got ${JSON.stringify(followUpSignals)}`);
  }
  if (!followUpSignals.includes('оскарження податкового повідомлення-рішення')) {
    throw new Error(`Expected tax payment follow-up to keep tax-notice appeal signal, got ${JSON.stringify(followUpSignals)}`);
  }
  console.log('[OK] heuristicGoalSplit adds specific tax appeal signals for payment/complaint follow-up');
}

function testGoalSplitCompactsExplicitActBundleAcrossQuestions(): void {
  const q =
    "Чи треба реєструвати авторське право на твір і які права має автор за законом про авторське право?";
  const r = heuristicGoalSplit(q, undefined, undefined);
  if (r.goals.length !== 1) {
    throw new Error(`Expected explicit-act same-bundle query to compact into 1 goal, got ${r.goals.length}`);
  }
  if (!r.reason_codes.includes('same_act_bundle_compaction')) {
    throw new Error(`Expected same_act_bundle_compaction, got ${JSON.stringify(r.reason_codes)}`);
  }
  console.log('[OK] heuristicGoalSplit compacts explicit-act same-bundle query across questions');
}

function testGoalSplitCompactsExplicitActClauseBundle(): void {
  const q = 'Які права автора передбачені законом про авторське право і суміжні права?';
  const r = heuristicGoalSplit(q, undefined, undefined);
  if (r.goals.length !== 1) {
    throw new Error(`Expected explicit-act clause bundle to compact into 1 goal, got ${r.goals.length}`);
  }
  if (!r.reason_codes.includes('same_act_bundle_compaction')) {
    throw new Error(`Expected same_act_bundle_compaction, got ${JSON.stringify(r.reason_codes)}`);
  }
  console.log('[OK] heuristicGoalSplit compacts explicit-act clause bundle');
}

function testGoalSplitCompactsProceduralBundleWithDocumentsFollowUp(): void {
  const q = "Як зареєструвати авторське право на комп'ютерну програму і які документи подаються?";
  const r = heuristicGoalSplit(q, undefined, undefined);
  if (r.goals.length !== 1) {
    throw new Error(`Expected registration/documents bundle to compact into 1 goal, got ${r.goals.length}`);
  }
  if (r.goals[0]?.goal_type !== 'procedure') {
    throw new Error(`Expected registration/documents bundle to infer procedure goal, got ${r.goals[0]?.goal_type}`);
  }
  if (!r.reason_codes.includes('procedural_bundle_compaction')) {
    throw new Error(`Expected procedural_bundle_compaction, got ${JSON.stringify(r.reason_codes)}`);
  }
  console.log('[OK] heuristicGoalSplit compacts procedural registration/documents bundle');
}

function testCategoryClusterSplitSkipsGroundedSingleAct(): void {
  const split = tryCategoryClusterSplitV2(
    {
      alias_hits: [
        { rada_nreg: '66/2026', category: 'other' },
        { rada_nreg: '45/2026', category: 'administrative' },
        { rada_nreg: '46/2026', category: 'national_security' },
      ],
      category_hints: ['other'],
      grounded_act_hit_count: 1,
      exact_act_hit_count: 0,
    },
    'Що регулює Указ про призначення Кубраков?',
    'general',
    undefined
  );
  if (split != null) {
    throw new Error(`Expected taxonomy cluster split to skip grounded single-act query, got ${JSON.stringify(split)}`);
  }
  console.log('[OK] taxonomy cluster split skips grounded single-act convergence');
}

function testGoalSplitMarksProceduralSingleGoal(): void {
  const q = 'Який строк оскарження податкового повідомлення-рішення?';
  const r = heuristicGoalSplit(q, 'tax_customs', undefined);
  if (r.goals.length !== 1) {
    throw new Error(`Expected single goal for procedural single query, got ${r.goals.length}`);
  }
  if (r.goals[0]?.goal_type !== 'procedure') {
    throw new Error(`Expected procedural goal type, got ${r.goals[0]?.goal_type}`);
  }
  if ((r.goals[0]?.must_have_signals?.length ?? 0) !== 0) {
    throw new Error(`Expected no extra must-have signals when query already contains procedural anchors, got ${JSON.stringify(r.goals[0]?.must_have_signals)}`);
  }
  console.log('[OK] heuristicGoalSplit marks procedural single-goal query without redundant soft signals');
}

function testGoalSplitCompactsProceduralBundleWithAnaphora(): void {
  const q = 'Чи можна подати апеляцію на заочне рішення суду і який строк на таке оскарження?';
  const r = heuristicGoalSplit(q, 'civil_procedure', undefined);
  if (r.goals.length !== 1) {
    throw new Error(`Expected procedural bundle compaction to keep 1 goal, got ${r.goals.length}`);
  }
  if (r.goals[0]?.goal_type !== 'procedure') {
    throw new Error(`Expected compacted goal to stay procedural, got ${r.goals[0]?.goal_type}`);
  }
  if (!r.reason_codes.includes('procedural_bundle_compaction')) {
    throw new Error(`Expected procedural_bundle_compaction reason code, got ${JSON.stringify(r.reason_codes)}`);
  }
  const mustHaveSignals = r.goals[0]?.must_have_signals ?? [];
  if (!mustHaveSignals.includes('оскарження') || !mustHaveSignals.includes('подання')) {
    throw new Error(`Expected compacted procedural goal to preserve merged procedural soft signals, got ${JSON.stringify(mustHaveSignals)}`);
  }
  console.log('[OK] heuristicGoalSplit compacts anaphoric procedural bundle into one goal');
}

function testGoalSplitCompactsProceduralBundleWithSharedProcessReference(): void {
  const q = 'Як оскаржити податкове повідомлення-рішення і чи треба сплачувати суму під час оскарження?';
  const r = heuristicGoalSplit(q, 'tax_customs', undefined);
  if (r.goals.length !== 1) {
    throw new Error(`Expected shared-process procedural bundle compaction to keep 1 goal, got ${r.goals.length}`);
  }
  if (r.goals[0]?.goal_type !== 'procedure') {
    throw new Error(`Expected compacted tax bundle to stay procedural, got ${r.goals[0]?.goal_type}`);
  }
  if (!r.reason_codes.includes('procedural_bundle_compaction')) {
    throw new Error(`Expected procedural_bundle_compaction for shared-process tax bundle, got ${JSON.stringify(r.reason_codes)}`);
  }
  const mustHaveSignals = r.goals[0]?.must_have_signals ?? [];
  if (!mustHaveSignals.includes('оскарження податкового повідомлення-рішення')) {
    throw new Error(`Expected compacted tax bundle to preserve shared tax appeal signal, got ${JSON.stringify(mustHaveSignals)}`);
  }
  console.log('[OK] heuristicGoalSplit compacts shared-process procedural bundle into one goal');
}

function testGoalSplitCompactsSameActNormBundle(): void {
  const q =
    'У день звільнення з працівником не розрахувалися повністю. Де шукати норму про строк остаточного розрахунку і норму про наслідки затримки?';
  const r = heuristicGoalSplit(q, 'labor_social', undefined);
  if (r.goals.length !== 1) {
    throw new Error(`Expected same-act norm bundle compaction to keep 1 goal, got ${r.goals.length}`);
  }
  if (!r.reason_codes.includes('same_act_bundle_compaction')) {
    throw new Error(`Expected same_act_bundle_compaction reason code, got ${JSON.stringify(r.reason_codes)}`);
  }
  console.log('[OK] heuristicGoalSplit compacts same-act norm bundle into one goal');
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

function testStrongTaxonomySignalHelperMatchesSingleGoalPolicy(): void {
  const strong = hasStrongSingleGoalTaxonomySignal({
    goals_count: 1,
    taxonomy_strength: {
      taxonomy_act_count: 2,
      alias_hit_count: 1,
      category_hint_count: 1,
      document_type_hint_count: 0,
    },
  });
  if (!strong) {
    throw new Error('Expected shared taxonomy-strength helper to treat grounded single-goal support as strong');
  }
  const weak = hasStrongSingleGoalTaxonomySignal({
    goals_count: 2,
    taxonomy_strength: {
      taxonomy_act_count: 5,
      alias_hit_count: 2,
      category_hint_count: 2,
      document_type_hint_count: 1,
    },
  });
  if (weak) {
    throw new Error('Expected shared taxonomy-strength helper to stay single-goal only');
  }
  console.log('[OK] taxonomy-strength helper stays aligned with single-goal strong-signal policy');
}

async function testTaxonomyGroundsSingleLogicalActFamilyFromExactAlias(): Promise<void> {
  const result = await getTaxonomyCandidates({
    query: 'КУпАП',
    entities: [
      { type: 'act_abbrev', value: 'КУпАП' },
      { type: 'law_title', value: 'КУпАП' },
    ],
    category_hints: [],
    document_type_hints: [],
  });
  if (result.grounded_act_hit_count !== 1) {
    throw new Error(`Expected exact alias to ground a single logical act family, got ${result.grounded_act_hit_count}`);
  }
  if (!result.grounded_act_nregs.includes('80731-10')) {
    throw new Error(`Expected logical-family representative 80731-10, got ${JSON.stringify(result.grounded_act_nregs)}`);
  }
  if (!result.rada_nreg_candidates.slice(0, 2).includes('80731-10')) {
    throw new Error(`Expected 80731-10 near top taxonomy candidates, got ${JSON.stringify(result.rada_nreg_candidates.slice(0, 5))}`);
  }
  console.log('[OK] taxonomy grounds exact alias across split logical-act families');
}

async function testTaxonomyGroundsRepealOrderByDerivedTitleAlias(): Promise<void> {
  const query = 'розпорядження про втрату чинності № 1478';
  const result = await getTaxonomyCandidates({
    query,
    entities: [{ type: 'law_title', value: query }],
    category_hints: [],
    document_type_hints: ['Розпорядження КМУ'],
  });
  if (result.grounded_act_hit_count !== 1) {
    throw new Error(`Expected repeal-order descriptive alias to ground one act, got ${result.grounded_act_hit_count}`);
  }
  if (!result.grounded_act_nregs.includes('3-2026-р')) {
    throw new Error(`Expected repeal-order grounding to recover 3-2026-р, got ${JSON.stringify(result.grounded_act_nregs)}`);
  }
  if (!result.rada_nreg_candidates.slice(0, 3).includes('3-2026-р')) {
    throw new Error(`Expected 3-2026-р near top taxonomy candidates, got ${JSON.stringify(result.rada_nreg_candidates.slice(0, 5))}`);
  }
  console.log('[OK] taxonomy grounds repeal-order descriptive aliases by derived title pattern');
}

function testStrongTaxonomySignalTreatsExactActHitAsStrong(): void {
  const strong = hasStrongSingleGoalTaxonomySignal({
    goals_count: 1,
    taxonomy_strength: {
      taxonomy_act_count: 1,
      alias_hit_count: 0,
      exact_act_hit_count: 1,
      category_hint_count: 0,
      document_type_hint_count: 0,
    },
  });
  if (!strong) {
    throw new Error('Expected exact structured act hit to count as strong single-goal taxonomy signal');
  }
  console.log('[OK] taxonomy-strength helper treats exact act identifier matches as strong support');
}

function testStrongTaxonomySignalTreatsGroundedAliasAsStrong(): void {
  const strong = hasStrongSingleGoalTaxonomySignal({
    goals_count: 1,
    taxonomy_strength: {
      taxonomy_act_count: 1,
      alias_hit_count: 4,
      grounded_act_hit_count: 1,
      category_hint_count: 0,
      document_type_hint_count: 0,
    },
  });
  if (!strong) {
    throw new Error('Expected grounded exact alias/title match to count as strong taxonomy support');
  }
  console.log('[OK] taxonomy-strength helper treats grounded exact alias/title matches as strong support');
}

function testStrongTaxonomySignalRejectsFuzzyAliasVolumeOnly(): void {
  const strong = hasStrongSingleGoalTaxonomySignal({
    goals_count: 1,
    taxonomy_strength: {
      taxonomy_act_count: 1,
      alias_hit_count: 5,
      grounded_act_hit_count: 0,
      category_hint_count: 0,
      document_type_hint_count: 0,
    },
  });
  if (strong) {
    throw new Error('Expected fuzzy alias-hit volume alone not to count as strong taxonomy support');
  }
  console.log('[OK] taxonomy-strength helper ignores fuzzy alias-hit volume without grounded act support');
}

function testDomainHintAlignedFamilyHelper(): void {
  if (!isDomainHintAlignedFamily('civil', 'civil_procedure')) {
    throw new Error('Expected civil domain hint to align with civil_procedure family');
  }
  if (!isDomainHintAlignedFamily('criminal', 'criminal_procedure')) {
    throw new Error('Expected criminal domain hint to align with criminal_procedure family');
  }
  if (!isDomainHintAlignedFamily('tax_customs', 'tax_customs')) {
    throw new Error('Expected tax_customs domain hint to align with same family');
  }
  if (isDomainHintAlignedFamily('general', 'civil')) {
    throw new Error('Expected general domain hint to avoid family alignment');
  }
  if (isDomainHintAlignedFamily('civil', 'administrative')) {
    throw new Error('Expected civil domain hint not to align with administrative family');
  }
  console.log('[OK] domain-hint family alignment helper keeps generic family envelopes only');
}

function testSingleGoalFirstPassPlanSkipsActsSearchOnStrongTaxonomySignal(): void {
  const result = buildSingleGoalFirstPassPlan({
    steps: undefined,
    collections: {
      chunks: 'lexery_legislation_chunks',
      acts: 'lexery_legislation_acts',
    },
    goalsCount: 1,
    taxonomyStrength: {
      taxonomy_act_count: 4,
      alias_hit_count: 2,
      category_hint_count: 1,
      document_type_hint_count: 1,
    },
  });
  if (result.usedActsSearch) {
    throw new Error(`Expected strong taxonomy signal to skip eager acts search, got ${JSON.stringify(result)}`);
  }
  if (JSON.stringify(result.requestedStepKinds) !== JSON.stringify(['lldbi_chunks', 'lldbi_acts'])) {
    throw new Error(`Expected default requested steps to stay intact for trace/audit, got ${JSON.stringify(result.requestedStepKinds)}`);
  }
  if (JSON.stringify(result.stepsToRun.map((step) => step.kind)) !== JSON.stringify(['lldbi_chunks'])) {
    throw new Error(`Expected only chunks step to execute under strong taxonomy signal, got ${JSON.stringify(result.stepsToRun)}`);
  }
  if (!result.actsSearchPolicyReasonCodes.includes('STRONG_TAXONOMY_SIGNAL')) {
    throw new Error(`Expected STRONG_TAXONOMY_SIGNAL acts-search policy reason, got ${JSON.stringify(result.actsSearchPolicyReasonCodes)}`);
  }
  console.log('[OK] single-goal first-pass plan skips eager acts search on strong taxonomy signal');
}

function testSingleGoalFirstPassPlanKeepsActsSearchWhenTaxonomyWeak(): void {
  const result = buildSingleGoalFirstPassPlan({
    steps: undefined,
    collections: {
      chunks: 'lexery_legislation_chunks',
      acts: 'lexery_legislation_acts',
    },
    goalsCount: 1,
    taxonomyStrength: {
      taxonomy_act_count: 0,
      alias_hit_count: 0,
      category_hint_count: 0,
      document_type_hint_count: 0,
    },
  });
  if (!result.usedActsSearch) {
    throw new Error(`Expected weak taxonomy signal to keep acts search enabled, got ${JSON.stringify(result)}`);
  }
  if (!result.actsSearchPolicyReasonCodes.includes('ACTS_SEARCH_ENABLED')) {
    throw new Error(`Expected ACTS_SEARCH_ENABLED reason code, got ${JSON.stringify(result.actsSearchPolicyReasonCodes)}`);
  }
  console.log('[OK] single-goal first-pass plan keeps acts search when taxonomy signal is weak');
}

function testSingleGoalFirstPassPlanKeepsActsSearchOnFuzzyAliasVolumeOnly(): void {
  const result = buildSingleGoalFirstPassPlan({
    steps: undefined,
    collections: {
      chunks: 'lexery_legislation_chunks',
      acts: 'lexery_legislation_acts',
    },
    goalsCount: 1,
    taxonomyStrength: {
      taxonomy_act_count: 1,
      alias_hit_count: 5,
      grounded_act_hit_count: 0,
      category_hint_count: 0,
      document_type_hint_count: 0,
    },
  });
  if (!result.usedActsSearch) {
    throw new Error(`Expected fuzzy alias-hit volume not to suppress acts search, got ${JSON.stringify(result)}`);
  }
  console.log('[OK] single-goal first-pass plan keeps acts search when only fuzzy alias volume is present');
}

function testSingleGoalFirstPassPlanRespectsExplicitChunksOnlyRequest(): void {
  const result = buildSingleGoalFirstPassPlan({
    steps: [{ kind: 'lldbi_chunks' } as never],
    collections: {
      chunks: 'lexery_legislation_chunks',
      acts: 'lexery_legislation_acts',
    },
    goalsCount: 1,
    taxonomyStrength: {
      taxonomy_act_count: 0,
      alias_hit_count: 0,
      category_hint_count: 0,
      document_type_hint_count: 0,
    },
  });
  if (result.usedActsSearch) {
    throw new Error(`Expected explicit chunks-only step request to avoid acts search, got ${JSON.stringify(result)}`);
  }
  if (!result.actsSearchPolicyReasonCodes.includes('NOT_REQUESTED')) {
    throw new Error(`Expected NOT_REQUESTED acts-search policy reason, got ${JSON.stringify(result.actsSearchPolicyReasonCodes)}`);
  }
  console.log('[OK] single-goal first-pass plan respects explicit chunks-only request');
}

function testSingleGoalFirstPassPlanPreservesExplicitActsOnlyRequest(): void {
  const result = buildSingleGoalFirstPassPlan({
    steps: [{ kind: 'lldbi_acts', collection: 'lexery_legislation_acts', top_k: 8 } as never],
    collections: {
      chunks: 'lexery_legislation_chunks',
      acts: 'lexery_legislation_acts',
    },
    goalsCount: 1,
    taxonomyStrength: {
      taxonomy_act_count: 2,
      alias_hit_count: 3,
      category_hint_count: 1,
      document_type_hint_count: 1,
    },
  });

  if (!result.usedActsSearch || result.stepsToRun.length !== 1 || result.stepsToRun[0]?.kind !== 'lldbi_acts') {
    throw new Error(`Expected explicit acts-only request to preserve acts search, got ${JSON.stringify(result)}`);
  }
  if (!result.actsSearchPolicyReasonCodes.includes('EXPLICIT_ACTS_ONLY_REQUEST')) {
    throw new Error(
      `Expected EXPLICIT_ACTS_ONLY_REQUEST policy reason code, got ${JSON.stringify(result.actsSearchPolicyReasonCodes)}`
    );
  }
  console.log('[OK] single-goal first-pass plan preserves explicit acts-only request');
}

function testReferenceExpansionSkipForStrongHeadCoverage(): void {
  const selectors = extractQueryCitationSelectors('Як оскаржити податкове повідомлення-рішення?');
  const hits = [
    { rada_nreg: '2755-17', score: 0.9, ordering_score: 0.9 } as never,
    { rada_nreg: '2755-17', score: 0.85, ordering_score: 0.85 } as never,
    { rada_nreg: '2755-17', score: 0.82, ordering_score: 0.82 } as never,
    { rada_nreg: '2747-15', score: 0.8, ordering_score: 0.8 } as never,
    { rada_nreg: '2747-15', score: 0.78, ordering_score: 0.78 } as never,
  ];
  if (!shouldSkipReferenceExpansionForStrongCoverage(hits, selectors)) {
    throw new Error('Expected strong two-act head coverage to skip reference expansion');
  }
  console.log('[OK] strong two-act head coverage skips reference expansion');
}

function testReferenceExpansionDoesNotSkipOnExplicitSelectors(): void {
  const selectors = extractQueryCitationSelectors('Що передбачено п. 56.18 ст. 56 ПКУ?');
  const hits = [
    { rada_nreg: '2755-17', score: 0.9, ordering_score: 0.9 } as never,
    { rada_nreg: '2755-17', score: 0.85, ordering_score: 0.85 } as never,
    { rada_nreg: '2747-15', score: 0.8, ordering_score: 0.8 } as never,
  ];
  if (shouldSkipReferenceExpansionForStrongCoverage(hits, selectors)) {
    throw new Error('Expected explicit selectors to keep reference expansion eligible');
  }
  console.log('[OK] explicit selectors keep reference expansion eligible');
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

function testExtractChunkEvidenceNregsFromHitsRanksByRepeatedChunkEvidence(): void {
  const nregs = extractChunkEvidenceNregsFromHits([
    { source: 'lldbi_chunks', rada_nreg: '2755-17', score: 0.4 } as const,
    { source: 'lldbi_chunks', rada_nreg: '2747-15', score: 0.7 } as const,
    { source: 'lldbi_chunks', rada_nreg: '2755-17', score: 0.6 } as const,
    { source: 'lldbi_acts', rada_nreg: '80731-10', score: 0.99 } as const,
    { source: 'lldbi_chunks', rada_nreg: '2747-15', score: 0.5 } as const,
    { source: 'lldbi_chunks', rada_nreg: '2747-15', score: 0.4 } as const,
  ]);
  if (JSON.stringify(nregs) !== JSON.stringify(['2747-15', '2755-17'])) {
    throw new Error(`Expected chunk evidence nregs to rank by repeated chunk support, got ${JSON.stringify(nregs)}`);
  }
  console.log('[OK] within-act pool extracts chunk-evidence nregs by repeated chunk support');
}

function testBuildWithinActPoolCanPreferChunkEvidenceOnStrongRuns(): void {
  const pool = buildWithinActPool({
    taxonomyNregs: ['80731-10', '2341-14'],
    actSearchNregs: ['2341-14', '111-11'],
    chunkEvidenceNregs: ['322-08', '100-95-п'],
    categoryHintCount: 2,
    preferChunkEvidence: true,
    limit: 4,
  });
  if (JSON.stringify(pool) !== JSON.stringify(['322-08', '100-95-п', '2341-14', '111-11'])) {
    throw new Error(`Expected strong-run within-act pool to follow first-pass chunk evidence, got ${JSON.stringify(pool)}`);
  }
  console.log('[OK] within-act pool can prefer first-pass chunk evidence on strong runs');
}

function testBuildWithinActPoolPrioritizesGroundedSingleAct(): void {
  const pool = buildWithinActPool({
    groundedNregs: ['66/2026'],
    taxonomyNregs: ['66/2026', '45/2026', '46/2026'],
    chunkEvidenceNregs: ['1861-17', '254к/96-вр'],
    limit: 4,
  });
  if (pool[0] !== '66/2026') {
    throw new Error(`Expected grounded single act to stay first in within-act pool, got ${JSON.stringify(pool)}`);
  }
  console.log('[OK] within-act pool prioritizes grounded single-act convergence');
}

function testQueryRewritePolicySkipsAnchoredStructuralTitleQuery(): void {
  const decision = decideQueryRewritePolicy({
    query: 'Який обов\'язок продавця щодо інформації про товар передбачений пунктом 12 Правил роздрібної торгівлі непродовольчими товарами?',
    entities: [{ type: 'law_title', value: 'Правил роздрібної торгівлі непродовольчими товарами' }],
  });
  if (decision.shouldCall) {
    throw new Error(`Expected anchored structural title query to skip rewrite, got ${JSON.stringify(decision)}`);
  }
  if (!decision.reason_codes.includes('ANCHORED_STRUCTURAL_QUERY')) {
    throw new Error(`Expected ANCHORED_STRUCTURAL_QUERY, got ${JSON.stringify(decision.reason_codes)}`);
  }
  console.log('[OK] query rewrite policy skips anchored structural title query');
}

function testQueryRewritePolicySkipsGroundedCitationWithActCue(): void {
  const decision = decideQueryRewritePolicy({
    query: 'Що передбачає КУпАП ст. 130 за перше керування у стані сп`яніння?',
    entities: [
      { type: 'act_abbrev', value: 'КУпАП' },
      { type: 'article_ref', value: 'ст. 130' },
    ],
  });
  if (decision.shouldCall) {
    throw new Error(`Expected grounded citation with act cue to skip rewrite, got ${JSON.stringify(decision)}`);
  }
  console.log('[OK] query rewrite policy skips grounded citation with act cue');
}

function testQueryRewritePolicySkipsWhenStrongTaxonomySignalExists(): void {
  const decision = decideQueryRewritePolicy({
    query: 'Як оскаржити податкове повідомлення-рішення і чи треба платити суму на час оскарження?',
    entities: [],
    goals_count: 1,
    taxonomy_strength: {
      taxonomy_act_count: 4,
      alias_hit_count: 2,
      category_hint_count: 2,
      document_type_hint_count: 1,
    },
  });
  if (decision.shouldCall) {
    throw new Error(`Expected strong taxonomy signal to skip rewrite, got ${JSON.stringify(decision)}`);
  }
  if (!decision.reason_codes.includes('STRONG_TAXONOMY_SIGNAL')) {
    throw new Error(`Expected STRONG_TAXONOMY_SIGNAL, got ${JSON.stringify(decision.reason_codes)}`);
  }
  console.log('[OK] query rewrite policy skips when single-goal taxonomy signal is already strong');
}

function testQueryRewritePolicySkipsWhenExactActIdentifierConverges(): void {
  const decision = decideQueryRewritePolicy({
    query: '1150-98-п',
    entities: [],
    goals_count: 1,
    taxonomy_strength: {
      taxonomy_act_count: 1,
      alias_hit_count: 0,
      exact_act_hit_count: 1,
      category_hint_count: 0,
      document_type_hint_count: 0,
    },
  });
  if (decision.shouldCall) {
    throw new Error(`Expected exact act identifier convergence to skip rewrite, got ${JSON.stringify(decision)}`);
  }
  if (!decision.reason_codes.includes('STRONG_TAXONOMY_SIGNAL')) {
    throw new Error(`Expected STRONG_TAXONOMY_SIGNAL for exact act id convergence, got ${JSON.stringify(decision.reason_codes)}`);
  }
  console.log('[OK] query rewrite policy skips when exact act identifier already converges in taxonomy');
}

function testQueryRewritePolicyAllowsFuzzyAliasVolumeOnly(): void {
  const decision = decideQueryRewritePolicy({
    query: 'Постанова 1178',
    entities: [],
    goals_count: 1,
    taxonomy_strength: {
      taxonomy_act_count: 1,
      alias_hit_count: 5,
      grounded_act_hit_count: 0,
      category_hint_count: 0,
      document_type_hint_count: 0,
    },
  });
  if (decision.reason_codes.includes('STRONG_TAXONOMY_SIGNAL')) {
    throw new Error(
      `Expected fuzzy alias volume alone not to look like grounded taxonomy support, got ${JSON.stringify(decision)}`
    );
  }
  console.log('[OK] query rewrite policy does not mistake fuzzy alias volume for grounded taxonomy support');
}

function testQueryRewritePolicyAllowsBroadNaturalLanguageQuery(): void {
  const decision = decideQueryRewritePolicy({
    query: 'У клієнта в Facebook написали, що він шахрай. На які норми спирати вимогу про спростування недостовірної інформації та моральну шкоду?',
    entities: [],
  });
  if (!decision.shouldCall) {
    throw new Error(`Expected broad legal query to still allow rewrite, got ${JSON.stringify(decision)}`);
  }
  console.log('[OK] query rewrite policy keeps rewrite for broad natural-language query');
}

function testGroundedQueryBuilderDropsGenericSignalsForStructuralQuery(): void {
  const result = buildGroundedRetrievalQuery({
    subquery: 'Що передбачає КПК ст. 214?',
    mustHaveSignals: ['строк', 'порядок', 'початок досудового розслідування'],
  });
  if (result.queryForRetrieval.includes('строк') || result.queryForRetrieval.includes('порядок')) {
    throw new Error(`Expected grounded query builder to drop generic procedural signals, got ${JSON.stringify(result)}`);
  }
  if (!result.queryForRetrieval.includes('початок досудового розслідування')) {
    throw new Error(`Expected grounded query builder to keep specific procedural signal, got ${JSON.stringify(result)}`);
  }
  console.log('[OK] grounded query builder keeps only specific signals for structural query');
}

function testGroundedQueryBuilderKeepsSignalsForNaturalLanguageQuery(): void {
  const filtered = filterGroundingSignalsForQuery('Хто розслідує шахрайство і як це оскаржується?', [
    'підслідність',
    'оскарження',
  ]);
  if (!filtered.includes('підслідність') || !filtered.includes('оскарження')) {
    throw new Error(`Expected natural-language query to keep shaping signals, got ${JSON.stringify(filtered)}`);
  }
  console.log('[OK] grounded query builder keeps signals for non-structural query');
}

function testWithinActExpansionPrefersProceduralAndStructuralQueries(): void {
  const decision = decideWithinActExpansion({
    hasActCandidates: true,
    needTwoStage: false,
    querySelectors: extractQueryCitationSelectors('Що передбачає КПК ст. 214?'),
    entities: [
      { type: 'act_abbrev', value: 'КПК' },
      { type: 'article_ref', value: 'ст. 214' },
    ],
    goalType: 'procedure',
    goalReasonCodes: [],
    mustHaveSignalsCount: 1,
    weakLimit: 5,
  });
  if (decision.limit < 4) {
    throw new Error(`Expected procedural structural query to keep broader within-act expansion, got ${JSON.stringify(decision)}`);
  }
  console.log('[OK] within-act expansion keeps broader fanout for procedural structural query');
}

function testWithinActExpansionCompactsSignalOnlyBundleQueries(): void {
  const decision = decideWithinActExpansion({
    hasActCandidates: true,
    needTwoStage: false,
    querySelectors: extractQueryCitationSelectors(
      'Яка відповідальність роботодавця за затримку остаточного розрахунку при звільненні і які норми про середній заробіток за цей час?'
    ),
    entities: [],
    goalType: 'liability',
    goalReasonCodes: ['multi_clause_structure'],
    mustHaveSignalsCount: 0,
    weakLimit: 5,
  });
  if (decision.limit !== 2) {
    throw new Error(`Expected signal-only bundle query to use compact within-act limit, got ${JSON.stringify(decision)}`);
  }
  console.log('[OK] within-act expansion compacts signal-only bundle queries');
}

function testWithinActExpansionCompactsProceduralNonStructuralQueries(): void {
  const decision = decideWithinActExpansion({
    hasActCandidates: true,
    needTwoStage: false,
    querySelectors: extractQueryCitationSelectors(
      'Як оскаржити податкове повідомлення-рішення і чи треба сплачувати суму під час оскарження?'
    ),
    entities: [],
    goalType: 'procedure',
    goalReasonCodes: ['procedural_bundle_compaction', 'multi_clause_structure'],
    mustHaveSignalsCount: 2,
    weakLimit: 5,
  });
  if (decision.limit !== 2) {
    throw new Error(`Expected non-structural procedural bundle to use compact procedural within-act limit, got ${JSON.stringify(decision)}`);
  }
  console.log('[OK] within-act expansion compacts non-structural procedural bundle queries');
}

function testWithinActExpansionTreatsNormalizedRetrievalEntitiesAsActAnchors(): void {
  const decision = decideWithinActExpansion({
    hasActCandidates: true,
    needTwoStage: false,
    querySelectors: extractQueryCitationSelectors('27-2026-р'),
    entities: [{ law_title: '27-2026-р' }],
    goalType: 'other',
    goalReasonCodes: [],
    mustHaveSignalsCount: 0,
    weakLimit: 5,
  });
  if (decision.limit !== 3 || !decision.reason_codes.includes('ENTITY_ANCHORED_QUERY')) {
    throw new Error(
      `Expected normalized retrieval law_title to keep act-anchored within-act fanout, got ${JSON.stringify(decision)}`
    );
  }
  console.log('[OK] within-act expansion respects normalized retrieval law_title entities');
}

function testWithinActExpansionSupportsGroundedSingleActQueriesWithoutStructuralSelectors(): void {
  const decision = decideWithinActExpansion({
    hasActCandidates: true,
    needTwoStage: false,
    querySelectors: extractQueryCitationSelectors('дотація на утримання закладів'),
    entities: [],
    goalType: 'other',
    goalReasonCodes: [],
    mustHaveSignalsCount: 0,
    groundedActHitCount: 1,
    queryTokenCount: 4,
    weakLimit: 5,
  });
  if (decision.limit !== 2 || !decision.reason_codes.includes('GROUNDED_SINGLE_ACT_QUERY')) {
    throw new Error(
      `Expected grounded single-act query to keep cheap within-act fanout, got ${JSON.stringify(decision)}`
    );
  }
  console.log('[OK] within-act expansion keeps grounded single-act queries on a cheap act fanout');
}

function testAuditBestProbeUsesNregInsteadOfWeakShortAlias(): void {
  const probe = buildBestProbe({
    rada_nreg: '254к/96-вр',
    title: 'Конституція України',
    aliases: ['КУ'],
    category: 'constitutional',
    storage_category: null,
    document_type: 'Конституція',
    document_type_slug: 'constitution',
    validity_status: 'in_force',
  });
  if (probe.probe_kind !== 'nreg' || probe.query !== '254к/96-вр') {
    throw new Error(`Expected weak short alias to fall back to nreg, got ${JSON.stringify(probe)}`);
  }
  console.log('[OK] audit best probe rejects weak short alias in favor of nreg');
}

function testAuditBestProbeUsesNregInsteadOfWeakShortCuedNumberAlias(): void {
  const probe = buildBestProbe({
    rada_nreg: '25-2026-р',
    title: "Про погодження розподілу додаткової дотації на здійснення переданих з державного бюджету видатків з утримання закладів освіти та охорони здоров'я між місцевими бюджетами у 2026 році",
    aliases: ['розпорядження кму №25-р'],
    category: 'finance_banking',
    storage_category: null,
    document_type: 'Розпорядження КМУ',
    document_type_slug: 'cmu_order',
    validity_status: 'in_force',
  });
  if (probe.probe_kind !== 'nreg' || probe.query !== '25-2026-р') {
    throw new Error(`Expected weak short cued-number alias to fall back to nreg, got ${JSON.stringify(probe)}`);
  }
  console.log('[OK] audit best probe rejects low-information short cued-number alias');
}

function testAuditBestProbeKeepsStrongCodeAlias(): void {
  const probe = buildBestProbe({
    rada_nreg: '2947-14',
    title: 'Сімейний кодекс України',
    aliases: ['СКУ'],
    category: 'family',
    storage_category: null,
    document_type: 'Кодекс',
    document_type_slug: 'code',
    validity_status: 'in_force',
  });
  if (probe.probe_kind !== 'alias' || probe.query.normalize('NFC').toLowerCase() !== 'ску') {
    throw new Error(`Expected strong code alias to remain best probe, got ${JSON.stringify(probe)}`);
  }
  console.log('[OK] audit best probe keeps strong code alias');
}

function testAuditBestProbeRejectsAliasWithoutActIdentityOverlap(): void {
  const probe = buildBestProbe({
    rada_nreg: '29-2026-р',
    title: 'Про звільнення Корзуна А.В. з посади заступника Міністра енергетики України',
    aliases: ['розпорядження свириденко'],
    category: 'energy_utilities',
    storage_category: null,
    document_type: 'Розпорядження КМУ',
    document_type_slug: 'cmu_order',
    validity_status: 'in_force',
  });
  if (probe.probe_kind !== 'nreg' || probe.query !== '29-2026-р') {
    throw new Error(`Expected non-overlapping person-name alias to fall back to nreg, got ${JSON.stringify(probe)}`);
  }
  console.log('[OK] audit best probe rejects alias without act-identity overlap');
}

function testAuditBestProbeUsesNregForAmendmentLikeActAliases(): void {
  const probe = buildBestProbe({
    rada_nreg: '27-2026-р',
    title: 'Про внесення зміни у додаток до розпорядження Кабінету Міністрів України від 29 квітня 2025 р. № 408',
    aliases: ['Зміни до стипендій КМУ'],
    category: 'education_science',
    storage_category: 'other',
    document_type: 'Розпорядження КМУ',
    document_type_slug: 'cmu_order',
    validity_status: 'in_force',
  });
  if (probe.probe_kind !== 'nreg' || probe.query !== '27-2026-р') {
    throw new Error(`Expected amendment-like alias probe to fall back to nreg, got ${JSON.stringify(probe)}`);
  }
  console.log('[OK] audit best probe uses nreg for amendment-like act aliases');
}

function testAuditBestProbeUsesNregForBoilerplateAdministrativeAliases(): void {
  const probe = buildBestProbe({
    rada_nreg: '15-2026-р',
    title: 'Про визнання таким, що втратило чинність, розпорядження Кабінету Міністрів України від 19 листопада 2025 р. № 1292',
    aliases: ['розпорядження про втрату чинності'],
    category: 'administrative',
    storage_category: null,
    document_type: 'Розпорядження КМУ',
    document_type_slug: 'cmu_order',
    validity_status: 'in_force',
  });
  if (probe.probe_kind !== 'nreg' || probe.query !== '15-2026-р') {
    throw new Error(`Expected boilerplate administrative alias to fall back to nreg, got ${JSON.stringify(probe)}`);
  }
  console.log('[OK] audit best probe uses nreg for boilerplate administrative aliases');
}

function testAuditBestProbeUsesOwnNregWhenAmendmentAliasReferencesDifferentActNumber(): void {
  const probe = buildBestProbe({
    rada_nreg: '22-2026-п',
    title: 'Про внесення змін до постанов Кабінету Міністрів України від 3 листопада 2023 р. № 1150 і від 28 червня 2024 р. № 764 та визнання такими, що втратили чинність, постанов Кабінету Міністрів України від 28 квітня 2023 р. № 417 і від 5 грудня 2023 р. № 1276',
    aliases: ['скасування постанови №417'],
    category: 'digital_data',
    storage_category: null,
    document_type: 'Постанова КМУ',
    document_type_slug: 'cmu_resolution',
    validity_status: 'in_force',
  });
  if (probe.probe_kind !== 'nreg' || probe.query !== '22-2026-п') {
    throw new Error(`Expected amendment alias with foreign numeric stem to fall back to own nreg, got ${JSON.stringify(probe)}`);
  }
  console.log('[OK] audit best probe prefers own nreg when amendment alias references another act number');
}

function testQueryRewritePolicySkipsSimpleFocusedLegalQuery(): void {
  const decision = decideQueryRewritePolicy({
    query: "Яка відповідальність за керування авто в стані алкогольного сп'яніння вперше?",
    entities: [],
    goals_count: 1,
  });
  if (decision.shouldCall) {
    throw new Error(`Expected simple focused legal query to skip rewrite, got ${JSON.stringify(decision)}`);
  }
  if (!decision.reason_codes.includes('SIMPLE_FOCUSED_QUERY')) {
    throw new Error(`Expected SIMPLE_FOCUSED_QUERY, got ${JSON.stringify(decision.reason_codes)}`);
  }
  console.log('[OK] query rewrite policy skips simple focused legal query');
}

function testStructuralCitationSelectorsCaptureNoteAndSubpoint(): void {
  const selectors = extractQueryCitationSelectors('Що передбачає примітка 2 до пп. 6 п. 5 ч. 1 ст. 45 ККУ?');
  if (selectors.article !== '45') throw new Error(`Expected article 45, got ${selectors.article}`);
  if (selectors.articlePart !== '1') throw new Error(`Expected part 1, got ${selectors.articlePart}`);
  if (selectors.point !== '5') throw new Error(`Expected point 5, got ${selectors.point}`);
  if (selectors.subpoint !== '6') throw new Error(`Expected subpoint 6, got ${selectors.subpoint}`);
  if (selectors.note !== '2') throw new Error(`Expected note 2, got ${selectors.note}`);
  if (selectors.explicitSelectorCount < 5) {
    throw new Error(`Expected note + structural selectors to count as explicit, got ${selectors.explicitSelectorCount}`);
  }
  console.log('[OK] structural citation selectors capture note + article/part/point/subpoint');
}

function testStructuralCitationSelectorsCaptureDottedSubpoint(): void {
  const selectors = extractQueryCitationSelectors('Що передбачає п.п. 6 п. 5 ч. 1 ст. 45 ККУ?');
  if (selectors.article !== '45') throw new Error(`Expected article 45, got ${selectors.article}`);
  if (selectors.articlePart !== '1') throw new Error(`Expected part 1, got ${selectors.articlePart}`);
  if (selectors.point !== '5') throw new Error(`Expected point 5, got ${selectors.point}`);
  if (selectors.subpoint !== '6') throw new Error(`Expected dotted subpoint 6, got ${selectors.subpoint}`);
  console.log('[OK] structural citation selectors capture dotted subpoint notation');
}

function testStructuralCitationSelectorsCapturePluralPartSyntax(): void {
  const selectors = extractQueryCitationSelectors('Що передбачають ч.ч. 1, 2 ст. 45 ККУ?');
  if (selectors.article !== '45') throw new Error(`Expected article 45, got ${selectors.article}`);
  if (selectors.articlePart !== '1') {
    throw new Error(`Expected first part 1 from plural part syntax, got ${selectors.articlePart}`);
  }
  console.log('[OK] structural citation selectors capture plural part syntax');
}

function testStructuralCitationMatchCountsNoteSelectors(): void {
  const querySelectors = extractQueryCitationSelectors('Що передбачає примітка 2 до ст. 45?');
  const hitSelectors = getHitCitationSelectors({
    article_number: '45',
    unit_type: 'article',
    note_number: '2',
    citation_path: 'ст. 45 примітка 2',
    metadata: {},
  });
  const matches = countCitationMatches(querySelectors, hitSelectors);
  if (matches < 2) {
    throw new Error(`Expected article + note match, got ${matches}`);
  }
  console.log('[OK] structural citation matching counts note selectors');
}

function testStructuralCitationMatchCountsMentionedNoteWithoutExplicitNumber(): void {
  const querySelectors = extractQueryCitationSelectors(
    'Що визначає примітка до статті 185 КК України щодо значної шкоди?'
  );
  const hitSelectors = getHitCitationSelectors({
    article_number: '185',
    unit_type: 'paragraph',
    note_number: '1',
    citation_path: 'ст. 185 примітка 1',
    metadata: {},
  });
  const matches = countCitationMatches(querySelectors, hitSelectors);
  if (matches < 2) {
    throw new Error(`Expected article + note-mentioned match, got ${matches}`);
  }
  console.log('[OK] structural citation matching counts note mention without explicit number');
}

function testStructuralCitationBareNoteMentionDoesNotOvermatch(): void {
  const querySelectors = extractQueryCitationSelectors('Що таке примітка у цій нормі?');
  if (querySelectors.explicitSelectorCount !== 0) {
    throw new Error(
      `Expected bare note mention to stay non-explicit, got ${querySelectors.explicitSelectorCount}`
    );
  }
  const hitSelectors = getHitCitationSelectors({
    article_number: '185',
    unit_type: 'paragraph',
    note_number: '1',
    citation_path: 'ст. 185 примітка 1',
    metadata: {},
  });
  const matches = countCitationMatches(querySelectors, hitSelectors);
  if (matches !== 0) {
    throw new Error(`Expected bare note mention not to overmatch note-bearing hit, got ${matches}`);
  }
  console.log('[OK] bare note mention does not overmatch unrelated note-bearing hit');
}

function testHitCitationKeyPreservesNestedFallbackSelectors(): void {
  const key = buildHitCitationKey({
    article_number: '40',
    article_part_number: '3',
    point_number: '2',
    subpoint_number: '1',
    paragraph_number: '4',
    note_number: null,
    citation_path: null,
    unstructured_fallback: false,
    metadata: {},
  } as never);
  if (key !== 'ст. 40 ч. 3 п. 2 пп. 1 абз. 4') {
    throw new Error(`Expected nested structural fallback key, got ${key}`);
  }
  console.log('[OK] structural citation key preserves full nested structural path');
}

function testArticleBackfillPrefersSingleAliasMatchedAct(): void {
  const preferred = deriveArticleBackfillPreferredNreg({
    anchor_tokens: [],
    rada_nreg_candidates: ['2755-17', '2747-15'],
    category_hints: [],
    alias_hits: [
      { rada_nreg: '2755-17', alias: 'ПКУ', title: 'Податковий кодекс України', category: 'tax_customs', score: 1 },
      { rada_nreg: '2755-17', alias: 'Податковий кодекс України', title: 'Податковий кодекс України', category: 'tax_customs', score: 1 },
    ],
    taxonomy_hints_used: undefined,
    debug: { source: 'supabase', taxonomy_snapshot_version: 1 },
  } as any);
  if (preferred !== '2755-17') {
    throw new Error(`Expected preferred rada_nreg 2755-17, got ${preferred}`);
  }
  console.log('[OK] article backfill prefers single alias-matched act when act cue is unambiguous');
}

function testArticleBackfillPrefersDominantAliasMatchedAct(): void {
  const preferred = deriveArticleBackfillPreferredNreg({
    anchor_tokens: [],
    rada_nreg_candidates: ['z1257-07', '1442-97-п', '280-98-п'],
    category_hints: [],
    alias_hits: [
      { rada_nreg: '1442-97-п', alias: 'роздрібної торгівлі', title: '...', category: 'energy_utilities', score: 1 },
      { rada_nreg: '280-98-п', alias: 'роздрібної торгівлі', title: '...', category: 'business_corporate', score: 1 },
      { rada_nreg: 'z1257-07', alias: 'торгівлі непродовольчими', title: '...', category: 'business_corporate', score: 1 },
      { rada_nreg: 'z1257-07', alias: 'непродовольчими товарами', title: '...', category: 'business_corporate', score: 1 },
      { rada_nreg: 'z1257-07', alias: 'роздрібної торгівлі непродовольчими', title: '...', category: 'business_corporate', score: 1 },
      { rada_nreg: 'z1257-07', alias: 'торгівлі непродовольчими товарами', title: '...', category: 'business_corporate', score: 1 },
    ],
    taxonomy_hints_used: undefined,
    debug: { source: 'supabase', taxonomy_snapshot_version: 1 },
  } as any);
  if (preferred !== 'z1257-07') {
    throw new Error(`Expected dominant alias evidence to pick z1257-07, got ${preferred}`);
  }
  console.log('[OK] article backfill prefers dominant alias-matched act when one act clearly wins alias evidence');
}

function testArticleBackfillFilterCarriesStructuralSelectors(): void {
  const selectors = extractQueryCitationSelectors('Що передбачає пп. 6 п. 5 ч. 1 ст. 56 ПКУ?');
  const filter = buildArticleBackfillFilter({
    ref: {
      raw_ref: '56',
      normalized_forms: ['56'],
      signal_strength: 'strong',
      evidence: 'legal_prefix',
    },
    selectors,
    preferredRadaNreg: '2755-17',
  });
  const mustKeys = (filter.must ?? []).map((item) => item.key);
  if (!mustKeys.includes('rada_nreg')) throw new Error(`Expected rada_nreg must filter, got ${JSON.stringify(filter)}`);
  if (!mustKeys.includes('article_part_number')) throw new Error(`Expected article_part_number must filter, got ${JSON.stringify(filter)}`);
  if (!mustKeys.includes('point_number')) throw new Error(`Expected point_number must filter, got ${JSON.stringify(filter)}`);
  if (!mustKeys.includes('subpoint_number')) throw new Error(`Expected subpoint_number must filter, got ${JSON.stringify(filter)}`);
  if ((filter.should ?? []).length !== 1 || filter.should?.[0]?.key !== 'article_number') {
    throw new Error(`Expected article_number should filters, got ${JSON.stringify(filter)}`);
  }
  console.log('[OK] article backfill filter carries structural selectors into Qdrant filter');
}

function testArticleBackfillFilterCarriesNoteSelectors(): void {
  const selectors = extractQueryCitationSelectors('Що передбачає примітка 2 до ст. 45 ККУ?');
  const filter = buildArticleBackfillFilter({
    ref: {
      raw_ref: '45',
      normalized_forms: ['45'],
      signal_strength: 'strong',
      evidence: 'legal_prefix',
    },
    selectors,
    preferredRadaNreg: '2341-14',
  });
  const noteFilter = (filter.must ?? []).find((item) => item.key === 'note_number');
  if (noteFilter?.match?.value !== '2') {
    throw new Error(`Expected note_number filter to equal 2, got ${JSON.stringify(filter)}`);
  }
  console.log('[OK] article backfill filter carries note selector into Qdrant filter');
}

function testArticleBackfillDoesNotTreatWrongPointAsSatisfied(): void {
  const selectors = extractQueryCitationSelectors('Що передбачає пп. 6 п. 5 ч. 1 ст. 56 ПКУ?');
  const satisfied = hitSatisfiesBackfillExpectation(
    {
      article_number: '56',
      article_part_number: '1',
      point_number: '4',
      subpoint_number: '6',
      unit_type: 'point',
      citation_path: 'ст. 56 ч. 1 п. 4 пп. 6',
      metadata: {},
    },
    {
      raw_ref: '56',
      normalized_forms: ['56'],
      signal_strength: 'strong',
      evidence: 'legal_prefix',
    },
    selectors
  );
  if (satisfied) {
    throw new Error('Expected wrong point_number to fail structural backfill satisfaction');
  }
  console.log('[OK] article backfill requires full structural match, not article-only presence');
}

function testStructuralOnlyBackfillFilterCarriesPointSelectors(): void {
  const selectors = extractQueryCitationSelectors('Що передбачено п. 21 Правил перетинання державного кордону?');
  const filter = buildStructuralOnlyBackfillFilter({
    selectors,
    preferredRadaNreg: '57-95-п',
  });
  const mustKeys = (filter?.must ?? []).map((item) => item.key);
  if (!mustKeys.includes('rada_nreg')) throw new Error(`Expected rada_nreg must filter, got ${JSON.stringify(filter)}`);
  if (!mustKeys.includes('point_number')) throw new Error(`Expected point_number must filter, got ${JSON.stringify(filter)}`);
  console.log('[OK] structural-only backfill filter carries preferred act + point selector');
}

function testStructuralOnlyBackfillRequiresPointMatch(): void {
  const selectors = extractQueryCitationSelectors('Що передбачено п. 12 Правил роздрібної торгівлі непродовольчими товарами?');
  const wrongPoint = hitSatisfiesStructuralSelectors(
    {
      unit_type: 'point',
      unit_number: '11',
      point_number: '11',
      citation_path: 'п. 11',
      metadata: {},
    },
    selectors
  );
  if (wrongPoint) {
    throw new Error('Expected structural-only backfill to reject wrong point_number');
  }
  const rightPoint = hitSatisfiesStructuralSelectors(
    {
      unit_type: 'point',
      unit_number: '12',
      point_number: '12',
      citation_path: 'п. 12',
      metadata: {},
    },
    selectors
  );
  if (!rightPoint) {
    throw new Error('Expected structural-only backfill to accept exact point_number');
  }
  console.log('[OK] structural-only backfill requires exact structural selector match');
}

function testSelectedActsFinalizerRaisesConfidenceAfterRoutingPrimaryLaw(): void {
  const result = finalizeSelectedActsAfterRouting({
    selected_acts_before_routing: [
      {
        rada_nreg: 'z1257-07',
        act_title: 'Правила',
        document_type: 'Наказ',
        act_kind: 'SECONDARY_ORDER',
      },
    ],
    selected_acts_final: [
      {
        rada_nreg: 'z1257-07',
        act_title: 'Правила',
        document_type: 'Наказ',
        act_kind: 'SECONDARY_ORDER',
      },
      {
        rada_nreg: '1023-12',
        act_title: 'Закон України Про захист прав споживачів',
        document_type: 'Закон',
        act_kind: 'PRIMARY_LAW',
      },
    ],
    base_confidence: 0.52,
    base_decision: {
      policy_version: 3.1,
      included_from_chunks_evidence: true,
      reason_codes: ['COVERAGE_GUARD_FAILED'],
    },
    routing_hints_added_count: 1,
    routing_hints_added_primary_law: true,
    routing_hints_added_nregs: ['1023-12'],
    retrieval_evidence_nregs: ['1023-12', 'z1257-07'],
  });
  if (result.selected_acts_confidence_final < 0.6) {
    throw new Error(`Expected routing-hints finalizer to raise confidence floor, got ${result.selected_acts_confidence_final}`);
  }
  if (!result.routing_hints_recovered_with_retrieval_evidence) {
    throw new Error('Expected routing-hints recovery to require retrieval evidence for the added act');
  }
  if (!result.selected_acts_decision_final.reason_codes?.includes('ROUTING_HINTS_ADDED_PRIMARY_LAW')) {
    throw new Error(`Expected routing hints decision code, got ${JSON.stringify(result.selected_acts_decision_final.reason_codes)}`);
  }
  console.log('[OK] selected acts finalizer reconciles confidence after routing-hints primary-law recovery');
}

function testSelectedActsFinalizerDoesNotInflateConfidenceWithoutEvidence(): void {
  const result = finalizeSelectedActsAfterRouting({
    selected_acts_before_routing: [
      {
        rada_nreg: 'z1257-07',
        act_title: 'Правила',
        document_type: 'Наказ',
        act_kind: 'SECONDARY_ORDER',
      },
    ],
    selected_acts_final: [
      {
        rada_nreg: 'z1257-07',
        act_title: 'Правила',
        document_type: 'Наказ',
        act_kind: 'SECONDARY_ORDER',
      },
      {
        rada_nreg: '1023-12',
        act_title: 'Закон України Про захист прав споживачів',
        document_type: 'Закон',
        act_kind: 'PRIMARY_LAW',
      },
    ],
    base_confidence: 0.52,
    base_decision: {
      policy_version: 3.1,
      included_from_chunks_evidence: true,
      reason_codes: ['COVERAGE_GUARD_FAILED'],
    },
    routing_hints_added_count: 1,
    routing_hints_added_primary_law: true,
    routing_hints_added_nregs: ['1023-12'],
    retrieval_evidence_nregs: ['z1257-07'],
  });
  if (result.selected_acts_confidence_final !== 0.52) {
    throw new Error(`Expected no confidence inflation without retrieval evidence, got ${result.selected_acts_confidence_final}`);
  }
  if (result.routing_hints_recovered_with_retrieval_evidence) {
    throw new Error('Expected routing-hints recovery flag to stay false without retrieval evidence');
  }
  console.log('[OK] selected acts finalizer does not inflate confidence when routing hints add unsupported act');
}

function testSelectedActsFinalizerRemovesUnsupportedRoutingHintActs(): void {
  const result = finalizeSelectedActsAfterRouting({
    selected_acts_before_routing: [
      {
        rada_nreg: '4651-17',
        act_title: 'КПК України',
        document_type: 'Кодекс',
        act_kind: 'PRIMARY_LAW',
      },
    ],
    selected_acts_final: [
      {
        rada_nreg: '4651-17',
        act_title: 'КПК України',
        document_type: 'Кодекс',
        act_kind: 'PRIMARY_LAW',
      },
      {
        rada_nreg: '580-19',
        act_title: 'Про Національну поліцію',
        document_type: 'Закон',
        act_kind: 'PRIMARY_LAW',
      },
    ],
    base_confidence: 0.66,
    base_decision: {
      policy_version: 3.1,
      included_from_chunks_evidence: true,
      reason_codes: ['SELECTED_ACTS_FROM_CHUNKS_EVIDENCE'],
    },
    routing_hints_added_count: 1,
    routing_hints_added_primary_law: true,
    routing_hints_added_nregs: ['580-19'],
    retrieval_evidence_nregs: ['4651-17'],
  });
  if (result.selected_acts_final.some((act) => act.rada_nreg === '580-19')) {
    throw new Error(`Expected unsupported routing-hint act to be removed, got ${JSON.stringify(result.selected_acts_final)}`);
  }
  if (!result.selected_acts_decision_final.reason_codes?.includes('ROUTING_HINTS_UNSUPPORTED_REMOVED')) {
    throw new Error(`Expected removal reason code, got ${JSON.stringify(result.selected_acts_decision_final.reason_codes)}`);
  }
  console.log('[OK] selected acts finalizer removes unsupported routing-hint additions');
}

function testSelectedActsBlocksUnrelatedSecondaryOrderUnderPrimaryLawDominance(): void {
  const result = buildSelectedActs({
    finalHits: [
      {
        rada_nreg: '4651-17',
        r2_key: 'r2://kpk-214',
        json_path: '$.content.chunks[0].text',
        score: 0.63,
        ordering_score: 0.63,
        source: 'lldbi_chunks',
        article_number: '214',
      } as never,
      {
        rada_nreg: '4651-17',
        r2_key: 'r2://kpk-303',
        json_path: '$.content.chunks[1].text',
        score: 0.61,
        ordering_score: 0.61,
        source: 'lldbi_chunks',
        article_number: '303',
      } as never,
      {
        rada_nreg: '4651-17',
        r2_key: 'r2://kpk-305',
        json_path: '$.content.chunks[2].text',
        score: 0.6,
        ordering_score: 0.6,
        source: 'lldbi_chunks',
        article_number: '305',
      } as never,
      {
        rada_nreg: '4651-17',
        r2_key: 'r2://kpk-306',
        json_path: '$.content.chunks[3].text',
        score: 0.59,
        ordering_score: 0.59,
        source: 'lldbi_chunks',
        article_number: '306',
      } as never,
      {
        rada_nreg: 'v0015700-98',
        r2_key: 'r2://plenum-13',
        json_path: '$.content.chunks[4].text',
        score: 0.58,
        ordering_score: 0.58,
        source: 'lldbi_chunks',
        unit_type: 'point',
        point_number: '13',
      } as never,
      {
        rada_nreg: 'v0015700-98',
        r2_key: 'r2://plenum-7',
        json_path: '$.content.chunks[5].text',
        score: 0.57,
        ordering_score: 0.57,
        source: 'lldbi_chunks',
        unit_type: 'point',
        point_number: '7',
      } as never,
    ],
    actCandidatesTop: [
      {
        rada_nreg: '4651-17',
        title: 'Кримінальний процесуальний кодекс України',
        category: 'criminal_procedure',
        document_type: 'кодекс',
        score: 0.95,
      },
      {
        rada_nreg: 'v0015700-98',
        title: 'Про внесення змін і доповнень у деякі постанови Пленуму Верховного Суду України в цивільних справах',
        category: 'civil',
        document_type: 'постанова пленуму верховного суду',
        score: 0.78,
      },
    ],
    goals_summary: [{ goal_id: 'goal_0' }],
    taxonomyNregs: new Set(['4651-17', 'v0015700-98']),
    actsSearchNregs: [],
    familyEvidence: {
      dominant_family_key: 'criminal_procedure',
      family_confidence: 0.78,
      family_conflict: false,
      top2: [{ family_key: 'criminal_procedure', support_score: 0.95 }],
    },
  });
  const selectedNregs = result.selected_acts.map((act) => act.rada_nreg);
  if (!selectedNregs.includes('4651-17')) {
    throw new Error(`Expected primary-law procedural act to remain selected, got ${JSON.stringify(selectedNregs)}`);
  }
  if (selectedNregs.includes('v0015700-98')) {
    throw new Error(`Expected unrelated secondary order to be blocked, got ${JSON.stringify(selectedNregs)}`);
  }
  if (!result.selected_acts_reason_codes.includes('ORDER_UNRELATED_BLOCKED')) {
    throw new Error(`Expected ORDER_UNRELATED_BLOCKED reason code, got ${JSON.stringify(result.selected_acts_reason_codes)}`);
  }
  console.log('[OK] selected acts blocks unrelated secondary order under primary-law dominance');
}

function testSelectedActsDropsWeakFirstSecondaryOrderFallbackEvenWithEvidence(): void {
  const result = buildSelectedActs({
    finalHits: [],
    actCandidatesTop: [
      {
        rada_nreg: '4651-17',
        title: 'Кримінальний процесуальний кодекс України',
        score: 0.95,
        category: 'criminal_procedure',
        document_type: 'Кодекс',
        source_tier: 'ACTS_1',
      },
      {
        rada_nreg: 'v0015700-98',
        title: 'Про внесення змін і доповнень у деякі постанови Пленуму Верховного Суду України в цивільних справах',
        score: 0.74,
        category: 'civil',
        document_type: 'Постанова Пленуму Верховного Суду',
        source_tier: 'ACTS_1',
      },
    ],
    goals_summary: [{ goal_id: 'goal_0' }],
    taxonomyNregs: new Set(['4651-17', 'v0015700-98']),
    actsSearchNregs: ['4651-17', 'v0015700-98'],
    chunks_evidence_top_acts: [
      {
        rada_nreg: '4651-17',
        count_in_top30: 9,
        avg_score_in_top30: 0.55,
        max_score: 0.62,
        best_rank_in_top30: 1,
        rank_mass_top30: 2.0,
        max_ordering_score: 0.63,
      },
      {
        rada_nreg: 'v0015700-98',
        count_in_top30: 3,
        avg_score_in_top30: 0.47,
        max_score: 0.52,
        best_rank_in_top30: 4,
        rank_mass_top30: 0.62,
        max_ordering_score: 0.54,
      },
    ],
    familyEvidence: {
      dominant_family_key: 'criminal_procedure',
      family_confidence: 0.81,
      family_conflict: false,
      top2: [{ family_key: 'criminal_procedure', support_score: 0.81 }],
    },
  });
  if (result.selected_acts.some((act) => act.rada_nreg === 'v0015700-98')) {
    throw new Error(
      `Expected weak first secondary order fallback to be blocked even with evidence, got ${JSON.stringify(result.selected_acts)}`
    );
  }
  console.log('[OK] selected acts blocks weak first secondary order fallback even with evidence');
}

function testSelectedActsDoesNotDiversifyIntoNoiseWhenPrimaryLawAlreadySelected(): void {
  const result = buildSelectedActs({
    finalHits: [],
    actCandidatesTop: [
      {
        rada_nreg: '2341-14',
        title: 'Кримінальний кодекс України',
        score: 0.96,
        category: 'criminal',
        document_type: 'Кодекс',
        source_tier: 'ACTS_1',
      },
      {
        rada_nreg: 'v001p710-19',
        title: 'Рішення Конституційного Суду України у кримінальній справі',
        score: 0.74,
        category: 'constitutional',
        document_type: 'Рішення КСУ',
        source_tier: 'ACTS_1',
      },
    ],
    goals_summary: [{ goal_id: 'goal_0' }, { goal_id: 'goal_1' }],
    taxonomyNregs: new Set(['2341-14', 'v001p710-19']),
    actsSearchNregs: ['2341-14', 'v001p710-19'],
    chunks_evidence_top_acts: [
      {
        rada_nreg: '2341-14',
        count_in_top30: 11,
        avg_score_in_top30: 0.56,
        max_score: 0.62,
        best_rank_in_top30: 1,
        rank_mass_top30: 2.2,
        max_ordering_score: 0.64,
      },
      {
        rada_nreg: 'v001p710-19',
        count_in_top30: 3,
        avg_score_in_top30: 0.45,
        max_score: 0.5,
        best_rank_in_top30: 8,
        rank_mass_top30: 0.2,
        max_ordering_score: 0.43,
      },
    ],
    familyEvidence: {
      dominant_family_key: 'criminal',
      family_confidence: 0.88,
      family_conflict: false,
      top2: [{ family_key: 'criminal', support_score: 0.88 }],
    },
  });
  if (result.selected_acts.some((act) => act.rada_nreg === 'v001p710-19')) {
    throw new Error(
      `Expected diversity guard not to manufacture noise when one primary law already covers the query, got ${JSON.stringify(result.selected_acts)}`
    );
  }
  console.log('[OK] selected acts does not diversify into noise when primary law already selected');
}

function testSummarizeSelectedActsCountsKindsAndDocTypes(): void {
  const summary = summarizeSelectedActs([
    { rada_nreg: '1023-12', document_type: 'Закон', act_kind: 'PRIMARY_LAW' },
    { rada_nreg: '435-15', document_type: 'Кодекс', act_kind: 'PRIMARY_LAW' },
    { rada_nreg: 'z1257-07', document_type: 'Наказ', act_kind: 'SECONDARY_ORDER' },
  ]);
  if (summary.selected_acts_kinds_count.PRIMARY_LAW !== 2) {
    throw new Error(`Expected 2 PRIMARY_LAW acts, got ${JSON.stringify(summary.selected_acts_kinds_count)}`);
  }
  if (!summary.selected_acts_document_types_top?.includes('Закон') || !summary.selected_acts_document_types_top?.includes('Наказ')) {
    throw new Error(`Expected document types summary, got ${JSON.stringify(summary.selected_acts_document_types_top)}`);
  }
  console.log('[OK] selected acts summary recomputes kinds and document types from final act list');
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

function testClassifyActKindUsesDocumentTypeSlug(): void {
  const treatyKind = classifyActKind('Convention text', undefined, undefined, 'convention');
  if (treatyKind !== 'INTERNATIONAL_TREATY') {
    throw new Error(`Expected INTERNATIONAL_TREATY via document_type_slug, got ${treatyKind}`);
  }
  const ksuKind = classifyActKind('Decision', undefined, undefined, 'ccu_decision');
  if (ksuKind !== 'KSU_DECISION') {
    throw new Error(`Expected KSU_DECISION via document_type_slug, got ${ksuKind}`);
  }
  console.log('[OK] classifyActKind(document_type_slug) → stable act kind without human document_type');
}

function testAmendmentSignalsStayGeneric(): void {
  if (!isAmendmentLikeActTitle('Про внесення змін до постанови Кабінету Міністрів України')) {
    throw new Error('Expected generic amendment title detector to recognize modification act');
  }
  if (isAmendmentLikeActTitle('Про затвердження Правил роздрібної торгівлі нафтопродуктами')) {
    throw new Error('Expected substantive base act title to stay non-amendment');
  }
  if (!queryLooksAmendmentFocused('Які зміни внесено до постанови про правила АЗС?')) {
    throw new Error('Expected query with explicit change language to be amendment-focused');
  }
  if (queryLooksAmendmentFocused('Які правила торгівлі на АЗС зараз діють?')) {
    throw new Error('Expected substantive compliance query to stay non-amendment-focused');
  }
  console.log('[OK] amendment detectors distinguish modifier intent from substantive act queries');
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

async function testTaxonomyPrefersBaseActOverAmendmentOnAliasCollision(): Promise<void> {
  const baseMeta = await getActMeta('1442-97-п');
  const amendmentMeta = await getActMeta('280-98-п');
  if (!baseMeta || !amendmentMeta) {
    console.log('[SKIP] amendment collision taxonomy test (acts not present in current LLDBI snapshot)');
    return;
  }
  const taxonomy = await getTaxonomyCandidates({ query: 'правила азс' });
  const baseRank = taxonomy.rada_nreg_candidates.indexOf('1442-97-п');
  const amendmentRank = taxonomy.rada_nreg_candidates.indexOf('280-98-п');
  if (baseRank < 0) {
    throw new Error(`Expected base act 1442-97-п in taxonomy candidates, got ${JSON.stringify(taxonomy.rada_nreg_candidates.slice(0, 10))}`);
  }
  if (amendmentRank >= 0 && amendmentRank < baseRank) {
    throw new Error(`Expected base act to outrank amendment act on substantive alias query, got base=${baseRank} amendment=${amendmentRank}`);
  }
  if (taxonomy.grounded_act_nregs.length === 1 && taxonomy.grounded_act_nregs[0] !== '1442-97-п') {
    throw new Error(`Expected grounded act recovery to prefer base act, got ${JSON.stringify(taxonomy.grounded_act_nregs)}`);
  }
  console.log('[OK] taxonomy prefers substantive base act over amendment alias collision');
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

function testStructuralScoreSoftensZeroOverlapPenaltyForStrongArticleHits(): void {
  const query = 'Хто розслідує шахрайство?';
  const articleHit = {
    r2_key: 'legislation/criminal_procedure/4651-17.json',
    json_path: '$.content.chunks[512].text',
    score: 0.52,
    source: 'lldbi_chunks' as const,
    rada_nreg: '4651-17',
    article_number: '216',
    metadata: {
      unit_type: 'article',
      chunk_title: 'Підслідність',
    },
  };
  const genericSectionHit = {
    r2_key: 'legislation/criminal_procedure/4651-17.json',
    json_path: '$.content.chunks[11].text',
    score: 0.52,
    source: 'lldbi_chunks' as const,
    rada_nreg: '4651-17',
    metadata: {
      unit_type: 'section',
      chunk_title: 'Загальні положення',
    },
  };
  const articleScore = computeChunkStructuralScore(articleHit, query);
  const genericScore = computeChunkStructuralScore(genericSectionHit, query);
  if (articleScore <= genericScore) {
    throw new Error(
      `Expected strong article hit with zero lexical overlap to be penalized less than generic section. article=${articleScore} generic=${genericScore}`
    );
  }
  console.log('[OK] structural score softens zero-overlap penalty for strong article hits');
}

function testStructuralScorePrefersProceduralAnchorArticleTitle(): void {
  const query = 'Хто розслідує шахрайство? підслідність орган досудового розслідування';
  const proceduralHit = {
    r2_key: 'legislation/criminal_procedure/4651-17.json',
    json_path: '$.content.chunks[512].text',
    score: 0.44,
    source: 'lldbi_chunks' as const,
    rada_nreg: '4651-17',
    article_number: '216',
    metadata: {
      unit_type: 'article',
      chunk_title: 'Підслідність',
    },
  };
  const genericProcedureHit = {
    r2_key: 'legislation/criminal_procedure/4651-17.json',
    json_path: '$.content.chunks[88].text',
    score: 0.47,
    source: 'lldbi_chunks' as const,
    rada_nreg: '4651-17',
    article_number: '55',
    metadata: {
      unit_type: 'article',
      chunk_title: 'Права та обов’язки потерпілого',
    },
  };
  const tokenWeights = buildDiscriminativeQueryTokenWeights([proceduralHit, genericProcedureHit], query);
  const proceduralScore = computeChunkStructuralScore(proceduralHit, query, tokenWeights);
  const genericScore = computeChunkStructuralScore(genericProcedureHit, query, tokenWeights);
  if (proceduralScore <= genericScore) {
    throw new Error(
      `Expected procedural anchor article to outrank generic procedural article. procedural=${proceduralScore} generic=${genericScore}`
    );
  }
  console.log('[OK] structural score prefers procedural anchor article title when query carries procedural signal');
}

function testStructuralScorePrefersExplicitPointCitation(): void {
  const query = 'Хто має право перетинати державний кордон під час воєнного стану за пунктом 21 цих Правил?';
  const matchingPointHit = {
    r2_key: 'legislation/other/57-95-п.json',
    json_path: '$.content.chunks[2].text',
    score: 0.43,
    source: 'lldbi_chunks' as const,
    rada_nreg: '57-95-п',
    unit_number: '21',
    unit_type: 'point',
    citation_path: 'п. 21',
    metadata: {
      unit_type: 'point',
      unit_number: '21',
      citation_path: 'п. 21',
      chunk_title: 'У разі введення на території України надзвичайного або воєнного стану перетинати державний кордон мають право:',
    },
  };
  const genericPointHit = {
    r2_key: 'legislation/other/57-95-п.json',
    json_path: '$.content.chunks[1].text',
    score: 0.46,
    source: 'lldbi_chunks' as const,
    rada_nreg: '57-95-п',
    unit_number: '2',
    unit_type: 'point',
    citation_path: 'п. 2',
    metadata: {
      unit_type: 'point',
      unit_number: '2',
      citation_path: 'п. 2',
      chunk_title: 'Пункт 2',
    },
  };
  const tokenWeights = buildDiscriminativeQueryTokenWeights([matchingPointHit, genericPointHit], query);
  const matchingScore = computeChunkStructuralScore(matchingPointHit, query, tokenWeights);
  const genericScore = computeChunkStructuralScore(genericPointHit, query, tokenWeights);
  if (matchingScore <= genericScore) {
    throw new Error(
      `Expected explicit point citation hit to outrank generic point. matching=${matchingScore} generic=${genericScore}`
    );
  }
  console.log('[OK] structural score prefers explicit point citation over generic point hit');
}

function testStructuralScoreDemotesWrongPointEvenWithLexicalOverlap(): void {
  const query =
    "Якщо продавець не перевірив товар і не надав інформацію за п. 12 Правил роздрібної торгівлі непродовольчими товарами?";
  const matchingPointHit = {
    r2_key: 'legislation/other/z1257-07.json',
    json_path: '$.content.chunks[14].text',
    score: 0.43,
    source: 'lldbi_chunks' as const,
    rada_nreg: 'z1257-07',
    unit_number: '12',
    unit_type: 'point',
    citation_path: 'п. 12',
    metadata: {
      unit_type: 'point',
      unit_number: '12',
      citation_path: 'п. 12',
      chunk_title:
        "Продавець зобов'язаний надати покупцеві необхідну, доступну, достовірну та своєчасну інформацію про товар.",
    },
  };
  const wrongPointHit = {
    r2_key: 'legislation/other/z1257-07.json',
    json_path: '$.content.chunks[31].text',
    score: 0.56,
    source: 'lldbi_chunks' as const,
    rada_nreg: 'z1257-07',
    unit_number: '31',
    unit_type: 'point',
    citation_path: 'п. 31',
    metadata: {
      unit_type: 'point',
      unit_number: '31',
      citation_path: 'п. 31',
      chunk_title: 'Продавець перевіряє товар перед продажем та повідомляє покупця про його властивості.',
    },
  };
  const tokenWeights = buildDiscriminativeQueryTokenWeights([matchingPointHit, wrongPointHit], query);
  const matchingScore = computeChunkStructuralScore(matchingPointHit, query, tokenWeights);
  const wrongScore = computeChunkStructuralScore(wrongPointHit, query, tokenWeights);
  if (matchingScore <= wrongScore) {
    throw new Error(
      `Expected exact point citation to outrank wrong lexical-overlap point. matching=${matchingScore} wrong=${wrongScore}`
    );
  }
  console.log('[OK] structural score demotes wrong point even when another point has strong lexical overlap');
}

function testGoalSplitAddsErdrProceduralSignal(): void {
  const q =
    "У який строк слідчий або прокурор зобов'язані внести відомості до ЄРДР після заяви про кримінальне правопорушення?";
  const r = heuristicGoalSplit(q, 'criminal', undefined);
  if (r.goals.length !== 1) {
    throw new Error(`Expected single goal for ЄРДР procedural query, got ${r.goals.length}`);
  }
  if (r.goals[0]?.goal_type !== 'procedure') {
    throw new Error(`Expected procedure goal for ЄРДР query, got ${r.goals[0]?.goal_type}`);
  }
  if (!r.goals[0]?.must_have_signals?.includes('початок досудового розслідування')) {
    throw new Error(
      `Expected ЄРДР query to include procedural concept signal, got ${JSON.stringify(r.goals[0]?.must_have_signals)}`
    );
  }
  console.log('[OK] heuristicGoalSplit adds ЄРДР procedural concept signal');
}

function testGoalSplitCompactsErdrComplaintBundle(): void {
  const q =
    'Після заяви про злочин слідчий каже, що спочатку перевірить обставини, а вже потім внесе відомості до реєстру. На що посилатися і як це оскаржується?';
  const r = heuristicGoalSplit(q, 'criminal', undefined);
  if (r.goals.length !== 1) {
    throw new Error(`Expected ЄРДР complaint bundle to compact into 1 goal, got ${r.goals.length}`);
  }
  if (r.goals[0]?.goal_type !== 'procedure') {
    throw new Error(`Expected compacted ЄРДР goal to be procedural, got ${r.goals[0]?.goal_type}`);
  }
  if (!r.reason_codes.includes('procedural_bundle_compaction')) {
    throw new Error(`Expected procedural_bundle_compaction for ЄРДР complaint bundle, got ${JSON.stringify(r.reason_codes)}`);
  }
  console.log('[OK] heuristicGoalSplit compacts ЄРДР complaint bundle into one procedural goal');
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
    throw new Error(`Expected weak tail acts to be trimmed, got ${JSON.stringify(result.selected_acts)}`);
  }
  if (
    !result.selected_acts_reason_codes.includes('SINGLE_GOAL_TAIL_TRIMMED') &&
    !result.selected_acts_reason_codes.includes('NON_PRIMARY_EVIDENCE_BLOCKED_PRIMARY_PRESENT')
  ) {
    throw new Error(`Expected single-goal tail cleanup reason code, got ${JSON.stringify(result.selected_acts_reason_codes)}`);
  }
  console.log('[OK] selected_acts cleans weak single-goal tail acts when primary evidence dominates');
}

function testSelectedActsTrimNonPrimaryOnlyTailAndLowerConfidence(): void {
  const result = buildSelectedActs({
    finalHits: [],
    actCandidatesTop: [
      {
        rada_nreg: '1178-2022-п',
        title: 'Особливості здійснення публічних закупівель',
        score: 0.92,
        category: 'admin',
        document_type: 'Постанова КМУ',
      },
      {
        rada_nreg: '33-2026-п',
        title: 'Про внесення змін до Порядку формування та використання електронного каталогу',
        score: 0.71,
        category: 'admin',
        document_type: 'Постанова КМУ',
      },
      {
        rada_nreg: 'va07p710-20',
        title: 'Рішення Першого сенату Конституційного Суду України',
        score: 0.38,
        category: 'judiciary_justice',
        document_type: 'Рішення КСУ',
      },
      {
        rada_nreg: 'v0015700-98',
        title: 'Про внесення змін і доповнень у деякі постанови Пленуму Верховного Суду України',
        score: 0.32,
        category: 'judiciary_justice',
        document_type: 'Постанова Пленуму Верховного Суду',
      },
    ],
    goals_summary: [{ goal_id: 'goal_0' }],
    taxonomyNregs: new Set(['1178-2022-п', '33-2026-п', 'va07p710-20', 'v0015700-98']),
    actsSearchNregs: ['1178-2022-п', '33-2026-п', 'va07p710-20', 'v0015700-98'],
    chunks_evidence_top_acts: [
      { rada_nreg: '1178-2022-п', count_in_top30: 9, avg_score_in_top30: 0.61, max_score: 0.68, best_rank_in_top30: 1, rank_mass_top30: 1.9, max_ordering_score: 0.63 },
      { rada_nreg: '33-2026-п', count_in_top30: 2, avg_score_in_top30: 0.56, max_score: 0.61, best_rank_in_top30: 3, rank_mass_top30: 0.58, max_ordering_score: 0.58 },
      { rada_nreg: 'va07p710-20', count_in_top30: 1, avg_score_in_top30: 0.35, max_score: 0.35, best_rank_in_top30: 10, rank_mass_top30: 0.1, max_ordering_score: 0.38 },
      { rada_nreg: 'v0015700-98', count_in_top30: 1, avg_score_in_top30: 0.31, max_score: 0.31, best_rank_in_top30: 12, rank_mass_top30: 0.08, max_ordering_score: 0.33 },
    ],
  });
  if (result.selected_acts.length !== 2) {
    throw new Error(`Expected non-primary-only tail trim to keep 2 acts, got ${result.selected_acts.length}`);
  }
  if (result.selected_acts.some((act) => act.rada_nreg === 'va07p710-20' || act.rada_nreg === 'v0015700-98')) {
    throw new Error(`Expected weak non-primary tail acts to be removed, got ${JSON.stringify(result.selected_acts)}`);
  }
  if (!result.selected_acts_reason_codes.includes('NON_PRIMARY_ONLY_WEAK_CONFIDENCE')) {
    throw new Error(`Expected NON_PRIMARY_ONLY_WEAK_CONFIDENCE, got ${JSON.stringify(result.selected_acts_reason_codes)}`);
  }
  if (result.selected_acts_confidence > 0.55) {
    throw new Error(`Expected non-primary-only selection confidence <= 0.55, got ${result.selected_acts_confidence}`);
  }
  console.log('[OK] selected_acts trims non-primary-only tails and lowers confidence without explicit non-primary hint');
}

function testCoverageGapTreatsNoPrimaryLawAsWeakEvidence(): void {
  const coverageGap = deriveCoverageGap({
    lowConfidence: true,
    reasonCodes: ['NO_PRIMARY_LAW_EVIDENCE', 'LOW_EVIDENCE'],
    selectedActsCount: 2,
    selectedActsConfidence: 0.55,
    hitsCount: 12,
    topScore: 0.67,
    categoryHintCount: 1,
    entitiesCount: 0,
    anchorsCount: 0,
  });
  if (coverageGap !== 'weak_evidence') {
    throw new Error(`Expected NO_PRIMARY_LAW_EVIDENCE to map to weak_evidence, got ${coverageGap}`);
  }
  console.log('[OK] coverage-gap treats no-primary-law low-confidence runs as weak evidence');
}

async function testResolveSingleGoalSelectedActsConfirmsExplicitNonPrimaryScope(): Promise<void> {
  const result = await resolveSingleGoalSelectedActs({
    query: 'За постановою № 1178 які документи подаються для участі в закупівлі?',
    goalId: 'goal_0',
    finalHits: [
      {
        rada_nreg: '1178-2022-п',
        r2_key: 'r2://1178',
        json_path: '$.chunks[0]',
        score: 0.548,
        ordering_score: 0.482,
        title:
          'Про затвердження особливостей здійснення публічних закупівель товарів, робіт і послуг для замовників',
        unit_type: 'point',
        unit_number: '47',
      },
      {
        rada_nreg: 'z1257-07',
        r2_key: 'r2://z1257',
        json_path: '$.chunks[1]',
        score: 0.478,
        ordering_score: 0.292,
        title: 'Про затвердження Правил роздрібної торгівлі непродовольчими товарами',
        unit_type: 'point',
        unit_number: '9',
      },
    ] as never,
    actCandidatesTopHydrated: [
      {
        rada_nreg: '1178-2022-п',
        title:
          'Про затвердження особливостей здійснення публічних закупівель товарів, робіт і послуг для замовників',
        score: 0.92,
        category: 'administrative',
        document_type: 'Постанова КМУ',
        document_type_slug: 'postanova-kmu',
      },
      {
        rada_nreg: 'z1257-07',
        title: 'Про затвердження Правил роздрібної торгівлі непродовольчими товарами',
        score: 0.71,
        category: 'administrative',
        document_type: 'Наказ',
        document_type_slug: 'nakaz',
      },
      {
        rada_nreg: 'z0270-10',
        title: 'Про затвердження Типових правил роботи оптових ринків сільськогосподарської продукції',
        score: 0.63,
        category: 'administrative',
        document_type: 'Наказ',
        document_type_slug: 'nakaz',
      },
    ],
    plannerRationaleByNreg: new Map(),
    taxonomyNregs: new Set(['1178-2022-п']),
    actsSearchNregs: ['1178-2022-п', 'z1257-07', 'z0270-10'],
    domainHint: 'administrative',
    documentTypeHints: ['Постанова КМУ'],
    taxonomyActCount: 1,
    aliasHitCount: 1,
    exactActHitCount: 0,
    exactActNregs: [],
    groundedActHitCount: 0,
    groundedActNregs: [],
    actSelectionLowConfidence: false,
    reasonCodes: [],
    useLowConfidenceFallback: false,
    queryRewriteMeta: { called: false, used: false, not_used_reason_codes: ['STRONG_TAXONOMY_SIGNAL'] },
    topScore: 0.548,
    avgScore: 0.52,
    categoryHintsCount: 1,
    entitiesCount: 1,
    anchorsCount: 0,
    domainWeak: false,
    precomputedChunksEvidenceTopActs: [
      {
        rada_nreg: '1178-2022-п',
        count_in_top30: 13,
        avg_score_in_top30: 0.53,
        max_score: 0.61,
        best_rank_in_top30: 1,
        rank_mass_top30: 1.9,
        max_ordering_score: 0.63,
      },
      {
        rada_nreg: 'z1257-07',
        count_in_top30: 8,
        avg_score_in_top30: 0.47,
        max_score: 0.52,
        best_rank_in_top30: 7,
        rank_mass_top30: 0.81,
        max_ordering_score: 0.29,
      },
      {
        rada_nreg: 'z0270-10',
        count_in_top30: 3,
        avg_score_in_top30: 0.44,
        max_score: 0.49,
        best_rank_in_top30: 6,
        rank_mass_top30: 0.42,
        max_ordering_score: 0.24,
      },
    ],
    getActMeta: async (rada_nreg) => {
      const byNreg: Record<string, { title: string; category: string; document_type: string; document_type_slug: string; storage_category: string | null }> = {
        '1178-2022-п': {
          title:
            'Про затвердження особливостей здійснення публічних закупівель товарів, робіт і послуг для замовників',
          category: 'administrative',
          document_type: 'Постанова КМУ',
          document_type_slug: 'postanova-kmu',
          storage_category: null,
        },
        'z1257-07': {
          title: 'Про затвердження Правил роздрібної торгівлі непродовольчими товарами',
          category: 'administrative',
          document_type: 'Наказ',
          document_type_slug: 'nakaz',
          storage_category: null,
        },
        'z0270-10': {
          title: 'Про затвердження Типових правил роботи оптових ринків сільськогосподарської продукції',
          category: 'administrative',
          document_type: 'Наказ',
          document_type_slug: 'nakaz',
          storage_category: null,
        },
      };
      return byNreg[rada_nreg]
        ? {
            rada_nreg,
            ...byNreg[rada_nreg],
            summary: null,
            aliases: [],
            validity_status: 'active',
          }
        : null;
    },
    hydrateSelectedActsMeta: async (acts, confidence) =>
      acts.map((act) => ({
        ...act,
        act_kind: classifyActKind(act.act_title ?? '', act.document_type ?? null, act.category ?? null, null),
        confidence,
      })),
    searchActsForRouting: async () => [],
  });
  if (result.low_confidence_final) {
    throw new Error(`Expected explicit subordinate-act scope to stay confident, got low_confidence=true with ${JSON.stringify(result.reasonCodes)}`);
  }
  if (result.coverageGap !== 'none') {
    throw new Error(`Expected explicit subordinate-act scope to keep coverage_gap=none, got ${result.coverageGap}`);
  }
  if (result.selected_acts_final.length !== 1 || result.selected_acts_final[0]?.rada_nreg !== '1178-2022-п') {
    throw new Error(`Expected subordinate-act scope trim to keep only 1178-2022-п, got ${JSON.stringify(result.selected_acts_final)}`);
  }
  if (result.reasonCodes.includes('NO_PRIMARY_LAW_EVIDENCE') || result.reasonCodes.includes('LOW_EVIDENCE')) {
    throw new Error(`Expected authoritative subordinate-act scope to clear primary-law weak-evidence codes, got ${JSON.stringify(result.reasonCodes)}`);
  }
  console.log('[OK] single-goal finalizer keeps grounded subordinate-act scope without false weak_evidence');
}

async function testResolveSingleGoalSelectedActsClearsOutOfScopeForExactActScope(): Promise<void> {
  const result = await resolveSingleGoalSelectedActs({
    query: '1697-18',
    goalId: 'goal_0',
    finalHits: [
      {
        rada_nreg: '1697-18',
        r2_key: 'r2://1697/1',
        json_path: '$.chunks[0]',
        score: 0.536,
        ordering_score: 0.514,
        title: 'Про прокуратуру',
        article_number: '21',
      },
      {
        rada_nreg: '1697-18',
        r2_key: 'r2://1697/2',
        json_path: '$.chunks[1]',
        score: 0.53,
        ordering_score: 0.49,
        title: 'Про прокуратуру',
        article_number: '44',
      },
    ] as never,
    actCandidatesTopHydrated: [
      {
        rada_nreg: '1697-18',
        title: 'Про прокуратуру',
        score: 0.91,
        category: 'judiciary_justice',
        document_type: 'Закон',
        document_type_slug: 'zakon',
        reasons: ['exact_title_match'],
      },
    ],
    plannerRationaleByNreg: new Map(),
    taxonomyNregs: new Set(['1697-18']),
    actsSearchNregs: ['1697-18'],
    domainHint: 'general',
    documentTypeHints: [],
    taxonomyActCount: 1,
    aliasHitCount: 0,
    exactActHitCount: 1,
    exactActNregs: ['1697-18'],
    groundedActHitCount: 1,
    groundedActNregs: ['1697-18'],
    actSelectionLowConfidence: false,
    reasonCodes: [],
    useLowConfidenceFallback: false,
    queryRewriteMeta: { called: false, used: false, not_used_reason_codes: ['STRONG_TAXONOMY_SIGNAL'] },
    topScore: 0.536,
    avgScore: 0.41,
    categoryHintsCount: 0,
    entitiesCount: 1,
    anchorsCount: 0,
    domainWeak: true,
    precomputedChunksEvidenceTopActs: [
      {
        rada_nreg: '1697-18',
        count_in_top30: 4,
        avg_score_in_top30: 0.52,
        max_score: 0.54,
        best_rank_in_top30: 1,
        rank_mass_top30: 0.94,
        max_ordering_score: 0.514,
      },
    ],
    getActMeta: async (rada_nreg) =>
      rada_nreg === '1697-18'
        ? {
            rada_nreg,
            title: 'Про прокуратуру',
            category: 'judiciary_justice',
            document_type: 'Закон',
            document_type_slug: 'zakon',
            summary: null,
            aliases: [],
            validity_status: 'in_force',
          }
        : null,
    hydrateSelectedActsMeta: async (acts, confidence) =>
      acts.map((act) => ({
        ...act,
        act_kind: classifyActKind(act.act_title ?? '', act.document_type ?? null, act.category ?? null, null),
        confidence,
      })),
    searchActsForRouting: async () => [],
  });
  if (result.low_confidence_final) {
    throw new Error(`Expected exact-act scope to recover from OOD guard, got low_confidence with ${JSON.stringify(result.reasonCodes)}`);
  }
  if (result.coverageGap !== 'none') {
    throw new Error(`Expected exact-act scope to keep coverage_gap=none, got ${result.coverageGap}`);
  }
  if (result.reasonCodes.includes('OUT_OF_SCOPE')) {
    throw new Error(`Expected exact-act scope to clear OUT_OF_SCOPE, got ${JSON.stringify(result.reasonCodes)}`);
  }
  if (result.selected_acts_final[0]?.rada_nreg !== '1697-18') {
    throw new Error(`Expected exact-act scope to keep 1697-18 selected, got ${JSON.stringify(result.selected_acts_final)}`);
  }
  console.log('[OK] single-goal finalizer clears out_of_scope when exact act scope is confirmed');
}

async function testResolveSingleGoalSelectedActsRecoversExplicitIdentifierFromTailEvidence(): Promise<void> {
  const result = await resolveSingleGoalSelectedActs({
    query: '27-2026-р',
    goalId: 'goal_0',
    finalHits: [
      {
        rada_nreg: '43-2026-п',
        r2_key: 'r2://43/1',
        json_path: '$.chunks[0]',
        score: 0.735,
        ordering_score: 0.623,
        title: 'Про внесення змін до постанов Кабінету Міністрів України від 8 липня 2020 р. № 573 і від 15 січня 2026 р. № 39',
        unit_type: 'point',
        unit_number: '2',
      },
      {
        rada_nreg: '950-2007-п',
        r2_key: 'r2://950/1',
        json_path: '$.chunks[1]',
        score: 0.683,
        ordering_score: 0.419,
        title: 'Про затвердження Регламенту Кабінету Міністрів України',
        unit_type: 'point',
        unit_number: '20',
      },
      {
        rada_nreg: '27-2026-р',
        r2_key: 'r2://27/1',
        json_path: '$.chunks[15]',
        score: 0.451,
        ordering_score: 0.294,
        title: 'Про внесення зміни у додаток до розпорядження Кабінету Міністрів України від 29 квітня 2025 р. № 408',
        unit_type: 'point',
        unit_number: '1',
      },
    ] as never,
    actCandidatesTopHydrated: [
      {
        rada_nreg: '27-2026-р',
        title: 'Про внесення зміни у додаток до розпорядження Кабінету Міністрів України від 29 квітня 2025 р. № 408',
        score: 13.1,
        category: 'education_science',
        document_type: 'Розпорядження КМУ',
        document_type_slug: 'cmu_order',
        reasons: ['exact_identifier_match', 'exact_alias_match'],
      },
      {
        rada_nreg: '43-2026-п',
        title: 'Про внесення змін до постанов Кабінету Міністрів України від 8 липня 2020 р. № 573 і від 15 січня 2026 р. № 39',
        score: 2.1,
        category: 'administrative',
        document_type: 'Постанова КМУ',
        document_type_slug: 'cmu_resolution',
      },
    ],
    plannerRationaleByNreg: new Map(),
    taxonomyNregs: new Set(['27-2026-р']),
    actsSearchNregs: [],
    domainHint: 'general',
    documentTypeHints: [],
    taxonomyActCount: 1,
    aliasHitCount: 1,
    exactActHitCount: 1,
    exactActNregs: ['27-2026-р'],
    groundedActHitCount: 1,
    groundedActNregs: ['27-2026-р'],
    actSelectionLowConfidence: false,
    reasonCodes: [],
    useLowConfidenceFallback: false,
    queryRewriteMeta: { called: false, used: false, not_used_reason_codes: ['STRONG_TAXONOMY_SIGNAL'] },
    topScore: 0.735,
    avgScore: 0.61,
    categoryHintsCount: 0,
    entitiesCount: 1,
    anchorsCount: 0,
    domainWeak: false,
    precomputedChunksEvidenceTopActs: [
      {
        rada_nreg: '43-2026-п',
        count_in_top30: 1,
        avg_score_in_top30: 0.735,
        max_score: 0.735,
        best_rank_in_top30: 1,
        rank_mass_top30: 1,
        max_ordering_score: 0.623,
      },
      {
        rada_nreg: '950-2007-п',
        count_in_top30: 8,
        avg_score_in_top30: 0.624,
        max_score: 0.683,
        best_rank_in_top30: 3,
        rank_mass_top30: 1.69,
        max_ordering_score: 0.419,
      },
      {
        rada_nreg: '27-2026-р',
        count_in_top30: 1,
        avg_score_in_top30: 0.451,
        max_score: 0.451,
        best_rank_in_top30: 16,
        rank_mass_top30: 0.0625,
        max_ordering_score: 0.294,
      },
    ],
    getActMeta: async (rada_nreg) =>
      rada_nreg === '27-2026-р'
        ? {
            rada_nreg,
            title: 'Про внесення зміни у додаток до розпорядження Кабінету Міністрів України від 29 квітня 2025 р. № 408',
            summary: null,
            aliases: [],
            category: 'education_science',
            storage_category: null,
            document_type: 'Розпорядження КМУ',
            document_type_slug: 'cmu_order',
            validity_status: 'in_force',
          }
        : null,
    hydrateSelectedActsMeta: async (acts, confidence) =>
      acts.map((act) => ({
        ...act,
        act_kind: classifyActKind(act.act_title ?? '', act.document_type ?? null, act.category ?? null, null),
        confidence,
      })),
    searchActsForRouting: async () => [],
  });
  if (result.low_confidence_final) {
    throw new Error(`Expected exact identifier tail evidence to recover same act, got low_confidence with ${JSON.stringify(result.reasonCodes)}`);
  }
  if (result.coverageGap !== 'none') {
    throw new Error(`Expected exact identifier tail evidence to keep coverage_gap=none, got ${result.coverageGap}`);
  }
  if (result.selected_acts_final.length !== 1 || result.selected_acts_final[0]?.rada_nreg !== '27-2026-р') {
    throw new Error(`Expected exact identifier tail evidence to recover 27-2026-р, got ${JSON.stringify(result.selected_acts_final)}`);
  }
  if (!result.reasonCodes.includes('EXACT_ACT_SCOPE_CONFIRMED')) {
    throw new Error(`Expected EXACT_ACT_SCOPE_CONFIRMED after recovery, got ${JSON.stringify(result.reasonCodes)}`);
  }
  console.log('[OK] single-goal finalizer recovers explicit identifier from same-act tail evidence');
}

async function testResolveSingleGoalSelectedActsRecoversGroundedDescriptiveSubordinateAct(): Promise<void> {
  const result = await resolveSingleGoalSelectedActs({
    query: 'розпорядження про закриття дисциплінарного провадження',
    goalId: 'goal_0',
    finalHits: [
      ...Array.from({ length: 7 }, (_, index) => ({
        rada_nreg: '1697-18',
        r2_key: `r2://1697/${index}`,
        json_path: `$.chunks[${index}]`,
        score: 0.52 - index * 0.01,
        ordering_score: 0.53 - index * 0.01,
        title: 'Про прокуратуру',
        article_number: String(44 + index),
      })),
      ...Array.from({ length: 3 }, (_, index) => ({
        rada_nreg: '4651-17',
        r2_key: `r2://4651/${index}`,
        json_path: `$.chunks[${index}]`,
        score: 0.51 - index * 0.01,
        ordering_score: 0.53 - index * 0.01,
        title: 'Кримінальний процесуальний кодекс України',
        article_number: String(284 + index),
      })),
      ...Array.from({ length: 2 }, (_, index) => ({
        rada_nreg: '2747-15',
        r2_key: `r2://2747/${index}`,
        json_path: `$.chunks[${index}]`,
        score: 0.52 - index * 0.01,
        ordering_score: 0.38 - index * 0.01,
        title: 'Кодекс адміністративного судочинства України',
        article_number: String(238 + index),
      })),
      {
        rada_nreg: '19-2026-р',
        r2_key: 'r2://19/1',
        json_path: '$.chunks[12]',
        score: 0.6021546,
        ordering_score: 0.359948024,
        title: 'Про закриття дисциплінарного провадження',
        unit_type: 'paragraph',
        unit_number: '1',
      },
    ] as never,
    actCandidatesTopHydrated: [
      {
        rada_nreg: '19-2026-р',
        title: 'Про закриття дисциплінарного провадження',
        score: 44.637206405166275,
        category: 'administrative',
        document_type: 'Розпорядження КМУ',
        document_type_slug: 'cmu_order',
        reasons: ['exact_alias_match', 'alias_match', 'title_match'],
      },
      {
        rada_nreg: '1697-18',
        title: 'Про прокуратуру',
        score: 0,
        category: 'judiciary_justice',
        document_type: 'Закон',
        document_type_slug: 'zakon',
      },
      {
        rada_nreg: '4651-17',
        title: 'Кримінальний процесуальний кодекс України',
        score: 0,
        category: 'criminal_procedure',
        document_type: 'Кодекс',
        document_type_slug: 'code',
      },
      {
        rada_nreg: '2747-15',
        title: 'Кодекс адміністративного судочинства України',
        score: 0,
        category: 'administrative',
        document_type: 'Кодекс',
        document_type_slug: 'code',
      },
    ],
    plannerRationaleByNreg: new Map(),
    taxonomyNregs: new Set(['19-2026-р', '15-2026-р', '18-2026-р']),
    actsSearchNregs: [],
    domainHint: 'general',
    documentTypeHints: ['Розпорядження КМУ'],
    taxonomyActCount: 3,
    aliasHitCount: 1,
    exactActHitCount: 0,
    exactActNregs: [],
    groundedActHitCount: 1,
    groundedActNregs: ['19-2026-р'],
    actSelectionLowConfidence: false,
    reasonCodes: [],
    useLowConfidenceFallback: false,
    queryRewriteMeta: { called: false, used: false, not_used_reason_codes: ['STRONG_TAXONOMY_SIGNAL'] },
    topScore: 0.6021546,
    avgScore: 0.426,
    categoryHintsCount: 0,
    entitiesCount: 1,
    anchorsCount: 2,
    domainWeak: true,
    precomputedChunksEvidenceTopActs: [
      {
        rada_nreg: '1697-18',
        count_in_top30: 13,
        avg_score_in_top30: 0.4495,
        max_score: 0.5186,
        best_rank_in_top30: 1,
        rank_mass_top30: 2.49,
        max_ordering_score: 0.5326,
      },
      {
        rada_nreg: '4651-17',
        count_in_top30: 6,
        avg_score_in_top30: 0.4503,
        max_score: 0.5112,
        best_rank_in_top30: 2,
        rank_mass_top30: 0.73,
        max_ordering_score: 0.5297,
      },
      {
        rada_nreg: '2747-15',
        count_in_top30: 8,
        avg_score_in_top30: 0.4615,
        max_score: 0.5378,
        best_rank_in_top30: 11,
        rank_mass_top30: 0.48,
        max_ordering_score: 0.3856,
      },
      {
        rada_nreg: '19-2026-р',
        count_in_top30: 1,
        avg_score_in_top30: 0.6021546,
        max_score: 0.6021546,
        best_rank_in_top30: 13,
        rank_mass_top30: 0.0769,
        max_ordering_score: 0.359948024,
      },
    ],
    getActMeta: async (rada_nreg) => {
      const byNreg: Record<string, { title: string; category: string; document_type: string; document_type_slug: string; storage_category: string | null }> = {
        '19-2026-р': {
          title: 'Про закриття дисциплінарного провадження',
          category: 'administrative',
          document_type: 'Розпорядження КМУ',
          document_type_slug: 'cmu_order',
          storage_category: null,
        },
        '1697-18': {
          title: 'Про прокуратуру',
          category: 'judiciary_justice',
          document_type: 'Закон',
          document_type_slug: 'zakon',
          storage_category: null,
        },
        '4651-17': {
          title: 'Кримінальний процесуальний кодекс України',
          category: 'criminal_procedure',
          document_type: 'Кодекс',
          document_type_slug: 'code',
          storage_category: null,
        },
        '2747-15': {
          title: 'Кодекс адміністративного судочинства України',
          category: 'administrative',
          document_type: 'Кодекс',
          document_type_slug: 'code',
          storage_category: null,
        },
      };
      return byNreg[rada_nreg]
        ? {
            rada_nreg,
            ...byNreg[rada_nreg],
            summary: null,
            aliases: [],
            validity_status: 'in_force',
          }
        : null;
    },
    hydrateSelectedActsMeta: async (acts, confidence) =>
      acts.map((act) => ({
        ...act,
        act_kind: classifyActKind(act.act_title ?? '', act.document_type ?? null, act.category ?? null, act.document_type_slug ?? null),
        confidence,
      })),
    searchActsForRouting: async () => [],
  });
  if (result.low_confidence_final) {
    throw new Error(`Expected grounded descriptive subordinate-act query to recover confidently, got low_confidence with ${JSON.stringify(result.reasonCodes)}`);
  }
  if (result.coverageGap !== 'none') {
    throw new Error(`Expected grounded descriptive subordinate-act query to keep coverage_gap=none, got ${result.coverageGap}`);
  }
  if (result.selected_acts_final.length !== 1 || result.selected_acts_final[0]?.rada_nreg !== '19-2026-р') {
    throw new Error(`Expected grounded descriptive subordinate-act query to recover 19-2026-р, got ${JSON.stringify(result.selected_acts_final)}`);
  }
  if (!result.reasonCodes.includes('GROUNDED_ACT_SCOPE_RECOVERED') || !result.reasonCodes.includes('GROUNDED_ACT_SCOPE_CONFIRMED')) {
    throw new Error(`Expected grounded descriptive subordinate-act recovery reason codes, got ${JSON.stringify(result.reasonCodes)}`);
  }
  console.log('[OK] single-goal finalizer recovers grounded descriptive subordinate-act titles from noisy primary-law heads');
}

async function testResolveSingleGoalSelectedActsRecoversMetadataGroundedExplicitSubordinateAct(): Promise<void> {
  const result = await resolveSingleGoalSelectedActs({
    query: 'Що регулює Наказ про скасування Правил торгівлі транспортними засобами?',
    goalId: 'goal_1',
    finalHits: [
      ...Array.from({ length: 9 }, (_, index) => ({
        rada_nreg: '80731-10',
        r2_key: `r2://80731/${index}`,
        json_path: `$.chunks[${index}]`,
        score: 0.67 - index * 0.01,
        ordering_score: 0.568 - index * 0.004,
        title: 'Кодекс України про адміністративні правопорушення',
        article_number: String(110 + index),
      })),
      {
        rada_nreg: 'z0147-10',
        r2_key: 'r2://z0147/4',
        json_path: '$.chunks[3]',
        score: 0.644,
        ordering_score: 0.54,
        title: 'Про визнання таким, що втратив чинність, наказу від 31.07.2002 N 228',
        unit_type: 'point',
        unit_number: '4',
      },
      {
        rada_nreg: 'z1257-07',
        r2_key: 'r2://z1257/1',
        json_path: '$.chunks[0]',
        score: 0.551,
        ordering_score: 0.498,
        title: 'Про затвердження Правил роздрібної торгівлі непродовольчими товарами',
        unit_type: 'point',
        unit_number: '1',
      },
      {
        rada_nreg: '435-15',
        r2_key: 'r2://435/977',
        json_path: '$.chunks[977]',
        score: 0.635,
        ordering_score: 0.485,
        title: 'Цивільний кодекс України',
        article_number: '977',
      },
    ] as never,
    actCandidatesTopHydrated: [
      {
        rada_nreg: 'z0147-10',
        title: 'Про визнання таким, що втратив чинність, наказу від 31.07.2002 N 228',
        score: 18.5,
        category: 'business_corporate',
        document_type: 'Наказ',
        document_type_slug: 'order',
        reasons: ['exact_title_match', 'title_match', 'alias_match'],
      },
      {
        rada_nreg: 'z1257-07',
        title: 'Про затвердження Правил роздрібної торгівлі непродовольчими товарами',
        score: 15.8,
        category: 'business_corporate',
        document_type: 'Наказ',
        document_type_slug: 'order',
      },
      {
        rada_nreg: '80731-10',
        title: 'Кодекс України про адміністративні правопорушення',
        score: 2.1,
        category: 'administrative_offenses',
        document_type: 'Кодекс',
        document_type_slug: 'code',
      },
      {
        rada_nreg: '435-15',
        title: 'Цивільний кодекс України',
        score: 1.4,
        category: 'civil',
        document_type: 'Кодекс',
        document_type_slug: 'code',
      },
    ],
    plannerRationaleByNreg: new Map(),
    taxonomyNregs: new Set(['z0147-10', 'z1257-07']),
    actsSearchNregs: [],
    domainHint: 'administrative',
    documentTypeHints: ['Наказ'],
    taxonomyActCount: 2,
    aliasHitCount: 1,
    exactActHitCount: 0,
    exactActNregs: [],
    groundedActHitCount: 0,
    groundedActNregs: [],
    actSelectionLowConfidence: false,
    reasonCodes: [],
    useLowConfidenceFallback: false,
    queryRewriteMeta: { called: false, used: false, not_used_reason_codes: ['STRONG_TAXONOMY_SIGNAL'] },
    topScore: 0.7258294,
    avgScore: 0.55,
    categoryHintsCount: 1,
    entitiesCount: 1,
    anchorsCount: 1,
    domainWeak: false,
    precomputedChunksEvidenceTopActs: [
      {
        rada_nreg: '80731-10',
        count_in_top30: 13,
        avg_score_in_top30: 0.62,
        max_score: 0.67,
        best_rank_in_top30: 1,
        rank_mass_top30: 2.9,
        max_ordering_score: 0.568,
      },
      {
        rada_nreg: 'z1257-07',
        count_in_top30: 7,
        avg_score_in_top30: 0.55,
        max_score: 0.551,
        best_rank_in_top30: 11,
        rank_mass_top30: 0.67,
        max_ordering_score: 0.498,
      },
      {
        rada_nreg: '435-15',
        count_in_top30: 2,
        avg_score_in_top30: 0.63,
        max_score: 0.635,
        best_rank_in_top30: 12,
        rank_mass_top30: 0.17,
        max_ordering_score: 0.485,
      },
      {
        rada_nreg: 'z0147-10',
        count_in_top30: 2,
        avg_score_in_top30: 0.612,
        max_score: 0.644,
        best_rank_in_top30: 10,
        rank_mass_top30: 0.21,
        max_ordering_score: 0.54,
      },
    ],
    getActMeta: async (rada_nreg) => {
      const byNreg: Record<string, { title: string; category: string; document_type: string; document_type_slug: string; storage_category: string | null }> = {
        'z0147-10': {
          title: 'Про визнання таким, що втратив чинність, наказу від 31.07.2002 N 228',
          category: 'business_corporate',
          document_type: 'Наказ',
          document_type_slug: 'order',
          storage_category: null,
        },
        'z1257-07': {
          title: 'Про затвердження Правил роздрібної торгівлі непродовольчими товарами',
          category: 'business_corporate',
          document_type: 'Наказ',
          document_type_slug: 'order',
          storage_category: null,
        },
        '80731-10': {
          title: 'Кодекс України про адміністративні правопорушення',
          category: 'administrative_offenses',
          document_type: 'Кодекс',
          document_type_slug: 'code',
          storage_category: null,
        },
        '435-15': {
          title: 'Цивільний кодекс України',
          category: 'civil',
          document_type: 'Кодекс',
          document_type_slug: 'code',
          storage_category: null,
        },
      };
      return byNreg[rada_nreg]
        ? {
            rada_nreg,
            ...byNreg[rada_nreg],
            summary: null,
            aliases: [],
            validity_status: 'in_force',
          }
        : null;
    },
    hydrateSelectedActsMeta: async (acts, confidence) =>
      acts.map((act) => ({
        ...act,
        act_kind: classifyActKind(act.act_title ?? '', act.document_type ?? null, act.category ?? null, act.document_type_slug ?? null),
        confidence,
      })),
    searchActsForRouting: async () => [],
  });
  if (result.low_confidence_final) {
    throw new Error(`Expected metadata-grounded explicit subordinate-act query to recover confidently, got low_confidence with ${JSON.stringify(result.reasonCodes)}`);
  }
  if (result.coverageGap !== 'none') {
    throw new Error(`Expected metadata-grounded explicit subordinate-act query to keep coverage_gap=none, got ${result.coverageGap}`);
  }
  if (result.selected_acts_final.length !== 1 || result.selected_acts_final[0]?.rada_nreg !== 'z0147-10') {
    throw new Error(`Expected metadata-grounded explicit subordinate-act query to recover z0147-10, got ${JSON.stringify(result.selected_acts_final)}`);
  }
  if (!result.reasonCodes.includes('METADATA_ACT_SCOPE_RECOVERED') || !result.reasonCodes.includes('METADATA_ACT_SCOPE_CONFIRMED')) {
    throw new Error(`Expected metadata-grounded explicit subordinate-act recovery reason codes, got ${JSON.stringify(result.reasonCodes)}`);
  }
  console.log('[OK] single-goal finalizer recovers metadata-grounded explicit subordinate-act titles from noisy primary-law heads');
}

async function testResolveSingleGoalSelectedActsKeepsGroundedSubordinateActAsWeakEvidenceWhenChunksMiss(): Promise<void> {
  const result = await resolveSingleGoalSelectedActs({
    query: 'розпорядження про втрату чинності № 1478',
    goalId: 'goal_1',
    finalHits: [
      {
        rada_nreg: '1898-2010-р',
        r2_key: 'r2://1898/3',
        json_path: '$.chunks[2]',
        score: 0.713,
        ordering_score: 0.688,
        title: 'Про визнання такими, що втратили чинність, деяких розпоряджень Кабінету Міністрів України',
        unit_type: 'point',
        unit_number: '3',
      },
      {
        rada_nreg: '1898-2010-р',
        r2_key: 'r2://1898/4',
        json_path: '$.chunks[3]',
        score: 0.707,
        ordering_score: 0.685,
        title: 'Про визнання такими, що втратили чинність, деяких розпоряджень Кабінету Міністрів України',
        unit_type: 'point',
        unit_number: '4',
      },
      {
        rada_nreg: 'z0147-10',
        r2_key: 'r2://z0147/2',
        json_path: '$.chunks[1]',
        score: 0.644,
        ordering_score: 0.573,
        title: 'Про визнання таким, що втратив чинність, наказу від 31.07.2002 N 228',
        unit_type: 'point',
        unit_number: '2',
      },
      {
        rada_nreg: '22-2026-п',
        r2_key: 'r2://22-2026/2',
        json_path: '$.chunks[1]',
        score: 0.639,
        ordering_score: 0.66,
        title: 'Про внесення змін до постанов Кабінету Міністрів України від 3 листопада 2023 р. № 1150 і від 28 червня 2024 р. № 764 та визнання такими, що втратили чинність, постанов Кабінету Міністрів України від 28 квітня 2023 р. № 417 і від 5 грудня 2023 р. № 1276',
        unit_type: 'point',
        unit_number: '2',
      },
    ] as never,
    actCandidatesTopHydrated: [
      {
        rada_nreg: '3-2026-р',
        title: 'Про визнання таким, що втратило чинність, розпорядження Кабінету Міністрів України від 24 грудня 2025 р. № 1478',
        score: 18.2,
        category: 'administrative',
        document_type: 'Розпорядження КМУ',
        document_type_slug: 'order',
        reasons: ['exact_alias_match', 'title_match', 'grounded_act_scope'],
      },
      {
        rada_nreg: '15-2026-р',
        title: 'Про інше розпорядження Кабінету Міністрів України',
        score: 15.9,
        category: 'administrative',
        document_type: 'Розпорядження КМУ',
        document_type_slug: 'order',
        reasons: ['title_match'],
      },
      {
        rada_nreg: '1898-2010-р',
        title: 'Про визнання такими, що втратили чинність, деяких розпоряджень Кабінету Міністрів України',
        score: 13.5,
        category: 'administrative',
        document_type: 'Розпорядження КМУ',
        document_type_slug: 'order',
      },
    ],
    plannerRationaleByNreg: new Map(),
    taxonomyNregs: new Set(['3-2026-р']),
    actsSearchNregs: [],
    domainHint: 'administrative',
    documentTypeHints: ['Розпорядження КМУ'],
    taxonomyActCount: 1,
    aliasHitCount: 1,
    exactActHitCount: 0,
    exactActNregs: [],
    groundedActHitCount: 1,
    groundedActNregs: ['3-2026-р'],
    actSelectionLowConfidence: true,
    reasonCodes: [],
    useLowConfidenceFallback: false,
    queryRewriteMeta: { called: false, used: false, not_used_reason_codes: ['STRONG_TAXONOMY_SIGNAL'] },
    topScore: 0.7131011,
    avgScore: 0.64,
    categoryHintsCount: 1,
    entitiesCount: 1,
    anchorsCount: 1,
    domainWeak: false,
    precomputedChunksEvidenceTopActs: [
      {
        rada_nreg: '1898-2010-р',
        count_in_top30: 5,
        avg_score_in_top30: 0.703,
        max_score: 0.713,
        best_rank_in_top30: 1,
        rank_mass_top30: 1.2,
        max_ordering_score: 0.688,
      },
      {
        rada_nreg: 'z0147-10',
        count_in_top30: 4,
        avg_score_in_top30: 0.612,
        max_score: 0.644,
        best_rank_in_top30: 7,
        rank_mass_top30: 0.44,
        max_ordering_score: 0.573,
      },
    ],
    getActMeta: async (rada_nreg) => {
      const byNreg: Record<string, { title: string; category: string; document_type: string; document_type_slug: string; storage_category: string | null }> = {
        '3-2026-р': {
          title: 'Про визнання таким, що втратило чинність, розпорядження Кабінету Міністрів України від 24 грудня 2025 р. № 1478',
          category: 'administrative',
          document_type: 'Розпорядження КМУ',
          document_type_slug: 'order',
          storage_category: null,
        },
        '1898-2010-р': {
          title: 'Про визнання такими, що втратили чинність, деяких розпоряджень Кабінету Міністрів України',
          category: 'administrative',
          document_type: 'Розпорядження КМУ',
          document_type_slug: 'order',
          storage_category: null,
        },
        '15-2026-р': {
          title: 'Про інше розпорядження Кабінету Міністрів України',
          category: 'administrative',
          document_type: 'Розпорядження КМУ',
          document_type_slug: 'order',
          storage_category: null,
        },
      };
      return byNreg[rada_nreg]
        ? {
            rada_nreg,
            ...byNreg[rada_nreg],
            summary: null,
            aliases: [],
            validity_status: 'in_force',
          }
        : null;
    },
    hydrateSelectedActsMeta: async (acts, confidence) =>
      acts.map((act) => ({
        ...act,
        act_kind: classifyActKind(act.act_title ?? '', act.document_type ?? null, act.category ?? null, act.document_type_slug ?? null),
        confidence,
      })),
    searchActsForRouting: async () => [],
  });
  if (result.low_confidence_final) {
    throw new Error('Expected grounded subordinate act recovery to resolve confidently once scope is recovered');
  }
  if (result.coverageGap !== 'none') {
    throw new Error(`Expected grounded subordinate act recovery to keep coverage_gap=none, got ${result.coverageGap}`);
  }
  if (result.selected_acts_final.length !== 1 || result.selected_acts_final[0]?.rada_nreg !== '3-2026-р') {
    throw new Error(`Expected taxonomy-only grounded subordinate recovery to keep 3-2026-р, got ${JSON.stringify(result.selected_acts_final)}`);
  }
  if (!result.reasonCodes.includes('GROUNDED_ACT_SCOPE_RECOVERED')) {
    throw new Error(`Expected grounded act scope recovery reason code, got ${JSON.stringify(result.reasonCodes)}`);
  }
  if (result.reasonCodes.includes('GROUNDED_ACT_SCOPE_NO_CONVERGENCE')) {
    throw new Error(`Expected taxonomy recovery to avoid false missing-act signal, got ${JSON.stringify(result.reasonCodes)}`);
  }
  console.log('[OK] single-goal finalizer turns grounded subordinate-act taxonomy recovery into confident scope resolution');
}

function testCoverageGapUsesSpecificDomainHintForLikelyMissingAct(): void {
  const coverageGap = deriveCoverageGap({
    lowConfidence: true,
    reasonCodes: ['LOW_EVIDENCE', 'NON_PRIMARY_ONLY_WEAK_CONFIDENCE'],
    selectedActsCount: 1,
    selectedActsConfidence: 0.41,
    selectedActKinds: ['SECONDARY_ORDER'],
    hitsCount: 6,
    topScore: 0.31,
    domainHint: 'intellectual_property',
    categoryHintCount: 0,
    documentTypeHintCount: 0,
    entitiesCount: 0,
    anchorsCount: 0,
  });
  if (coverageGap !== 'likely_missing_act') {
    throw new Error(`Expected specific-domain low-confidence non-primary-only run to map to likely_missing_act, got ${coverageGap}`);
  }
  console.log('[OK] coverage-gap promotes legally specific weak runs to likely_missing_act');
}

function testCoverageGapUsesMissingTaxonomyConvergenceForLikelyMissingAct(): void {
  const coverageGap = deriveCoverageGap({
    lowConfidence: true,
    reasonCodes: ['MISSING_TAXONOMY_CONVERGENCE', 'NO_STRONG_ACT_EVIDENCE'],
    selectedActsCount: 2,
    selectedActsConfidence: 0.49,
    selectedActKinds: ['PRIMARY_LAW', 'PRIMARY_LAW'],
    hitsCount: 8,
    topScore: 0.58,
    domainHint: 'general',
    categoryHintCount: 0,
    documentTypeHintCount: 1,
    entitiesCount: 0,
    anchorsCount: 0,
  });
  if (coverageGap !== 'likely_missing_act') {
    throw new Error(`Expected missing-taxonomy convergence to map to likely_missing_act, got ${coverageGap}`);
  }
  console.log('[OK] coverage-gap promotes missing-taxonomy convergence to likely_missing_act');
}

function testCoverageGapUsesFamilyGuardNoEvidenceForLikelyMissingAct(): void {
  const coverageGap = deriveCoverageGap({
    lowConfidence: true,
    reasonCodes: ['FAMILY_GUARD_NO_EVIDENCE', 'ACT_SELECTION_LOW_CONFIDENCE'],
    selectedActsCount: 2,
    selectedActsConfidence: 0.48,
    selectedActKinds: ['PRIMARY_LAW', 'PRIMARY_LAW'],
    hitsCount: 11,
    topScore: 0.63,
    domainHint: 'general',
    categoryHintCount: 0,
    documentTypeHintCount: 1,
    entitiesCount: 0,
    anchorsCount: 0,
  });
  if (coverageGap !== 'likely_missing_act') {
    throw new Error(`Expected family-guard no-evidence to map to likely_missing_act, got ${coverageGap}`);
  }
  console.log('[OK] coverage-gap promotes family-guard no-evidence to likely_missing_act');
}

function testCoverageGapUsesExplicitActScopeNoConvergenceForWeakEvidenceWhenActIsGrounded(): void {
  const coverageGap = deriveCoverageGap({
    lowConfidence: true,
    reasonCodes: ['EXPLICIT_ACT_SCOPE_NO_CONVERGENCE', 'NO_STRONG_ACT_EVIDENCE'],
    selectedActsCount: 1,
    selectedActsConfidence: 0.51,
    selectedActKinds: ['PRIMARY_LAW'],
    exactActHitCount: 1,
    hitsCount: 14,
    topScore: 0.61,
    domainHint: 'general',
    categoryHintCount: 0,
    documentTypeHintCount: 1,
    entitiesCount: 0,
    anchorsCount: 0,
  });
  if (coverageGap !== 'weak_evidence') {
    throw new Error(`Expected explicit-act-scope no-convergence with grounded act to map to weak_evidence, got ${coverageGap}`);
  }
  console.log('[OK] coverage-gap keeps explicit-act-scope no-convergence as weak_evidence when the act is already grounded');
}

function testCoverageGapUsesProceduralOnlyMixedGoalFallbackForLikelyMissingAct(): void {
  const coverageGap = deriveCoverageGap({
    lowConfidence: true,
    reasonCodes: ['COVERAGE_MISS_SELECTED_ACTS', 'MULTI_GOAL_PROCEDURAL_SINGLE_ACT_BLOCKED', 'LOW_EVIDENCE'],
    selectedActsCount: 1,
    selectedActsConfidence: 0.5,
    selectedActKinds: ['PRIMARY_LAW'],
    mixedProcedureAndNonProcedureGoals: true,
    proceduralOnlySelection: true,
    hitsCount: 24,
    topScore: 0.66,
    domainHint: 'general',
    categoryHintCount: 1,
    documentTypeHintCount: 0,
    entitiesCount: 1,
    anchorsCount: 0,
  });
  if (coverageGap !== 'likely_missing_act') {
    throw new Error(`Expected mixed-goal procedural fallback to map to likely_missing_act, got ${coverageGap}`);
  }
  console.log('[OK] coverage-gap promotes mixed-goal procedural fallback to likely_missing_act');
}

function testCoverageGapUsesGroundedActScopeNoConvergenceForWeakEvidenceWhenActIsGrounded(): void {
  const coverageGap = deriveCoverageGap({
    lowConfidence: true,
    reasonCodes: ['GROUNDED_ACT_SCOPE_NO_CONVERGENCE', 'NO_STRONG_ACT_EVIDENCE'],
    selectedActsCount: 0,
    selectedActsConfidence: 0.4,
    groundedActHitCount: 1,
    hitsCount: 20,
    topScore: 0.58,
    domainHint: 'general',
    categoryHintCount: 0,
    documentTypeHintCount: 1,
    entitiesCount: 0,
    anchorsCount: 0,
  });
  if (coverageGap !== 'weak_evidence') {
    throw new Error(`Expected grounded-act-scope no-convergence with grounded act to map to weak_evidence, got ${coverageGap}`);
  }
  console.log('[OK] coverage-gap keeps grounded-act-scope no-convergence as weak_evidence when the act is already grounded');
}

function testCoverageGapUsesMetadataActScopeNoConvergenceForWeakEvidenceWhenActIsGrounded(): void {
  const coverageGap = deriveCoverageGap({
    lowConfidence: true,
    reasonCodes: ['METADATA_ACT_SCOPE_NO_CONVERGENCE', 'NO_STRONG_ACT_EVIDENCE'],
    selectedActsCount: 0,
    selectedActsConfidence: 0.42,
    metadataGroundedActCount: 1,
    hitsCount: 18,
    topScore: 0.57,
    domainHint: 'general',
    categoryHintCount: 0,
    documentTypeHintCount: 1,
    entitiesCount: 0,
    anchorsCount: 0,
  });
  if (coverageGap !== 'weak_evidence') {
    throw new Error(`Expected metadata-act-scope no-convergence with grounded act to map to weak_evidence, got ${coverageGap}`);
  }
  console.log('[OK] coverage-gap keeps metadata-act-scope no-convergence as weak_evidence when the act is already grounded');
}

function testCoverageGapUsesProceduralPrimaryWithoutActGroundingForLikelyMissingAct(): void {
  const coverageGap = deriveCoverageGap({
    lowConfidence: true,
    reasonCodes: ['NO_ACT_GROUNDING_PROCEDURAL_PRIMARY_ONLY', 'NO_STRONG_ACT_EVIDENCE'],
    selectedActsCount: 1,
    selectedActsConfidence: 0.84,
    selectedActKinds: ['PRIMARY_LAW'],
    hitsCount: 12,
    topScore: 0.61,
    domainHint: 'administrative',
    categoryHintCount: 1,
    documentTypeHintCount: 0,
    entitiesCount: 1,
    anchorsCount: 0,
  });
  if (coverageGap !== 'likely_missing_act') {
    throw new Error(`Expected procedural-primary-only ungrounded path to map to likely_missing_act, got ${coverageGap}`);
  }
  console.log('[OK] coverage-gap promotes procedural-primary-only ungrounded path to likely_missing_act');
}

function testDeriveTopScoreFromHitsUsesPostprocessedHits(): void {
  const topScore = deriveTopScoreFromHits([
    {
      rada_nreg: '322-08',
      r2_key: 'r2://a',
      json_path: '$.content.chunks[0].text',
      score: 0.49,
      ordering_score: 0.52,
      source: 'lldbi_chunks',
    },
    {
      rada_nreg: '322-08',
      r2_key: 'r2://b',
      json_path: '$.content.chunks[1].text',
      score: 0.67,
      ordering_score: 0.7,
      source: 'lldbi_chunks',
    },
  ]);
  if (topScore !== 0.67) {
    throw new Error(`Expected postprocessed topScore 0.67, got ${topScore}`);
  }
  if (deriveTopScoreFromHits([]) !== null) {
    throw new Error('Expected empty postprocessed hits to produce null topScore');
  }
  console.log('[OK] single-goal postprocess recomputes topScore from final hits');
}

function testNormalizeFinalReasonCodesDropsRecoveredWeakSignals(): void {
  const finalReasonCodes = normalizeFinalReasonCodes(
    [
      'LOW_EVIDENCE',
      'ACT_SELECTION_LOW_CONFIDENCE',
      'ROUTING_HINTS_LOW_CONF',
      'FINALIZER_DROPPED_ROUTING_ADD',
      'FAMILY_GUARD_NO_EVIDENCE',
    ],
    false
  );
  if (finalReasonCodes.includes('LOW_EVIDENCE')) {
    throw new Error(`Expected LOW_EVIDENCE to be dropped after recovery, got ${JSON.stringify(finalReasonCodes)}`);
  }
  if (finalReasonCodes.includes('ACT_SELECTION_LOW_CONFIDENCE')) {
    throw new Error(
      `Expected ACT_SELECTION_LOW_CONFIDENCE to be dropped after recovery, got ${JSON.stringify(finalReasonCodes)}`
    );
  }
  if (finalReasonCodes.includes('ROUTING_HINTS_LOW_CONF')) {
    throw new Error(
      `Expected ROUTING_HINTS_LOW_CONF to be dropped after recovery, got ${JSON.stringify(finalReasonCodes)}`
    );
  }
  if (!finalReasonCodes.includes('FINALIZER_DROPPED_ROUTING_ADD')) {
    throw new Error(`Expected forensic non-confidence code to be preserved, got ${JSON.stringify(finalReasonCodes)}`);
  }
  if (!finalReasonCodes.includes('FAMILY_GUARD_NO_EVIDENCE')) {
    throw new Error(`Expected generic forensic reason code to be preserved, got ${JSON.stringify(finalReasonCodes)}`);
  }
  console.log('[OK] final reason code normalization drops stale low-confidence signals after recovery');
}

function testCoverageGuardRecoveryRequiresActGrounding(): void {
  const relaxedWithoutGrounding = canRelaxCoverageGuardWithActGrounding({
    selectedActsReasonCodes: ['COVERAGE_GUARD_FAILED'],
    familyReasonCodes: ['FAMILY_DOMINANT_OK'],
    qrSignaledOod: false,
    exactActHitCount: 0,
    groundedActHitCount: 0,
    metadataGroundedSelectedActsCount: 0,
  });
  if (relaxedWithoutGrounding) {
    throw new Error('Expected coverage-guard recovery to stay blocked without act-level grounding');
  }
  const relaxedWithGrounding = canRelaxCoverageGuardWithActGrounding({
    selectedActsReasonCodes: ['COVERAGE_GUARD_FAILED'],
    familyReasonCodes: ['FAMILY_DOMINANT_OK'],
    qrSignaledOod: false,
    exactActHitCount: 0,
    groundedActHitCount: 1,
    metadataGroundedSelectedActsCount: 0,
  });
  if (!relaxedWithGrounding) {
    throw new Error('Expected grounded act evidence to allow coverage-guard relaxation');
  }
  console.log('[OK] coverage-guard relaxation requires real act grounding');
}

function testStickySingleGoalLowConfidenceReasonsBlockRecovery(): void {
  if (!hasStickySingleGoalLowConfidenceReason(['FAMILY_GUARD_NO_EVIDENCE'])) {
    throw new Error('Expected family-guard no-evidence to remain sticky');
  }
  if (hasStickySingleGoalLowConfidenceReason(['FINALIZER_DROPPED_ROUTING_ADD'])) {
    throw new Error('Did not expect non-confidence forensic code to become sticky');
  }
  console.log('[OK] sticky single-goal low-confidence reasons preserve missing-act honesty');
}

function testProceduralPrimaryWithoutGroundingRequiresActSignals(): void {
  const shouldFlag = shouldFlagProceduralPrimaryWithoutActGrounding({
    proceduralOnlyPrimarySelection: true,
    explicitActScopeCue: true,
    structuredActIdentifiersCount: 0,
    documentTypeHintsCount: 1,
    anchorsCount: 0,
    exactActHitCount: 0,
    groundedActHitCount: 0,
    metadataGroundedPrimaryActsCount: 0,
    leadSelectedMetadataGrounded: false,
  });
  if (!shouldFlag) {
    throw new Error('Expected explicit act-scoped procedural selection without grounding to be low confidence');
  }
  const shouldNotFlagGenericProcedure = shouldFlagProceduralPrimaryWithoutActGrounding({
    proceduralOnlyPrimarySelection: true,
    explicitActScopeCue: false,
    structuredActIdentifiersCount: 0,
    documentTypeHintsCount: 0,
    anchorsCount: 0,
    exactActHitCount: 0,
    groundedActHitCount: 0,
    metadataGroundedPrimaryActsCount: 0,
    leadSelectedMetadataGrounded: false,
  });
  if (shouldNotFlagGenericProcedure) {
    throw new Error('Expected generic procedural-code query without act-scope signals to remain eligible for grounded success');
  }
  console.log('[OK] procedural-primary honesty guard only fires when act-level grounding is expected');
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

function testBuildTaxonomyQuerySignalsKeepsShortDiscriminativePhrases(): void {
  const signals = buildTaxonomyQuerySignals('Які правила азс діють для роздрібної торгівлі пальним?');
  if (!signals.phrases.includes('правила азс')) {
    throw new Error(`Expected short discriminative phrase to survive taxonomy signal build, got ${JSON.stringify(signals.phrases)}`);
  }
  console.log('[OK] buildTaxonomyQuerySignals keeps short discriminative legal phrases');
}

function testBuildTaxonomyQuerySignalsPreservesStructuredActIdentifiers(): void {
  const signals = buildTaxonomyQuerySignals('Які вимоги встановлює акт 1150-98-п і що змінює v0003359-26?');
  if (!signals.tokens.includes('1150-98-п')) {
    throw new Error(`Expected structured nreg token to survive query-signal build, got ${JSON.stringify(signals.tokens)}`);
  }
  if (!signals.phrases.includes('v0003359-26')) {
    throw new Error(`Expected structured act id phrase to survive query-signal build, got ${JSON.stringify(signals.phrases)}`);
  }
  console.log('[OK] buildTaxonomyQuerySignals preserves structured act identifiers');
}

function testExtractActReferenceSignalsCapturesExplicitDocumentTitles(): void {
  const signals = extractActReferenceSignals('Що регулює Указ про призначення Кубраков?');
  if (!signals.some((signal) => signal.toLowerCase().includes('указ про призначення кубраков'))) {
    throw new Error(`Expected explicit document-title signal for decree query, got ${JSON.stringify(signals)}`);
  }
  console.log('[OK] act-reference signal extraction captures explicit title-heavy act references');
}

function testEntityExtractorCapturesExplicitDecreeTitleAsLawTitle(): void {
  const { entities } = extractEntities('Що регулює Указ про призначення Кубраков?');
  const lawTitles = entities.filter((entity) => entity.type === 'law_title').map((entity) => entity.value);
  if (!lawTitles.some((value) => value.toLowerCase().includes('указ про призначення кубраков'))) {
    throw new Error(`Expected law_title entity for explicit decree title query, got ${JSON.stringify(entities)}`);
  }
  console.log('[OK] entity extractor captures explicit decree titles as law_title');
}

function testExtractStructuredActIdentifiersIgnoresDates(): void {
  const ids = extractStructuredActIdentifiers('Чи діяв акт 115/2015 станом на 12/05/2024 і що змінює 2811-20?');
  if (!ids.includes('115/2015') || !ids.includes('2811-20')) {
    throw new Error(`Expected structured act identifiers to be extracted, got ${JSON.stringify(ids)}`);
  }
  if (ids.includes('12/05/2024')) {
    throw new Error(`Expected date-like token to be ignored, got ${JSON.stringify(ids)}`);
  }
  console.log('[OK] extractStructuredActIdentifiers keeps act ids and ignores date-like strings');
}

function testExtractCuedNumericActReferencesCapturesBareNumberWithCue(): void {
  const refs = extractCuedNumericActReferences(
    'Що за постановою КМУ №1178 подає учасник у складі пропозиції на закупівлю та чи потрібен наказ Мінфіну №45?'
  );
  if (!refs.some((ref) => ref.cue === 'постанова' && ref.numericStem === '1178')) {
    throw new Error(`Expected постанова №1178 to be extracted as a cued numeric act reference, got ${JSON.stringify(refs)}`);
  }
  if (!refs.some((ref) => ref.cue === 'наказ' && ref.numericStem === '45')) {
    throw new Error(`Expected наказ №45 to be extracted as a cued numeric act reference, got ${JSON.stringify(refs)}`);
  }
  console.log('[OK] extractCuedNumericActReferences captures bare act numbers with document-type cues');
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
      { rada_nreg: '4651-17', count_in_top30: 1, avg_score_in_top30: 0.33, max_score: 0.34 },
      { rada_nreg: '580-19', count_in_top30: 1, avg_score_in_top30: 0.31, max_score: 0.31 },
    ],
  });
  if (result.selected_acts.some((act) => act.rada_nreg === '580-19')) {
    throw new Error(`Expected weak multi-goal tail act to be trimmed, got ${JSON.stringify(result.selected_acts)}`);
  }
  if (result.selected_acts.some((act) => act.rada_nreg === '4651-17')) {
    throw new Error(`Expected weak ACTS_1 support without material evidence to stay out entirely, got ${JSON.stringify(result.selected_acts)}`);
  }
  console.log('[OK] selected_acts blocks weak multi-goal ACTS_1 tail before it reaches final trim');
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

function testSelectedActsBlocksWeakNoiseKindsWhenMultiGoalPrimaryLawsAlreadyCoverGoals(): void {
  const result = buildSelectedActs({
    finalHits: [],
    actCandidatesTop: [
      {
        rada_nreg: '2341-14',
        title: 'Кримінальний кодекс України',
        score: 0.94,
        category: 'criminal',
        document_type: 'Кодекс',
        source_tier: 'ACTS_1',
      },
      {
        rada_nreg: '4651-17',
        title: 'Кримінальний процесуальний кодекс України',
        score: 0.91,
        category: 'criminal_procedure',
        document_type: 'Кодекс',
        source_tier: 'ACTS_1',
      },
      {
        rada_nreg: 'v001p710-19',
        title: 'Рішення Конституційного Суду України у кримінальній справі',
        score: 0.73,
        category: 'constitutional',
        document_type: 'Рішення КСУ',
        source_tier: 'ACTS_1',
      },
    ],
    goals_summary: [{ goal_id: 'goal_0' }, { goal_id: 'goal_1' }],
    taxonomyNregs: new Set(['2341-14', '4651-17', 'v001p710-19']),
    actsSearchNregs: ['2341-14', '4651-17', 'v001p710-19'],
    chunks_evidence_top_acts: [
      {
        rada_nreg: '2341-14',
        count_in_top30: 8,
        avg_score_in_top30: 0.54,
        max_score: 0.6,
        best_rank_in_top30: 1,
        rank_mass_top30: 1.5,
        max_ordering_score: 0.63,
      },
      {
        rada_nreg: '4651-17',
        count_in_top30: 5,
        avg_score_in_top30: 0.5,
        max_score: 0.56,
        best_rank_in_top30: 2,
        rank_mass_top30: 0.9,
        max_ordering_score: 0.58,
      },
      {
        rada_nreg: 'v001p710-19',
        count_in_top30: 2,
        avg_score_in_top30: 0.46,
        max_score: 0.51,
        best_rank_in_top30: 10,
        rank_mass_top30: 0.16,
        max_ordering_score: 0.42,
      },
    ],
    familyEvidence: {
      dominant_family_key: 'criminal',
      family_confidence: 0.62,
      family_conflict: true,
      top2: [
        { family_key: 'criminal', support_score: 0.62 },
        { family_key: 'criminal_procedure', support_score: 0.57 },
      ],
    },
  });
  if (result.selected_acts.some((act) => act.rada_nreg === 'v001p710-19')) {
    throw new Error(
      `Expected weak KSU decision to be blocked once multi-goal primary laws already cover the query, got ${JSON.stringify(result.selected_acts)}`
    );
  }
  console.log('[OK] selected_acts blocks weak noise kinds when multi-goal primary laws already cover goals');
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
    goal_support_by_act: {
      '2597-19': ['goal_0', 'goal_1'],
    },
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

function testSelectedActsKeepsEarlyProceduralPrimaryLawForMultiGoal(): void {
  const result = buildSelectedActs({
    finalHits: [],
    actCandidatesTop: [
      {
        rada_nreg: '2341-14',
        title: 'Кримінальний кодекс України',
        score: 0.92,
        category: 'criminal',
        document_type: 'Кодекс',
        source_tier: 'ACTS_1',
      },
      {
        rada_nreg: '4651-17',
        title: 'Кримінальний процесуальний кодекс України',
        score: 0.74,
        category: 'criminal_procedure',
        document_type: 'Кодекс',
        source_tier: 'ACTS_1',
      },
    ],
    goals_summary: [{ goal_id: 'goal_0' }, { goal_id: 'goal_1' }],
    goal_support_by_act: {
      '2341-14': ['goal_0'],
      '4651-17': ['goal_1'],
    },
    taxonomyNregs: new Set(['2341-14', '4651-17']),
    actsSearchNregs: ['2341-14', '4651-17'],
    chunks_evidence_top_acts: [
      {
        rada_nreg: '2341-14',
        count_in_top30: 8,
        avg_score_in_top30: 0.57,
        max_score: 0.61,
        best_rank_in_top30: 1,
        rank_mass_top30: 1.9,
        max_ordering_score: 0.64,
      },
      {
        rada_nreg: '4651-17',
        count_in_top30: 2,
        avg_score_in_top30: 0.53,
        max_score: 0.56,
        best_rank_in_top30: 3,
        rank_mass_top30: 0.58,
        max_ordering_score: 0.59,
      },
    ],
  });
  if (!result.selected_acts.some((act) => act.rada_nreg === '4651-17')) {
    throw new Error(`Expected early procedural primary law to remain selected, got ${JSON.stringify(result.selected_acts)}`);
  }
  if (result.selected_acts_reason_codes.includes('MULTI_GOAL_SINGLE_ACT_COVERAGE_ALLOWED')) {
    throw new Error(
      `Did not expect MULTI_GOAL_SINGLE_ACT_COVERAGE_ALLOWED when distinct procedural primary law has early evidence, got ${JSON.stringify(result.selected_acts_reason_codes)}`
    );
  }
  console.log('[OK] selected_acts keeps early procedural primary-law evidence in multi-goal retrieval');
}

function testSelectedActsMarksCoverageMissWhenGoalSupportIsIncomplete(): void {
  const result = buildSelectedActs({
    finalHits: [
      {
        rada_nreg: '2341-14',
        r2_key: 'legislation/criminal/2341-14.json',
        json_path: '$.content.chunks[0].text',
        score: 0.71,
        ordering_score: 0.76,
        source: 'lldbi_chunks',
        goal_id: 'goal_0',
      } as never,
    ],
    actCandidatesTop: [
      {
        rada_nreg: '2341-14',
        title: 'Кримінальний кодекс України',
        score: 0.92,
        category: 'criminal',
        document_type: 'Кодекс',
        source_tier: 'ACTS_1',
      },
      {
        rada_nreg: '4651-17',
        title: 'Кримінальний процесуальний кодекс України',
        score: 0.74,
        category: 'criminal_procedure',
        document_type: 'Кодекс',
        source_tier: 'ACTS_1',
      },
    ],
    goals_summary: [{ goal_id: 'goal_0' }, { goal_id: 'goal_1' }],
    goal_support_by_act: {
      '2341-14': ['goal_0'],
      '4651-17': ['goal_1'],
    },
    taxonomyNregs: new Set(['2341-14', '4651-17']),
    actsSearchNregs: ['2341-14', '4651-17'],
    chunks_evidence_top_acts: [
      {
        rada_nreg: '2341-14',
        count_in_top30: 9,
        avg_score_in_top30: 0.58,
        max_score: 0.62,
        best_rank_in_top30: 1,
        rank_mass_top30: 2.1,
        max_ordering_score: 0.66,
      },
    ],
  });
  if (!result.selected_acts_reason_codes.includes('COVERAGE_MISS_SELECTED_ACTS')) {
    throw new Error(`Expected COVERAGE_MISS_SELECTED_ACTS for incomplete goal coverage, got ${JSON.stringify(result.selected_acts_reason_codes)}`);
  }
  if (result.selected_acts_reason_codes.includes('MULTI_GOAL_SINGLE_ACT_COVERAGE_ALLOWED')) {
    throw new Error(`Did not expect MULTI_GOAL_SINGLE_ACT_COVERAGE_ALLOWED with incomplete goal support, got ${JSON.stringify(result.selected_acts_reason_codes)}`);
  }
  console.log('[OK] selected_acts marks multi-goal coverage miss when selected acts do not cover all goals');
}

function testSelectedActsDoesNotTrustPartialGoalSupportOverDistinctCoverage(): void {
  const result = buildSelectedActs({
    finalHits: [
      {
        rada_nreg: '2341-14',
        r2_key: 'legislation/criminal/2341-14.json',
        json_path: '$.content.chunks[0].text',
        score: 0.71,
        ordering_score: 0.76,
        source: 'lldbi_chunks',
        goal_id: 'goal_0',
      } as never,
      {
        rada_nreg: '4651-17',
        r2_key: 'legislation/criminal_procedure/4651-17.json',
        json_path: '$.content.chunks[0].text',
        score: 0.68,
        ordering_score: 0.73,
        source: 'lldbi_chunks',
      } as never,
    ],
    actCandidatesTop: [
      {
        rada_nreg: '2341-14',
        title: 'Кримінальний кодекс України',
        score: 0.92,
        category: 'criminal',
        document_type: 'Кодекс',
        source_tier: 'ACTS_1',
      },
      {
        rada_nreg: '4651-17',
        title: 'Кримінальний процесуальний кодекс України',
        score: 0.89,
        category: 'criminal_procedure',
        document_type: 'Кодекс',
        source_tier: 'ACTS_1',
      },
    ],
    goals_summary: [{ goal_id: 'goal_0' }, { goal_id: 'goal_1' }],
    goal_support_by_act: {
      '2341-14': ['goal_0'],
    },
    taxonomyNregs: new Set(['2341-14', '4651-17']),
    actsSearchNregs: ['2341-14', '4651-17'],
    chunks_evidence_top_acts: [
      {
        rada_nreg: '2341-14',
        count_in_top30: 9,
        avg_score_in_top30: 0.58,
        max_score: 0.62,
        best_rank_in_top30: 1,
        rank_mass_top30: 2.1,
        max_ordering_score: 0.66,
      },
      {
        rada_nreg: '4651-17',
        count_in_top30: 7,
        avg_score_in_top30: 0.56,
        max_score: 0.61,
        best_rank_in_top30: 2,
        rank_mass_top30: 2.4,
        max_ordering_score: 0.64,
      },
    ],
  });
  if (result.selected_acts_reason_codes.includes('COVERAGE_MISS_SELECTED_ACTS')) {
    throw new Error(`Did not expect coverage miss with distinct selected acts and partial goal support, got ${JSON.stringify(result.selected_acts_reason_codes)}`);
  }
  console.log('[OK] partial goal support does not override distinct multi-goal coverage when support map is incomplete');
}

function testSelectedActsBlocksUngroundedProceduralSingleActCoverageForMixedGoals(): void {
  const result = buildSelectedActs({
    finalHits: [
      {
        rada_nreg: '2747-15',
        r2_key: 'legislation/administrative/2747-15.json',
        json_path: '$.content.chunks[0].text',
        score: 0.66,
        ordering_score: 0.69,
        source: 'lldbi_chunks',
        goal_id: 'goal_0',
      } as never,
      {
        rada_nreg: '2747-15',
        r2_key: 'legislation/administrative/2747-15.json',
        json_path: '$.content.chunks[1].text',
        score: 0.64,
        ordering_score: 0.67,
        source: 'lldbi_chunks',
        goal_id: 'goal_1',
      } as never,
    ],
    actCandidatesTop: [
      {
        rada_nreg: '2747-15',
        title: 'Кодекс адміністративного судочинства України',
        score: 0.94,
        category: 'administrative',
        document_type: 'Кодекс',
        source_tier: 'ACTS_1',
      },
      {
        rada_nreg: '435-15',
        title: 'Цивільний кодекс України',
        score: 0.62,
        category: 'civil',
        document_type: 'Кодекс',
        source_tier: 'ACTS_1',
      },
    ],
    goals_summary: [
      { goal_id: 'goal_0', goal_type: 'definition' },
      { goal_id: 'goal_1', goal_type: 'procedure' },
    ],
    goal_support_by_act: {
      '2747-15': ['goal_0', 'goal_1'],
    },
    taxonomyNregs: new Set(['2747-15', '435-15']),
    actsSearchNregs: ['2747-15', '435-15'],
    chunks_evidence_top_acts: [
      {
        rada_nreg: '2747-15',
        count_in_top30: 15,
        avg_score_in_top30: 0.61,
        max_score: 0.66,
        best_rank_in_top30: 1,
        rank_mass_top30: 2.8,
        max_ordering_score: 0.71,
      },
      {
        rada_nreg: '435-15',
        count_in_top30: 1,
        avg_score_in_top30: 0.43,
        max_score: 0.43,
        best_rank_in_top30: 12,
        rank_mass_top30: 0.08,
        max_ordering_score: 0.34,
      },
    ],
  });
  if (result.selected_acts_reason_codes.includes('MULTI_GOAL_SINGLE_ACT_COVERAGE_ALLOWED')) {
    throw new Error(
      `Did not expect MULTI_GOAL_SINGLE_ACT_COVERAGE_ALLOWED for mixed-goal procedural fallback, got ${JSON.stringify(result.selected_acts_reason_codes)}`
    );
  }
  if (!result.selected_acts_reason_codes.includes('MULTI_GOAL_PROCEDURAL_SINGLE_ACT_BLOCKED')) {
    throw new Error(
      `Expected MULTI_GOAL_PROCEDURAL_SINGLE_ACT_BLOCKED, got ${JSON.stringify(result.selected_acts_reason_codes)}`
    );
  }
  if ((result.selected_acts_confidence ?? 0) > 0.75) {
    throw new Error(
      `Did not expect high confidence after blocking mixed-goal procedural fallback, got ${result.selected_acts_confidence}`
    );
  }
  console.log('[OK] mixed-goal procedural fallback does not count as full act coverage');
}

function testSelectedActsDocumentTypeSlugHintsAllowTreatyAndDraft(): void {
  const treatyResult = buildSelectedActs({
    finalHits: [
      {
        rada_nreg: '995_004',
        r2_key: 'legislation/treaty/995_004.json',
        json_path: '$.content.chunks[0].text',
        score: 0.72,
        ordering_score: 0.78,
        source: 'lldbi_chunks',
      } as never,
    ],
    actCandidatesTop: [
      {
        rada_nreg: '995_004',
        title: 'Конвенція про захист прав людини і основоположних свобод',
        score: 0.91,
        category: 'international',
        document_type_slug: 'convention',
        source_tier: 'ACTS_1',
      },
    ],
    goals_summary: [{ goal_id: 'goal_0' }],
    taxonomyNregs: new Set(['995_004']),
    actsSearchNregs: ['995_004'],
    documentTypeHints: ['Конвенція'],
    chunks_evidence_top_acts: [
      {
        rada_nreg: '995_004',
        count_in_top30: 6,
        avg_score_in_top30: 0.6,
        max_score: 0.64,
        best_rank_in_top30: 1,
        rank_mass_top30: 1.8,
        max_ordering_score: 0.69,
      },
    ],
  });
  if (treatyResult.selected_acts_reason_codes.includes('NON_PRIMARY_ONLY_WEAK_CONFIDENCE')) {
    throw new Error(`Did not expect weak non-primary confidence for slug-only treaty with explicit convention hint, got ${JSON.stringify(treatyResult.selected_acts_reason_codes)}`);
  }

  const draftResult = buildSelectedActs({
    finalHits: [],
    actCandidatesTop: [
      {
        rada_nreg: 'draft-1',
        title: 'Проєкт Закону про тестовий режим',
        score: 0.91,
        category: 'general',
        document_type_slug: 'bill_draft',
        source_tier: 'ACTS_1',
      },
    ],
    goals_summary: [{ goal_id: 'goal_0' }],
    taxonomyNregs: new Set(['draft-1']),
    actsSearchNregs: ['draft-1'],
    documentTypeHints: ['Проєкт Закону'],
  });
  if (!draftResult.selected_acts.some((act) => act.rada_nreg === 'draft-1')) {
    throw new Error(`Expected slug-only bill draft to be selectable with explicit draft hint, got ${JSON.stringify(draftResult.selected_acts)}`);
  }
  console.log('[OK] document_type_slug participates in treaty and bill-draft hint matching');
}

function testSelectedActsFallbackDoesNotReAddBlockedNoiseAct(): void {
  const result = buildSelectedActs({
    finalHits: [
      {
        r2_key: 'legislation/criminal/2341-14.json',
        json_path: '$.content.chunks[1].text',
        score: 0.72,
        source: 'lldbi_chunks',
        rada_nreg: '2341-14',
      },
    ],
    actCandidatesTop: [
      {
        rada_nreg: '2341-14',
        title: 'Кримінальний кодекс України',
        score: 3.2,
        category: 'criminal',
        document_type: 'Кодекс',
        source_tier: 'ACTS_1',
      },
      {
        rada_nreg: '1-v/2024',
        title: 'Рішення Конституційного Суду України',
        score: 2.6,
        category: 'constitutional',
        document_type: 'Рішення КСУ',
        source_tier: 'ACTS_1',
      },
    ],
    goals_summary: [{ goal_id: 'goal_0' }, { goal_id: 'goal_1' }],
    taxonomyNregs: new Set(['2341-14', '1-v/2024']),
    actsSearchNregs: ['2341-14', '1-v/2024'],
    chunks_evidence_top_acts: [
      {
        rada_nreg: '2341-14',
        count_in_top30: 9,
        avg_score_in_top30: 0.68,
        max_score: 0.72,
        best_rank_in_top30: 1,
        rank_mass_top30: 1.9,
        max_ordering_score: 0.71,
      },
    ],
    familyEvidence: {
      dominant_family_key: 'criminal',
      family_confidence: 0.9,
      family_conflict: false,
      top2: [{ family_key: 'criminal', support_score: 1 }],
    },
  });
  if (result.selected_acts.some((act) => act.rada_nreg === '1-v/2024')) {
    throw new Error(`Expected blocked noise act to stay out of fallback fill, got ${JSON.stringify(result.selected_acts)}`);
  }
  console.log('[OK] selected_acts fallback does not re-add blocked noise act');
}

function testSelectedActsTrimWeakOffFamilyPrimaryLawInSingleGoal(): void {
  const result = buildSelectedActs({
    finalHits: [],
    actCandidatesTop: [
      {
        rada_nreg: '1618-15',
        title: 'Цивільний процесуальний кодекс України',
        score: 3.2,
        category: 'civil_procedure',
        document_type: 'Кодекс',
        source_tier: 'ACTS_1',
      },
      {
        rada_nreg: '4651-17',
        title: 'Кримінальний процесуальний кодекс України',
        score: 2.4,
        category: 'criminal_procedure',
        document_type: 'Кодекс',
        source_tier: 'ACTS_1',
      },
    ],
    goals_summary: [{ goal_id: 'goal_0' }],
    taxonomyNregs: new Set(['1618-15', '4651-17']),
    actsSearchNregs: ['1618-15', '4651-17'],
    documentTypeHints: ['кодекс'],
    chunks_evidence_top_acts: [
      {
        rada_nreg: '1618-15',
        count_in_top30: 8,
        avg_score_in_top30: 0.7,
        max_score: 0.76,
        best_rank_in_top30: 1,
        rank_mass_top30: 1.9,
        max_ordering_score: 0.81,
      },
      {
        rada_nreg: '4651-17',
        count_in_top30: 2,
        avg_score_in_top30: 0.41,
        max_score: 0.47,
        best_rank_in_top30: 14,
        rank_mass_top30: 0.25,
        max_ordering_score: 0.45,
      },
    ],
    familyEvidence: {
      dominant_family_key: 'civil_procedure',
      family_confidence: 0.82,
      family_conflict: false,
      top2: [
        { family_key: 'civil_procedure', support_score: 0.95 },
        { family_key: 'criminal_procedure', support_score: 0.22 },
      ],
    },
  });
  const selectedNregs = result.selected_acts.map((act) => act.rada_nreg);
  if (JSON.stringify(selectedNregs) !== JSON.stringify(['1618-15'])) {
    throw new Error(`Expected dominant-family primary law only, got ${JSON.stringify(selectedNregs)}`);
  }
  if (!result.selected_acts_reason_codes.includes('SINGLE_GOAL_OFF_FAMILY_PRIMARY_TRIMMED')) {
    throw new Error(`Expected SINGLE_GOAL_OFF_FAMILY_PRIMARY_TRIMMED, got ${JSON.stringify(result.selected_acts_reason_codes)}`);
  }
  console.log('[OK] selected_acts trims weak off-family primary-law tail in dominant single-goal runs');
}

function testSelectedActsRequireEvidenceForPrimaryLawSupportTail(): void {
  const result = buildSelectedActs({
    finalHits: [
      {
        r2_key: 'legislation/cpc/4651-17.json',
        json_path: '$.content.chunks[0].text',
        score: 0.71,
        ordering_score: 0.79,
        source: 'lldbi_chunks',
        rada_nreg: '4651-17',
        article_number: '214',
      } as never,
    ],
    actCandidatesTop: [
      {
        rada_nreg: '4651-17',
        title: 'Кримінальний процесуальний кодекс України',
        score: 0.93,
        category: 'criminal_procedure',
        document_type: 'Кодекс',
        source_tier: 'ACTS_1',
      },
      {
        rada_nreg: '1700-18',
        title: 'Про запобігання корупції',
        score: 0.86,
        category: 'anti_corruption',
        document_type: 'Закон',
        source_tier: 'ACTS_1',
      },
      {
        rada_nreg: '80731-10',
        title: 'Кодекс України про адміністративні правопорушення',
        score: 0.82,
        category: 'administrative_offenses',
        document_type: 'Кодекс',
        source_tier: 'ACTS_1',
      },
    ],
    goals_summary: [{ goal_id: 'goal_0' }],
    taxonomyNregs: new Set(['4651-17', '1700-18', '80731-10']),
    actsSearchNregs: ['4651-17', '1700-18', '80731-10'],
    chunks_evidence_top_acts: [
      {
        rada_nreg: '4651-17',
        count_in_top30: 7,
        avg_score_in_top30: 0.68,
        max_score: 0.71,
        best_rank_in_top30: 1,
        rank_mass_top30: 1.84,
        max_ordering_score: 0.79,
      },
    ],
    familyEvidence: {
      dominant_family_key: 'criminal_procedure',
      family_confidence: 0.92,
      family_conflict: false,
      top2: [{ family_key: 'criminal_procedure', support_score: 0.92 }],
    },
  });
  const selectedNregs = result.selected_acts.map((act) => act.rada_nreg);
  if (JSON.stringify(selectedNregs) !== JSON.stringify(['4651-17'])) {
    throw new Error(`Expected support tail without evidence to stay out of selected_acts, got ${JSON.stringify(selectedNregs)}`);
  }
  console.log('[OK] selected_acts requires retrieval evidence before adding extra primary-law tail acts');
}

async function main(): Promise<void> {
  console.log('RAG unit tests\n');
  testGoalSplitEmptyQuery();
  testGoalSplitMultiQuestion();
  testGoalSplitSingleQueryNoSplit();
  testNoTopicBasedMultiGoal();
  testContrastiveLiabilityGoalSplit();
  testFamilyGuardDoesNotInjectUnsupportedPrimaryLaw();
  testHasMultiClauseStructure();
  testGoalSplitMultiClauseWithoutPlannerDependency();
  testGoalSplitCarriesSharedTailAcrossClauses();
  testExplicitActScopeCueCoversStructuredIdsAndSubordinateActs();
  testStrongActScopeCueCountDistinguishesSingleAndMixedActScope();
  testGoalSplitDoesNotCompactMixedActScopeBundle();
  testGoalSplitCompactsSingleStrongActScopeBundle();
  testGoalSplitCarriesSubjectIntoProceduralQuestion();
  testGoalSplitCarriesSubjectIntoYesNoFollowUp();
  testGoalSplitAddsSpecificTaxAppealSignals();
  testGoalSplitCompactsExplicitActBundleAcrossQuestions();
  testGoalSplitCompactsExplicitActClauseBundle();
  testGoalSplitCompactsProceduralBundleWithDocumentsFollowUp();
  testCategoryClusterSplitSkipsGroundedSingleAct();
  testGoalSplitMarksProceduralSingleGoal();
  testGoalSplitCompactsProceduralBundleWithAnaphora();
  testGoalSplitCompactsProceduralBundleWithSharedProcessReference();
  testGoalSplitCompactsSameActNormBundle();
  testGoalSplitAddsErdrProceduralSignal();
  testGoalSplitCompactsErdrComplaintBundle();
  testActPlannerTierSkipsSingleGoalWhenTaxonomySignalExists();
  testActPlannerTierUsesTierOneWhenSignalsAreMissing();
  testActPlannerTierKeepsTierTwoForMultiGoal();
  testStrongTaxonomySignalHelperMatchesSingleGoalPolicy();
  await testTaxonomyGroundsSingleLogicalActFamilyFromExactAlias();
  await testTaxonomyGroundsRepealOrderByDerivedTitleAlias();
  testStrongTaxonomySignalTreatsExactActHitAsStrong();
  testStrongTaxonomySignalTreatsGroundedAliasAsStrong();
  testStrongTaxonomySignalRejectsFuzzyAliasVolumeOnly();
  testDomainHintAlignedFamilyHelper();
  testSingleGoalFirstPassPlanSkipsActsSearchOnStrongTaxonomySignal();
  testSingleGoalFirstPassPlanKeepsActsSearchWhenTaxonomyWeak();
  testSingleGoalFirstPassPlanKeepsActsSearchOnFuzzyAliasVolumeOnly();
  testSingleGoalFirstPassPlanRespectsExplicitChunksOnlyRequest();
  testSingleGoalFirstPassPlanPreservesExplicitActsOnlyRequest();
  testReferenceExpansionSkipForStrongHeadCoverage();
  testReferenceExpansionDoesNotSkipOnExplicitSelectors();
  testExtractActSearchNregsFromHitsUsesOnlyActSearchHits();
  testExtractChunkEvidenceNregsFromHitsRanksByRepeatedChunkEvidence();
  testBuildWithinActPoolPrefersTaxonomyWhenHintsExist();
  testBuildWithinActPoolCanPreferChunkEvidenceOnStrongRuns();
  testBuildWithinActPoolPrioritizesGroundedSingleAct();
  testBuildWithinActPoolPromotesPlannerPreferredActs();
  testQueryRewritePolicySkipsAnchoredStructuralTitleQuery();
  testQueryRewritePolicySkipsGroundedCitationWithActCue();
  testQueryRewritePolicySkipsWhenStrongTaxonomySignalExists();
  testQueryRewritePolicySkipsWhenExactActIdentifierConverges();
  testQueryRewritePolicyAllowsFuzzyAliasVolumeOnly();
  testQueryRewritePolicySkipsSimpleFocusedLegalQuery();
  testQueryRewritePolicyAllowsBroadNaturalLanguageQuery();
  testGroundedQueryBuilderDropsGenericSignalsForStructuralQuery();
  testGroundedQueryBuilderKeepsSignalsForNaturalLanguageQuery();
  testWithinActExpansionPrefersProceduralAndStructuralQueries();
  testWithinActExpansionCompactsSignalOnlyBundleQueries();
  testWithinActExpansionCompactsProceduralNonStructuralQueries();
  testWithinActExpansionTreatsNormalizedRetrievalEntitiesAsActAnchors();
  testWithinActExpansionSupportsGroundedSingleActQueriesWithoutStructuralSelectors();
  testAuditBestProbeUsesNregInsteadOfWeakShortAlias();
  testAuditBestProbeUsesNregInsteadOfWeakShortCuedNumberAlias();
  testAuditBestProbeKeepsStrongCodeAlias();
  testAuditBestProbeRejectsAliasWithoutActIdentityOverlap();
  testAuditBestProbeUsesNregForAmendmentLikeActAliases();
  testAuditBestProbeUsesNregForBoilerplateAdministrativeAliases();
  testAuditBestProbeUsesOwnNregWhenAmendmentAliasReferencesDifferentActNumber();
  testStructuralCitationSelectorsCaptureNoteAndSubpoint();
  testStructuralCitationSelectorsCaptureDottedSubpoint();
  testStructuralCitationSelectorsCapturePluralPartSyntax();
  testStructuralCitationMatchCountsNoteSelectors();
  testStructuralCitationMatchCountsMentionedNoteWithoutExplicitNumber();
  testStructuralCitationBareNoteMentionDoesNotOvermatch();
  testHitCitationKeyPreservesNestedFallbackSelectors();
  testArticleBackfillPrefersSingleAliasMatchedAct();
  testArticleBackfillPrefersDominantAliasMatchedAct();
  testArticleBackfillFilterCarriesStructuralSelectors();
  testArticleBackfillFilterCarriesNoteSelectors();
  testArticleBackfillDoesNotTreatWrongPointAsSatisfied();
  testStructuralOnlyBackfillFilterCarriesPointSelectors();
  testStructuralOnlyBackfillRequiresPointMatch();
  testSelectedActsFinalizerRaisesConfidenceAfterRoutingPrimaryLaw();
  testSelectedActsFinalizerDoesNotInflateConfidenceWithoutEvidence();
  testSelectedActsFinalizerRemovesUnsupportedRoutingHintActs();
  testSelectedActsBlocksUnrelatedSecondaryOrderUnderPrimaryLawDominance();
  testSelectedActsDropsWeakFirstSecondaryOrderFallbackEvenWithEvidence();
  testSummarizeSelectedActsCountsKindsAndDocTypes();
  testClassifyActKindPrimaryLaw();
  testClassifyActKindSecondaryOrder();
  testClassifyActKindUnknown();
  testClassifyActKindBillDraftNeedsMetadata();
  testClassifyActKindUsesDocumentTypeSlug();
  await testTaxonomyKeywordTopicNotInScore();
  await testFindActByTitleFragmentExport();
  await testDocsOnlyNoSemanticPlanIsNotMarkedDegraded();
  testChunkStructuralScorePrefersBaseArticleTitle();
  testOrderingScoreBeatsRawVectorScore();
  testDiscriminativeStructuralScorePrefersMobilizationArticle();
  testStructuralScoreRemainsFiniteWhenMatchesAppearOutOfOrder();
  testStructuralScoreSoftensZeroOverlapPenaltyForStrongArticleHits();
  testStructuralScorePrefersProceduralAnchorArticleTitle();
  testStructuralScorePrefersExplicitPointCitation();
  testStructuralScoreDemotesWrongPointEvenWithLexicalOverlap();
  testSingleGoalSelectedActsTailTrim();
  testSelectedActsTrimNonPrimaryOnlyTailAndLowerConfidence();
  testCoverageGapTreatsNoPrimaryLawAsWeakEvidence();
  await testResolveSingleGoalSelectedActsConfirmsExplicitNonPrimaryScope();
  await testResolveSingleGoalSelectedActsClearsOutOfScopeForExactActScope();
  await testResolveSingleGoalSelectedActsRecoversExplicitIdentifierFromTailEvidence();
  await testResolveSingleGoalSelectedActsRecoversGroundedDescriptiveSubordinateAct();
  await testResolveSingleGoalSelectedActsRecoversMetadataGroundedExplicitSubordinateAct();
  await testResolveSingleGoalSelectedActsKeepsGroundedSubordinateActAsWeakEvidenceWhenChunksMiss();
  testCoverageGapUsesSpecificDomainHintForLikelyMissingAct();
  testCoverageGapUsesMissingTaxonomyConvergenceForLikelyMissingAct();
  testCoverageGapUsesFamilyGuardNoEvidenceForLikelyMissingAct();
  testCoverageGapUsesExplicitActScopeNoConvergenceForWeakEvidenceWhenActIsGrounded();
  testCoverageGapUsesProceduralOnlyMixedGoalFallbackForLikelyMissingAct();
  testCoverageGapUsesGroundedActScopeNoConvergenceForWeakEvidenceWhenActIsGrounded();
  testCoverageGapUsesMetadataActScopeNoConvergenceForWeakEvidenceWhenActIsGrounded();
  testCoverageGapUsesProceduralPrimaryWithoutActGroundingForLikelyMissingAct();
  testDeriveTopScoreFromHitsUsesPostprocessedHits();
  testNormalizeFinalReasonCodesDropsRecoveredWeakSignals();
  testCoverageGuardRecoveryRequiresActGrounding();
  testStickySingleGoalLowConfidenceReasonsBlockRecovery();
  testProceduralPrimaryWithoutGroundingRequiresActSignals();
  testProcedureCategoryEnvelopeFallsBackToProcedureFamilies();
  testBuildTaxonomyQuerySignalsIncludesMultiWordPhrases();
  testBuildTaxonomyQuerySignalsPreservesStructuredActIdentifiers();
  testExtractActReferenceSignalsCapturesExplicitDocumentTitles();
  testEntityExtractorCapturesExplicitDecreeTitleAsLawTitle();
  testExtractStructuredActIdentifiersIgnoresDates();
  testExtractCuedNumericActReferencesCapturesBareNumberWithCue();
  testSelectedActsAvoidWeakSingleGoalSupportNoise();
  testSelectedActsTrimWeakMultiGoalTail();
  testSelectedActsBlockCrossFamilySupportWithoutEvidence();
  testSelectedActsDemoteCrossFamilyChunkEvidence();
  testSelectedActsPreserveStrongEarlyPrimaryLawEvidence();
  testSelectedActsBlocksKsuNoiseUnderPrimaryLawDominance();
  testSelectedActsBlocksKsuNoiseEvenWhenFamilyEvidenceConflicts();
  testSelectedActsBlocksWeakNoiseKindsWhenMultiGoalPrimaryLawsAlreadyCoverGoals();
  testSelectedActsDoesNotDiversifyIntoNoiseWhenPrimaryLawAlreadySelected();
  testSelectedActsKeepStrongSupportingOrderWithRepeatedEvidence();
  testSelectedActsAllowSingleActCoverageForDominantMultiGoal();
  testSelectedActsKeepsEarlyProceduralPrimaryLawForMultiGoal();
  testSelectedActsMarksCoverageMissWhenGoalSupportIsIncomplete();
  testSelectedActsDoesNotTrustPartialGoalSupportOverDistinctCoverage();
  testSelectedActsBlocksUngroundedProceduralSingleActCoverageForMixedGoals();
  testSelectedActsDocumentTypeSlugHintsAllowTreatyAndDraft();
  testSelectedActsFallbackDoesNotReAddBlockedNoiseAct();
  testSelectedActsTrimWeakOffFamilyPrimaryLawInSingleGoal();
  testSelectedActsRequireEvidenceForPrimaryLawSupportTail();
  console.log('\nAll RAG unit tests passed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
