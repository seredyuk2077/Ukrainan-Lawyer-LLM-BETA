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
import { buildSelectedActs, classifyActKind, documentTypeHintMatches } from '../../retrieval/selected-acts.js';
import {
  areActReferenceCuesCompatible,
  buildTaxonomyQuerySignals,
  extractCuedNumericActReferences,
  extractActReferenceSignals,
  extractQuotedActTitleFragments,
  extractStructuredActIdentifiers,
  getActMeta,
  getTaxonomyCandidates,
  isAmendmentLikeActTitle,
  queryLooksAmendmentFocused,
  scoreActCandidate,
  findActByTitleFragment,
  shouldSkipApproximateActReferenceGrounding,
} from '../../retrieval/act-taxonomy-store.js';
import { extractEntities } from '../../classify/entity-extractor.js';
import { tagLegalDomain } from '../../classify/legal-domain-tagger.js';
import { runCacheRag } from '../../retrieval/cache-rag.js';
import { selectActPlannerTier } from '../../retrieval/act-planner.js';
import {
  buildWithinActPool,
  extractActSearchNregsFromHits,
  extractChunkEvidenceNregsFromHits,
  summarizeChunkEvidenceActs,
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
import { applyHybridOrdering } from '../../retrieval/hit-ranking.js';
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
import { buildSingleGoalDegradedTrace } from '../../retrieval/single-goal-degraded-trace.js';
import { normalizeSingleGoalLowConfidenceSelection } from '../../retrieval/single-goal-final-honesty.js';
import {
  isDomainHintAlignedFamily,
  normalizeFinalReasonCodes,
  resolveSingleGoalSelectedActs,
  shouldConfirmSoftPrimarySingleAct,
  shouldConfirmSoftNonPrimarySingleAct,
  shouldConfirmSoftProceduralSingleAct,
} from '../../retrieval/single-goal-selected-acts.js';
import {
  extractStrictActScopeReferenceSignals,
  isInterrogativePrimaryLawLocatorQuery,
  isMetadataGroundedActCandidate,
  resolveSingleActScopeSelection,
} from '../../retrieval/single-goal-act-scope.js';
import {
  canRelaxCoverageGuardWithActGrounding,
  hasStickySingleGoalLowConfidenceReason,
  shouldFlagProceduralPrimaryWithoutActGrounding,
} from '../../retrieval/single-goal-honesty.js';
import {
  finalizeMultiGoalSelectedActs,
  hasStrongGoalSupportedMultiPrimaryCoverage,
  resolveExplicitPrimaryActMultiGoalSelection,
  shouldFlagUngroundedMultiGoalFallback,
  shouldSkipMultiGoalVariantSearch,
  trimLowConfidenceMultiGoalSelection,
  trimUngroundedMultiGoalFallbackSelection,
} from '../../retrieval/multi-goal-confidence.js';
import { preferEvidenceBackedGoalSupport } from '../../retrieval/goal-support.js';
import { hasStrongSingleGoalTaxonomySignal } from '../../retrieval/taxonomy-strength.js';
import { buildBestProbe } from './audit_lldbi_act_coverage.js';

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])];
}

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

function testDocumentTypeHintMatchesSupportsSlugHints(): void {
  if (!documentTypeHintMatches('Розпорядження КМУ', ['cmu_order'], 'cmu_order')) {
    throw new Error('Expected documentTypeHintMatches to accept exact slug hints for document_type_slug-backed acts');
  }
  if (!documentTypeHintMatches('Постанова КМУ', ['cmu_resolution'], 'cmu_resolution')) {
    throw new Error('Expected documentTypeHintMatches to accept exact resolution slug hints');
  }
  if (documentTypeHintMatches('Розпорядження КМУ', ['cmu_resolution'], 'cmu_order')) {
    throw new Error('Expected documentTypeHintMatches not to cross-match incompatible CMU document_type slugs');
  }
  console.log('[OK] documentTypeHintMatches supports slug hints without cross-matching incompatible kinds');
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
    goals_summary: [
      { goal_id: 'goal_0', goal_type: 'definition' },
      { goal_id: 'goal_1', goal_type: 'procedure' },
    ],
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
  if (
    hasMultiClauseStructure(
      'За Законом України «Про ратифікацію Угоди між Україною та Канадою про взаємну охорону інформації з обмеженим доступом», між якими державами укладено угоду та який саме вид інформації вона охоплює?'
    )
  ) {
    throw new Error('Expected quoted act title with internal conjunction to avoid multi_clause_structure');
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

function testGoalSplitKeepsSingleQuestionCoordinatedObjectBundleAsOneGoal(): void {
  const q =
    'Де Кабмін у березні 2026 року скоригував порядок експериментального проекту допомоги покупцям товарів і послуг українського виробництва?';
  const r = heuristicGoalSplit(q, 'labor_social', undefined);
  if (r.goals.length !== 1) {
    throw new Error(`Expected coordinated object bundle to stay single-goal, got ${JSON.stringify(r)}`);
  }
  if (!r.reason_codes.includes('same_act_bundle_compaction')) {
    throw new Error(`Expected same_act_bundle_compaction, got ${JSON.stringify(r.reason_codes)}`);
  }
  if (r.reason_codes.includes('multi_clause_structure')) {
    throw new Error(`Did not expect multi_clause_structure after phrase-bundle compaction, got ${JSON.stringify(r.reason_codes)}`);
  }
  console.log('[OK] heuristicGoalSplit keeps coordinated object bundle inside one goal');
}

function testGoalSplitKeepsAnchoredActTitleWithInternalConjunctionAsSingleGoal(): void {
  const q = 'Указ Президента Про рішення Ради національної безпеки і оборони України від 25 січня 2015 року';
  const r = heuristicGoalSplit(q, undefined, undefined);
  if (r.goals.length !== 1) {
    throw new Error(`Expected anchored act-title query to stay single-goal, got ${JSON.stringify(r)}`);
  }
  if (r.reason_codes.includes('multi_clause_structure')) {
    throw new Error(`Expected anchored act-title query to avoid multi_clause_structure, got ${JSON.stringify(r.reason_codes)}`);
  }
  console.log('[OK] heuristicGoalSplit keeps anchored act title with internal conjunction as single goal');
}

function testGoalSplitKeepsCompactTitleFragmentWithInternalConjunctionAsSingleGoal(): void {
  const q =
    "Деякі питання здійснення заходів сприяння захисту прав інтелектуальної власності та реєстрації у митному реєстрі об'єктів права інтелектуальної власності";
  const r = heuristicGoalSplit(q, undefined, undefined);
  if (r.goals.length !== 1) {
    throw new Error(`Expected compact title-fragment query to stay single-goal, got ${JSON.stringify(r)}`);
  }
  if (r.reason_codes.includes('multi_clause_structure')) {
    throw new Error(`Expected compact title-fragment query to avoid multi_clause_structure, got ${JSON.stringify(r.reason_codes)}`);
  }
  console.log('[OK] heuristicGoalSplit keeps compact title fragment with internal conjunction as single goal');
}

function testGoalSplitKeepsQuotedRatificationTitleWithInternalConjunctionAsSingleGoal(): void {
  const q =
    'За Законом України «Про ратифікацію Угоди між Україною та Канадою про взаємну охорону інформації з обмеженим доступом», між якими державами укладено угоду та який саме вид інформації вона охоплює?';
  const r = heuristicGoalSplit(q, undefined, undefined);
  if (r.goals.length !== 1) {
    throw new Error(`Expected quoted ratification-title query to stay single-goal, got ${JSON.stringify(r)}`);
  }
  if (r.reason_codes.includes('multi_clause_structure')) {
    throw new Error(`Expected quoted ratification-title query to avoid multi_clause_structure, got ${JSON.stringify(r.reason_codes)}`);
  }
  console.log('[OK] heuristicGoalSplit keeps quoted ratification title with internal conjunction as single goal');
}

function testGoalSplitKeepsQuotedRatificationTitleSingleGoalWhenContractLike(): void {
  const q =
    'За Законом України «Про ратифікацію Угоди між Україною, з однієї сторони, та Європейським Союзом, з іншої сторони, про участь України у напрямі «Зайнятість та соціальні інновації» (EaSI) Європейського соціального фонду Плюс (ESF+)», у якому саме напрямі ESF+ бере участь Україна після ратифікації?';
  const r = heuristicGoalSplit(q, undefined, { input_looks_like_contract: true } as never);
  if (r.goals.length !== 1) {
    throw new Error(`Expected quoted contract-like ratification query to stay single-goal, got ${JSON.stringify(r)}`);
  }
  if (r.reason_codes.includes('multi_clause_structure')) {
    throw new Error(`Expected quoted contract-like ratification query to avoid multi_clause_structure, got ${JSON.stringify(r.reason_codes)}`);
  }
  console.log('[OK] heuristicGoalSplit keeps quoted contract-like ratification title as single goal');
}

function testExplicitActScopeCueCoversStructuredIdsAndSubordinateActs(): void {
  if (!hasExplicitActScopeCue('Які документи подаються за постановою № 1178?')) {
    throw new Error('Expected subordinate act number cue to count as explicit act scope');
  }
  if (!hasExplicitActScopeCue('За Законом України «Про електронні комунікації», коли постачальник має попередити абонента?')) {
    throw new Error('Expected quoted law-title cue with "Законом України" to count as explicit act scope');
  }
  if (!hasExplicitActScopeCue('2811-20 які документи подаються для реєстрації?')) {
    throw new Error('Expected structured act identifier to count as explicit act scope');
  }
  if (!hasExplicitActScopeCue('Що регулює Наказ про скасування Правил торгівлі транспортними засобами?')) {
    throw new Error('Expected descriptive subordinate-act title to count as explicit act scope');
  }
  if (!hasExplicitActScopeCue('Яким розпорядженням закрито дисциплінарне провадження?')) {
    throw new Error('Expected interrogative subordinate-act locator to count as explicit act scope');
  }
  if (!hasExplicitActScopeCue('За Конвенцією про кіберзлочинність, які заходи щодо термінового збереження даних вона передбачає?')) {
    throw new Error('Expected treaty/convention cue to count as explicit act scope');
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
  if (countStrongActScopeCues('За Законом України «Про електронні комунікації», коли постачальник має попередити абонента?') !== 1) {
    throw new Error('Expected one strong act-scope cue for quoted law-title query');
  }
  if (countStrongActScopeCues('Що регулює Наказ про скасування Правил торгівлі транспортними засобами?') !== 1) {
    throw new Error('Expected one strong act-scope cue for descriptive subordinate-act title query');
  }
  if (countStrongActScopeCues('Яким наказом визнано таким, що втратив чинність, попередній порядок або інструкцію?') !== 1) {
    throw new Error('Expected one strong act-scope cue for interrogative repeal-order query');
  }
  if (countStrongActScopeCues('За Конвенцією про кіберзлочинність що таке термінове збереження даних?') !== 1) {
    throw new Error('Expected one strong act-scope cue for treaty/convention query');
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

function testGoalSplitCompactsActMetadataBundle(): void {
  const q = 'Яким розпорядженням закрито дисциплінарне провадження і хто прийняв це рішення?';
  const r = heuristicGoalSplit(q, undefined, undefined);
  if (r.goals.length !== 1) {
    throw new Error(`Expected act-metadata bundle to compact into 1 goal, got ${r.goals.length}`);
  }
  if (r.goals[0]?.goal_type !== 'definition') {
    throw new Error(`Expected compacted act-metadata bundle to stay definition-like, got ${r.goals[0]?.goal_type}`);
  }
  if (!r.reason_codes.includes('act_metadata_bundle_compaction')) {
    throw new Error(`Expected act_metadata_bundle_compaction, got ${JSON.stringify(r.reason_codes)}`);
  }
  if (!r.reason_codes.includes('same_act_bundle_compaction')) {
    throw new Error(`Expected same_act_bundle_compaction to remain present, got ${JSON.stringify(r.reason_codes)}`);
  }
  if ((r.goals[0]?.must_have_signals?.length ?? 0) !== 0) {
    throw new Error(`Expected act-metadata bundle to avoid procedural must-have signals, got ${JSON.stringify(r.goals[0]?.must_have_signals)}`);
  }
  console.log('[OK] heuristicGoalSplit compacts descriptive subordinate-act metadata bundle');
}

function testGoalSplitCompactsActMetadataBundleWithNeuterLocator(): void {
  const q = 'Яке розпорядження закрило дисциплінарне провадження та ким воно прийняте?';
  const r = heuristicGoalSplit(q, undefined, undefined);
  if (r.goals.length !== 1) {
    throw new Error(`Expected neuter act-metadata bundle to compact into 1 goal, got ${r.goals.length}`);
  }
  if (!hasExplicitActScopeCue(q)) {
    throw new Error('Expected neuter interrogative act locator to count as explicit act scope cue');
  }
  if (countStrongActScopeCues(q) !== 1) {
    throw new Error(`Expected exactly one strong act-scope cue, got ${countStrongActScopeCues(q)}`);
  }
  if (!r.reason_codes.includes('act_metadata_bundle_compaction')) {
    throw new Error(`Expected act_metadata_bundle_compaction, got ${JSON.stringify(r.reason_codes)}`);
  }
  if (!r.reason_codes.includes('same_act_bundle_compaction')) {
    throw new Error(`Expected same_act_bundle_compaction, got ${JSON.stringify(r.reason_codes)}`);
  }
  console.log('[OK] heuristicGoalSplit compacts neuter interrogative act-metadata bundle');
}

function testGoalSplitCompactsProfileLawMetadataBundle(): void {
  const q =
    "Який профільний закон встановлює перелік спеціальних економічних та інших обмежувальних заходів і суб'єктів подання пропозицій про санкції?";
  const r = heuristicGoalSplit(q, undefined, undefined);
  if (r.goals.length !== 1) {
    throw new Error(`Expected profile-law metadata bundle to compact into 1 goal, got ${JSON.stringify(r)}`);
  }
  if (!hasExplicitActScopeCue(q)) {
    throw new Error('Expected profile-law locator to count as explicit act scope cue');
  }
  if (countStrongActScopeCues(q) !== 1) {
    throw new Error(`Expected exactly one strong act-scope cue, got ${countStrongActScopeCues(q)}`);
  }
  if (!r.reason_codes.includes('same_act_bundle_compaction')) {
    throw new Error(`Expected same_act_bundle_compaction, got ${JSON.stringify(r.reason_codes)}`);
  }
  if (r.reason_codes.includes('multi_clause_structure')) {
    throw new Error(`Did not expect multi_clause_structure after single-act compaction, got ${JSON.stringify(r.reason_codes)}`);
  }
  console.log('[OK] heuristicGoalSplit compacts profile-law locator bundle into one grounded act-scope goal');
}

function testGoalSplitCompactsRepealOrderMetadataBundle(): void {
  const q =
    'Яким наказом визнано таким, що втратив чинність, попередній порядок або інструкцію, і з якого моменту припинилося її застосування?';
  const r = heuristicGoalSplit(q, undefined, undefined);
  if (r.goals.length !== 1) {
    throw new Error(`Expected repeal-order metadata bundle to compact into 1 goal, got ${r.goals.length}`);
  }
  if (r.goals[0]?.goal_type !== 'definition') {
    throw new Error(`Expected repeal-order metadata bundle to stay definition-like, got ${r.goals[0]?.goal_type}`);
  }
  if (!r.reason_codes.includes('act_metadata_bundle_compaction')) {
    throw new Error(`Expected act_metadata_bundle_compaction for repeal-order bundle, got ${JSON.stringify(r.reason_codes)}`);
  }
  console.log('[OK] heuristicGoalSplit compacts repeal-order metadata bundle');
}

function testGoalSplitDoesNotCompactActLocatorWithSubstantiveProcedureBundle(): void {
  const q = 'Яким законом передбачена відповідальність за шахрайство і хто розслідує цей злочин?';
  const r = heuristicGoalSplit(q, 'criminal', undefined);
  if (r.goals.length < 2) {
    throw new Error(`Expected act-locator + substantive/procedure bundle to remain split, got ${r.goals.length}`);
  }
  if (r.reason_codes.includes('act_metadata_bundle_compaction')) {
    throw new Error(`Did not expect act_metadata_bundle_compaction for substantive/procedure bundle, got ${JSON.stringify(r.reason_codes)}`);
  }
  console.log('[OK] heuristicGoalSplit does not over-compact non-metadata act-locator bundle');
}

function testGoalSplitDoesNotCompactActMetadataBundleWithProceduralRemedyFollowUp(): void {
  const q = 'Яким наказом затверджено порядок дистанційної ідентифікації і як оскаржити відмову органу?';
  const r = heuristicGoalSplit(q, undefined, undefined);
  if (r.goals.length < 2) {
    throw new Error(`Expected act-locator bundle with procedural remedy follow-up to remain split, got ${JSON.stringify(r.goals)}`);
  }
  if (r.reason_codes.includes('act_metadata_bundle_compaction')) {
    throw new Error(`Did not expect act_metadata_bundle_compaction for procedural remedy follow-up, got ${JSON.stringify(r.reason_codes)}`);
  }
  console.log('[OK] heuristicGoalSplit keeps act-locator + procedural-remedy bundle split');
}

function testGoalSplitDoesNotCompactGroundedSameActSubstanceProcedureBundle(): void {
  const q = 'ККУ ст. 190 шахрайство та підслідність';
  const r = heuristicGoalSplit(q, 'criminal', undefined);
  if (r.goals.length < 2) {
    throw new Error(`Expected grounded same-act substance/procedure bundle to remain split, got ${r.goals.length}`);
  }
  const goalTypes = new Set(r.goals.map((goal) => goal.goal_type));
  if (!goalTypes.has('procedure') || goalTypes.size < 2) {
    throw new Error(`Expected grounded same-act split to preserve non-procedural + procedural goals, got ${JSON.stringify(r.goals)}`);
  }
  if (r.reason_codes.includes('same_act_bundle_compaction')) {
    throw new Error(`Did not expect same_act_bundle_compaction for grounded substance/procedure bundle, got ${JSON.stringify(r.reason_codes)}`);
  }
  console.log('[OK] heuristicGoalSplit keeps grounded same-act substance/procedure bundle split');
}

function testGoalSplitDoesNotOverSplitSelectorBundleOnGenericDeadlineWording(): void {
  const q = 'ККУ ст. 190 санкція та строк давності';
  const r = heuristicGoalSplit(q, 'criminal', undefined);
  if (r.goals.length !== 1) {
    throw new Error(`Expected selector bundle with generic deadline wording to stay single-goal, got ${JSON.stringify(r.goals)}`);
  }
  if (r.reason_codes.includes('multi_clause_structure')) {
    throw new Error(`Did not expect multi_clause_structure for generic deadline selector bundle, got ${JSON.stringify(r.reason_codes)}`);
  }
  console.log('[OK] heuristicGoalSplit avoids over-splitting selector bundle on generic deadline wording');
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

function testGoalSplitCarriesActorSubjectIntoPoliceFollowUp(): void {
  const q = 'Що може поліція під час перевірки документів і коли вона має пояснити причину зупинки?';
  const r = heuristicGoalSplit(q, 'administrative', undefined);
  if (r.goals.length !== 1) {
    throw new Error(`Expected police same-actor bundle to compact into 1 goal, got ${r.goals.length}`);
  }
  if (!r.reason_codes.includes('shared_actor_bundle_compaction')) {
    throw new Error(`Expected shared_actor_bundle_compaction for police bundle, got ${JSON.stringify(r.reason_codes)}`);
  }
  if (!r.goals[0]?.subquery.toLowerCase().includes('поліці')) {
    throw new Error(`Expected compacted police goal to keep actor subject, got ${r.goals[0]?.subquery}`);
  }
  console.log('[OK] heuristicGoalSplit compacts same-actor police bundle into one goal');
}

function testGoalSplitCarriesActorSubjectIntoLaborNeedFollowUp(): void {
  const q = 'Коли роботодавець може звільнити за прогул і що треба оформити перед цим?';
  const r = heuristicGoalSplit(q, 'labor_social', undefined);
  if (r.goals.length !== 1) {
    throw new Error(`Expected labor same-actor bundle to compact into 1 goal, got ${r.goals.length}`);
  }
  if (!r.reason_codes.includes('shared_actor_bundle_compaction')) {
    throw new Error(`Expected shared_actor_bundle_compaction for labor bundle, got ${JSON.stringify(r.reason_codes)}`);
  }
  if (!r.goals[0]?.subquery.toLowerCase().includes('роботодав')) {
    throw new Error(`Expected compacted labor goal to keep employer actor subject, got ${r.goals[0]?.subquery}`);
  }
  console.log('[OK] heuristicGoalSplit compacts same-actor labor bundle into one goal');
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
      rada_nreg_candidates: ['66/2026'],
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

function testCategoryClusterSplitSkipsDominantTitleFragmentSingleAct(): void {
  const split = tryCategoryClusterSplitV2(
    {
      rada_nreg_candidates: ['1-2026-р', '32-2026-р', '48-2026-р'],
      alias_hits: [
        { rada_nreg: '1-2026-р', category: 'other' },
        { rada_nreg: '1-2026-р', category: 'other' },
        { rada_nreg: '32-2026-р', category: 'defense_mobilization' },
        { rada_nreg: '48-2026-р', category: 'defense_mobilization' },
      ],
      category_hints: ['other'],
      grounded_act_hit_count: 0,
      exact_act_hit_count: 0,
    },
    'Про звільнення Кислиці посади першого заступника Міністра закордонних',
    'general',
    undefined
  );
  if (split != null) {
    throw new Error(`Expected taxonomy cluster split to skip dominant single-act title fragment query, got ${JSON.stringify(split)}`);
  }
  console.log('[OK] taxonomy cluster split skips dominant title-fragment single-act convergence');
}

function testCategoryClusterSplitSkipsQuotedExplicitLawTitleScope(): void {
  const split = tryCategoryClusterSplitV2(
    {
      rada_nreg_candidates: ['2456-17', '2755-17', '984_011'],
      alias_hits: [
        { rada_nreg: '2456-17', category: 'finance_banking' },
        { rada_nreg: '2456-17', category: 'finance_banking' },
        { rada_nreg: '2755-17', category: 'tax_customs' },
        { rada_nreg: '2755-17', category: 'tax_customs' },
        { rada_nreg: '984_011', category: 'international' },
      ],
      category_hints: ['finance_banking'],
      grounded_act_hit_count: 0,
      exact_act_hit_count: 0,
    },
    'За Законом України «Про внесення змін до Бюджетного кодексу України щодо реалізації Угоди між Урядом України та Урядом Сполучених Штатів Америки про створення Американсько-Українського інвестиційного фонду відбудови», для реалізації якої саме угоди та якого фонду відбудови вносяться ці зміни?',
    'general',
    undefined
  );
  if (split != null) {
    throw new Error(`Expected taxonomy cluster split to skip quoted explicit law-title scope, got ${JSON.stringify(split)}`);
  }
  console.log('[OK] taxonomy cluster split skips quoted explicit law-title scope');
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

async function testTaxonomyPrefersInForceLogicalActSuccessorForTruncatedQuotedLawTitle(): Promise<void> {
  const currentLaw = await getActMeta('361-20');
  const historicalLaw = await getActMeta('1702-18');
  if (!currentLaw || !historicalLaw) {
    console.log('[SKIP] in-force logical successor grounding test (361-20/1702-18 missing in current LLDBI snapshot)');
    return;
  }
  const query =
    'За Законом України «Про запобігання та протидію легалізації (відмиванню) доходів...», коли суб\'єкт первинного фінансового моніторингу зобов\'язаний провести належну перевірку клієнта та як застосовуються заходи щодо політично значущих осіб?';
  const result = await getTaxonomyCandidates({
    query,
    entities: [{ type: 'law_title', value: query }],
    category_hints: [],
    document_type_hints: ['Закон України'],
  });
  if (result.grounded_act_hit_count !== 1) {
    throw new Error(`Expected truncated quoted law title to ground one in-force act, got ${result.grounded_act_hit_count}`);
  }
  if (!result.grounded_act_nregs.includes('361-20')) {
    throw new Error(`Expected truncated quoted law title to prefer 361-20, got ${JSON.stringify(result.grounded_act_nregs)}`);
  }
  if (result.grounded_act_nregs.includes('1702-18')) {
    throw new Error(`Expected historical expired twin to stay out of grounded act hits, got ${JSON.stringify(result.grounded_act_nregs)}`);
  }
  console.log('[OK] taxonomy prefers in-force logical act successor for truncated quoted law titles');
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

function testStrongTaxonomySignalRejectsCalendarScopedVolumeWithoutGrounding(): void {
  const strong = hasStrongSingleGoalTaxonomySignal({
    goals_count: 1,
    taxonomy_strength: {
      taxonomy_act_count: 12,
      alias_hit_count: 8,
      grounded_act_hit_count: 0,
      exact_act_hit_count: 0,
      category_hint_count: 1,
      document_type_hint_count: 1,
      has_explicit_calendar_date: true,
    },
  });
  if (strong) {
    throw new Error('Expected explicit calendar-date query without exact/grounded act identity not to count as strong taxonomy support');
  }
  console.log('[OK] taxonomy-strength helper rejects calendar-scoped taxonomy volume without act grounding');
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
  if (!isDomainHintAlignedFamily('civil', 'family')) {
    throw new Error('Expected civil domain hint to align with family family');
  }
  if (!isDomainHintAlignedFamily('family', 'civil')) {
    throw new Error('Expected family domain hint to align with civil family');
  }
  if (!isDomainHintAlignedFamily('admin', 'administrative_offenses')) {
    throw new Error('Expected admin domain hint to align with administrative_offenses family');
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
  if (isDomainHintAlignedFamily('admin', 'civil')) {
    throw new Error('Expected admin domain hint not to align with civil family');
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

function testSingleGoalFirstPassPlanKeepsActsSearchForDescriptiveActTitleScope(): void {
  const result = buildSingleGoalFirstPassPlan({
    steps: undefined,
    collections: {
      chunks: 'lexery_legislation_chunks',
      acts: 'lexery_legislation_acts',
    },
    goalsCount: 1,
    taxonomyStrength: {
      taxonomy_act_count: 2,
      grounded_act_hit_count: 1,
      alias_hit_count: 1,
      category_hint_count: 1,
      document_type_hint_count: 1,
    },
    descriptiveActTitleScope: true,
  });
  if (!result.usedActsSearch) {
    throw new Error(`Expected descriptive act-title scope to keep acts search enabled, got ${JSON.stringify(result)}`);
  }
  if (!result.actsSearchPolicyReasonCodes.includes('DESCRIPTIVE_ACT_TITLE_SCOPE')) {
    throw new Error(
      `Expected DESCRIPTIVE_ACT_TITLE_SCOPE reason code, got ${JSON.stringify(result.actsSearchPolicyReasonCodes)}`
    );
  }
  console.log('[OK] single-goal first-pass plan keeps acts search for descriptive act-title scope');
}

function testSingleGoalFirstPassPlanKeepsActsSearchForCalendarScopedTaxonomyVolume(): void {
  const result = buildSingleGoalFirstPassPlan({
    steps: undefined,
    collections: {
      chunks: 'lexery_legislation_chunks',
      acts: 'lexery_legislation_acts',
    },
    goalsCount: 1,
    taxonomyStrength: {
      taxonomy_act_count: 12,
      alias_hit_count: 8,
      grounded_act_hit_count: 0,
      exact_act_hit_count: 0,
      category_hint_count: 1,
      document_type_hint_count: 1,
      has_explicit_calendar_date: true,
    },
  });
  if (!result.usedActsSearch) {
    throw new Error(`Expected explicit calendar-date taxonomy volume to keep acts search enabled, got ${JSON.stringify(result)}`);
  }
  if (!result.actsSearchPolicyReasonCodes.includes('ACTS_SEARCH_ENABLED')) {
    throw new Error(`Expected ACTS_SEARCH_ENABLED for calendar-scoped taxonomy volume, got ${JSON.stringify(result.actsSearchPolicyReasonCodes)}`);
  }
  console.log('[OK] single-goal first-pass plan keeps acts search for calendar-scoped taxonomy volume without grounding');
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

function testSummarizeChunkEvidenceActsCapturesStrongHeadConsensus(): void {
  const summary = summarizeChunkEvidenceActs([
    { source: 'lldbi_chunks', rada_nreg: '4651-17', score: 0.71 } as const,
    { source: 'lldbi_chunks', rada_nreg: '4651-17', score: 0.62 } as const,
    { source: 'lldbi_chunks', rada_nreg: '2341-14', score: 0.58 } as const,
    { source: 'lldbi_chunks', rada_nreg: '4651-17', score: 0.55 } as const,
  ]);
  if (summary.top_nreg !== '4651-17' || summary.top_hit_count !== 3 || summary.act_count !== 2) {
    throw new Error(`Expected chunk-evidence summary to expose head consensus, got ${JSON.stringify(summary)}`);
  }
  console.log('[OK] within-act pool summarizes strong head act consensus');
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

function testBuildWithinActPoolPrefersTaxonomyForExplicitActScopeQueries(): void {
  const pool = buildWithinActPool({
    taxonomyNregs: ['19-2026-р', '60/2026', '4651-17'],
    chunkEvidenceNregs: ['2747-15', '80732-10', '1697-18'],
    preferChunkEvidence: true,
    explicitActScopeCue: true,
    limit: 3,
  });
  if (JSON.stringify(pool) !== JSON.stringify(['19-2026-р', '60/2026', '4651-17'])) {
    throw new Error(
      `Expected explicit act-scope query to preserve taxonomy-led candidate pool ahead of chunk noise, got ${JSON.stringify(pool)}`
    );
  }
  console.log('[OK] within-act pool preserves taxonomy-led candidates for descriptive explicit act-scope queries');
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
    chunkEvidenceActCount: 1,
    topChunkEvidenceHitCount: 2,
    topChunkEvidenceMatchesLeadingAct: true,
    weakLimit: 5,
  });
  if (
    decision.limit !== 1 ||
    decision.chunks_per_act_limit !== 24 ||
    !decision.reason_codes.includes('GROUNDED_SINGLE_ACT_QUERY') ||
    !decision.reason_codes.includes('STRONG_HEAD_ACT_CONSENSUS')
  ) {
    throw new Error(
      `Expected grounded single-act query with strong head evidence to collapse to one-act fanout, got ${JSON.stringify(decision)}`
    );
  }
  console.log('[OK] within-act expansion collapses grounded single-act queries on strong head evidence');
}

function testWithinActExpansionCompactsGroundedStructuralSingleActQueries(): void {
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
    groundedActHitCount: 1,
    queryTokenCount: 5,
    chunkEvidenceActCount: 1,
    topChunkEvidenceHitCount: 2,
    topChunkEvidenceMatchesLeadingAct: true,
    weakLimit: 5,
  });
  if (
    decision.limit !== 1 ||
    decision.chunks_per_act_limit !== 24 ||
    !decision.reason_codes.includes('GROUNDED_SINGLE_ACT_QUERY') ||
    !decision.reason_codes.includes('STRONG_HEAD_ACT_CONSENSUS')
  ) {
    throw new Error(
      `Expected grounded structural single-act query with strong head evidence to use one-act fanout, got ${JSON.stringify(decision)}`
    );
  }
  console.log('[OK] within-act expansion collapses grounded structural single-act queries on strong head evidence');
}

function testWithinActExpansionSupportsExplicitActScopeWithoutExactGrounding(): void {
  const decision = decideWithinActExpansion({
    hasActCandidates: true,
    needTwoStage: false,
    querySelectors: extractQueryCitationSelectors(
      'Яким розпорядженням закрито дисциплінарне провадження і хто прийняв це рішення?'
    ),
    entities: [],
    explicitActScopeCue: true,
    goalType: 'definition',
    goalReasonCodes: ['same_act_bundle_compaction', 'act_metadata_bundle_compaction'],
    mustHaveSignalsCount: 0,
    groundedActHitCount: 0,
    queryTokenCount: 10,
    weakLimit: 5,
  });
  if (decision.limit !== 3 || !decision.reason_codes.includes('EXPLICIT_ACT_SCOPE_QUERY')) {
    throw new Error(
      `Expected explicit act-scope query without exact grounding to keep act-anchored within-act fanout, got ${JSON.stringify(decision)}`
    );
  }
  console.log('[OK] within-act expansion keeps explicit act-scope queries alive even without exact grounding');
}

function testWithinActExpansionCollapsesExplicitActScopeOnStrongHeadConsensus(): void {
  const decision = decideWithinActExpansion({
    hasActCandidates: true,
    needTwoStage: false,
    querySelectors: extractQueryCitationSelectors(
      'Яким розпорядженням закрито дисциплінарне провадження і хто прийняв це рішення?'
    ),
    entities: [],
    explicitActScopeCue: true,
    goalType: 'definition',
    goalReasonCodes: ['same_act_bundle_compaction', 'act_metadata_bundle_compaction'],
    mustHaveSignalsCount: 0,
    groundedActHitCount: 0,
    queryTokenCount: 10,
    chunkEvidenceActCount: 1,
    topChunkEvidenceHitCount: 3,
    topChunkEvidenceMatchesLeadingAct: true,
    weakLimit: 5,
  });
  if (
    decision.limit !== 1 ||
    decision.chunks_per_act_limit !== 24 ||
    !decision.reason_codes.includes('EXPLICIT_ACT_SCOPE_QUERY') ||
    !decision.reason_codes.includes('STRONG_HEAD_ACT_CONSENSUS')
  ) {
    throw new Error(
      `Expected strong explicit act-scope query to collapse to one-act fanout, got ${JSON.stringify(decision)}`
    );
  }
  console.log('[OK] within-act expansion collapses strong explicit act-scope queries');
}

function testWithinActExpansionSupportsGroundedDescriptiveActTitleQueries(): void {
  const decision = decideWithinActExpansion({
    hasActCandidates: true,
    needTwoStage: false,
    querySelectors: extractQueryCitationSelectors(
      "Деякі питання здійснення заходів сприяння захисту прав інтелектуальної власності та реєстрації у митному реєстрі об'єктів права інтелектуальної власності"
    ),
    entities: [],
    descriptiveActTitleScope: true,
    goalType: 'procedure',
    goalReasonCodes: [],
    mustHaveSignalsCount: 1,
    groundedActHitCount: 1,
    queryTokenCount: 18,
    weakLimit: 5,
  });
  if (
    decision.limit !== 2 ||
    decision.chunks_per_act_limit !== 28 ||
    !decision.reason_codes.includes('DESCRIPTIVE_ACT_TITLE_QUERY') ||
    !decision.reason_codes.includes('GROUNDED_SINGLE_ACT_QUERY')
  ) {
    throw new Error(
      `Expected grounded descriptive act-title query to keep compact act-anchored within-act fanout, got ${JSON.stringify(decision)}`
    );
  }
  console.log('[OK] within-act expansion keeps grounded descriptive act-title queries act-anchored');
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
  const taxonomyResult: Parameters<typeof deriveArticleBackfillPreferredNreg>[0] = {
    anchor_tokens: [],
    rada_nreg_candidates: ['2755-17', '2747-15'],
    category_hints: [],
    alias_hits: [
      { rada_nreg: '2755-17', alias: 'ПКУ', title: 'Податковий кодекс України', category: 'tax_customs', score: 1 },
      { rada_nreg: '2755-17', alias: 'Податковий кодекс України', title: 'Податковий кодекс України', category: 'tax_customs', score: 1 },
    ],
    taxonomy_hints_used: undefined,
    debug: { source: 'supabase', taxonomy_snapshot_version: 1 },
  };
  const preferred = deriveArticleBackfillPreferredNreg(taxonomyResult);
  if (preferred !== '2755-17') {
    throw new Error(`Expected preferred rada_nreg 2755-17, got ${preferred}`);
  }
  console.log('[OK] article backfill prefers single alias-matched act when act cue is unambiguous');
}

function testArticleBackfillPrefersDominantAliasMatchedAct(): void {
  const taxonomyResult: Parameters<typeof deriveArticleBackfillPreferredNreg>[0] = {
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
  };
  const preferred = deriveArticleBackfillPreferredNreg(taxonomyResult);
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
    goals_summary: [
      { goal_id: 'goal_0', goal_type: 'definition' },
      { goal_id: 'goal_1', goal_type: 'procedure' },
    ],
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

async function testFindActByTitleFragmentRecoversLongOfficialTitleVariant(): Promise<void> {
  const targetMeta = await getActMeta('1127-2022-п');
  if (!targetMeta) {
    console.log('[SKIP] long official title fragment grounding test (1127-2022-п missing in current LLDBI snapshot)');
    return;
  }
  const matches = await findActByTitleFragment(
    "Деякі питання здійснення заходів сприяння захисту прав інтелектуальної власності та реєстрації у митному реєстрі об'єктів права інтелектуальної власності"
  );
  if (matches.length !== 1 || matches[0] !== '1127-2022-п') {
    throw new Error(`Expected long official title fragment to ground 1127-2022-п, got ${JSON.stringify(matches)}`);
  }
  console.log('[OK] findActByTitleFragment recovers long official title variants with omitted stopwords/tail');
}

async function testFindActByTitleFragmentUsesFullQueryDateToResolveRecurringSeriesAmbiguity(): Promise<void> {
  const targetMeta = await getActMeta('n0116500-26');
  const neighborMeta = await getActMeta('n0120500-26');
  if (!targetMeta || !neighborMeta) {
    console.log('[SKIP] query-aware recurring title-fragment grounding test (n0116500-26 or n0120500-26 missing in current LLDBI snapshot)');
    return;
  }
  const fragment = 'Про облікову ціну банківських металів';
  const query = 'Де Нацбанк на 23 березня 2026 року зафіксував облікову ціну банківських металів?';
  const matches = await findActByTitleFragment(fragment, query);
  if (matches.length !== 1 || matches[0] !== 'n0116500-26') {
    throw new Error(
      `Expected full query date to disambiguate recurring same-title fragment to n0116500-26, got ${JSON.stringify(matches)}`
    );
  }
  console.log('[OK] findActByTitleFragment uses full query date to resolve recurring same-title ambiguity');
}

async function testFindActByTitleFragmentRecoversCurrencyRateAliasVariant(): Promise<void> {
  const targetMeta = await getActMeta('n0115500-26');
  if (!targetMeta) {
    console.log('[SKIP] currency-rate alias fragment grounding test (n0115500-26 missing in current LLDBI snapshot)');
    return;
  }
  const query =
    'Яким документом НБУ на 23.03.2026 встановлено офіційний валютний курс гривні для щоденного застосування?';
  const matches = await findActByTitleFragment('офіційний валютний курс гривні', query);
  if (matches.length !== 1 || matches[0] !== 'n0115500-26') {
    throw new Error(
      `Expected currency-rate alias variant to ground n0115500-26, got ${JSON.stringify(matches)}`
    );
  }
  console.log('[OK] findActByTitleFragment recovers currency-rate alias variants for recurring NBU daily acts');
}

async function testQuotedActTitleFragmentsSupportGroundingSignals(): Promise<void> {
  const query =
    'За Законом України «Про електронні комунікації», коли постачальник має попередити абонента?';
  const fragments = extractQuotedActTitleFragments(query);
  if (!fragments.includes('Про електронні комунікації')) {
    throw new Error(`Expected quoted act title fragment extraction, got ${JSON.stringify(fragments)}`);
  }
  const matches = await findActByTitleFragment(fragments[0]);
  if (!Array.isArray(matches) || matches.length === 0) {
    throw new Error(`Expected quoted title fragment to resolve indexed act, got ${JSON.stringify(matches)}`);
  }
  console.log('[OK] extractQuotedActTitleFragments supports title-fragment grounding');
}

function testQuotedActTitleFragmentsRemainStableAcrossCallsForShortLawTitles(): void {
  const query =
    "За Законом України «Про медіацію», які істотні умови має містити договір про проведення медіації?";
  const first = extractQuotedActTitleFragments(query);
  const second = extractQuotedActTitleFragments(query);
  if (!first.includes('Про медіацію') || !second.includes('Про медіацію')) {
    throw new Error(
      `Expected quoted short law title fragment to stay stable across repeated calls, got first=${JSON.stringify(first)} second=${JSON.stringify(second)}`
    );
  }
  console.log('[OK] extractQuotedActTitleFragments stays stable for short quoted law titles');
}

function testQuotedActTitleFragmentsPreserveOuterNestedQuotedLawTitles(): void {
  const query =
    'За Законом України «Про внесення змін до Закону України "Про наукову і науково-технічну діяльність" щодо питань дослідницької інфраструктури та підтримки молодих вчених», яких саме питань стосується цей закон про зміни?';
  const fragments = extractQuotedActTitleFragments(query);
  if (
    !fragments.includes(
      'Про внесення змін до Закону України "Про наукову і науково-технічну діяльність" щодо питань дослідницької інфраструктури та підтримки молодих вчених'
    )
  ) {
    throw new Error(
      `Expected outer nested quoted amendment title to be preserved, got ${JSON.stringify(fragments)}`
    );
  }
  if (!fragments.includes('Про наукову і науково-технічну діяльність')) {
    throw new Error(`Expected inner nested quoted title to stay available, got ${JSON.stringify(fragments)}`);
  }
  console.log('[OK] extractQuotedActTitleFragments preserves outer nested quoted law titles');
}

function testApproximateGroundingSkipsQuotedAnchoredActTitles(): void {
  const quotedSignal =
    'Законом України «Про електронну ідентифікацію та електронні довірчі послуги»';
  if (!shouldSkipApproximateActReferenceGrounding(quotedSignal)) {
    throw new Error('Expected quoted anchored act title signal to skip approximate grounding');
  }
  if (shouldSkipApproximateActReferenceGrounding('постанова КМУ № 1178')) {
    throw new Error('Expected cued-number reference to keep approximate grounding path available');
  }
  console.log('[OK] approximate grounding skips unsafe quoted anchored act-title signals');
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

function testHybridOrderingPrefersGroundedActSearchHitForTitleLocator(): void {
  const query =
    "Деякі питання здійснення заходів сприяння захисту прав інтелектуальної власності та реєстрації у митному реєстрі об'єктів права інтелектуальної власності";
  const hits = [
    {
      r2_key: 'legislation/civil/435-15.json',
      json_path: '$.content.chunks[11].text',
      score: 0.74,
      source: 'lldbi_chunks' as const,
      rada_nreg: '435-15',
      article_number: '432',
      title: 'Цивільний кодекс України',
      document_type: 'Кодекс',
      category: 'civil',
    },
    {
      r2_key: 'legislation/customs/1127-2022-п.json',
      json_path: '$.title',
      score: 0.63,
      source: 'lldbi_acts' as const,
      rada_nreg: '1127-2022-п',
      title:
        "Деякі питання здійснення заходів із сприяння захисту прав інтелектуальної власності та реєстрації у митному реєстрі об'єктів права інтелектуальної власності, які охороняються відповідно до закону",
      document_type: 'Постанова',
      category: 'tax_customs',
    },
  ];
  const taxonomy = {
    rada_nreg_candidates: ['1127-2022-п'],
    alias_hits: [],
    category_hints: [],
    grounded_act_nregs: ['1127-2022-п'],
  } as never;
  applyHybridOrdering(hits as never, query, taxonomy, []);
  if (hits[0]?.rada_nreg !== '1127-2022-п') {
    throw new Error(`Expected grounded act-search hit to rank first for title locator, got ${hits[0]?.rada_nreg ?? 'none'}`);
  }
  console.log('[OK] hybrid ordering prefers grounded act-search hit for title locator query');
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

function testGoalSplitCompactsErdrCourtDeadlineBundle(): void {
  const q =
    'До якого суду і в який строк скаржаться на невнесення відомостей до ЄРДР після заяви про злочин?';
  const r = heuristicGoalSplit(q, 'criminal', undefined);
  if (r.goals.length !== 1) {
    throw new Error(`Expected ЄРДР court/deadline bundle to compact into 1 goal, got ${r.goals.length}`);
  }
  if (r.goals[0]?.goal_type !== 'procedure') {
    throw new Error(`Expected compacted ЄРДР court/deadline goal to be procedural, got ${r.goals[0]?.goal_type}`);
  }
  if (!r.reason_codes.includes('procedural_bundle_compaction')) {
    throw new Error(
      `Expected procedural_bundle_compaction for ЄРДР court/deadline bundle, got ${JSON.stringify(r.reason_codes)}`
    );
  }
  if (!r.goals[0]?.must_have_signals?.includes('початок досудового розслідування')) {
    throw new Error(
      `Expected compacted ЄРДР court/deadline goal to preserve procedural concept signal, got ${JSON.stringify(r.goals[0]?.must_have_signals)}`
    );
  }
  console.log('[OK] heuristicGoalSplit compacts ЄРДР court/deadline bundle into one procedural goal');
}

function testTagLegalDomainTreatsErdrAsCriminalCue(): void {
  const q = 'До якого суду і в який строк скаржаться на невнесення відомостей до ЄРДР після заяви про злочин?';
  const got = tagLegalDomain(q);
  if (got !== 'criminal') {
    throw new Error(`Expected ЄРДР structural cue to map to criminal domain, got ${got}`);
  }
  console.log('[OK] tagLegalDomain maps ЄРДР structural cue to criminal domain');
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

function testSingleGoalDegradedTraceMarksWeakEvidenceHonestly(): void {
  const trace = buildSingleGoalDegradedTrace({
    queryUsed: 'правила азс',
    latencyMs: 42,
    stepsLatencyMs: [17],
    degradedSources: { lldbi: true },
    reasonCodes: ['EMBEDDING_FAILED'],
    error: 'embedding timeout',
    qdrantCallsCountTotal: 0,
  });
  if (trace.meta?.low_confidence !== true) {
    throw new Error(`Expected degraded trace to set low_confidence=true, got ${String(trace.meta?.low_confidence)}`);
  }
  if (trace.meta?.coverage_gap !== 'weak_evidence') {
    throw new Error(`Expected degraded trace to use weak_evidence, got ${trace.meta?.coverage_gap}`);
  }
  const reasonCodes = trace.meta?.reason_codes ?? [];
  if (!reasonCodes.includes('DEGRADED_LLDBI') || !reasonCodes.includes('LOW_EVIDENCE')) {
    throw new Error(`Expected degraded trace to include honesty reason codes, got ${JSON.stringify(reasonCodes)}`);
  }
  if (trace.meta?.why_low_confidence !== 'DEGRADED_LLDBI') {
    throw new Error(`Expected degraded trace to explain degraded low confidence, got ${trace.meta?.why_low_confidence}`);
  }
  console.log('[OK] single-goal degraded trace reports weak_evidence honestly');
}

function testNormalizeSingleGoalLowConfidenceSelectionClearsOutOfScopeNoise(): void {
  const result = normalizeSingleGoalLowConfidenceSelection({
    lowConfidence: true,
    selectedActsFinal: [
      {
        rada_nreg: '2947-14',
        act_title: 'Сімейний кодекс України',
        act_kind: 'PRIMARY_LAW',
        category: 'family',
        score: 0.44,
        document_type: 'Кодекс',
      },
      {
        rada_nreg: '2811-20',
        act_title: 'Про авторське право і суміжні права',
        act_kind: 'PRIMARY_LAW',
        category: 'intellectual_property',
        score: 0.42,
        document_type: 'Закон',
      },
    ],
    selectedActsFinalMeta: {
      selected_acts_final: [],
      selected_acts_confidence_final: 0.52,
      selected_acts_confidence_pre_routing: 0.52,
      selected_acts_decision_final: { confidence: 0.52, reason_codes: [] },
      selected_acts_kinds_count_final: {},
      selected_acts_document_types_top_final: undefined,
      routing_hints_recovered_with_retrieval_evidence: false,
    },
    reasonCodes: ['OUT_OF_SCOPE', 'LOW_EVIDENCE', 'UNGROUNDED_MULTI_FAMILY_SELECTION'],
    domainHint: 'general',
    actCandidatesTopHydrated: [
      { rada_nreg: '2947-14', category: 'family' },
      { rada_nreg: '2811-20', category: 'intellectual_property' },
    ],
    chunksEvidenceTopActs: [
      { rada_nreg: '2947-14', rank_mass_top30: 0.2, best_rank_in_top30: 7, max_ordering_score: 0.41 },
      { rada_nreg: '2811-20', rank_mass_top30: 0.18, best_rank_in_top30: 9, max_ordering_score: 0.39 },
    ],
  });
  if (result.selectedActsFinal.length !== 0) {
    throw new Error(`Expected out-of-scope weak selection to clear selected acts, got ${JSON.stringify(result.selectedActsFinal)}`);
  }
  if (!result.reasonCodes.includes('LOW_CONFIDENCE_SELECTED_ACTS_CLEARED')) {
    throw new Error(`Expected LOW_CONFIDENCE_SELECTED_ACTS_CLEARED, got ${JSON.stringify(result.reasonCodes)}`);
  }
  console.log('[OK] low-confidence normalization clears ungrounded out-of-scope selected acts');
}

function testNormalizeSingleGoalLowConfidenceSelectionKeepsSingleDomainAlignedPrimaryLaw(): void {
  const result = normalizeSingleGoalLowConfidenceSelection({
    lowConfidence: true,
    selectedActsFinal: [
      {
        rada_nreg: '2755-17',
        act_title: 'Податковий кодекс України',
        act_kind: 'PRIMARY_LAW',
        category: 'tax_customs',
        score: 0.53,
        document_type: 'Кодекс',
      },
      {
        rada_nreg: '1402-19',
        act_title: 'Про судоустрій і статус суддів',
        act_kind: 'PRIMARY_LAW',
        category: 'judiciary_justice',
        score: 0.41,
        document_type: 'Закон',
      },
    ],
    selectedActsFinalMeta: {
      selected_acts_final: [],
      selected_acts_confidence_final: 0.54,
      selected_acts_confidence_pre_routing: 0.54,
      selected_acts_decision_final: { confidence: 0.54, reason_codes: [] },
      selected_acts_kinds_count_final: {},
      selected_acts_document_types_top_final: undefined,
      routing_hints_recovered_with_retrieval_evidence: false,
    },
    reasonCodes: ['LOW_EVIDENCE', 'UNGROUNDED_MULTI_FAMILY_SELECTION'],
    domainHint: 'tax_customs',
    actCandidatesTopHydrated: [
      { rada_nreg: '2755-17', category: 'tax_customs' },
      { rada_nreg: '1402-19', category: 'judiciary_justice' },
    ],
    chunksEvidenceTopActs: [
      { rada_nreg: '2755-17', rank_mass_top30: 0.9, best_rank_in_top30: 1, max_ordering_score: 0.61 },
      { rada_nreg: '1402-19', rank_mass_top30: 0.1, best_rank_in_top30: 14, max_ordering_score: 0.31 },
    ],
  });
  if (result.selectedActsFinal.length !== 1 || result.selectedActsFinal[0]?.rada_nreg !== '2755-17') {
    throw new Error(`Expected low-confidence normalization to keep the single domain-aligned primary law, got ${JSON.stringify(result.selectedActsFinal)}`);
  }
  if (!result.reasonCodes.includes('LOW_CONFIDENCE_SELECTED_ACTS_NARROWED')) {
    throw new Error(`Expected LOW_CONFIDENCE_SELECTED_ACTS_NARROWED, got ${JSON.stringify(result.reasonCodes)}`);
  }
  console.log('[OK] low-confidence normalization keeps one domain-aligned primary law instead of noisy tail');
}

function testNormalizeSingleGoalLowConfidenceSelectionKeepsDominantDomainAlignedProceduralPrimaryLaw(): void {
  const result = normalizeSingleGoalLowConfidenceSelection({
    lowConfidence: true,
    selectedActsFinal: [
      {
        rada_nreg: '4651-17',
        act_title: 'Кримінальний процесуальний кодекс України',
        act_kind: 'PRIMARY_LAW',
        category: 'criminal_procedure',
        score: 0.59,
        document_type: 'Кодекс',
      },
      {
        rada_nreg: '2341-14',
        act_title: 'Кримінальний кодекс України',
        act_kind: 'PRIMARY_LAW',
        category: 'criminal',
        score: 0.47,
        document_type: 'Кодекс',
      },
      {
        rada_nreg: '2747-15',
        act_title: 'Кодекс адміністративного судочинства України',
        act_kind: 'PRIMARY_LAW',
        category: 'civil_procedure_administrative',
        score: 0.45,
        document_type: 'Кодекс',
      },
    ],
    selectedActsFinalMeta: {
      selected_acts_final: [],
      selected_acts_confidence_final: 0.53,
      selected_acts_confidence_pre_routing: 0.53,
      selected_acts_decision_final: { confidence: 0.53, reason_codes: [] },
      selected_acts_kinds_count_final: {},
      selected_acts_document_types_top_final: undefined,
      routing_hints_recovered_with_retrieval_evidence: false,
    },
    reasonCodes: ['LOW_EVIDENCE', 'FRAGMENTED_PRIMARY_FAMILY_SELECTION'],
    domainHint: 'criminal',
    actCandidatesTopHydrated: [
      { rada_nreg: '4651-17', category: 'criminal_procedure' },
      { rada_nreg: '2341-14', category: 'criminal' },
      { rada_nreg: '2747-15', category: 'civil_procedure_administrative' },
    ],
    chunksEvidenceTopActs: [
      { rada_nreg: '4651-17', rank_mass_top30: 1.42, best_rank_in_top30: 1, max_ordering_score: 0.58 },
      { rada_nreg: '2341-14', rank_mass_top30: 0.09, best_rank_in_top30: 11, max_ordering_score: 0.48 },
      { rada_nreg: '2747-15', rank_mass_top30: 0.07, best_rank_in_top30: 9, max_ordering_score: 0.52 },
    ],
  });
  if (result.selectedActsFinal.length !== 1 || result.selectedActsFinal[0]?.rada_nreg !== '4651-17') {
    throw new Error(
      `Expected low-confidence normalization to keep the dominant domain-aligned procedural code, got ${JSON.stringify(result.selectedActsFinal)}`
    );
  }
  if (!result.reasonCodes.includes('LOW_CONFIDENCE_SELECTED_ACTS_NARROWED')) {
    throw new Error(`Expected LOW_CONFIDENCE_SELECTED_ACTS_NARROWED, got ${JSON.stringify(result.reasonCodes)}`);
  }
  console.log('[OK] low-confidence normalization keeps dominant domain-aligned procedural primary law');
}

function testShouldConfirmSoftProceduralSingleAct(): void {
  const shouldConfirm = shouldConfirmSoftProceduralSingleAct({
    query: 'До якого суду і в який строк скаржаться на невнесення відомостей до ЄРДР після заяви про злочин?',
    domainHint: 'criminal',
    reasonCodes: [
      'CHUNKS_FAMILY_MISMATCH_DEMOTED',
      'SUPPORT_FAMILY_MISMATCH_BLOCKED',
      'FRAGMENTED_PRIMARY_FAMILY_SELECTION',
      'LOW_EVIDENCE',
      'LOW_CONFIDENCE_SELECTED_ACTS_NARROWED',
    ],
    topScore: 0.599,
    selectedActsCount: 1,
    leadAct: {
      act_kind: 'PRIMARY_LAW',
      category: 'criminal_procedure',
    },
    leadEvidence: {
      count_in_top30: 8,
      best_rank_in_top30: 1,
      rank_mass_top30: 4.395,
      max_ordering_score: 0.583,
    },
    familyDominantOk: true,
    proceduralOnlyPrimarySelection: true,
    interrogativePrimaryLawLocatorQuery: false,
  });
  if (!shouldConfirm) {
    throw new Error('Expected strong domain-aligned soft procedural single-act surface to be confirmable');
  }

  const shouldRejectExplicitScope = shouldConfirmSoftProceduralSingleAct({
    query: 'За Кримінальним процесуальним кодексом України, до якого суду скаржаться на невнесення відомостей до ЄРДР?',
    domainHint: 'criminal',
    reasonCodes: ['FRAGMENTED_PRIMARY_FAMILY_SELECTION', 'LOW_EVIDENCE'],
    topScore: 0.61,
    selectedActsCount: 1,
    leadAct: {
      act_kind: 'PRIMARY_LAW',
      category: 'criminal_procedure',
    },
    leadEvidence: {
      count_in_top30: 7,
      best_rank_in_top30: 1,
      rank_mass_top30: 3.9,
      max_ordering_score: 0.59,
    },
    familyDominantOk: true,
    proceduralOnlyPrimarySelection: false,
    interrogativePrimaryLawLocatorQuery: false,
  });
  if (shouldRejectExplicitScope) {
    throw new Error('Did not expect explicit act-scoped procedural query to use soft single-act confirmation');
  }

  const shouldRejectNonProceduralSelection = shouldConfirmSoftProceduralSingleAct({
    query: 'Куди і в який строк скаржаться на невнесення відомостей до ЄРДР після заяви про злочин?',
    domainHint: 'criminal',
    reasonCodes: ['FRAGMENTED_PRIMARY_FAMILY_SELECTION', 'LOW_EVIDENCE', 'LOW_CONFIDENCE_SELECTED_ACTS_NARROWED'],
    topScore: 0.61,
    selectedActsCount: 1,
    leadAct: {
      act_kind: 'PRIMARY_LAW',
      category: 'criminal_procedure',
    },
    leadEvidence: {
      count_in_top30: 7,
      best_rank_in_top30: 1,
      rank_mass_top30: 4.1,
      max_ordering_score: 0.59,
    },
    familyDominantOk: true,
    proceduralOnlyPrimarySelection: false,
    interrogativePrimaryLawLocatorQuery: false,
  });
  if (shouldRejectNonProceduralSelection) {
    throw new Error('Did not expect non-procedural-only primary selection to use soft procedural single-act confirmation');
  }
  console.log('[OK] soft procedural single-act confirmation stays bounded to non-explicit procedural surfaces');
}

function testShouldConfirmSoftPrimarySingleAct(): void {
  const shouldConfirm = shouldConfirmSoftPrimarySingleAct({
    query: 'Що може поліція під час перевірки документів і коли вона має пояснити причину зупинки?',
    domainHint: 'administrative',
    reasonCodes: [
      'SUPPORT_FAMILY_MISMATCH_BLOCKED',
      'SELECTED_ACTS_FROM_CHUNKS_EVIDENCE',
      'FAMILY_DOMINANT_OK',
      'FRAGMENTED_PRIMARY_FAMILY_SELECTION',
      'LOW_EVIDENCE',
      'UNGROUNDED_PRIMARY_FALLBACK',
      'LOW_CONFIDENCE_SELECTED_ACTS_NARROWED',
    ],
    topScore: 0.574,
    selectedActsCount: 1,
    leadAct: {
      act_kind: 'PRIMARY_LAW',
      category: 'administrative',
    },
    leadEvidence: {
      count_in_top30: 8,
      best_rank_in_top30: 1,
      rank_mass_top30: 3.2,
      max_ordering_score: 0.551,
    },
    familyDominantOk: true,
  });
  if (!shouldConfirm) {
    throw new Error('Expected strong dominant soft primary-law surface to be confirmable');
  }

  const shouldRejectExplicitScope = shouldConfirmSoftPrimarySingleAct({
    query: 'За Законом України Про Національну поліцію, коли поліцейський має пояснити причину зупинки?',
    domainHint: 'administrative',
    reasonCodes: ['FAMILY_DOMINANT_OK', 'LOW_EVIDENCE', 'UNGROUNDED_PRIMARY_FALLBACK'],
    topScore: 0.61,
    selectedActsCount: 1,
    leadAct: {
      act_kind: 'PRIMARY_LAW',
      category: 'administrative',
    },
    leadEvidence: {
      count_in_top30: 9,
      best_rank_in_top30: 1,
      rank_mass_top30: 3.8,
      max_ordering_score: 0.57,
    },
    familyDominantOk: true,
  });
  if (shouldRejectExplicitScope) {
    throw new Error('Did not expect explicit law-scoped primary query to use soft primary-law confirmation');
  }
  console.log('[OK] soft primary-law single-act confirmation stays bounded to non-explicit dominant surfaces');
}

function testShouldConfirmSoftNonPrimarySingleAct(): void {
  const shouldConfirm = shouldConfirmSoftNonPrimarySingleAct({
    reasonCodes: [
      'GROUNDED_ACT_SCOPE_CONFIRMED',
      'GROUNDED_ACT_SCOPE_RECOVERED',
      'CALENDAR_SCOPED_ACT_NO_UNIQUE_CONVERGENCE',
      'EXPLICIT_ACT_SCOPE_NO_CONVERGENCE',
      'NO_STRONG_ACT_EVIDENCE',
      'LOW_CONFIDENCE_EXPLICIT_SCOPE_SELECTED_ACTS_CLEARED',
    ],
    topScore: 0.61,
    selectedActsCount: 1,
    leadAct: {
      rada_nreg: '1178-2022-п',
      act_title: 'Про затвердження Особливостей здійснення публічних закупівель',
      document_type: 'Постанова КМУ',
      act_kind: 'SECONDARY_ORDER',
    },
    leadCandidate: {
      rada_nreg: '1178-2022-п',
      title: 'Про затвердження Особливостей здійснення публічних закупівель',
      document_type: 'Постанова КМУ',
      document_type_slug: 'cmu_resolution',
      reasons: ['exact_alias_match'],
      score: 3.1,
    },
    leadEvidence: {
      count_in_top30: 1,
      best_rank_in_top30: 2,
      rank_mass_top30: 0.5,
      max_ordering_score: 0.47,
    },
  });
  if (!shouldConfirm) {
    throw new Error('Expected sparse grounded non-primary single-act scope to be confirmable');
  }

  const shouldConfirmRecurringDailyAct = shouldConfirmSoftNonPrimarySingleAct({
    query: 'Де Нацбанк на 24.03.2026 зафіксував референтну облікову ціну банківських металів?',
    reasonCodes: ['NO_STRONG_ACT_EVIDENCE', 'NON_PRIMARY_ONLY_WEAK_CONFIDENCE', 'NO_PRIMARY_LAW_EVIDENCE', 'LOW_EVIDENCE'],
    topScore: 0.6903,
    selectedActsCount: 1,
    leadAct: {
      rada_nreg: 'n0118500-26',
      act_title: 'Про облікову ціну банківських металів',
      document_type: 'Постанова НБУ',
      act_kind: 'SECONDARY_ORDER',
    },
    leadCandidate: {
      rada_nreg: 'n0118500-26',
      title: 'Про облікову ціну банківських металів',
      document_type: 'Постанова НБУ',
      document_type_slug: 'nbu_resolution',
      reasons: ['title_match'],
      score: 2.4,
    },
    leadEvidence: {
      count_in_top30: 1,
      best_rank_in_top30: 1,
      rank_mass_top30: 0.399,
      max_ordering_score: 0.399,
    },
  });
  if (!shouldConfirmRecurringDailyAct) {
    throw new Error('Expected strong date-scoped recurring non-primary act to be confirmable after import');
  }

  const shouldRejectAuthoritativeFallback = shouldConfirmSoftNonPrimarySingleAct({
    reasonCodes: [
      'AUTHORITATIVE_NON_PRIMARY_SCOPE_CONFIRMED',
      'LOW_EVIDENCE',
      'ACT_SELECTION_LOW_CONFIDENCE',
    ],
    topScore: 0.66,
    selectedActsCount: 1,
    leadAct: {
      rada_nreg: '950-2007-п',
      act_title: 'Про затвердження Регламенту Кабінету Міністрів України',
      document_type: 'Постанова КМУ',
      act_kind: 'SECONDARY_ORDER',
    },
    leadCandidate: {
      rada_nreg: '950-2007-п',
      title: 'Про затвердження Регламенту Кабінету Міністрів України',
      document_type: 'Постанова КМУ',
      document_type_slug: 'cmu_resolution',
      reasons: ['summary_match'],
      score: 3.4,
    },
    leadEvidence: {
      count_in_top30: 7,
      best_rank_in_top30: 1,
      rank_mass_top30: 2.1,
      max_ordering_score: 0.46,
    },
  });
  if (shouldRejectAuthoritativeFallback) {
    throw new Error('Did not expect broad authoritative non-primary fallback to use soft single-act confirmation');
  }

  const shouldRejectExplicitGenericFallback = shouldConfirmSoftNonPrimarySingleAct({
    query: 'Яким актом Кабінету Міністрів у березні 2026 року подовжено контракт із директором ДП "Енергоринок" Гнатюком Ю.Л.?',
    reasonCodes: [
      'GROUNDED_ACT_SCOPE_CONFIRMED',
      'GROUNDED_ACT_SCOPE_RECOVERED',
      'CALENDAR_SCOPED_ACT_NO_UNIQUE_CONVERGENCE',
      'EXPLICIT_ACT_SCOPE_NO_CONVERGENCE',
      'NO_STRONG_ACT_EVIDENCE',
      'LOW_CONFIDENCE_EXPLICIT_SCOPE_SELECTED_ACTS_CLEARED',
    ],
    topScore: 0.61,
    selectedActsCount: 1,
    leadAct: {
      rada_nreg: '950-2007-п',
      act_title: 'Про затвердження Регламенту Кабінету Міністрів України',
      document_type: 'Постанова КМУ',
      act_kind: 'SECONDARY_ORDER',
    },
    leadCandidate: {
      rada_nreg: '950-2007-п',
      title: 'Про затвердження Регламенту Кабінету Міністрів України',
      document_type: 'Постанова КМУ',
      document_type_slug: 'cmu_resolution',
      reasons: ['summary_match'],
      score: 3.4,
    },
    leadEvidence: {
      count_in_top30: 5,
      best_rank_in_top30: 2,
      rank_mass_top30: 0.95,
      max_ordering_score: 0.477,
    },
  });
  if (shouldRejectExplicitGenericFallback) {
    throw new Error('Did not expect explicit descriptive non-primary query to confirm generic regulation fallback');
  }
  console.log('[OK] soft non-primary single-act confirmation stays bounded to grounded/recovered scope surfaces');
}

function testNormalizeSingleGoalLowConfidenceSelectionClearsExplicitScopeFallbackNoise(): void {
  const result = normalizeSingleGoalLowConfidenceSelection({
    lowConfidence: true,
    selectedActsFinal: [
      {
        rada_nreg: '435-15',
        act_title: 'Цивільний кодекс України',
        act_kind: 'PRIMARY_LAW',
        category: 'civil',
        score: 0.53,
        document_type: 'Кодекс',
      },
      {
        rada_nreg: '361-20',
        act_title: 'Про фінансові послуги та фінансові компанії',
        act_kind: 'PRIMARY_LAW',
        category: 'finance',
        score: 0.46,
        document_type: 'Закон',
      },
    ],
    selectedActsFinalMeta: {
      selected_acts_final: [],
      selected_acts_confidence_final: 0.52,
      selected_acts_confidence_pre_routing: 0.52,
      selected_acts_decision_final: { confidence: 0.52, reason_codes: [] },
      selected_acts_kinds_count_final: {},
      selected_acts_document_types_top_final: undefined,
      routing_hints_recovered_with_retrieval_evidence: false,
    },
    reasonCodes: ['LOW_EVIDENCE', 'EXPLICIT_ACT_SCOPE_NO_CONVERGENCE'],
    domainHint: 'commercial',
    actCandidatesTopHydrated: [
      { rada_nreg: '435-15', category: 'civil' },
      { rada_nreg: '361-20', category: 'finance' },
    ],
    chunksEvidenceTopActs: [
      { rada_nreg: '435-15', rank_mass_top30: 0.42, best_rank_in_top30: 4, max_ordering_score: 0.39 },
      { rada_nreg: '361-20', rank_mass_top30: 0.24, best_rank_in_top30: 8, max_ordering_score: 0.36 },
    ],
  });
  if (result.selectedActsFinal.length !== 0) {
    throw new Error(`Expected explicit-scope no-convergence fallback noise to be cleared, got ${JSON.stringify(result.selectedActsFinal)}`);
  }
  if (!result.reasonCodes.includes('LOW_CONFIDENCE_EXPLICIT_SCOPE_SELECTED_ACTS_CLEARED')) {
    throw new Error(`Expected explicit-scope clear reason code, got ${JSON.stringify(result.reasonCodes)}`);
  }
  console.log('[OK] low-confidence normalization clears fallback selected acts for explicit missing-act scope');
}

function testNormalizeSingleGoalLowConfidenceSelectionPreservesStrongFamilyCivilBundle(): void {
  const result = normalizeSingleGoalLowConfidenceSelection({
    lowConfidence: true,
    selectedActsFinal: [
      {
        rada_nreg: '2947-14',
        act_title: 'Сімейний кодекс України',
        act_kind: 'PRIMARY_LAW',
        category: 'family',
        score: 0.58,
        document_type: 'Кодекс',
      },
      {
        rada_nreg: '435-15',
        act_title: 'Цивільний кодекс України',
        act_kind: 'PRIMARY_LAW',
        category: 'civil',
        score: 0.49,
        document_type: 'Кодекс',
      },
    ],
    selectedActsFinalMeta: {
      selected_acts_final: [],
      selected_acts_confidence_final: 0.52,
      selected_acts_confidence_pre_routing: 0.52,
      selected_acts_decision_final: { confidence: 0.52, reason_codes: [] },
      selected_acts_kinds_count_final: {},
      selected_acts_document_types_top_final: undefined,
      routing_hints_recovered_with_retrieval_evidence: false,
    },
    reasonCodes: ['LOW_EVIDENCE', 'UNGROUNDED_PRIMARY_FALLBACK'],
    domainHint: 'civil',
    actCandidatesTopHydrated: [
      { rada_nreg: '2947-14', category: 'family' },
      { rada_nreg: '435-15', category: 'civil' },
    ],
    chunksEvidenceTopActs: [
      { rada_nreg: '2947-14', rank_mass_top30: 0.84, best_rank_in_top30: 1, max_ordering_score: 0.58 },
      { rada_nreg: '435-15', rank_mass_top30: 0.43, best_rank_in_top30: 6, max_ordering_score: 0.39 },
    ],
  });
  const selectedNregs = result.selectedActsFinal.map((act) => act.rada_nreg);
  if (JSON.stringify(selectedNregs) !== JSON.stringify(['2947-14', '435-15'])) {
    throw new Error(`Expected strong family+civil bundle to survive low-confidence narrowing, got ${JSON.stringify(selectedNregs)}`);
  }
  if (!result.reasonCodes.includes('LOW_CONFIDENCE_TWO_ACT_BUNDLE_PRESERVED')) {
    throw new Error(`Expected LOW_CONFIDENCE_TWO_ACT_BUNDLE_PRESERVED, got ${JSON.stringify(result.reasonCodes)}`);
  }
  console.log('[OK] low-confidence normalization preserves strong family+civil two-act bundle');
}

function testNormalizeSingleGoalLowConfidenceSelectionPreservesTaxonomyBackedCivilBundle(): void {
  const result = normalizeSingleGoalLowConfidenceSelection({
    lowConfidence: true,
    selectedActsFinal: [
      {
        rada_nreg: '435-15',
        act_title: 'Цивільний кодекс України',
        act_kind: 'PRIMARY_LAW',
        category: 'civil',
        score: 0.58,
        document_type: 'Кодекс',
        source_tags: ['CHUNKS_EVIDENCE'],
      },
      {
        rada_nreg: '1023-12',
        act_title: 'Про захист прав споживачів',
        act_kind: 'PRIMARY_LAW',
        category: 'civil',
        score: 0.41,
        document_type: 'Закон',
        source_tags: ['TAXONOMY'],
      },
    ],
    selectedActsFinalMeta: {
      selected_acts_final: [],
      selected_acts_confidence_final: 0.52,
      selected_acts_confidence_pre_routing: 0.52,
      selected_acts_decision_final: { confidence: 0.52, reason_codes: [] },
      selected_acts_kinds_count_final: {},
      selected_acts_document_types_top_final: undefined,
      routing_hints_recovered_with_retrieval_evidence: false,
    },
    selectedActsSourcesBreakdown: {
      from_taxonomy: ['1023-12'],
      from_acts_search: [],
      from_chunks_evidence: ['435-15'],
    },
    reasonCodes: ['LOW_EVIDENCE', 'UNGROUNDED_PRIMARY_FALLBACK'],
    domainHint: 'civil',
    actCandidatesTopHydrated: [
      { rada_nreg: '435-15', category: 'civil', score: 0.35, reasons: ['category_hint', 'validity_in_force'] },
      {
        rada_nreg: '1023-12',
        category: 'civil',
        score: 1.6,
        reasons: ['keyword_match', 'category_hint', 'validity_in_force'],
      },
    ],
    chunksEvidenceTopActs: [
      { rada_nreg: '435-15', rank_mass_top30: 0.86, best_rank_in_top30: 1, max_ordering_score: 0.57 },
      { rada_nreg: '1023-12', rank_mass_top30: 0.09, best_rank_in_top30: 18, max_ordering_score: 0.18 },
    ],
  });
  const selectedNregs = result.selectedActsFinal.map((act) => act.rada_nreg);
  if (JSON.stringify(selectedNregs) !== JSON.stringify(['435-15', '1023-12'])) {
    throw new Error(
      `Expected taxonomy-backed civil bundle to survive low-confidence narrowing, got ${JSON.stringify(selectedNregs)}`
    );
  }
  if (!result.reasonCodes.includes('LOW_CONFIDENCE_TWO_ACT_BUNDLE_PRESERVED')) {
    throw new Error(`Expected LOW_CONFIDENCE_TWO_ACT_BUNDLE_PRESERVED, got ${JSON.stringify(result.reasonCodes)}`);
  }
  console.log('[OK] low-confidence normalization preserves taxonomy-backed same-family civil bundle');
}

function testNormalizeSingleGoalLowConfidenceSelectionRecoversCompanionFromActCandidates(): void {
  const result = normalizeSingleGoalLowConfidenceSelection({
    lowConfidence: true,
    selectedActsFinal: [
      {
        rada_nreg: '435-15',
        act_title: 'Цивільний кодекс України',
        act_kind: 'PRIMARY_LAW',
        category: 'civil',
        score: 0.49,
        document_type: 'Кодекс',
        source_tags: ['CHUNKS_EVIDENCE'],
      },
    ],
    selectedActsFinalMeta: {
      selected_acts_final: [],
      selected_acts_confidence_final: 0.55,
      selected_acts_confidence_pre_routing: 0.55,
      selected_acts_decision_final: {
        confidence: 0.55,
        reason_codes: ['LOW_CONFIDENCE_SELECTED_ACTS_NARROWED'],
      },
      selected_acts_kinds_count_final: {},
      selected_acts_document_types_top_final: undefined,
      routing_hints_recovered_with_retrieval_evidence: false,
    },
    selectedActsSourcesBreakdown: {
      from_taxonomy: [],
      from_acts_search: [],
      from_chunks_evidence: ['435-15', 'z1257-07'],
    },
    reasonCodes: ['LOW_EVIDENCE', 'UNGROUNDED_PRIMARY_FALLBACK', 'LOW_CONFIDENCE_SELECTED_ACTS_NARROWED'],
    domainHint: 'civil',
    actCandidatesTopHydrated: [
      {
        rada_nreg: '1023-12',
        title: 'Про захист прав споживачів',
        category: 'civil',
        score: 2.04,
        reasons: ['keyword_match', 'category_hint', 'validity_in_force', 'hits_evidence'],
        document_type: 'Закон',
      },
      {
        rada_nreg: '435-15',
        title: 'Цивільний кодекс України',
        category: 'civil',
        score: 1.18,
        reasons: ['category_hint', 'validity_in_force', 'hits_evidence'],
        document_type: 'Кодекс',
      },
      {
        rada_nreg: '1178-2022-п',
        title: 'Про затвердження особливостей здійснення публічних закупівель',
        category: 'procurement',
        score: 1.39,
        reasons: ['title_match', 'summary_match', 'validity_in_force'],
        document_type: 'Постанова КМУ',
      },
    ],
    chunksEvidenceTopActs: [
      { rada_nreg: '435-15', rank_mass_top30: 1.42, best_rank_in_top30: 1, max_ordering_score: 0.49 },
      { rada_nreg: '1023-12', rank_mass_top30: 0.11, best_rank_in_top30: 9, max_ordering_score: 0.37 },
      { rada_nreg: 'z1257-07', rank_mass_top30: 0.14, best_rank_in_top30: 10, max_ordering_score: 0.29 },
    ],
  });
  const selectedNregs = result.selectedActsFinal.map((act) => act.rada_nreg);
  if (JSON.stringify(selectedNregs) !== JSON.stringify(['435-15', '1023-12'])) {
    throw new Error(
      `Expected companion recovery from strong act candidates, got ${JSON.stringify(selectedNregs)}`
    );
  }
  if (!result.reasonCodes.includes('LOW_CONFIDENCE_COMPANION_ACT_RECOVERED')) {
    throw new Error(
      `Expected LOW_CONFIDENCE_COMPANION_ACT_RECOVERED, got ${JSON.stringify(result.reasonCodes)}`
    );
  }
  console.log('[OK] low-confidence normalization recovers compatible companion act from strong act candidates');
}

function testNormalizeSingleGoalLowConfidenceSelectionNarrowsMetadataCompanionFallback(): void {
  const result = normalizeSingleGoalLowConfidenceSelection({
    lowConfidence: true,
    selectedActsFinal: [
      {
        rada_nreg: '1023-12',
        act_title: 'Про захист прав споживачів',
        act_kind: 'PRIMARY_LAW',
        category: 'civil',
        document_type: 'Закон',
        score: 0.58,
      },
      {
        rada_nreg: '435-15',
        act_title: 'Цивільний кодекс України',
        act_kind: 'PRIMARY_LAW',
        category: 'civil',
        document_type: 'Кодекс',
        score: 0.55,
      },
    ],
    selectedActsFinalMeta: {
      selected_acts_final: [],
      selected_acts_confidence_final: 0.55,
      selected_acts_confidence_pre_routing: 0.55,
      selected_acts_decision_final: {
        confidence: 0.55,
        reason_codes: ['LOW_CONFIDENCE_SELECTED_ACTS_NARROWED'],
      },
      selected_acts_kinds_count_final: {},
      selected_acts_document_types_top_final: undefined,
      routing_hints_recovered_with_retrieval_evidence: false,
    },
    selectedActsSourcesBreakdown: {
      from_taxonomy: ['435-15'],
      from_acts_search: ['435-15'],
      from_chunks_evidence: ['1023-12'],
    },
    reasonCodes: ['LOW_EVIDENCE', 'UNGROUNDED_PRIMARY_COMPANION_FALLBACK'],
    domainHint: 'general',
    actCandidatesTopHydrated: [
      {
        rada_nreg: '1023-12',
        title: 'Про захист прав споживачів',
        category: 'civil',
        score: 1.18,
        document_type: 'Закон',
      },
      {
        rada_nreg: '435-15',
        title: 'Цивільний кодекс України',
        category: 'civil',
        score: 0.92,
        document_type: 'Кодекс',
      },
    ],
    chunksEvidenceTopActs: [
      { rada_nreg: '1023-12', rank_mass_top30: 0.44, best_rank_in_top30: 1, max_ordering_score: 0.58 },
      { rada_nreg: '435-15', rank_mass_top30: 0.08, best_rank_in_top30: 7, max_ordering_score: 0.55 },
    ],
  });
  const selectedNregs = result.selectedActsFinal.map((act) => act.rada_nreg);
  if (JSON.stringify(selectedNregs) !== JSON.stringify(['1023-12'])) {
    throw new Error(`Expected metadata-companion fallback to narrow to strongest single act, got ${JSON.stringify(selectedNregs)}`);
  }
  if (!result.reasonCodes.includes('LOW_CONFIDENCE_SELECTED_ACTS_NARROWED')) {
    throw new Error(`Expected LOW_CONFIDENCE_SELECTED_ACTS_NARROWED, got ${JSON.stringify(result.reasonCodes)}`);
  }
  if (result.reasonCodes.includes('LOW_CONFIDENCE_COMPANION_ACT_RECOVERED')) {
    throw new Error(`Did not expect companion recovery after strict narrowing, got ${JSON.stringify(result.reasonCodes)}`);
  }
  console.log('[OK] low-confidence normalization narrows metadata-companion fallback instead of preserving the pair');
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

async function testResolveSingleGoalSelectedActsPreservesProceduralPrimarySupportForGroundedMixedBundle(): Promise<void> {
  const result = await resolveSingleGoalSelectedActs({
    query: 'ККУ ст. 190 шахрайство та підслідність',
    goalId: 'goal_0',
    finalHits: [
      ...Array.from({ length: 6 }, (_, index) => ({
        rada_nreg: '2341-14',
        r2_key: `r2://2341/${index}`,
        json_path: `$.chunks[${index}]`,
        score: 0.63 - index * 0.01,
        ordering_score: 0.73 - index * 0.01,
        title: 'Кримінальний кодекс України',
        article_number: '190',
      })),
      ...Array.from({ length: 4 }, (_, index) => ({
        rada_nreg: '4651-17',
        r2_key: `r2://4651/${index}`,
        json_path: `$.chunks[${index}]`,
        score: 0.61 - index * 0.01,
        ordering_score: 0.36 - index * 0.01,
        title: 'Кримінальний процесуальний кодекс України',
        article_number: '216',
      })),
    ] as never,
    actCandidatesTopHydrated: [
      {
        rada_nreg: '2341-14',
        title: 'Кримінальний кодекс України',
        score: 6.18,
        category: 'criminal',
        document_type: 'Кодекс',
        document_type_slug: 'code',
        reasons: ['exact_alias_match', 'alias_match', 'category_hint', 'validity_in_force', 'hits_evidence'],
      },
      {
        rada_nreg: '4651-17',
        title: 'Кримінальний процесуальний кодекс України',
        score: 0,
        category: 'criminal_procedure',
        document_type: 'Кодекс',
        document_type_slug: 'code',
        reasons: ['chunks_evidence_meta'],
      },
    ],
    plannerRationaleByNreg: new Map(),
    taxonomyNregs: new Set(['2341-14', '4651-17']),
    actsSearchNregs: [],
    domainHint: 'criminal',
    documentTypeHints: ['Кодекс'],
    taxonomyActCount: 4,
    aliasHitCount: 1,
    exactActHitCount: 0,
    exactActNregs: [],
    groundedActHitCount: 1,
    groundedActNregs: ['2341-14'],
    actSelectionLowConfidence: false,
    reasonCodes: [],
    useLowConfidenceFallback: false,
    queryRewriteMeta: { called: false, used: false, not_used_reason_codes: ['STRONG_TAXONOMY_SIGNAL'] },
    topScore: 0.6283407,
    avgScore: 0.59,
    categoryHintsCount: 1,
    entitiesCount: 1,
    anchorsCount: 2,
    domainWeak: false,
    precomputedChunksEvidenceTopActs: [
      {
        rada_nreg: '2341-14',
        count_in_top30: 13,
        avg_score_in_top30: 0.589,
        max_score: 0.6283407,
        best_rank_in_top30: 1,
        rank_mass_top30: 2.896,
        max_ordering_score: 0.7351226922973553,
      },
      {
        rada_nreg: '4651-17',
        count_in_top30: 8,
        avg_score_in_top30: 0.591,
        max_score: 0.61194015,
        best_rank_in_top30: 11,
        rank_mass_top30: 0.5661398242280595,
        max_ordering_score: 0.3522097235605877,
      },
    ],
    getActMeta: async (rada_nreg) => {
      const byNreg: Record<string, { title: string; category: string; document_type: string; document_type_slug: string; storage_category: string | null }> = {
        '2341-14': {
          title: 'Кримінальний кодекс України',
          category: 'criminal',
          document_type: 'Кодекс',
          document_type_slug: 'code',
          storage_category: null,
        },
        '4651-17': {
          title: 'Кримінальний процесуальний кодекс України',
          category: 'criminal_procedure',
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
        act_kind: classifyActKind(
          act.act_title ?? '',
          act.document_type ?? null,
          act.category ?? null,
          act.document_type_slug ?? null
        ),
        confidence,
      })),
    searchActsForRouting: async () => [],
  });
  const selectedNregs = result.selected_acts_final.map((act) => act.rada_nreg).sort();
  if (result.low_confidence_final) {
    throw new Error(`Expected grounded mixed bundle to remain confident, got low_confidence with ${JSON.stringify(result.reasonCodes)}`);
  }
  if (result.coverageGap !== 'none') {
    throw new Error(`Expected grounded mixed bundle to keep coverage_gap=none, got ${result.coverageGap}`);
  }
  if (JSON.stringify(selectedNregs) !== JSON.stringify(['2341-14', '4651-17'])) {
    throw new Error(`Expected grounded mixed bundle to preserve substantive + procedural acts, got ${JSON.stringify(result.selected_acts_final)}`);
  }
  if (!result.reasonCodes.includes('ACT_SCOPE_PRESERVED_PROCEDURAL_SUPPORT')) {
    throw new Error(`Expected grounded mixed bundle to record preserved procedural support, got ${JSON.stringify(result.reasonCodes)}`);
  }
  console.log('[OK] single-goal finalizer preserves strong procedural primary-law support inside grounded mixed bundles');
}

async function testResolveSingleGoalSelectedActsPreservesExplicitHintedNonPrimarySupportForGroundedBundle(): Promise<void> {
  const result = await resolveSingleGoalSelectedActs({
    query: 'Які пункти Порядку обчислення середньої заробітної плати треба дивитися для виплат при звільненні і які норми КЗпП це підтримують?',
    goalId: 'goal_0',
    finalHits: [
      ...Array.from({ length: 6 }, (_, index) => ({
        rada_nreg: '100-95-п',
        r2_key: `r2://100-95-p/${index}`,
        json_path: `$.chunks[${index}]`,
        score: 0.66 - index * 0.01,
        ordering_score: 0.74 - index * 0.01,
        title: 'Про затвердження Порядку обчислення середньої заробітної плати',
        point_number: String(index + 1),
      })),
      ...Array.from({ length: 4 }, (_, index) => ({
        rada_nreg: '322-08',
        r2_key: `r2://322-08/${index}`,
        json_path: `$.chunks[${index}]`,
        score: 0.62 - index * 0.01,
        ordering_score: 0.41 - index * 0.01,
        title: 'Кодекс законів про працю України',
        article_number: index === 0 ? '116' : '117',
      })),
    ] as never,
    actCandidatesTopHydrated: [
      {
        rada_nreg: '322-08',
        title: 'Кодекс законів про працю України',
        score: 6.3,
        category: 'labor_social',
        document_type: 'Кодекс',
        document_type_slug: 'code',
        reasons: ['exact_alias_match', 'alias_match', 'category_hint', 'validity_in_force', 'hits_evidence'],
      },
      {
        rada_nreg: '100-95-п',
        title: 'Про затвердження Порядку обчислення середньої заробітної плати',
        score: 4.4,
        category: 'labor_social',
        document_type: 'Постанова',
        document_type_slug: 'cmu_resolution',
        reasons: ['title_match', 'document_type_hint', 'hits_evidence'],
      },
    ],
    plannerRationaleByNreg: new Map(),
    taxonomyNregs: new Set(['322-08', '100-95-п']),
    actsSearchNregs: [],
    domainHint: 'labor',
    documentTypeHints: ['Порядок', 'Кодекс'],
    taxonomyActCount: 2,
    aliasHitCount: 1,
    exactActHitCount: 0,
    exactActNregs: [],
    groundedActHitCount: 1,
    groundedActNregs: ['322-08'],
    actSelectionLowConfidence: false,
    reasonCodes: [],
    useLowConfidenceFallback: false,
    queryRewriteMeta: { called: false, used: false, not_used_reason_codes: ['STRONG_TAXONOMY_SIGNAL'] },
    topScore: 0.66,
    avgScore: 0.61,
    categoryHintsCount: 1,
    entitiesCount: 1,
    anchorsCount: 2,
    domainWeak: false,
    precomputedChunksEvidenceTopActs: [
      {
        rada_nreg: '100-95-п',
        count_in_top30: 8,
        avg_score_in_top30: 0.61,
        max_score: 0.66,
        best_rank_in_top30: 1,
        rank_mass_top30: 1.92,
        max_ordering_score: 0.74,
      },
      {
        rada_nreg: '322-08',
        count_in_top30: 5,
        avg_score_in_top30: 0.58,
        max_score: 0.62,
        best_rank_in_top30: 7,
        rank_mass_top30: 0.81,
        max_ordering_score: 0.41,
      },
    ],
    getActMeta: async (rada_nreg) => {
      const byNreg: Record<string, { title: string; category: string; document_type: string; document_type_slug: string; storage_category: string | null }> = {
        '322-08': {
          title: 'Кодекс законів про працю України',
          category: 'labor_social',
          document_type: 'Кодекс',
          document_type_slug: 'code',
          storage_category: null,
        },
        '100-95-п': {
          title: 'Про затвердження Порядку обчислення середньої заробітної плати',
          category: 'labor_social',
          document_type: 'Постанова',
          document_type_slug: 'cmu_resolution',
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
        act_kind: classifyActKind(
          act.act_title ?? '',
          act.document_type ?? null,
          act.category ?? null,
          act.document_type_slug ?? null
        ),
        confidence,
      })),
    searchActsForRouting: async () => [],
  });
  const selectedNregs = result.selected_acts_final.map((act) => act.rada_nreg);
  if (result.low_confidence_final) {
    throw new Error(`Expected grounded labor mixed-source bundle to remain confident, got ${JSON.stringify(result.reasonCodes)}`);
  }
  if (result.coverageGap !== 'none') {
    throw new Error(`Expected grounded labor mixed-source bundle to keep coverage_gap=none, got ${result.coverageGap}`);
  }
  if (JSON.stringify(selectedNregs) !== JSON.stringify(['100-95-п', '322-08'])) {
    throw new Error(`Expected grounded labor mixed-source bundle to preserve code + hinted order, got ${JSON.stringify(result.selected_acts_final)}`);
  }
  if (!result.reasonCodes.includes('ACT_SCOPE_PRESERVED_HINTED_SUPPORT_ACT')) {
    throw new Error(`Expected explicit hinted support preservation reason code, got ${JSON.stringify(result.reasonCodes)}`);
  }
  console.log('[OK] single-goal finalizer preserves explicit hinted non-primary support inside grounded law + bylaw bundles');
}

async function testResolveSingleGoalSelectedActsPreservesTitleAnchoredNonPrimarySupportWithoutDocumentHints(): Promise<void> {
  const result = await resolveSingleGoalSelectedActs({
    query: 'Які пункти Порядку обчислення середньої заробітної плати треба дивитися для виплат при звільненні і які норми КЗпП це підтримують?',
    goalId: 'goal_0',
    finalHits: [
      ...Array.from({ length: 6 }, (_, index) => ({
        rada_nreg: '100-95-п',
        r2_key: `r2://100-95-p/${index}`,
        json_path: `$.chunks[${index}]`,
        score: 0.66 - index * 0.01,
        ordering_score: 0.74 - index * 0.01,
        title: 'Про затвердження Порядку обчислення середньої заробітної плати',
        point_number: String(index + 1),
      })),
      ...Array.from({ length: 4 }, (_, index) => ({
        rada_nreg: '322-08',
        r2_key: `r2://322-08/${index}`,
        json_path: `$.chunks[${index}]`,
        score: 0.62 - index * 0.01,
        ordering_score: 0.41 - index * 0.01,
        title: 'Кодекс законів про працю України',
        article_number: index === 0 ? '116' : '117',
      })),
    ] as never,
    actCandidatesTopHydrated: [
      {
        rada_nreg: '322-08',
        title: 'Кодекс законів про працю України',
        score: 6.3,
        category: 'labor_social',
        document_type: 'Кодекс',
        document_type_slug: 'code',
        reasons: ['exact_alias_match', 'alias_match', 'category_hint', 'validity_in_force', 'hits_evidence'],
      },
      {
        rada_nreg: '100-95-п',
        title: 'Про затвердження Порядку обчислення середньої заробітної плати',
        score: 4.4,
        category: 'labor_social',
        document_type: 'Постанова',
        document_type_slug: 'cmu_resolution',
        reasons: ['title_match', 'hits_evidence'],
      },
    ],
    plannerRationaleByNreg: new Map(),
    taxonomyNregs: new Set(['322-08', '100-95-п']),
    actsSearchNregs: [],
    domainHint: 'labor',
    documentTypeHints: [],
    taxonomyActCount: 2,
    aliasHitCount: 1,
    exactActHitCount: 0,
    exactActNregs: [],
    groundedActHitCount: 1,
    groundedActNregs: ['322-08'],
    actSelectionLowConfidence: false,
    reasonCodes: [],
    useLowConfidenceFallback: false,
    queryRewriteMeta: { called: false, used: false, not_used_reason_codes: ['STRONG_TAXONOMY_SIGNAL'] },
    topScore: 0.66,
    avgScore: 0.61,
    categoryHintsCount: 1,
    entitiesCount: 1,
    anchorsCount: 2,
    domainWeak: false,
    precomputedChunksEvidenceTopActs: [
      {
        rada_nreg: '100-95-п',
        count_in_top30: 8,
        avg_score_in_top30: 0.61,
        max_score: 0.66,
        best_rank_in_top30: 1,
        rank_mass_top30: 1.92,
        max_ordering_score: 0.74,
      },
      {
        rada_nreg: '322-08',
        count_in_top30: 5,
        avg_score_in_top30: 0.58,
        max_score: 0.62,
        best_rank_in_top30: 7,
        rank_mass_top30: 0.81,
        max_ordering_score: 0.41,
      },
    ],
    getActMeta: async (rada_nreg) => {
      const byNreg: Record<string, { title: string; category: string; document_type: string; document_type_slug: string; storage_category: string | null }> = {
        '322-08': {
          title: 'Кодекс законів про працю України',
          category: 'labor_social',
          document_type: 'Кодекс',
          document_type_slug: 'code',
          storage_category: null,
        },
        '100-95-п': {
          title: 'Про затвердження Порядку обчислення середньої заробітної плати',
          category: 'labor_social',
          document_type: 'Постанова',
          document_type_slug: 'cmu_resolution',
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
        act_kind: classifyActKind(
          act.act_title ?? '',
          act.document_type ?? null,
          act.category ?? null,
          act.document_type_slug ?? null
        ),
        confidence,
      })),
    searchActsForRouting: async () => [],
  });
  const selectedNregs = result.selected_acts_final.map((act) => act.rada_nreg).sort();
  if (JSON.stringify(selectedNregs) !== JSON.stringify(['100-95-п', '322-08'])) {
    throw new Error(`Expected title-anchored law + bylaw bundle to preserve code + order even without document hints, got ${JSON.stringify(result.selected_acts_final)}`);
  }
  if (!result.reasonCodes.includes('ACT_SCOPE_PRESERVED_HINTED_SUPPORT_ACT')) {
    throw new Error(`Expected title-anchored support preservation reason code without document hints, got ${JSON.stringify(result.reasonCodes)}`);
  }
  console.log('[OK] single-goal finalizer preserves title-anchored non-primary support inside grounded bundle even without U2 document hints');
}

async function testResolveSingleGoalSelectedActsDoesNotPreserveProceduralSupportOnGenericDeadlineWording(): Promise<void> {
  const result = await resolveSingleGoalSelectedActs({
    query: 'ККУ ст. 190 санкція та строк давності',
    goalId: 'goal_0',
    finalHits: [
      ...Array.from({ length: 6 }, (_, index) => ({
        rada_nreg: '2341-14',
        r2_key: `r2://2341-generic/${index}`,
        json_path: `$.chunks[${index}]`,
        score: 0.63 - index * 0.01,
        ordering_score: 0.73 - index * 0.01,
        title: 'Кримінальний кодекс України',
        article_number: '190',
      })),
      ...Array.from({ length: 4 }, (_, index) => ({
        rada_nreg: '4651-17',
        r2_key: `r2://4651-generic/${index}`,
        json_path: `$.chunks[${index}]`,
        score: 0.61 - index * 0.01,
        ordering_score: 0.36 - index * 0.01,
        title: 'Кримінальний процесуальний кодекс України',
        article_number: '216',
      })),
    ] as never,
    actCandidatesTopHydrated: [
      {
        rada_nreg: '2341-14',
        title: 'Кримінальний кодекс України',
        score: 6.18,
        category: 'criminal',
        document_type: 'Кодекс',
        document_type_slug: 'code',
        reasons: ['exact_alias_match', 'alias_match', 'category_hint', 'validity_in_force', 'hits_evidence'],
      },
      {
        rada_nreg: '4651-17',
        title: 'Кримінальний процесуальний кодекс України',
        score: 0,
        category: 'criminal_procedure',
        document_type: 'Кодекс',
        document_type_slug: 'code',
        reasons: ['chunks_evidence_meta'],
      },
    ],
    plannerRationaleByNreg: new Map(),
    taxonomyNregs: new Set(['2341-14', '4651-17']),
    actsSearchNregs: [],
    domainHint: 'criminal',
    documentTypeHints: ['Кодекс'],
    taxonomyActCount: 4,
    aliasHitCount: 1,
    exactActHitCount: 0,
    exactActNregs: [],
    groundedActHitCount: 1,
    groundedActNregs: ['2341-14'],
    actSelectionLowConfidence: false,
    reasonCodes: [],
    useLowConfidenceFallback: false,
    queryRewriteMeta: { called: false, used: false, not_used_reason_codes: ['STRONG_TAXONOMY_SIGNAL'] },
    topScore: 0.6283407,
    avgScore: 0.59,
    categoryHintsCount: 1,
    entitiesCount: 1,
    anchorsCount: 2,
    domainWeak: false,
    precomputedChunksEvidenceTopActs: [
      {
        rada_nreg: '2341-14',
        count_in_top30: 13,
        avg_score_in_top30: 0.589,
        max_score: 0.6283407,
        best_rank_in_top30: 1,
        rank_mass_top30: 2.896,
        max_ordering_score: 0.7351226922973553,
      },
      {
        rada_nreg: '4651-17',
        count_in_top30: 8,
        avg_score_in_top30: 0.591,
        max_score: 0.61194015,
        best_rank_in_top30: 11,
        rank_mass_top30: 0.5661398242280595,
        max_ordering_score: 0.3522097235605877,
      },
    ],
    getActMeta: async (rada_nreg) => {
      const byNreg: Record<string, { title: string; category: string; document_type: string; document_type_slug: string; storage_category: string | null }> = {
        '2341-14': {
          title: 'Кримінальний кодекс України',
          category: 'criminal',
          document_type: 'Кодекс',
          document_type_slug: 'code',
          storage_category: null,
        },
        '4651-17': {
          title: 'Кримінальний процесуальний кодекс України',
          category: 'criminal_procedure',
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
        act_kind: classifyActKind(
          act.act_title ?? '',
          act.document_type ?? null,
          act.category ?? null,
          act.document_type_slug ?? null
        ),
        confidence,
      })),
    searchActsForRouting: async () => [],
  });
  const selectedNregs = result.selected_acts_final.map((act) => act.rada_nreg);
  if (JSON.stringify(selectedNregs) !== JSON.stringify(['2341-14'])) {
    throw new Error(`Expected generic deadline wording to keep only grounded substantive act, got ${JSON.stringify(result.selected_acts_final)}`);
  }
  if (result.reasonCodes.includes('ACT_SCOPE_PRESERVED_PROCEDURAL_SUPPORT')) {
    throw new Error(`Did not expect preserved procedural support for generic deadline wording, got ${JSON.stringify(result.reasonCodes)}`);
  }
  if (result.coverageGap === 'likely_missing_act' || result.coverageGap === 'out_of_scope') {
    throw new Error(`Did not expect generic deadline wording to be treated as missing-act gap, got ${JSON.stringify(result.reasonCodes)}`);
  }
  console.log('[OK] single-goal finalizer avoids preserving procedural support on generic deadline wording');
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

async function testResolveSingleGoalSelectedActsRecoversAnchoredDescriptiveSubordinateAct(): Promise<void> {
  const result = await resolveSingleGoalSelectedActs({
    query: 'Яким розпорядженням закрито дисциплінарне провадження і хто прийняв це рішення?',
    goalId: 'goal_1',
    finalHits: [
      ...Array.from({ length: 6 }, (_, index) => ({
        rada_nreg: index % 2 === 0 ? '392/2020' : '1697-18',
        r2_key: `r2://noise/${index}`,
        json_path: `$.chunks[${index}]`,
        score: 0.54 - index * 0.02,
        ordering_score: 0.33 - index * 0.01,
        title:
          index % 2 === 0
            ? 'Про рішення Ради національної безпеки і оборони України від 14 вересня 2020 року "Про Стратегію національної безпеки України"'
            : 'Про прокуратуру',
      })),
      {
        rada_nreg: '19-2026-р',
        r2_key: 'r2://19/1',
        json_path: '$.chunks[0]',
        score: 0.526,
        ordering_score: 0.277,
        title: 'Про закриття дисциплінарного провадження',
        unit_type: 'paragraph',
        unit_number: '1',
      },
    ] as never,
    actCandidatesTopHydrated: [
      {
        rada_nreg: '19-2026-р',
        title: 'Про закриття дисциплінарного провадження',
        score: 7.37,
        category: 'administrative',
        document_type: 'Розпорядження КМУ',
        document_type_slug: 'cmu_order',
        reasons: ['keyword_match', 'title_match', 'summary_match', 'category_hint', 'validity_in_force', 'hits_evidence'],
      },
      {
        rada_nreg: 'v6-3_700-08',
        title: 'Щодо порушення десятиденного строку розгляду заяв',
        score: 4.88,
        category: 'judiciary_justice',
        document_type: 'Постанова Пленуму Верховного Суду',
        document_type_slug: 'court_explanation',
        reasons: ['keyword_match', 'topic_match', 'validity_in_force', 'hits_evidence'],
      },
      {
        rada_nreg: '392/2020',
        title:
          'Про рішення Ради національної безпеки і оборони України від 14 вересня 2020 року "Про Стратегію національної безпеки України"',
        score: 4.71,
        category: 'national_security',
        document_type: 'Указ Президента',
        document_type_slug: 'presidential_decree',
        reasons: ['summary_match', 'keyword_match', 'topic_match', 'title_match', 'validity_in_force', 'hits_evidence'],
      },
      {
        rada_nreg: '1697-18',
        title: 'Про прокуратуру',
        score: 2.2,
        category: 'judiciary_justice',
        document_type: 'Закон',
        document_type_slug: 'law',
        reasons: ['keyword_match', 'summary_match', 'hits_evidence'],
      },
    ],
    plannerRationaleByNreg: new Map(),
    taxonomyNregs: new Set(['19-2026-р', 'v6-3_700-08', '392/2020']),
    actsSearchNregs: [],
    domainHint: 'administrative',
    documentTypeHints: ['Розпорядження КМУ'],
    taxonomyActCount: 8,
    aliasHitCount: 0,
    exactActHitCount: 0,
    exactActNregs: [],
    groundedActHitCount: 0,
    groundedActNregs: [],
    actSelectionLowConfidence: false,
    reasonCodes: [],
    useLowConfidenceFallback: false,
    queryRewriteMeta: { called: false, used: false, not_used_reason_codes: ['STRONG_TAXONOMY_SIGNAL'] },
    topScore: 0.53890216,
    avgScore: 0.41,
    categoryHintsCount: 1,
    entitiesCount: 0,
    anchorsCount: 0,
    domainWeak: false,
    precomputedChunksEvidenceTopActs: [
      {
        rada_nreg: '392/2020',
        count_in_top30: 17,
        avg_score_in_top30: 0.287,
        max_score: 0.36,
        best_rank_in_top30: 2,
        rank_mass_top30: 1.65,
        max_ordering_score: 0.329,
      },
      {
        rada_nreg: '1697-18',
        count_in_top30: 6,
        avg_score_in_top30: 0.398,
        max_score: 0.539,
        best_rank_in_top30: 1,
        rank_mass_top30: 1.34,
        max_ordering_score: 0.526,
      },
      {
        rada_nreg: '19-2026-р',
        count_in_top30: 1,
        avg_score_in_top30: 0.526,
        max_score: 0.526,
        best_rank_in_top30: 8,
        rank_mass_top30: 0.125,
        max_ordering_score: 0.277,
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
        '392/2020': {
          title:
            'Про рішення Ради національної безпеки і оборони України від 14 вересня 2020 року "Про Стратегію національної безпеки України"',
          category: 'national_security',
          document_type: 'Указ Президента',
          document_type_slug: 'presidential_decree',
          storage_category: null,
        },
        '1697-18': {
          title: 'Про прокуратуру',
          category: 'judiciary_justice',
          document_type: 'Закон',
          document_type_slug: 'law',
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
    throw new Error(
      `Expected anchored descriptive subordinate-act query to recover confidently, got low_confidence with ${JSON.stringify(result.reasonCodes)}`
    );
  }
  if (result.coverageGap !== 'none') {
    throw new Error(
      `Expected anchored descriptive subordinate-act query to keep coverage_gap=none, got ${result.coverageGap}`
    );
  }
  if (result.selected_acts_final.length !== 1 || result.selected_acts_final[0]?.rada_nreg !== '19-2026-р') {
    throw new Error(
      `Expected anchored descriptive subordinate-act query to recover 19-2026-р, got ${JSON.stringify(result.selected_acts_final)}`
    );
  }
  if (
    !result.reasonCodes.includes('METADATA_ACT_SCOPE_RECOVERED') ||
    !result.reasonCodes.includes('METADATA_ACT_SCOPE_CONFIRMED')
  ) {
    throw new Error(
      `Expected anchored descriptive subordinate-act recovery reason codes, got ${JSON.stringify(result.reasonCodes)}`
    );
  }
  console.log('[OK] single-goal finalizer recovers anchored descriptive subordinate-act titles from noisy heads');
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

async function testResolveSingleGoalSelectedActsFlagsUngroundedGeneralMultiFamilySelection(): Promise<void> {
  const result = await resolveSingleGoalSelectedActs({
    query: 'Які права має особа на видалення своїх даних і які засоби захисту є при бездіяльності володільця?',
    goalId: 'goal_0',
    finalHits: [
      {
        rada_nreg: '435-15',
        r2_key: 'r2://435/20',
        json_path: '$.chunks[20]',
        score: 0.57,
        ordering_score: 0.0,
        title: 'Цивільний кодекс України',
        article_number: '20',
      },
      {
        rada_nreg: '2747-15',
        r2_key: 'r2://2747/2',
        json_path: '$.chunks[2]',
        score: 0.56,
        ordering_score: 0.0,
        title: 'Кодекс адміністративного судочинства України',
        article_number: '2',
      },
    ] as never,
    actCandidatesTopHydrated: [
      {
        rada_nreg: '435-15',
        title: 'Цивільний кодекс України',
        score: 1.7,
        category: 'civil',
        document_type: 'Кодекс',
        document_type_slug: 'code',
      },
      {
        rada_nreg: '2747-15',
        title: 'Кодекс адміністративного судочинства України',
        score: 1.5,
        category: 'judiciary_justice',
        document_type: 'Кодекс',
        document_type_slug: 'code',
      },
    ],
    plannerRationaleByNreg: new Map(),
    taxonomyNregs: new Set(),
    actsSearchNregs: [],
    domainHint: 'general',
    documentTypeHints: [],
    taxonomyActCount: 0,
    aliasHitCount: 0,
    exactActHitCount: 0,
    exactActNregs: [],
    groundedActHitCount: 0,
    groundedActNregs: [],
    actSelectionLowConfidence: false,
    reasonCodes: ['CHUNKS_FAMILY_MISMATCH_DEMOTED', 'SUPPORT_FAMILY_MISMATCH_BLOCKED'],
    useLowConfidenceFallback: false,
    queryRewriteMeta: { called: false, used: false, not_used_reason_codes: [] },
    topScore: 0.57,
    avgScore: 0.56,
    categoryHintsCount: 0,
    entitiesCount: 0,
    anchorsCount: 0,
    domainWeak: false,
    precomputedChunksEvidenceTopActs: [
      {
        rada_nreg: '435-15',
        count_in_top30: 4,
        avg_score_in_top30: 0.55,
        max_score: 0.57,
        best_rank_in_top30: 1,
        rank_mass_top30: 0.41,
        max_ordering_score: 0.0,
      },
      {
        rada_nreg: '2747-15',
        count_in_top30: 4,
        avg_score_in_top30: 0.54,
        max_score: 0.56,
        best_rank_in_top30: 2,
        rank_mass_top30: 0.36,
        max_ordering_score: 0.0,
      },
    ],
    getActMeta: async (rada_nreg) => {
      const byNreg: Record<string, { title: string; category: string; document_type: string; document_type_slug: string; storage_category: string | null }> = {
        '435-15': {
          title: 'Цивільний кодекс України',
          category: 'civil',
          document_type: 'Кодекс',
          document_type_slug: 'code',
          storage_category: null,
        },
        '2747-15': {
          title: 'Кодекс адміністративного судочинства України',
          category: 'judiciary_justice',
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
        act_kind: classifyActKind(
          act.act_title ?? '',
          act.document_type ?? null,
          act.category ?? null,
          act.document_type_slug ?? null
        ),
        confidence,
      })),
    searchActsForRouting: async () => [],
  });
  if (!result.low_confidence_final) {
    throw new Error(`Expected ungrounded multi-family general query to be low confidence, got ${JSON.stringify(result.reasonCodes)}`);
  }
  if (result.coverageGap !== 'weak_evidence' && result.coverageGap !== 'likely_missing_act') {
    throw new Error(`Expected ungrounded multi-family general query to map to a non-none coverage gap, got ${result.coverageGap}`);
  }
  if (!result.reasonCodes.includes('UNGROUNDED_MULTI_FAMILY_SELECTION')) {
    throw new Error(`Expected UNGROUNDED_MULTI_FAMILY_SELECTION reason code, got ${JSON.stringify(result.reasonCodes)}`);
  }
  console.log('[OK] single-goal finalizer flags ungrounded general multi-family primary-law fallback as weak evidence');
}

async function testResolveSingleGoalSelectedActsRecoversEvidenceDominantExplicitActScope(): Promise<void> {
  const result = await resolveSingleGoalSelectedActs({
    query: 'За законом про адміністративну процедуру який строк на оскарження індивідуального акта?',
    goalId: 'goal_0',
    finalHits: [
      {
        rada_nreg: '2073-20',
        r2_key: 'r2://2073/92',
        json_path: '$.chunks[92]',
        score: 0.578,
        ordering_score: 0.553,
        title: 'Про адміністративну процедуру',
        article_number: '92',
      },
      {
        rada_nreg: '2073-20',
        r2_key: 'r2://2073/93',
        json_path: '$.chunks[93]',
        score: 0.56,
        ordering_score: 0.543,
        title: 'Про адміністративну процедуру',
        article_number: '93',
      },
      {
        rada_nreg: '2073-20',
        r2_key: 'r2://2073/70',
        json_path: '$.chunks[70]',
        score: 0.539,
        ordering_score: 0.541,
        title: 'Про адміністративну процедуру',
        article_number: '70',
      },
      {
        rada_nreg: '2073-20',
        r2_key: 'r2://2073/88',
        json_path: '$.chunks[88]',
        score: 0.541,
        ordering_score: 0.537,
        title: 'Про адміністративну процедуру',
        article_number: '88',
      },
      {
        rada_nreg: '2073-20',
        r2_key: 'r2://2073/34',
        json_path: '$.chunks[34]',
        score: 0.547,
        ordering_score: 0.483,
        title: 'Про адміністративну процедуру',
        article_number: '34',
      },
      {
        rada_nreg: '1697-18',
        r2_key: 'r2://1697/50',
        json_path: '$.chunks[50]',
        score: 0.47,
        ordering_score: 0.445,
        title: 'Про прокуратуру',
        article_number: '50',
      },
      {
        rada_nreg: '2747-15',
        r2_key: 'r2://2747/289',
        json_path: '$.chunks[289]',
        score: 0.537,
        ordering_score: 0.437,
        title: 'Кодекс адміністративного судочинства України',
        article_number: '289',
      },
    ] as never,
    actCandidatesTopHydrated: [
      {
        rada_nreg: '2747-15',
        title: 'Кодекс адміністративного судочинства України',
        score: 1.4,
        category: 'judiciary_justice',
        document_type: 'Кодекс',
        document_type_slug: 'code',
      },
      {
        rada_nreg: '1697-18',
        title: 'Про прокуратуру',
        score: 1.2,
        category: 'judiciary_justice',
        document_type: 'Закон України',
        document_type_slug: 'law',
      },
      {
        rada_nreg: '2073-20',
        title: 'Про адміністративну процедуру',
        score: 0.8,
        category: 'administrative',
        document_type: 'Закон України',
        document_type_slug: 'law',
        reasons: ['summary_match'],
      },
    ],
    plannerRationaleByNreg: new Map(),
    taxonomyNregs: new Set(),
    actsSearchNregs: [],
    domainHint: 'administrative',
    documentTypeHints: ['law'],
    taxonomyActCount: 0,
    aliasHitCount: 0,
    exactActHitCount: 0,
    exactActNregs: [],
    groundedActHitCount: 0,
    groundedActNregs: [],
    actSelectionLowConfidence: false,
    reasonCodes: ['NON_PRIMARY_SUPPORT_BLOCKED_PRIMARY_PRESENT'],
    useLowConfidenceFallback: false,
    queryRewriteMeta: { called: false, used: false, not_used_reason_codes: [] },
    topScore: 0.5775986,
    avgScore: 0.54,
    categoryHintsCount: 1,
    entitiesCount: 0,
    anchorsCount: 0,
    domainWeak: false,
    precomputedChunksEvidenceTopActs: [
      {
        rada_nreg: '2073-20',
        count_in_top30: 8,
        avg_score_in_top30: 0.55,
        max_score: 0.578,
        best_rank_in_top30: 1,
        rank_mass_top30: 2.15,
        max_ordering_score: 0.553,
      },
      {
        rada_nreg: '2747-15',
        count_in_top30: 2,
        avg_score_in_top30: 0.49,
        max_score: 0.537,
        best_rank_in_top30: 10,
        rank_mass_top30: 0.37,
        max_ordering_score: 0.437,
      },
      {
        rada_nreg: '1697-18',
        count_in_top30: 2,
        avg_score_in_top30: 0.45,
        max_score: 0.47,
        best_rank_in_top30: 9,
        rank_mass_top30: 0.29,
        max_ordering_score: 0.445,
      },
    ],
    getActMeta: async (rada_nreg) => {
      const byNreg: Record<string, { title: string; category: string; document_type: string; document_type_slug: string; storage_category: string | null }> = {
        '2073-20': {
          title: 'Про адміністративну процедуру',
          category: 'administrative',
          document_type: 'Закон України',
          document_type_slug: 'law',
          storage_category: 'administrative',
        },
        '2747-15': {
          title: 'Кодекс адміністративного судочинства України',
          category: 'judiciary_justice',
          document_type: 'Кодекс',
          document_type_slug: 'code',
          storage_category: null,
        },
        '1697-18': {
          title: 'Про прокуратуру',
          category: 'judiciary_justice',
          document_type: 'Закон України',
          document_type_slug: 'law',
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
        act_kind: classifyActKind(
          act.act_title ?? '',
          act.document_type ?? null,
          act.category ?? null,
          act.document_type_slug ?? null
        ),
        confidence,
      })),
    searchActsForRouting: async () => [],
  });
  if (result.low_confidence_final) {
    throw new Error(`Expected evidence-dominant explicit act scope to resolve confidently, got ${JSON.stringify(result.reasonCodes)}`);
  }
  if (result.coverageGap !== 'none') {
    throw new Error(`Expected evidence-dominant explicit act scope to keep coverage_gap=none, got ${result.coverageGap}`);
  }
  if (result.selected_acts_final.length !== 1 || result.selected_acts_final[0]?.rada_nreg !== '2073-20') {
    throw new Error(`Expected evidence-dominant explicit act scope to keep 2073-20 selected, got ${JSON.stringify(result.selected_acts_final)}`);
  }
  if (!result.reasonCodes.includes('EVIDENCE_ACT_SCOPE_CONFIRMED')) {
    throw new Error(`Expected EVIDENCE_ACT_SCOPE_CONFIRMED reason code, got ${JSON.stringify(result.reasonCodes)}`);
  }
  if (result.reasonCodes.includes('EXPLICIT_ACT_SCOPE_NO_CONVERGENCE')) {
    throw new Error(`Expected evidence-dominant explicit act scope to avoid false no-convergence, got ${JSON.stringify(result.reasonCodes)}`);
  }
  console.log('[OK] single-goal finalizer recovers explicit act scope from dominant chunks evidence');
}

async function testResolveSingleGoalSelectedActsRecoversSpecialLawLocatorFromCoverageWeightedEvidence(): Promise<void> {
  const result = await resolveSingleGoalSelectedActs({
    query:
      'Який спеціальний закон визначає процедури defense procurement і підстави для закриття інформації про таку закупівлю?',
    goalId: 'goal_0',
    finalHits: [
      {
        rada_nreg: '922-19',
        r2_key: 'r2://922/13',
        json_path: '$.chunks[13]',
        score: 0.537,
        ordering_score: 0.614,
        title: 'Про публічні закупівлі',
        article_number: '13',
      },
      {
        rada_nreg: '922-19',
        r2_key: 'r2://922/40',
        json_path: '$.chunks[40]',
        score: 0.562,
        ordering_score: 0.537,
        title: 'Про публічні закупівлі',
        article_number: '40',
      },
      {
        rada_nreg: '808-20',
        r2_key: 'r2://808/21',
        json_path: '$.chunks[21]',
        score: 0.54,
        ordering_score: 0.523,
        title: 'Про оборонні закупівлі',
        article_number: '21',
      },
      {
        rada_nreg: '808-20',
        r2_key: 'r2://808/18',
        json_path: '$.chunks[18]',
        score: 0.567,
        ordering_score: 0.5,
        title: 'Про оборонні закупівлі',
        article_number: '18',
      },
      {
        rada_nreg: '1178-2022-п',
        r2_key: 'r2://1178/81',
        json_path: '$.chunks[81]',
        score: 0.537,
        ordering_score: 0.482,
        title:
          'Про затвердження особливостей здійснення публічних закупівель товарів, робіт і послуг для замовників, передбачених Законом України “Про публічні закупівлі”, на період дії правового режиму воєнного стану в Україні та протягом 90 днів з дня його припинення або скасування',
        unit_type: 'point',
        unit_number: '81',
      },
      {
        rada_nreg: '808-20',
        r2_key: 'r2://808/27',
        json_path: '$.chunks[27]',
        score: 0.556,
        ordering_score: 0.479,
        title: 'Про оборонні закупівлі',
        article_number: '27',
      },
      {
        rada_nreg: '808-20',
        r2_key: 'r2://808/30',
        json_path: '$.chunks[30]',
        score: 0.585,
        ordering_score: 0.479,
        title: 'Про оборонні закупівлі',
        article_number: '30',
      },
      {
        rada_nreg: '808-20',
        r2_key: 'r2://808/28',
        json_path: '$.chunks[28]',
        score: 0.565,
        ordering_score: 0.471,
        title: 'Про оборонні закупівлі',
        article_number: '28',
      },
      {
        rada_nreg: '922-19',
        r2_key: 'r2://922/34',
        json_path: '$.chunks[34]',
        score: 0.549,
        ordering_score: 0.462,
        title: 'Про публічні закупівлі',
        article_number: '34',
      },
      {
        rada_nreg: '808-20',
        r2_key: 'r2://808/16',
        json_path: '$.chunks[16]',
        score: 0.553,
        ordering_score: 0.456,
        title: 'Про оборонні закупівлі',
        article_number: '16',
      },
      {
        rada_nreg: '808-20',
        r2_key: 'r2://808/34',
        json_path: '$.chunks[34]',
        score: 0.545,
        ordering_score: 0.453,
        title: 'Про оборонні закупівлі',
        article_number: '34',
      },
      {
        rada_nreg: '808-20',
        r2_key: 'r2://808/4',
        json_path: '$.chunks[4]',
        score: 0.56,
        ordering_score: 0.453,
        title: 'Про оборонні закупівлі',
        article_number: '4',
      },
    ] as never,
    actCandidatesTopHydrated: [
      {
        rada_nreg: '4801-20',
        title: 'Про ратифікацію Угоди між Україною та Канадою про взаємну охорону інформації з обмеженим доступом',
        score: 6.24,
        category: 'international_eu',
        document_type: 'Закон',
        document_type_slug: 'law',
        reasons: ['title_match', 'summary_match', 'keyword_match', 'topic_match', 'validity_in_force'],
      },
      {
        rada_nreg: 'v020p710-10',
        title:
          'Рішення Конституційного Суду України у справі за конституційним поданням 252 народних депутатів України щодо відповідності Конституції України (конституційності) Закону України "Про внесення змін до Конституції України" від 8 грудня 2004 року N 2222-IV (справа про додержання процедури внесення змін до Конституції України)',
        score: 6.18,
        category: 'constitutional',
        document_type: 'Рішення КСУ',
        document_type_slug: 'ccu_decision',
        reasons: ['keyword_match', 'topic_match', 'title_match', 'summary_match', 'validity_in_force'],
      },
      {
        rada_nreg: '1402-19',
        title: 'Про судоустрій і статус суддів',
        score: 4.71,
        category: 'judiciary_justice',
        document_type: 'Закон',
        document_type_slug: 'law',
        reasons: ['keyword_match', 'title_match', 'summary_match', 'validity_in_force', 'hits_evidence'],
      },
      {
        rada_nreg: '1697-18',
        title: 'Про прокуратуру',
        score: 4.56,
        category: 'judiciary_justice',
        document_type: 'Закон',
        document_type_slug: 'law',
        reasons: ['keyword_match', 'topic_match', 'title_match', 'summary_match', 'validity_in_force', 'hits_evidence'],
      },
      {
        rada_nreg: '1618-15',
        title: 'Цивільний процесуальний кодекс України',
        score: 2.25,
        category: 'civil_procedure',
        document_type: 'Кодекс',
        document_type_slug: 'code',
        reasons: ['keyword_match', 'summary_match', 'validity_in_force'],
      },
      {
        rada_nreg: '922-19',
        title: 'Про публічні закупівлі',
        score: 5.34,
        category: 'procurement',
        document_type: 'Закон',
        document_type_slug: 'law',
        reasons: ['title_match', 'summary_match', 'keyword_match', 'topic_match', 'validity_in_force', 'chunks_evidence_meta'],
      },
      {
        rada_nreg: '808-20',
        title: 'Про оборонні закупівлі',
        score: 3.09,
        category: 'defense_mobilization',
        document_type: 'Закон',
        document_type_slug: 'law',
        reasons: ['title_match', 'summary_match', 'keyword_match', 'validity_in_force', 'chunks_evidence_meta'],
      },
      {
        rada_nreg: '1178-2022-п',
        title:
          'Про затвердження особливостей здійснення публічних закупівель товарів, робіт і послуг для замовників, передбачених Законом України “Про публічні закупівлі”, на період дії правового режиму воєнного стану в Україні та протягом 90 днів з дня його припинення або скасування',
        score: 0.94,
        category: 'procurement',
        document_type: 'Постанова КМУ',
        document_type_slug: 'cmu_resolution',
        reasons: ['title_match', 'validity_in_force', 'chunks_evidence_meta'],
      },
    ],
    plannerRationaleByNreg: new Map(),
    taxonomyNregs: new Set(['4801-20', 'v020p710-10', '1402-19', '1697-18', '1618-15']),
    actsSearchNregs: [],
    domainHint: 'general',
    documentTypeHints: ['Закон'],
    taxonomyActCount: 5,
    aliasHitCount: 0,
    exactActHitCount: 0,
    exactActNregs: [],
    groundedActHitCount: 0,
    groundedActNregs: [],
    actSelectionLowConfidence: false,
    reasonCodes: ['NON_PRIMARY_SUPPORT_BLOCKED_PRIMARY_PRESENT'],
    useLowConfidenceFallback: false,
    queryRewriteMeta: { called: false, used: false, not_used_reason_codes: [] },
    topScore: 0.5852038,
    avgScore: 0.55,
    categoryHintsCount: 0,
    entitiesCount: 0,
    anchorsCount: 0,
    domainWeak: false,
    precomputedChunksEvidenceTopActs: [
      {
        rada_nreg: '922-19',
        count_in_top30: 5,
        avg_score_in_top30: 0.548,
        max_score: 0.562,
        best_rank_in_top30: 1,
        rank_mass_top30: 1.716,
        max_ordering_score: 0.614,
      },
      {
        rada_nreg: '808-20',
        count_in_top30: 11,
        avg_score_in_top30: 0.554,
        max_score: 0.585,
        best_rank_in_top30: 3,
        rank_mass_top30: 1.399,
        max_ordering_score: 0.523,
      },
      {
        rada_nreg: '1697-18',
        count_in_top30: 9,
        avg_score_in_top30: 0.338,
        max_score: 0.36,
        best_rank_in_top30: 13,
        rank_mass_top30: 0.493,
        max_ordering_score: 0.412,
      },
      {
        rada_nreg: '1178-2022-п',
        count_in_top30: 1,
        avg_score_in_top30: 0.537,
        max_score: 0.537,
        best_rank_in_top30: 5,
        rank_mass_top30: 0.2,
        max_ordering_score: 0.482,
      },
      {
        rada_nreg: '1402-19',
        count_in_top30: 4,
        avg_score_in_top30: 0.348,
        max_score: 0.37,
        best_rank_in_top30: 17,
        rank_mass_top30: 0.186,
        max_ordering_score: 0.385,
      },
    ],
    getActMeta: async (rada_nreg) => {
      const byNreg: Record<
        string,
        { title: string; category: string; document_type: string; document_type_slug: string; storage_category: string | null }
      > = {
        '4801-20': {
          title: 'Про ратифікацію Угоди між Україною та Канадою про взаємну охорону інформації з обмеженим доступом',
          category: 'international_eu',
          document_type: 'Закон',
          document_type_slug: 'law',
          storage_category: null,
        },
        'v020p710-10': {
          title:
            'Рішення Конституційного Суду України у справі за конституційним поданням 252 народних депутатів України щодо відповідності Конституції України (конституційності) Закону України "Про внесення змін до Конституції України" від 8 грудня 2004 року N 2222-IV (справа про додержання процедури внесення змін до Конституції України)',
          category: 'constitutional',
          document_type: 'Рішення КСУ',
          document_type_slug: 'ccu_decision',
          storage_category: null,
        },
        '1402-19': {
          title: 'Про судоустрій і статус суддів',
          category: 'judiciary_justice',
          document_type: 'Закон',
          document_type_slug: 'law',
          storage_category: null,
        },
        '1697-18': {
          title: 'Про прокуратуру',
          category: 'judiciary_justice',
          document_type: 'Закон',
          document_type_slug: 'law',
          storage_category: null,
        },
        '1618-15': {
          title: 'Цивільний процесуальний кодекс України',
          category: 'civil_procedure',
          document_type: 'Кодекс',
          document_type_slug: 'code',
          storage_category: null,
        },
        '922-19': {
          title: 'Про публічні закупівлі',
          category: 'procurement',
          document_type: 'Закон',
          document_type_slug: 'law',
          storage_category: null,
        },
        '808-20': {
          title: 'Про оборонні закупівлі',
          category: 'defense_mobilization',
          document_type: 'Закон',
          document_type_slug: 'law',
          storage_category: null,
        },
        '1178-2022-п': {
          title:
            'Про затвердження особливостей здійснення публічних закупівель товарів, робіт і послуг для замовників, передбачених Законом України “Про публічні закупівлі”, на період дії правового режиму воєнного стану в Україні та протягом 90 днів з дня його припинення або скасування',
          category: 'procurement',
          document_type: 'Постанова КМУ',
          document_type_slug: 'cmu_resolution',
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
        act_kind: classifyActKind(
          act.act_title ?? '',
          act.document_type ?? null,
          act.category ?? null,
          act.document_type_slug ?? null
        ),
        confidence,
      })),
    searchActsForRouting: async () => [],
  });
  if (result.low_confidence_final) {
    throw new Error(
      `Expected semantic special-law locator to recover from coverage-weighted evidence, got low_confidence with ${JSON.stringify(result.reasonCodes)}`
    );
  }
  if (result.coverageGap !== 'none') {
    throw new Error(
      `Expected semantic special-law locator to keep coverage_gap=none after evidence recovery, got ${result.coverageGap}`
    );
  }
  if (result.selected_acts_final.length !== 1 || result.selected_acts_final[0]?.rada_nreg !== '808-20') {
    throw new Error(
      `Expected semantic special-law locator to recover 808-20, got ${JSON.stringify(result.selected_acts_final)}`
    );
  }
  if (
    !result.reasonCodes.includes('EVIDENCE_ACT_SCOPE_RECOVERED') ||
    !result.reasonCodes.includes('EVIDENCE_ACT_SCOPE_CONFIRMED')
  ) {
    throw new Error(
      `Expected coverage-weighted special-law recovery reason codes, got ${JSON.stringify(result.reasonCodes)}`
    );
  }
  console.log('[OK] single-goal finalizer recovers semantic special-law locator from coverage-weighted evidence');
}

async function testResolveSingleGoalSelectedActsKeepsShortExplicitLawTitleWhenMetadataAndChunksConverge(): Promise<void> {
  const result = await resolveSingleGoalSelectedActs({
    query: 'За законом про знаки коли можна подати заперечення проти ТМ?',
    goalId: 'goal_0',
    finalHits: [
      {
        rada_nreg: '3689-12',
        r2_key: 'r2://3689/8',
        json_path: '$.chunks[8]',
        score: 0.539,
        ordering_score: 0.465,
        title: 'Про охорону прав на знаки для товарів і послуг',
        article_number: '8',
      },
      {
        rada_nreg: '3689-12',
        r2_key: 'r2://3689/11',
        json_path: '$.chunks[11]',
        score: 0.566,
        ordering_score: 0.399,
        title: 'Про охорону прав на знаки для товарів і послуг',
        article_number: '11',
      },
      {
        rada_nreg: '1697-18',
        r2_key: 'r2://1697/62',
        json_path: '$.chunks[62]',
        score: 0.351,
        ordering_score: 0.392,
        title: 'Про прокуратуру',
        article_number: '62',
      },
      {
        rada_nreg: '3689-12',
        r2_key: 'r2://3689/22',
        json_path: '$.chunks[22]',
        score: 0.534,
        ordering_score: 0.385,
        title: 'Про охорону прав на знаки для товарів і послуг',
        article_number: '22',
      },
      {
        rada_nreg: '3689-12',
        r2_key: 'r2://3689/15',
        json_path: '$.chunks[15]',
        score: 0.521,
        ordering_score: 0.379,
        title: 'Про охорону прав на знаки для товарів і послуг',
        article_number: '15',
      },
      {
        rada_nreg: '3689-12',
        r2_key: 'r2://3689/6',
        json_path: '$.chunks[6]',
        score: 0.521,
        ordering_score: 0.379,
        title: 'Про охорону прав на знаки для товарів і послуг',
        article_number: '6',
      },
      {
        rada_nreg: '3689-12',
        r2_key: 'r2://3689/16',
        json_path: '$.chunks[16]',
        score: 0.519,
        ordering_score: 0.378,
        title: 'Про охорону прав на знаки для товарів і послуг',
        article_number: '16',
      },
      {
        rada_nreg: '3689-12',
        r2_key: 'r2://3689/21',
        json_path: '$.chunks[21]',
        score: 0.515,
        ordering_score: 0.377,
        title: 'Про охорону прав на знаки для товарів і послуг',
        article_number: '21',
      },
      {
        rada_nreg: '3689-12',
        r2_key: 'r2://3689/7',
        json_path: '$.chunks[7]',
        score: 0.515,
        ordering_score: 0.376,
        title: 'Про охорону прав на знаки для товарів і послуг',
        article_number: '7',
      },
      {
        rada_nreg: '5207-17',
        r2_key: 'r2://5207/4',
        json_path: '$.chunks[4]',
        score: 0.357,
        ordering_score: 0.372,
        title: 'Про засади запобігання та протидії дискримінації в Україні',
        article_number: '4',
      },
      {
        rada_nreg: '5207-17',
        r2_key: 'r2://5207/3',
        json_path: '$.chunks[3]',
        score: 0.332,
        ordering_score: 0.371,
        title: 'Про засади запобігання та протидії дискримінації в Україні',
        article_number: '3',
      },
      {
        rada_nreg: '5207-17',
        r2_key: 'r2://5207/16',
        json_path: '$.chunks[16]',
        score: 0.332,
        ordering_score: 0.365,
        title: 'Про засади запобігання та протидії дискримінації в Україні',
        article_number: '16',
      },
    ] as never,
    actCandidatesTopHydrated: [
      {
        rada_nreg: '3689-12',
        title: 'Про охорону прав на знаки для товарів і послуг',
        score: 2.2,
        category: 'business_corporate',
        document_type: 'Закон',
        document_type_slug: 'law',
        reasons: ['title_match', 'summary_match', 'validity_in_force', 'hits_evidence'],
      },
      {
        rada_nreg: '5207-17',
        title: 'Про засади запобігання та протидії дискримінації в Україні',
        score: 1.8541,
        category: 'civil',
        document_type: 'Закон',
        document_type_slug: 'law',
        reasons: ['keyword_match', 'validity_in_force', 'hits_evidence'],
      },
      {
        rada_nreg: '995_096',
        title: "Конвенція Організації Об'єднаних Націй про боротьбу проти незаконного обігу наркотичних засобів і психотропних речовин",
        score: 1.39,
        category: 'international_eu',
        document_type: 'Міжнародний договір',
        document_type_slug: 'international_treaty',
        reasons: ['title_match', 'summary_match', 'validity_in_force'],
      },
      {
        rada_nreg: '1697-18',
        title: 'Про прокуратуру',
        score: 0.6276,
        category: 'judiciary_justice',
        document_type: 'Закон',
        document_type_slug: 'law',
        reasons: ['validity_in_force', 'hits_evidence'],
      },
    ],
    plannerRationaleByNreg: new Map(),
    taxonomyNregs: new Set(['3689-12', '5207-17', '995_096', '1697-18']),
    actsSearchNregs: [],
    domainHint: 'general',
    documentTypeHints: ['law'],
    taxonomyActCount: 4,
    aliasHitCount: 0,
    exactActHitCount: 0,
    exactActNregs: [],
    groundedActHitCount: 0,
    groundedActNregs: [],
    actSelectionLowConfidence: false,
    reasonCodes: ['CHUNKS_FAMILY_MISMATCH_DEMOTED', 'NON_PRIMARY_SUPPORT_BLOCKED_PRIMARY_PRESENT', 'DOC_TYPE_HINT_ALLOWED'],
    useLowConfidenceFallback: false,
    queryRewriteMeta: { called: false, used: false, not_used_reason_codes: ['STRONG_TAXONOMY_SIGNAL'] },
    topScore: 0.5691354,
    avgScore: 0.45,
    categoryHintsCount: 0,
    entitiesCount: 0,
    anchorsCount: 0,
    domainWeak: false,
    precomputedChunksEvidenceTopActs: [
      {
        rada_nreg: '3689-12',
        count_in_top30: 13,
        avg_score_in_top30: 0.521,
        max_score: 0.5655,
        best_rank_in_top30: 1,
        rank_mass_top30: 2.6746,
        max_ordering_score: 0.4645,
      },
      {
        rada_nreg: '5207-17',
        count_in_top30: 8,
        avg_score_in_top30: 0.315,
        max_score: 0.3574,
        best_rank_in_top30: 10,
        rank_mass_top30: 0.6073,
        max_ordering_score: 0.3718,
      },
      {
        rada_nreg: '1697-18',
        count_in_top30: 4,
        avg_score_in_top30: 0.379,
        max_score: 0.4157,
        best_rank_in_top30: 3,
        rank_mass_top30: 0.4898,
        max_ordering_score: 0.3922,
      },
    ],
    getActMeta: async (rada_nreg) => {
      const byNreg: Record<string, { title: string; category: string; document_type: string; document_type_slug: string; storage_category: string | null }> = {
        '3689-12': {
          title: 'Про охорону прав на знаки для товарів і послуг',
          category: 'business_corporate',
          document_type: 'Закон',
          document_type_slug: 'law',
          storage_category: null,
        },
        '5207-17': {
          title: 'Про засади запобігання та протидії дискримінації в Україні',
          category: 'civil',
          document_type: 'Закон',
          document_type_slug: 'law',
          storage_category: null,
        },
        '1697-18': {
          title: 'Про прокуратуру',
          category: 'judiciary_justice',
          document_type: 'Закон',
          document_type_slug: 'law',
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
        act_kind: classifyActKind(
          act.act_title ?? '',
          act.document_type ?? null,
          act.category ?? null,
          act.document_type_slug ?? null
        ),
        confidence,
      })),
    searchActsForRouting: async () => [],
  });
  if (result.low_confidence_final) {
    throw new Error(`Expected short explicit law-title query with dominant grounded evidence to resolve confidently, got ${JSON.stringify(result.reasonCodes)}`);
  }
  if (result.coverageGap !== 'none') {
    throw new Error(`Expected short explicit law-title query with dominant grounded evidence to keep coverage_gap=none, got ${result.coverageGap}`);
  }
  if (result.selected_acts_final.length !== 1 || result.selected_acts_final[0]?.rada_nreg !== '3689-12') {
    throw new Error(`Expected short explicit law-title query to keep 3689-12 selected, got ${JSON.stringify(result.selected_acts_final)}`);
  }
  if (
    !result.reasonCodes.includes('METADATA_ACT_SCOPE_CONFIRMED') &&
    !result.reasonCodes.includes('EVIDENCE_ACT_SCOPE_CONFIRMED')
  ) {
    throw new Error(`Expected short explicit law-title query to confirm act scope, got ${JSON.stringify(result.reasonCodes)}`);
  }
  if (result.reasonCodes.includes('LOW_CONFIDENCE_SELECTED_ACTS_CLEARED')) {
    throw new Error(`Expected short explicit law-title query to avoid low-confidence clearing, got ${JSON.stringify(result.reasonCodes)}`);
  }
  console.log('[OK] short explicit law-title queries stay grounded when metadata and chunks converge on one act');
}

async function testResolveSingleActScopeSelectionRecoversAnchorWhenOnlyHintedSupportActRemains(): Promise<void> {
  const result = await resolveSingleActScopeSelection({
    query:
      'За Законом України «Про ратифікацію Угоди між Урядом України та Урядом Республіки Польща про діяльність Bank Gospodarstwa Krajowego в Україні», діяльність якого саме банку в Україні врегульовується цією угодою?',
    domainHint: 'general',
    documentTypeHints: ['Закон'],
    selectedActsFinal: [
      {
        rada_nreg: 'z0841-01',
        act_title: 'Про діяльність Bank Gospodarstwa Krajowego в Україні',
        act_kind: 'SECONDARY_ORDER',
        document_type: 'Положення',
        category: 'banking',
        score: 0.82,
      },
    ],
    selectedActsSourcesBreakdownFinal: {
      from_taxonomy: [],
      from_acts_search: [],
      from_chunks_evidence: ['z0841-01'],
    },
    selectedActsFinalMeta: {
      selected_acts_final: [
        {
          rada_nreg: 'z0841-01',
          act_title: 'Про діяльність Bank Gospodarstwa Krajowego в Україні',
          act_kind: 'SECONDARY_ORDER',
          document_type: 'Положення',
          category: 'banking',
          score: 0.82,
        },
      ],
      selected_acts_confidence_final: 0.82,
      selected_acts_confidence_pre_routing: 0.82,
      selected_acts_decision_final: {
        policy_version: 1,
        included_from_chunks_evidence: true,
        reason_codes: ['SELECTED_ACTS_FROM_CHUNKS_EVIDENCE'],
      },
      selected_acts_kinds_count_final: { SECONDARY_ORDER: 1 },
      selected_acts_document_types_top_final: ['Положення'],
      routing_hints_recovered_with_retrieval_evidence: false,
    },
    reasonCodes: [],
    chunksEvidenceTopActs: [
      {
        rada_nreg: 'z0841-01',
        count_in_top30: 3,
        avg_score_in_top30: 0.61,
        max_score: 0.7,
        best_rank_in_top30: 1,
        rank_mass_top30: 1.4,
        max_ordering_score: 0.62,
      },
      {
        rada_nreg: '4800-20',
        count_in_top30: 1,
        avg_score_in_top30: 0.53,
        max_score: 0.53,
        best_rank_in_top30: 5,
        rank_mass_top30: 0.2,
        max_ordering_score: 0.45,
      },
    ],
    actCandidatesTopHydrated: [
      {
        rada_nreg: '4800-20',
        title: 'Про ратифікацію Угоди між Урядом України та Урядом Республіки Польща про діяльність Bank Gospodarstwa Krajowego в Україні',
        score: 4.6,
        category: 'international_eu',
        document_type: 'Закон',
        document_type_slug: 'law',
        reasons: ['title_match', 'summary_match', 'keyword_match', 'validity_in_force'],
      },
      {
        rada_nreg: 'z0841-01',
        title: 'Про діяльність Bank Gospodarstwa Krajowego в Україні',
        score: 1.6,
        category: 'banking',
        document_type: 'Положення',
        document_type_slug: 'regulation',
        reasons: ['title_match', 'summary_match', 'validity_in_force'],
      },
    ],
    exactActNregs: [],
    groundedActNregs: ['4800-20'],
    topScore: 0.7,
    getActMeta: async (rada_nreg) => {
      const byNreg: Record<string, { title: string; category: string; document_type: string; document_type_slug: string; storage_category: string | null }> = {
        '4800-20': {
          title: 'Про ратифікацію Угоди між Урядом України та Урядом Республіки Польща про діяльність Bank Gospodarstwa Krajowego в Україні',
          category: 'international_eu',
          document_type: 'Закон',
          document_type_slug: 'law',
          storage_category: null,
        },
        'z0841-01': {
          title: 'Про діяльність Bank Gospodarstwa Krajowego в Україні',
          category: 'banking',
          document_type: 'Положення',
          document_type_slug: 'regulation',
          storage_category: null,
        },
      };
      const entry = byNreg[rada_nreg];
      return entry
        ? {
            rada_nreg,
            ...entry,
            summary: null,
            aliases: [],
            validity_status: 'in_force',
          }
        : null;
    },
    metadataGroundingReasonCodes: new Set(['exact_alias_match', 'exact_title_match', 'alias_match', 'title_match']),
    nonPrimaryAuthoritativeKinds: new Set(['SECONDARY_ORDER', 'KSU_DECISION', 'CASELAW_OPINION']),
  });
  if (!result.selectedActsFinal.some((act) => act.rada_nreg === '4800-20')) {
    throw new Error(
      `Expected grounded scope recovery to reinsert 4800-20 when only hinted support act survived, got ${JSON.stringify(result.selectedActsFinal)}`
    );
  }
  if (result.selectedActsFinal[0]?.rada_nreg !== '4800-20') {
    throw new Error(
      `Expected grounded scope anchor to stay first after recovery, got ${JSON.stringify(result.selectedActsFinal)}`
    );
  }
  if (!result.reasonCodes.includes('GROUNDED_ACT_SCOPE_RECOVERED')) {
    throw new Error(
      `Expected grounded scope recovery reason code after reinserting anchor act, got ${JSON.stringify(result.reasonCodes)}`
    );
  }
  console.log('[OK] single-act scope recovery reinserts grounded anchor before hinted support act');
}

async function testResolveSingleActScopeSelectionRejectsUntrustedGroundedPersonnelOrder(): Promise<void> {
  const result = await resolveSingleActScopeSelection({
    query:
      "Яким розпорядженням Кабінету Міністрів України тимчасово покладено виконання обов'язків Голови Національної соціальної сервісної служби України на Ільченка І.О.?",
    domainHint: 'administrative',
    documentTypeHints: ['cmu_order'],
    selectedActsFinal: [
      {
        rada_nreg: '5-2026-р',
        act_title:
          "Про тимчасове покладення виконання обов'язків Голови Державної служби України з лікарських засобів та контролю за наркотиками на Короленка В.В.",
        act_kind: 'SECONDARY_ORDER',
        document_type: 'Розпорядження КМУ',
        category: 'administrative',
        score: 0.7,
      },
    ],
    selectedActsSourcesBreakdownFinal: {
      from_taxonomy: ['5-2026-р'],
      from_acts_search: [],
      from_chunks_evidence: ['5-2026-р'],
    },
    selectedActsFinalMeta: {
      selected_acts_final: [
        {
          rada_nreg: '5-2026-р',
          act_title:
            "Про тимчасове покладення виконання обов'язків Голови Державної служби України з лікарських засобів та контролю за наркотиками на Короленка В.В.",
          act_kind: 'SECONDARY_ORDER',
          document_type: 'Розпорядження КМУ',
          category: 'administrative',
          score: 0.7,
        },
      ],
      selected_acts_confidence_final: 0.72,
      selected_acts_confidence_pre_routing: 0.72,
      selected_acts_decision_final: {
        policy_version: 1,
        included_from_chunks_evidence: true,
        reason_codes: ['SELECTED_ACTS_FROM_CHUNKS_EVIDENCE'],
      },
      selected_acts_kinds_count_final: { SECONDARY_ORDER: 1 },
      selected_acts_document_types_top_final: ['Розпорядження КМУ'],
      routing_hints_recovered_with_retrieval_evidence: false,
    },
    reasonCodes: [],
    chunksEvidenceTopActs: [
      {
        rada_nreg: '5-2026-р',
        count_in_top30: 1,
        avg_score_in_top30: 0.591,
        max_score: 0.591,
        best_rank_in_top30: 2,
        rank_mass_top30: 0.5,
        max_ordering_score: 0.305,
      },
      {
        rada_nreg: '44/2026',
        count_in_top30: 1,
        avg_score_in_top30: 0.531,
        max_score: 0.531,
        best_rank_in_top30: 4,
        rank_mass_top30: 0.2,
        max_ordering_score: 0.328,
      },
    ],
    actCandidatesTopHydrated: [
      {
        rada_nreg: '5-2026-р',
        title:
          "Про тимчасове покладення виконання обов'язків Голови Державної служби України з лікарських засобів та контролю за наркотиками на Короленка В.В.",
        score: 4.4,
        category: 'administrative',
        document_type: 'Розпорядження КМУ',
        document_type_slug: 'cmu_order',
        reasons: ['title_match', 'summary_match'],
      },
      {
        rada_nreg: '44/2026',
        title: "Про тимчасове виконання обов'язків голови Волинської обласної державної адміністрації",
        score: 2.2,
        category: 'administrative',
        document_type: 'Указ Президента',
        document_type_slug: 'president_decree',
        reasons: ['summary_match'],
      },
    ],
    exactActNregs: [],
    groundedActNregs: ['5-2026-р'],
    topScore: 0.79,
    getActMeta: async (rada_nreg) => {
      const byNreg: Record<string, { title: string; category: string; document_type: string; document_type_slug: string; storage_category: string | null }> = {
        '5-2026-р': {
          title:
            "Про тимчасове покладення виконання обов'язків Голови Державної служби України з лікарських засобів та контролю за наркотиками на Короленка В.В.",
          category: 'administrative',
          document_type: 'Розпорядження КМУ',
          document_type_slug: 'cmu_order',
          storage_category: null,
        },
        '44/2026': {
          title: "Про тимчасове виконання обов'язків голови Волинської обласної державної адміністрації",
          category: 'administrative',
          document_type: 'Указ Президента',
          document_type_slug: 'president_decree',
          storage_category: null,
        },
      };
      const entry = byNreg[rada_nreg];
      return entry
        ? {
            rada_nreg,
            ...entry,
            summary: null,
            aliases: [],
            validity_status: 'in_force',
          }
        : null;
    },
    metadataGroundingReasonCodes: new Set(['exact_alias_match', 'exact_title_match', 'alias_match', 'title_match', 'summary_match']),
    nonPrimaryAuthoritativeKinds: new Set(['SECONDARY_ORDER', 'KSU_DECISION', 'CASELAW_OPINION']),
  });
  if (result.groundedSingleActConverged) {
    throw new Error(`Expected wrong grounded personnel-order anchor to be rejected, got ${JSON.stringify(result.groundedActNregSet ? [...result.groundedActNregSet] : [])}`);
  }
  if (result.reasonCodes.some((code) => code.startsWith('GROUNDED_ACT_SCOPE_'))) {
    throw new Error(`Expected untrusted grounded personnel-order anchor not to emit grounded scope recovery codes, got ${JSON.stringify(result.reasonCodes)}`);
  }
  console.log('[OK] single-act scope rejects grounded personnel-order anchors that fail explicit identity matching');
}

async function testResolveSingleActScopeSelectionRecoversGroundedRepealOrderWithTrustedDateNumberIdentity(): Promise<void> {
  const result = await resolveSingleActScopeSelection({
    query:
      'Яким розпорядженням Кабінету Міністрів України визнано таким, що втратило чинність, розпорядження від 25 лютого 2026 р. № 177?',
    domainHint: 'administrative',
    documentTypeHints: ['cmu_order'],
    selectedActsFinal: [],
    selectedActsSourcesBreakdownFinal: {
      from_taxonomy: [],
      from_acts_search: [],
      from_chunks_evidence: [],
    },
    selectedActsFinalMeta: {
      selected_acts_final: [],
      selected_acts_confidence_final: 0.52,
      selected_acts_confidence_pre_routing: 0.52,
      selected_acts_decision_final: {
        policy_version: 1,
        included_from_chunks_evidence: true,
        reason_codes: ['SELECTED_ACTS_FROM_CHUNKS_EVIDENCE'],
      },
      selected_acts_kinds_count_final: {},
      selected_acts_document_types_top_final: [],
      routing_hints_recovered_with_retrieval_evidence: false,
    },
    reasonCodes: [],
    chunksEvidenceTopActs: [
      {
        rada_nreg: '1898-2010-р',
        count_in_top30: 5,
        avg_score_in_top30: 0.6897,
        max_score: 0.7269,
        best_rank_in_top30: 1,
        rank_mass_top30: 2.1309,
        max_ordering_score: 0.6872,
      },
      {
        rada_nreg: '950-2007-п',
        count_in_top30: 16,
        avg_score_in_top30: 0.5881,
        max_score: 0.6711,
        best_rank_in_top30: 5,
        rank_mass_top30: 1.1462,
        max_ordering_score: 0.6639,
      },
      {
        rada_nreg: '262-2026-р',
        count_in_top30: 1,
        avg_score_in_top30: 0.7071,
        max_score: 0.7071,
        best_rank_in_top30: 16,
        rank_mass_top30: 0.0625,
        max_ordering_score: 0.5261,
      },
    ],
    actCandidatesTopHydrated: [
      {
        rada_nreg: '4-2026-р',
        title: 'Про визнання таким, що втратило чинність, розпорядження Кабінету Міністрів України від 24 грудня 2025 р. № 1479',
        score: 35.03,
        category: 'administrative',
        document_type: 'Розпорядження КМУ',
        document_type_slug: 'cmu_order',
        reasons: ['title_match', 'summary_match', 'keyword_match', 'alias_match', 'validity_in_force', 'hits_evidence'],
      },
      {
        rada_nreg: '15-2026-р',
        title: 'Про визнання таким, що втратило чинність, розпорядження Кабінету Міністрів України від 19 листопада 2025 р. № 1292',
        score: 35.02,
        category: 'administrative',
        document_type: 'Розпорядження КМУ',
        document_type_slug: 'cmu_order',
        reasons: ['title_match', 'summary_match', 'keyword_match', 'alias_match', 'validity_in_force', 'hits_evidence'],
      },
      {
        rada_nreg: '262-2026-р',
        title: 'Про визнання таким, що втратило чинність, розпорядження Кабінету Міністрів України від 25 лютого 2026 р. № 177',
        score: 34.55,
        category: 'administrative',
        document_type: 'Розпорядження КМУ',
        document_type_slug: 'cmu_order',
        reasons: ['title_match', 'summary_match', 'keyword_match', 'alias_match', 'validity_in_force', 'hits_evidence'],
      },
    ],
    exactActNregs: [],
    groundedActNregs: ['262-2026-р'],
    topScore: 0.727,
    getActMeta: async (rada_nreg) => {
      const byNreg: Record<string, { title: string; category: string; document_type: string; document_type_slug: string; storage_category: string | null }> = {
        '4-2026-р': {
          title: 'Про визнання таким, що втратило чинність, розпорядження Кабінету Міністрів України від 24 грудня 2025 р. № 1479',
          category: 'administrative',
          document_type: 'Розпорядження КМУ',
          document_type_slug: 'cmu_order',
          storage_category: null,
        },
        '15-2026-р': {
          title: 'Про визнання таким, що втратило чинність, розпорядження Кабінету Міністрів України від 19 листопада 2025 р. № 1292',
          category: 'administrative',
          document_type: 'Розпорядження КМУ',
          document_type_slug: 'cmu_order',
          storage_category: null,
        },
        '262-2026-р': {
          title: 'Про визнання таким, що втратило чинність, розпорядження Кабінету Міністрів України від 25 лютого 2026 р. № 177',
          category: 'administrative',
          document_type: 'Розпорядження КМУ',
          document_type_slug: 'cmu_order',
          storage_category: null,
        },
      };
      const entry = byNreg[rada_nreg];
      return entry
        ? {
            rada_nreg,
            ...entry,
            summary: null,
            aliases: [],
            validity_status: 'in_force',
          }
        : null;
    },
    metadataGroundingReasonCodes: new Set(['exact_alias_match', 'exact_title_match', 'alias_match', 'title_match', 'summary_match']),
    nonPrimaryAuthoritativeKinds: new Set(['SECONDARY_ORDER', 'KSU_DECISION', 'CASELAW_OPINION']),
  });
  if (!result.groundedSingleActConverged) {
    throw new Error(`Expected repeal-order query with exact date+number identity to keep grounded single-act convergence, got ${JSON.stringify([...result.groundedActNregSet])}`);
  }
  if (result.selectedActsFinal[0]?.rada_nreg !== '262-2026-р') {
    throw new Error(`Expected grounded repeal-order anchor to be recovered into selected acts, got ${JSON.stringify(result.selectedActsFinal)}`);
  }
  if (!result.reasonCodes.includes('GROUNDED_ACT_SCOPE_RECOVERED')) {
    throw new Error(`Expected grounded repeal-order recovery to emit GROUNDED_ACT_SCOPE_RECOVERED, got ${JSON.stringify(result.reasonCodes)}`);
  }
  console.log('[OK] single-act scope recovers grounded repeal-order anchors when date+number identity matches the explicit query');
}

async function testResolveSingleGoalSelectedActsPrefersDominantEvidenceOverSemanticNeighborMetadataScope(): Promise<void> {
  const result = await resolveSingleGoalSelectedActs({
    query:
      "Який спеціальний закон вимагає food traceability від операторів ринку та розкриття даних на запит компетентного органу?",
    goalId: 'goal_0',
    finalHits: [
      {
        rada_nreg: '771/97-вр',
        r2_key: 'r2://771/8',
        json_path: '$.chunks[8]',
        score: 0.5701,
        ordering_score: 0.549,
        title: 'Про основні принципи та вимоги до безпечності та якості харчових продуктів',
        article_number: '8',
      },
      {
        rada_nreg: '771/97-вр',
        r2_key: 'r2://771/20',
        json_path: '$.chunks[20]',
        score: 0.558,
        ordering_score: 0.537,
        title: 'Про основні принципи та вимоги до безпечності та якості харчових продуктів',
        article_number: '20',
      },
      {
        rada_nreg: '771/97-вр',
        r2_key: 'r2://771/22',
        json_path: '$.chunks[22]',
        score: 0.567,
        ordering_score: 0.399,
        title: 'Про основні принципи та вимоги до безпечності та якості харчових продуктів',
        article_number: '22',
      },
      {
        rada_nreg: '771/97-вр',
        r2_key: 'r2://771/23',
        json_path: '$.chunks[23]',
        score: 0.546,
        ordering_score: 0.39,
        title: 'Про основні принципи та вимоги до безпечності та якості харчових продуктів',
        article_number: '23',
      },
      {
        rada_nreg: '771/97-вр',
        r2_key: 'r2://771/25',
        json_path: '$.chunks[25]',
        score: 0.544,
        ordering_score: 0.389,
        title: 'Про основні принципи та вимоги до безпечності та якості харчових продуктів',
        article_number: '25',
      },
      {
        rada_nreg: '2297-17',
        r2_key: 'r2://2297/7',
        json_path: '$.chunks[7]',
        score: 0.396,
        ordering_score: 0.385,
        title: 'Про захист персональних даних',
        article_number: '7',
      },
      {
        rada_nreg: '2297-17',
        r2_key: 'r2://2297/9',
        json_path: '$.chunks[9]',
        score: 0.398,
        ordering_score: 0.383,
        title: 'Про захист персональних даних',
        article_number: '9',
      },
      {
        rada_nreg: '2297-17',
        r2_key: 'r2://2297/11',
        json_path: '$.chunks[11]',
        score: 0.398,
        ordering_score: 0.381,
        title: 'Про захист персональних даних',
        article_number: '11',
      },
      {
        rada_nreg: '2297-17',
        r2_key: 'r2://2297/1',
        json_path: '$.chunks[1]',
        score: 0.39,
        ordering_score: 0.381,
        title: 'Про захист персональних даних',
        article_number: '1',
      },
    ] as never,
    actCandidatesTopHydrated: [
      {
        rada_nreg: '2297-17',
        title: 'Про захист персональних даних',
        score: 8.1,
        category: 'civil',
        document_type: 'Закон',
        document_type_slug: 'law',
        reasons: ['keyword_match', 'summary_match', 'topic_match', 'title_match', 'document_type_match'],
      },
      {
        rada_nreg: '771/97-вр',
        title: 'Про основні принципи та вимоги до безпечності та якості харчових продуктів',
        score: 5.9,
        category: 'agriculture_food',
        document_type: 'Закон',
        document_type_slug: 'law',
        reasons: ['keyword_match', 'summary_match', 'topic_match', 'document_type_match'],
      },
    ],
    plannerRationaleByNreg: new Map(),
    taxonomyNregs: new Set(['2297-17', '771/97-вр']),
    actsSearchNregs: [],
    domainHint: 'general',
    documentTypeHints: ['law'],
    taxonomyActCount: 2,
    aliasHitCount: 0,
    exactActHitCount: 0,
    exactActNregs: [],
    groundedActHitCount: 0,
    groundedActNregs: [],
    actSelectionLowConfidence: false,
    reasonCodes: ['DOC_TYPE_HINT_ALLOWED'],
    useLowConfidenceFallback: false,
    queryRewriteMeta: { called: false, used: false, not_used_reason_codes: [] },
    topScore: 0.5701,
    avgScore: 0.47,
    categoryHintsCount: 0,
    entitiesCount: 0,
    anchorsCount: 0,
    domainWeak: true,
    precomputedChunksEvidenceTopActs: [
      {
        rada_nreg: '771/97-вр',
        count_in_top30: 5,
        avg_score_in_top30: 0.557,
        max_score: 0.5701,
        best_rank_in_top30: 1,
        rank_mass_top30: 2.264,
        max_ordering_score: 0.549,
      },
      {
        rada_nreg: '2297-17',
        count_in_top30: 4,
        avg_score_in_top30: 0.396,
        max_score: 0.398,
        best_rank_in_top30: 6,
        rank_mass_top30: 0.92,
        max_ordering_score: 0.385,
      },
    ],
    getActMeta: async (rada_nreg) => {
      const byNreg: Record<
        string,
        { title: string; category: string; document_type: string; document_type_slug: string; storage_category: string | null }
      > = {
        '771/97-вр': {
          title: 'Про основні принципи та вимоги до безпечності та якості харчових продуктів',
          category: 'agriculture_food',
          document_type: 'Закон',
          document_type_slug: 'law',
          storage_category: null,
        },
        '2297-17': {
          title: 'Про захист персональних даних',
          category: 'civil',
          document_type: 'Закон',
          document_type_slug: 'law',
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
        act_kind: classifyActKind(
          act.act_title ?? '',
          act.document_type ?? null,
          act.category ?? null,
          act.document_type_slug ?? null
        ),
        confidence,
      })),
    searchActsForRouting: async () => [],
  });
  if (result.low_confidence_final) {
    throw new Error(
      `Expected dominant-evidence special-law locator query to resolve confidently, got ${JSON.stringify(result.reasonCodes)}`
    );
  }
  if (result.coverageGap !== 'none') {
    throw new Error(
      `Expected dominant-evidence special-law locator query to keep coverage_gap=none, got ${result.coverageGap}`
    );
  }
  if (result.selected_acts_final.length !== 1 || result.selected_acts_final[0]?.rada_nreg !== '771/97-вр') {
    throw new Error(
      `Expected dominant-evidence special-law locator query to keep 771/97-вр selected, got ${JSON.stringify(result.selected_acts_final)}`
    );
  }
  if (!result.reasonCodes.includes('EVIDENCE_ACT_SCOPE_CONFIRMED')) {
    throw new Error(
      `Expected dominant-evidence special-law locator query to confirm evidence act scope, got ${JSON.stringify(result.reasonCodes)}`
    );
  }
  if (result.reasonCodes.includes('METADATA_ACT_SCOPE_CONFIRMED')) {
    throw new Error(
      `Expected dominant-evidence special-law locator query to avoid semantic-neighbor metadata confirmation, got ${JSON.stringify(result.reasonCodes)}`
    );
  }
  console.log('[OK] dominant chunk evidence beats semantic-neighbor metadata scope for special-law locator queries');
}

async function testResolveSingleGoalSelectedActsPrefersEarlyRankMassLawOverCoverageTailForSoftLocator(): Promise<void> {
  const result = await resolveSingleGoalSelectedActs({
    query:
      'Який спеціальний закон регулює transfer of state and communal property objects та пакет документів для такої передачі?',
    goalId: 'goal_0',
    finalHits: [
      {
        rada_nreg: '147/98-вр',
        r2_key: 'r2://147/3',
        json_path: '$.chunks[3]',
        score: 0.568,
        ordering_score: 0.476,
        title: "Про передачу об'єктів права державної та комунальної власності",
        article_number: '3',
      },
      {
        rada_nreg: '147/98-вр',
        r2_key: 'r2://147/7',
        json_path: '$.chunks[7]',
        score: 0.549,
        ordering_score: 0.465,
        title: "Про передачу об'єктів права державної та комунальної власності",
        article_number: '7',
      },
      {
        rada_nreg: '147/98-вр',
        r2_key: 'r2://147/1',
        json_path: '$.chunks[1]',
        score: 0.579,
        ordering_score: 0.463,
        title: "Про передачу об'єктів права державної та комунальної власності",
        article_number: '1',
      },
      {
        rada_nreg: '147/98-вр',
        r2_key: 'r2://147/5',
        json_path: '$.chunks[5]',
        score: 0.519,
        ordering_score: 0.451,
        title: "Про передачу об'єктів права державної та комунальної власності",
        article_number: '5',
      },
      {
        rada_nreg: '147/98-вр',
        r2_key: 'r2://147/4',
        json_path: '$.chunks[4]',
        score: 0.501,
        ordering_score: 0.444,
        title: "Про передачу об'єктів права державної та комунальної власності",
        article_number: '4',
      },
      {
        rada_nreg: '147/98-вр',
        r2_key: 'r2://147/71',
        json_path: '$.chunks[71]',
        score: 0.535,
        ordering_score: 0.385,
        title: "Про передачу об'єктів права державної та комунальної власності",
        article_number: '71',
      },
      {
        rada_nreg: '1861-17',
        r2_key: 'r2://1861/91',
        json_path: '$.chunks[91]',
        score: 0.334,
        ordering_score: 0.443,
        title: 'Про Регламент Верховної Ради України',
        article_number: '91',
      },
      {
        rada_nreg: '1861-17',
        r2_key: 'r2://1861/194',
        json_path: '$.chunks[194]',
        score: 0.329,
        ordering_score: 0.437,
        title: 'Про Регламент Верховної Ради України',
        article_number: '194',
      },
      {
        rada_nreg: '1861-17',
        r2_key: 'r2://1861/127',
        json_path: '$.chunks[127]',
        score: 0.299,
        ordering_score: 0.403,
        title: 'Про Регламент Верховної Ради України',
        article_number: '127',
      },
      {
        rada_nreg: '1861-17',
        r2_key: 'r2://1861/71',
        json_path: '$.chunks[71]',
        score: 0.331,
        ordering_score: 0.379,
        title: 'Про Регламент Верховної Ради України',
        article_number: '71',
      },
    ] as never,
    actCandidatesTopHydrated: [
      {
        rada_nreg: '1861-17',
        title: 'Про Регламент Верховної Ради України',
        score: 4.71,
        category: 'constitutional',
        document_type: 'Закон',
        document_type_slug: 'law',
        reasons: ['keyword_match', 'topic_match', 'title_match', 'summary_match', 'validity_in_force', 'hits_evidence'],
      },
      {
        rada_nreg: '147/98-вр',
        title: "Про передачу об'єктів права державної та комунальної власності",
        score: 3.54,
        category: 'property_real_estate',
        document_type: 'Закон',
        document_type_slug: 'law',
        reasons: ['title_match', 'summary_match', 'keyword_match', 'validity_in_force', 'chunks_evidence_meta'],
      },
    ],
    plannerRationaleByNreg: new Map(),
    taxonomyNregs: new Set(['1861-17', '147/98-вр']),
    actsSearchNregs: [],
    domainHint: 'general',
    documentTypeHints: ['Закон'],
    taxonomyActCount: 2,
    aliasHitCount: 0,
    exactActHitCount: 0,
    exactActNregs: [],
    groundedActHitCount: 0,
    groundedActNregs: [],
    actSelectionLowConfidence: false,
    reasonCodes: ['DOC_TYPE_HINT_ALLOWED'],
    useLowConfidenceFallback: false,
    queryRewriteMeta: { called: false, used: false, not_used_reason_codes: [] },
    topScore: 0.579,
    avgScore: 0.454,
    categoryHintsCount: 0,
    entitiesCount: 0,
    anchorsCount: 0,
    domainWeak: true,
    precomputedChunksEvidenceTopActs: [
      {
        rada_nreg: '147/98-вр',
        count_in_top30: 6,
        avg_score_in_top30: 0.5418,
        max_score: 0.579,
        best_rank_in_top30: 1,
        rank_mass_top30: 2.2909,
        max_ordering_score: 0.4755,
      },
      {
        rada_nreg: '1861-17',
        count_in_top30: 13,
        avg_score_in_top30: 0.3168,
        max_score: 0.3747,
        best_rank_in_top30: 7,
        rank_mass_top30: 0.9041,
        max_ordering_score: 0.4429,
      },
    ],
    getActMeta: async (rada_nreg) => {
      const byNreg: Record<
        string,
        { title: string; category: string; document_type: string; document_type_slug: string; storage_category: string | null }
      > = {
        '147/98-вр': {
          title: "Про передачу об'єктів права державної та комунальної власності",
          category: 'property_real_estate',
          document_type: 'Закон',
          document_type_slug: 'law',
          storage_category: null,
        },
        '1861-17': {
          title: 'Про Регламент Верховної Ради України',
          category: 'constitutional',
          document_type: 'Закон',
          document_type_slug: 'law',
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
        act_kind: classifyActKind(
          act.act_title ?? '',
          act.document_type ?? null,
          act.category ?? null,
          act.document_type_slug ?? null
        ),
        confidence,
      })),
    searchActsForRouting: async () => [],
  });
  if (result.low_confidence_final) {
    throw new Error(
      `Expected soft special-law locator with dominant early evidence to resolve confidently, got ${JSON.stringify(result.reasonCodes)}`
    );
  }
  if (result.coverageGap !== 'none') {
    throw new Error(
      `Expected soft special-law locator with dominant early evidence to keep coverage_gap=none, got ${result.coverageGap}`
    );
  }
  if (result.selected_acts_final.length !== 1 || result.selected_acts_final[0]?.rada_nreg !== '147/98-вр') {
    throw new Error(
      `Expected soft special-law locator to prefer 147/98-вр over generic coverage tail, got ${JSON.stringify(result.selected_acts_final)}`
    );
  }
  if (!result.reasonCodes.includes('EVIDENCE_ACT_SCOPE_CONFIRMED')) {
    throw new Error(
      `Expected soft special-law locator to confirm evidence act scope, got ${JSON.stringify(result.reasonCodes)}`
    );
  }
  console.log('[OK] soft special-law locator prefers early rank-mass leader over generic primary-law coverage tail');
}

async function testResolveSingleGoalSelectedActsRecoversInterrogativePrimaryLawLocatorAfterLowConfidenceNarrowing(): Promise<void> {
  const result = await resolveSingleGoalSelectedActs({
    query: "Який профільний закон регулює дозвіл на будівництво та класи наслідків об'єктів будівництва?",
    goalId: 'goal_0',
    finalHits: [
      {
        rada_nreg: '3038-17',
        r2_key: 'r2://3038/32',
        json_path: '$.chunks[32]',
        score: 0.587,
        ordering_score: 0.592,
        title: 'Про регулювання містобудівної діяльності',
        article_number: '32',
      },
      {
        rada_nreg: '3038-17',
        r2_key: 'r2://3038/34',
        json_path: '$.chunks[34]',
        score: 0.514,
        ordering_score: 0.446,
        title: 'Про регулювання містобудівної діяльності',
        article_number: '34',
      },
      {
        rada_nreg: '2518-20',
        r2_key: 'r2://2518/5',
        json_path: '$.chunks[5]',
        score: 0.451,
        ordering_score: 0.414,
        title: "Про гарантування речових прав на об'єкти нерухомого майна, які будуть споруджені в майбутньому",
        article_number: '5',
      },
      {
        rada_nreg: '2518-20',
        r2_key: 'r2://2518/2',
        json_path: '$.chunks[2]',
        score: 0.442,
        ordering_score: 0.413,
        title: "Про гарантування речових прав на об'єкти нерухомого майна, які будуть споруджені в майбутньому",
        article_number: '2',
      },
      {
        rada_nreg: '3038-17',
        r2_key: 'r2://3038/37',
        json_path: '$.chunks[37]',
        score: 0.562,
        ordering_score: 0.371,
        title: 'Про регулювання містобудівної діяльності',
        article_number: '37',
      },
    ] as never,
    actCandidatesTopHydrated: [
      {
        rada_nreg: '2518-20',
        title: "Про гарантування речових прав на об'єкти нерухомого майна, які будуть споруджені в майбутньому",
        score: 3.8,
        category: 'property_real_estate',
        document_type: 'Закон',
        document_type_slug: 'law',
        reasons: ['keyword_match', 'topic_match', 'summary_match', 'validity_in_force'],
      },
      {
        rada_nreg: '3038-17',
        title: 'Про регулювання містобудівної діяльності',
        score: 2.9,
        category: 'property_real_estate',
        document_type: 'Закон',
        document_type_slug: 'law',
        reasons: ['summary_match', 'keyword_match', 'chunks_evidence_meta', 'validity_in_force'],
      },
    ],
    plannerRationaleByNreg: new Map(),
    taxonomyNregs: new Set(['2518-20', '3038-17']),
    actsSearchNregs: [],
    domainHint: 'general',
    documentTypeHints: ['Закон'],
    taxonomyActCount: 2,
    aliasHitCount: 0,
    exactActHitCount: 0,
    exactActNregs: [],
    groundedActHitCount: 0,
    groundedActNregs: [],
    actSelectionLowConfidence: false,
    reasonCodes: ['DOC_TYPE_HINT_ALLOWED'],
    useLowConfidenceFallback: false,
    queryRewriteMeta: { called: false, used: false, not_used_reason_codes: [] },
    topScore: 0.587,
    avgScore: 0.47,
    categoryHintsCount: 0,
    entitiesCount: 0,
    anchorsCount: 0,
    domainWeak: true,
    precomputedChunksEvidenceTopActs: [
      {
        rada_nreg: '3038-17',
        count_in_top30: 3,
        avg_score_in_top30: 0.554,
        max_score: 0.587,
        best_rank_in_top30: 1,
        rank_mass_top30: 1.409,
        max_ordering_score: 0.592,
      },
      {
        rada_nreg: '2518-20',
        count_in_top30: 2,
        avg_score_in_top30: 0.446,
        max_score: 0.451,
        best_rank_in_top30: 3,
        rank_mass_top30: 0.827,
        max_ordering_score: 0.414,
      },
    ],
    getActMeta: async (rada_nreg) => {
      const byNreg: Record<
        string,
        { title: string; category: string; document_type: string; document_type_slug: string; storage_category: string | null }
      > = {
        '2518-20': {
          title: "Про гарантування речових прав на об'єкти нерухомого майна, які будуть споруджені в майбутньому",
          category: 'property_real_estate',
          document_type: 'Закон',
          document_type_slug: 'law',
          storage_category: null,
        },
        '3038-17': {
          title: 'Про регулювання містобудівної діяльності',
          category: 'property_real_estate',
          document_type: 'Закон',
          document_type_slug: 'law',
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
        act_kind: classifyActKind(
          act.act_title ?? '',
          act.document_type ?? null,
          act.category ?? null,
          act.document_type_slug ?? null
        ),
        confidence,
      })),
    searchActsForRouting: async () => [],
  });
  if (result.low_confidence_final) {
    throw new Error(`Expected soft interrogative primary-law locator to recover confidently, got ${JSON.stringify(result.reasonCodes)}`);
  }
  if (result.coverageGap !== 'none') {
    throw new Error(`Expected soft interrogative primary-law locator to keep coverage_gap=none, got ${result.coverageGap}`);
  }
  if (result.selected_acts_final.length !== 1 || result.selected_acts_final[0]?.rada_nreg !== '3038-17') {
    throw new Error(`Expected soft interrogative primary-law locator to keep 3038-17 selected, got ${JSON.stringify(result.selected_acts_final)}`);
  }
  if (!result.reasonCodes.includes('INTERROGATIVE_PRIMARY_LAW_LOCATOR_CONFIRMED')) {
    throw new Error(`Expected interrogative primary-law locator confirmation reason, got ${JSON.stringify(result.reasonCodes)}`);
  }
  if (result.reasonCodes.includes('EXPLICIT_ACT_SCOPE_NO_CONVERGENCE')) {
    throw new Error(`Expected soft interrogative primary-law locator to avoid explicit act-scope no-convergence, got ${JSON.stringify(result.reasonCodes)}`);
  }
  console.log('[OK] soft interrogative primary-law locator recovers after low-confidence narrowing');
}

async function testResolveSingleGoalSelectedActsRejectsCalendarScopedRecurringActWithoutUniqueConvergence(): Promise<void> {
  const result = await resolveSingleGoalSelectedActs({
    query: 'Яким актом Національного банку України на 26 березня 2026 року встановлено офіційний курс гривні щодо іноземних валют?',
    goalId: 'goal_0',
    finalHits: [
      {
        rada_nreg: 'v0001500-19',
        r2_key: 'r2://v0001500/7',
        json_path: '$.chunks[7]',
        score: 0.557,
        ordering_score: 0.516,
        title: 'Про затвердження Положення про структуру валютного ринку України, умови та порядок торгівлі іноземною валютою та банківськими металами на валютному ринку України',
        unit_number: '7',
        unit_type: 'point',
      },
      {
        rada_nreg: 'v0001500-19',
        r2_key: 'r2://v0001500/27',
        json_path: '$.chunks[27]',
        score: 0.563,
        ordering_score: 0.507,
        title: 'Про затвердження Положення про структуру валютного ринку України, умови та порядок торгівлі іноземною валютою та банківськими металами на валютному ринку України',
        unit_number: '27',
        unit_type: 'point',
      },
      {
        rada_nreg: 'n0031500-26',
        r2_key: 'r2://n0031500/1',
        json_path: '$.chunks[1]',
        score: 0.747,
        ordering_score: 0.423,
        title: 'Про офіційний курс гривні щодо іноземних валют',
      },
      {
        rada_nreg: 'n0029500-26',
        r2_key: 'r2://n0029500/1',
        json_path: '$.chunks[1]',
        score: 0.746,
        ordering_score: 0.423,
        title: 'Про офіційний курс гривні щодо іноземних валют',
      },
      {
        rada_nreg: 'n0123500-26',
        r2_key: 'r2://n0123500/1',
        json_path: '$.chunks[1]',
        score: 0.744,
        ordering_score: 0.422,
        title: 'Про офіційний курс гривні щодо іноземних валют',
      },
    ] as never,
    actCandidatesTopHydrated: [
      {
        rada_nreg: 'v0001500-19',
        title:
          'Про затвердження Положення про структуру валютного ринку України, умови та порядок торгівлі іноземною валютою та банківськими металами на валютному ринку України',
        score: 3.4,
        category: 'banking_currency',
        document_type: 'Постанова',
        document_type_slug: 'resolution',
        reasons: ['summary_match', 'keyword_match', 'chunks_evidence_meta', 'validity_in_force'],
      },
      {
        rada_nreg: 'n0031500-26',
        title: 'Про офіційний курс гривні щодо іноземних валют',
        score: 3.1,
        category: 'banking_currency',
        document_type: 'Постанова',
        document_type_slug: 'resolution',
        reasons: ['title_match', 'chunks_evidence_meta', 'validity_in_force'],
      },
      {
        rada_nreg: 'n0029500-26',
        title: 'Про офіційний курс гривні щодо іноземних валют',
        score: 3.05,
        category: 'banking_currency',
        document_type: 'Постанова',
        document_type_slug: 'resolution',
        reasons: ['title_match', 'chunks_evidence_meta', 'validity_in_force'],
      },
      {
        rada_nreg: 'n0123500-26',
        title: 'Про офіційний курс гривні щодо іноземних валют',
        score: 3,
        category: 'banking_currency',
        document_type: 'Постанова',
        document_type_slug: 'resolution',
        reasons: ['title_match', 'chunks_evidence_meta', 'validity_in_force'],
      },
    ],
    plannerRationaleByNreg: new Map(),
    taxonomyNregs: new Set(['v0001500-19', 'n0031500-26', 'n0029500-26', 'n0123500-26']),
    actsSearchNregs: [],
    domainHint: 'general',
    documentTypeHints: ['Постанова'],
    taxonomyActCount: 4,
    aliasHitCount: 0,
    exactActHitCount: 0,
    exactActNregs: [],
    groundedActHitCount: 0,
    groundedActNregs: [],
    actSelectionLowConfidence: false,
    reasonCodes: ['DOC_TYPE_HINT_ALLOWED'],
    useLowConfidenceFallback: false,
    queryRewriteMeta: { called: false, used: false, not_used_reason_codes: [] },
    topScore: 0.557,
    avgScore: 0.49,
    categoryHintsCount: 0,
    entitiesCount: 1,
    anchorsCount: 0,
    domainWeak: true,
    precomputedChunksEvidenceTopActs: [
      {
        rada_nreg: 'v0001500-19',
        count_in_top30: 2,
        avg_score_in_top30: 0.56,
        max_score: 0.563,
        best_rank_in_top30: 1,
        rank_mass_top30: 1.45,
        max_ordering_score: 0.516,
      },
      {
        rada_nreg: 'n0031500-26',
        count_in_top30: 1,
        avg_score_in_top30: 0.747,
        max_score: 0.747,
        best_rank_in_top30: 3,
        rank_mass_top30: 0.42,
        max_ordering_score: 0.423,
      },
      {
        rada_nreg: 'n0029500-26',
        count_in_top30: 1,
        avg_score_in_top30: 0.746,
        max_score: 0.746,
        best_rank_in_top30: 4,
        rank_mass_top30: 0.42,
        max_ordering_score: 0.423,
      },
      {
        rada_nreg: 'n0123500-26',
        count_in_top30: 1,
        avg_score_in_top30: 0.744,
        max_score: 0.744,
        best_rank_in_top30: 5,
        rank_mass_top30: 0.41,
        max_ordering_score: 0.422,
      },
    ],
    getActMeta: async (rada_nreg) => {
      const byNreg: Record<
        string,
        { title: string; category: string; document_type: string; document_type_slug: string; storage_category: string | null }
      > = {
        'v0001500-19': {
          title:
            'Про затвердження Положення про структуру валютного ринку України, умови та порядок торгівлі іноземною валютою та банківськими металами на валютному ринку України',
          category: 'banking_currency',
          document_type: 'Постанова',
          document_type_slug: 'resolution',
          storage_category: null,
        },
        'n0031500-26': {
          title: 'Про офіційний курс гривні щодо іноземних валют',
          category: 'banking_currency',
          document_type: 'Постанова',
          document_type_slug: 'resolution',
          storage_category: null,
        },
        'n0029500-26': {
          title: 'Про офіційний курс гривні щодо іноземних валют',
          category: 'banking_currency',
          document_type: 'Постанова',
          document_type_slug: 'resolution',
          storage_category: null,
        },
        'n0123500-26': {
          title: 'Про офіційний курс гривні щодо іноземних валют',
          category: 'banking_currency',
          document_type: 'Постанова',
          document_type_slug: 'resolution',
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
        act_kind: classifyActKind(
          act.act_title ?? '',
          act.document_type ?? null,
          act.category ?? null,
          act.document_type_slug ?? null
        ),
        confidence,
      })),
    searchActsForRouting: async () => [],
  });
  if (!result.low_confidence_final) {
    throw new Error(`Expected calendar-scoped recurring-act locator without unique convergence to stay low-confidence, got ${JSON.stringify(result.reasonCodes)}`);
  }
  if (result.coverageGap !== 'likely_missing_act') {
    throw new Error(`Expected calendar-scoped recurring-act locator to surface likely_missing_act, got ${result.coverageGap}`);
  }
  if (result.selected_acts_final.length !== 0) {
    throw new Error(`Expected calendar-scoped recurring-act locator to clear selected acts, got ${JSON.stringify(result.selected_acts_final)}`);
  }
  if (!result.reasonCodes.includes('EXPLICIT_ACT_SCOPE_NO_CONVERGENCE')) {
    throw new Error(`Expected calendar-scoped recurring-act locator to mark explicit scope no convergence, got ${JSON.stringify(result.reasonCodes)}`);
  }
  if (result.reasonCodes.includes('EVIDENCE_ACT_SCOPE_CONFIRMED')) {
    throw new Error(`Expected calendar-scoped recurring-act locator to avoid evidence scope confirmation, got ${JSON.stringify(result.reasonCodes)}`);
  }
  console.log('[OK] calendar-scoped recurring-act locator stays honest without unique convergence');
}

async function testResolveSingleGoalSelectedActsRecoversCalendarScopedRecurringActWithUniqueDateMatch(): Promise<void> {
  const result = await resolveSingleGoalSelectedActs({
    query: 'Де Нацбанк на 25 березня 2026 року закріпив офіційний курс гривні до іноземних валют?',
    goalId: 'goal_0',
    finalHits: [
      {
        rada_nreg: 'v0001500-19',
        r2_key: 'r2://v0001500-19/27',
        json_path: '$.chunks[27]',
        score: 0.508,
        ordering_score: 0.484,
        title:
          'Про затвердження Положення про структуру валютного ринку України, умови та порядок торгівлі іноземною валютою та банківськими металами на валютному ринку України',
      },
      {
        rada_nreg: 'n0119500-26',
        r2_key: 'r2://n0119500-26/1',
        json_path: '$.paragraphs[1]',
        score: 0.723,
        ordering_score: 0.413,
        title: 'Про офіційний курс гривні щодо іноземних валют',
      },
      {
        rada_nreg: 'n0121500-26',
        r2_key: 'r2://n0121500-26/1',
        json_path: '$.paragraphs[1]',
        score: 0.72,
        ordering_score: 0.412,
        title: 'Про офіційний курс гривні щодо іноземних валют',
      },
      {
        rada_nreg: 'n0123500-26',
        r2_key: 'r2://n0123500-26/1',
        json_path: '$.paragraphs[1]',
        score: 0.714,
        ordering_score: 0.409,
        title: 'Про офіційний курс гривні щодо іноземних валют',
      },
    ],
    actCandidatesTopHydrated: [
      {
        rada_nreg: 'n0119500-26',
        title: 'Про офіційний курс гривні щодо іноземних валют',
        score: 3.2,
        category: 'banking_currency',
        document_type: 'Повідомлення НБУ',
        document_type_slug: 'nbu_letter',
        reasons: ['title_match', 'keyword_match', 'rada_datred_match', 'chunks_evidence_meta', 'validity_in_force'],
      },
      {
        rada_nreg: 'n0121500-26',
        title: 'Про офіційний курс гривні щодо іноземних валют',
        score: 3.1,
        category: 'banking_currency',
        document_type: 'Повідомлення НБУ',
        document_type_slug: 'nbu_letter',
        reasons: ['title_match', 'keyword_match', 'rada_datred_penalty', 'chunks_evidence_meta', 'validity_in_force'],
      },
      {
        rada_nreg: 'n0123500-26',
        title: 'Про офіційний курс гривні щодо іноземних валют',
        score: 3.05,
        category: 'banking_currency',
        document_type: 'Повідомлення НБУ',
        document_type_slug: 'nbu_letter',
        reasons: ['title_match', 'keyword_match', 'rada_datred_penalty', 'chunks_evidence_meta', 'validity_in_force'],
      },
    ],
    plannerRationaleByNreg: new Map(),
    taxonomyNregs: new Set(['n0119500-26', 'n0121500-26', 'n0123500-26']),
    actsSearchNregs: [],
    domainHint: 'general',
    documentTypeHints: ['Повідомлення НБУ'],
    taxonomyActCount: 3,
    aliasHitCount: 0,
    exactActHitCount: 0,
    exactActNregs: [],
    groundedActHitCount: 0,
    groundedActNregs: [],
    actSelectionLowConfidence: false,
    reasonCodes: ['DOC_TYPE_HINT_ALLOWED'],
    useLowConfidenceFallback: false,
    queryRewriteMeta: { called: false, used: false, not_used_reason_codes: [] },
    topScore: 0.723,
    avgScore: 0.62,
    categoryHintsCount: 0,
    entitiesCount: 0,
    anchorsCount: 0,
    domainWeak: true,
    precomputedChunksEvidenceTopActs: [
      {
        rada_nreg: 'v0001500-19',
        count_in_top30: 2,
        avg_score_in_top30: 0.505,
        max_score: 0.508,
        best_rank_in_top30: 1,
        rank_mass_top30: 1.1,
        max_ordering_score: 0.484,
      },
      {
        rada_nreg: 'n0119500-26',
        count_in_top30: 1,
        avg_score_in_top30: 0.723,
        max_score: 0.723,
        best_rank_in_top30: 4,
        rank_mass_top30: 0.42,
        max_ordering_score: 0.413,
      },
      {
        rada_nreg: 'n0121500-26',
        count_in_top30: 1,
        avg_score_in_top30: 0.72,
        max_score: 0.72,
        best_rank_in_top30: 5,
        rank_mass_top30: 0.41,
        max_ordering_score: 0.412,
      },
      {
        rada_nreg: 'n0123500-26',
        count_in_top30: 1,
        avg_score_in_top30: 0.714,
        max_score: 0.714,
        best_rank_in_top30: 6,
        rank_mass_top30: 0.4,
        max_ordering_score: 0.409,
      },
    ],
    getActMeta: async (rada_nreg) => {
      const byNreg: Record<
        string,
        { title: string; category: string; document_type: string; document_type_slug: string; storage_category: string | null }
      > = {
        'v0001500-19': {
          title:
            'Про затвердження Положення про структуру валютного ринку України, умови та порядок торгівлі іноземною валютою та банківськими металами на валютному ринку України',
          category: 'banking_currency',
          document_type: 'Постанова',
          document_type_slug: 'resolution',
          storage_category: null,
        },
        'n0119500-26': {
          title: 'Про офіційний курс гривні щодо іноземних валют',
          category: 'banking_currency',
          document_type: 'Повідомлення НБУ',
          document_type_slug: 'nbu_letter',
          storage_category: 'finance',
        },
        'n0121500-26': {
          title: 'Про офіційний курс гривні щодо іноземних валют',
          category: 'banking_currency',
          document_type: 'Повідомлення НБУ',
          document_type_slug: 'nbu_letter',
          storage_category: 'finance',
        },
        'n0123500-26': {
          title: 'Про офіційний курс гривні щодо іноземних валют',
          category: 'banking_currency',
          document_type: 'Повідомлення НБУ',
          document_type_slug: 'nbu_letter',
          storage_category: 'finance',
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
        act_kind: classifyActKind(
          act.act_title ?? '',
          act.document_type ?? null,
          act.category ?? null,
          act.document_type_slug ?? null
        ),
        confidence,
      })),
    searchActsForRouting: async () => [],
  });
  if (result.low_confidence_final) {
    throw new Error(`Expected unique date-matched recurring act to resolve confidently, got ${JSON.stringify(result.reasonCodes)}`);
  }
  if (result.coverageGap !== 'none') {
    throw new Error(`Expected unique date-matched recurring act to clear coverage gap, got ${result.coverageGap}`);
  }
  if (result.selected_acts_final[0]?.rada_nreg !== 'n0119500-26') {
    throw new Error(`Expected date-matched recurring act to be selected, got ${JSON.stringify(result.selected_acts_final)}`);
  }
  console.log('[OK] calendar-scoped recurring act converges when one candidate has unique date identity match');
}

async function testResolveSingleGoalSelectedActsRejectsDomainAlignedPrimaryFallbackForAbsentExplicitLawTitle(): Promise<void> {
  const result = await resolveSingleGoalSelectedActs({
    query:
      'За Законом України «Про фінансовий лізинг», чи може лізингодавець відмовитися від договору через прострочення лізингових платежів?',
    goalId: 'goal_0',
    finalHits: [
      {
        rada_nreg: '435-15',
        r2_key: 'r2://435/806',
        json_path: '$.chunks[806]',
        score: 0.665,
        ordering_score: 0.584,
        title: 'Цивільний кодекс України',
        article_number: '806',
      },
      {
        rada_nreg: '435-15',
        r2_key: 'r2://435/8091',
        json_path: '$.chunks[8091]',
        score: 0.666,
        ordering_score: 0.582,
        title: 'Цивільний кодекс України',
        article_number: '809-1',
      },
      {
        rada_nreg: '435-15',
        r2_key: 'r2://435/809',
        json_path: '$.chunks[809]',
        score: 0.628,
        ordering_score: 0.558,
        title: 'Цивільний кодекс України',
        article_number: '809',
      },
      {
        rada_nreg: '435-15',
        r2_key: 'r2://435/807',
        json_path: '$.chunks[807]',
        score: 0.609,
        ordering_score: 0.557,
        title: 'Цивільний кодекс України',
        article_number: '807',
      },
      {
        rada_nreg: '80731-10',
        r2_key: 'r2://80731/18829',
        json_path: '$.chunks[18829]',
        score: 0.603,
        ordering_score: 0.503,
        title: 'Кодекс України про адміністративні правопорушення',
        article_number: '188-29',
      },
    ] as never,
    actCandidatesTopHydrated: [
      {
        rada_nreg: '435-15',
        title: 'Цивільний кодекс України',
        score: 1.5,
        category: 'civil',
        document_type: 'Кодекс',
        document_type_slug: 'code',
      },
      {
        rada_nreg: '80731-10',
        title: 'Кодекс України про адміністративні правопорушення',
        score: 0.9,
        category: 'administrative_offenses',
        document_type: 'Кодекс',
        document_type_slug: 'code',
      },
    ],
    plannerRationaleByNreg: new Map(),
    taxonomyNregs: new Set(),
    actsSearchNregs: [],
    domainHint: 'civil',
    documentTypeHints: ['law'],
    taxonomyActCount: 0,
    aliasHitCount: 0,
    exactActHitCount: 0,
    exactActNregs: [],
    groundedActHitCount: 0,
    groundedActNregs: [],
    actSelectionLowConfidence: false,
    reasonCodes: ['NON_PRIMARY_SUPPORT_BLOCKED_PRIMARY_PRESENT'],
    useLowConfidenceFallback: false,
    queryRewriteMeta: { called: false, used: false, not_used_reason_codes: [] },
    topScore: 0.66565,
    avgScore: 0.62,
    categoryHintsCount: 0,
    entitiesCount: 1,
    anchorsCount: 0,
    domainWeak: false,
    precomputedChunksEvidenceTopActs: [
      {
        rada_nreg: '435-15',
        count_in_top30: 6,
        avg_score_in_top30: 0.63,
        max_score: 0.666,
        best_rank_in_top30: 1,
        rank_mass_top30: 1.94,
        max_ordering_score: 0.584,
      },
      {
        rada_nreg: '80731-10',
        count_in_top30: 2,
        avg_score_in_top30: 0.58,
        max_score: 0.603,
        best_rank_in_top30: 7,
        rank_mass_top30: 0.31,
        max_ordering_score: 0.503,
      },
    ],
    getActMeta: async (rada_nreg) => {
      const byNreg: Record<
        string,
        {
          title: string;
          category: string;
          document_type: string;
          document_type_slug: string;
          storage_category: string | null;
        }
      > = {
        '435-15': {
          title: 'Цивільний кодекс України',
          category: 'civil',
          document_type: 'Кодекс',
          document_type_slug: 'code',
          storage_category: null,
        },
        '80731-10': {
          title: 'Кодекс України про адміністративні правопорушення',
          category: 'administrative_offenses',
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
        act_kind: classifyActKind(
          act.act_title ?? '',
          act.document_type ?? null,
          act.category ?? null,
          act.document_type_slug ?? null
        ),
        confidence,
      })),
    searchActsForRouting: async () => [],
  });
  if (!result.low_confidence_final) {
    throw new Error(`Expected absent explicit law-title query to stay low confidence, got ${JSON.stringify(result.reasonCodes)}`);
  }
  if (result.coverageGap !== 'likely_missing_act') {
    throw new Error(`Expected absent explicit law-title query to map to likely_missing_act, got ${result.coverageGap}`);
  }
  if (!result.reasonCodes.includes('EXPLICIT_ACT_SCOPE_NO_CONVERGENCE')) {
    throw new Error(`Expected EXPLICIT_ACT_SCOPE_NO_CONVERGENCE reason code, got ${JSON.stringify(result.reasonCodes)}`);
  }
  if (result.reasonCodes.includes('EVIDENCE_ACT_SCOPE_CONFIRMED')) {
    throw new Error(`Expected absent explicit law-title query to avoid fake evidence act-scope confirmation, got ${JSON.stringify(result.reasonCodes)}`);
  }
  console.log('[OK] single-goal finalizer rejects domain-aligned primary fallback for absent explicit law-title queries');
}

async function testResolveSingleGoalSelectedActsRejectsSupportOnlySecondaryActForAbsentExplicitLawTitle(): Promise<void> {
  const result = await resolveSingleGoalSelectedActs({
    query:
      'За Законом України «Про національну безпеку України», хто затверджує Стратегію національної безпеки та які документи входять до системи планування у сфері національної безпеки і оборони?',
    goalId: 'goal_0',
    finalHits: [
      {
        rada_nreg: '392/2020',
        r2_key: 'r2://392/2',
        json_path: '$.chunks[2]',
        score: 0.67,
        ordering_score: 0.63,
        title: 'Про рішення Ради національної безпеки і оборони України від 14 вересня 2020 року "Про Стратегію національної безпеки України"',
        unit_type: 'point',
      },
      {
        rada_nreg: '392/2020',
        r2_key: 'r2://392/4',
        json_path: '$.chunks[4]',
        score: 0.65,
        ordering_score: 0.61,
        title: 'Про рішення Ради національної безпеки і оборони України від 14 вересня 2020 року "Про Стратегію національної безпеки України"',
        unit_type: 'point',
      },
      {
        rada_nreg: '392/2020',
        r2_key: 'r2://392/1',
        json_path: '$.chunks[1]',
        score: 0.63,
        ordering_score: 0.58,
        title: 'Про рішення Ради національної безпеки і оборони України від 14 вересня 2020 року "Про Стратегію національної безпеки України"',
        unit_type: 'point',
      },
    ] as never,
    actCandidatesTopHydrated: [
      {
        rada_nreg: '392/2020',
        title: 'Про рішення Ради національної безпеки і оборони України від 14 вересня 2020 року "Про Стратегію національної безпеки України"',
        score: 2.4,
        category: 'national_security',
        document_type: 'Указ Президента',
        document_type_slug: 'presidential_decree',
        reasons: ['title_match', 'summary_match'],
      },
    ],
    plannerRationaleByNreg: new Map(),
    taxonomyNregs: new Set(),
    actsSearchNregs: [],
    domainHint: 'general',
    documentTypeHints: ['law'],
    taxonomyActCount: 0,
    aliasHitCount: 0,
    exactActHitCount: 0,
    exactActNregs: [],
    groundedActHitCount: 0,
    groundedActNregs: [],
    actSelectionLowConfidence: false,
    reasonCodes: [],
    useLowConfidenceFallback: false,
    queryRewriteMeta: { called: false, used: false, not_used_reason_codes: [] },
    topScore: 0.67,
    avgScore: 0.65,
    categoryHintsCount: 0,
    entitiesCount: 1,
    anchorsCount: 0,
    domainWeak: false,
    precomputedChunksEvidenceTopActs: [
      {
        rada_nreg: '392/2020',
        count_in_top30: 8,
        avg_score_in_top30: 0.65,
        max_score: 0.67,
        best_rank_in_top30: 1,
        rank_mass_top30: 1.73,
        max_ordering_score: 0.63,
      },
    ],
    getActMeta: async (rada_nreg) => {
      if (rada_nreg !== '392/2020') return null;
      return {
        rada_nreg,
        title: 'Про рішення Ради національної безпеки і оборони України від 14 вересня 2020 року "Про Стратегію національної безпеки України"',
        category: 'national_security',
        document_type: 'Указ Президента',
        document_type_slug: 'presidential_decree',
        storage_category: null,
        summary: null,
        aliases: [],
        validity_status: 'in_force',
      };
    },
    hydrateSelectedActsMeta: async (acts, confidence) =>
      acts.map((act) => ({
        ...act,
        act_kind: classifyActKind(
          act.act_title ?? '',
          act.document_type ?? null,
          act.category ?? null,
          act.document_type_slug ?? null
        ),
        confidence,
      })),
    searchActsForRouting: async () => [],
  });
  if (!result.low_confidence_final) {
    throw new Error(`Expected support-only secondary act fallback for explicit law title to stay low confidence, got ${JSON.stringify(result.reasonCodes)}`);
  }
  if (result.coverageGap !== 'likely_missing_act') {
    throw new Error(`Expected support-only secondary act fallback to map to likely_missing_act, got ${result.coverageGap}`);
  }
  if (result.reasonCodes.includes('AUTHORITATIVE_NON_PRIMARY_SCOPE_CONFIRMED')) {
    throw new Error(`Expected explicit law-title query not to confirm support-only non-primary scope, got ${JSON.stringify(result.reasonCodes)}`);
  }
  console.log('[OK] explicit law-title queries do not treat support-only secondary acts as grounded success');
}

async function testResolveSingleGoalSelectedActsRecoversSoftNonPrimaryAmendmentOrderAfterExplicitScopeClear(): Promise<void> {
  const result = await resolveSingleGoalSelectedActs({
    query: 'Яким актом Кабмін скоригував розпорядження №625 від 25.06.2025?',
    goalId: 'goal_0',
    finalHits: [
      {
        rada_nreg: '950-2007-п',
        r2_key: 'r2://950/4',
        json_path: '$.chunks[4]',
        score: 0.67,
        ordering_score: 0.53,
        title: 'Про затвердження Регламенту Кабінету Міністрів України',
        unit_type: 'point',
      },
      {
        rada_nreg: '250-2026-р',
        r2_key: 'r2://250/1',
        json_path: '$.chunks[1]',
        score: 0.71,
        ordering_score: 0.42,
        title: 'Про внесення змін до розпорядження Кабінету Міністрів України від 25 червня 2025 р. № 625',
        unit_type: 'paragraph',
      },
      {
        rada_nreg: '950-2007-п',
        r2_key: 'r2://950/31',
        json_path: '$.chunks[31]',
        score: 0.65,
        ordering_score: 0.51,
        title: 'Про затвердження Регламенту Кабінету Міністрів України',
        unit_type: 'point',
      },
      {
        rada_nreg: '950-2007-п',
        r2_key: 'r2://950/2',
        json_path: '$.chunks[2]',
        score: 0.63,
        ordering_score: 0.49,
        title: 'Про затвердження Регламенту Кабінету Міністрів України',
        unit_type: 'point',
      },
    ] as never,
    actCandidatesTopHydrated: [
      {
        rada_nreg: '250-2026-р',
        title: 'Про внесення змін до розпорядження Кабінету Міністрів України від 25 червня 2025 р. № 625',
        score: 3.3,
        category: 'public_administration',
        document_type: 'Розпорядження КМУ',
        document_type_slug: 'cmu_order',
        reasons: ['document_number_match', 'rada_datred_match', 'title_match'],
      },
      {
        rada_nreg: '950-2007-п',
        title: 'Про затвердження Регламенту Кабінету Міністрів України',
        score: 2.4,
        category: 'public_administration',
        document_type: 'Постанова КМУ',
        document_type_slug: 'cmu_resolution',
        reasons: ['summary_match'],
      },
    ],
    plannerRationaleByNreg: new Map(),
    taxonomyNregs: new Set(['250-2026-р', '950-2007-п']),
    actsSearchNregs: ['250-2026-р', '950-2007-п'],
    domainHint: 'general',
    documentTypeHints: [],
    taxonomyActCount: 2,
    aliasHitCount: 0,
    exactActHitCount: 0,
    exactActNregs: [],
    groundedActHitCount: 0,
    groundedActNregs: [],
    actSelectionLowConfidence: false,
    reasonCodes: [],
    useLowConfidenceFallback: false,
    queryRewriteMeta: { called: false, used: false, not_used_reason_codes: [] },
    topScore: 0.71,
    avgScore: 0.665,
    categoryHintsCount: 0,
    entitiesCount: 0,
    anchorsCount: 0,
    domainWeak: false,
    precomputedChunksEvidenceTopActs: [
      {
        rada_nreg: '950-2007-п',
        count_in_top30: 6,
        avg_score_in_top30: 0.65,
        max_score: 0.67,
        best_rank_in_top30: 1,
        rank_mass_top30: 1.83,
        max_ordering_score: 0.53,
      },
      {
        rada_nreg: '250-2026-р',
        count_in_top30: 1,
        avg_score_in_top30: 0.71,
        max_score: 0.71,
        best_rank_in_top30: 2,
        rank_mass_top30: 0.5,
        max_ordering_score: 0.42,
      },
    ],
    getActMeta: async (rada_nreg) => {
      if (rada_nreg === '250-2026-р') {
        return {
          rada_nreg,
          title: 'Про внесення змін до розпорядження Кабінету Міністрів України від 25 червня 2025 р. № 625',
          category: 'public_administration',
          document_type: 'Розпорядження КМУ',
          document_type_slug: 'cmu_order',
          storage_category: null,
          summary: null,
          aliases: [],
          validity_status: 'in_force',
        };
      }
      if (rada_nreg === '950-2007-п') {
        return {
          rada_nreg,
          title: 'Про затвердження Регламенту Кабінету Міністрів України',
          category: 'public_administration',
          document_type: 'Постанова КМУ',
          document_type_slug: 'cmu_resolution',
          storage_category: null,
          summary: null,
          aliases: [],
          validity_status: 'in_force',
        };
      }
      return null;
    },
    hydrateSelectedActsMeta: async (acts, confidence) =>
      acts.map((act) => ({
        ...act,
        act_kind: classifyActKind(
          act.act_title ?? '',
          act.document_type ?? null,
          act.category ?? null,
          act.document_type_slug ?? null
        ),
        confidence,
      })),
    searchActsForRouting: async () => [],
  });
  if (result.low_confidence_final) {
    throw new Error(`Expected recovered soft non-primary amendment order to clear low confidence, got ${JSON.stringify(result.reasonCodes)}`);
  }
  if (result.coverageGap !== 'none') {
    throw new Error(`Expected recovered soft non-primary amendment order to map to none, got ${result.coverageGap}`);
  }
  if (result.selected_acts_final[0]?.rada_nreg !== '250-2026-р') {
    throw new Error(`Expected recovered soft non-primary amendment order to select 250-2026-р, got ${JSON.stringify(result.selected_acts_final)}`);
  }
  if (
    !result.reasonCodes.includes('SOFT_NON_PRIMARY_SINGLE_ACT_RECOVERED') &&
    !result.reasonCodes.includes('METADATA_ACT_SCOPE_RECOVERED')
  ) {
    throw new Error(`Expected bounded non-primary recovery reason code, got ${JSON.stringify(result.reasonCodes)}`);
  }
  if (
    !result.reasonCodes.includes('SOFT_NON_PRIMARY_SINGLE_ACT_CONFIRMED') &&
    !result.reasonCodes.includes('METADATA_ACT_SCOPE_CONFIRMED')
  ) {
    throw new Error(`Expected bounded non-primary confirmation reason code, got ${JSON.stringify(result.reasonCodes)}`);
  }
  console.log('[OK] single-goal finalizer recovers explicit soft non-primary amendment orders after low-confidence clear');
}

async function testResolveSingleGoalSelectedActsRecoversDateScopedRecurringNonPrimaryActAfterFrameworkDrift(): Promise<void> {
  const result = await resolveSingleGoalSelectedActs({
    query: 'Де НБУ на 24.03.2026 закріпив офіційний курс гривні щодо іноземних валют?',
    goalId: 'goal_0',
    finalHits: [
      {
        rada_nreg: 'v0001500-19',
        r2_key: 'r2://v0001500/5',
        json_path: '$.chunks[5]',
        score: 0.66,
        ordering_score: 0.48,
        title: 'Про затвердження Положення про встановлення офіційного курсу гривні до іноземних валют та розрахунку довідкового значення курсу гривні до долара США',
        unit_type: 'point',
      },
      {
        rada_nreg: 'n0117500-26',
        r2_key: 'r2://n0117500/1',
        json_path: '$.chunks[1]',
        score: 0.69,
        ordering_score: 0.4,
        title: 'Про офіційний курс гривні щодо іноземних валют',
        unit_type: 'paragraph',
      },
      {
        rada_nreg: 'v0001500-19',
        r2_key: 'r2://v0001500/7',
        json_path: '$.chunks[7]',
        score: 0.64,
        ordering_score: 0.46,
        title: 'Про затвердження Положення про встановлення офіційного курсу гривні до іноземних валют та розрахунку довідкового значення курсу гривні до долара США',
        unit_type: 'point',
      },
      {
        rada_nreg: 'v0001500-19',
        r2_key: 'r2://v0001500/2',
        json_path: '$.chunks[2]',
        score: 0.62,
        ordering_score: 0.45,
        title: 'Про затвердження Положення про встановлення офіційного курсу гривні до іноземних валют та розрахунку довідкового значення курсу гривні до долара США',
        unit_type: 'point',
      },
    ] as never,
    actCandidatesTopHydrated: [
      {
        rada_nreg: 'n0117500-26',
        title: 'Про офіційний курс гривні щодо іноземних валют',
        score: 3.1,
        category: 'finance',
        document_type: 'Постанова НБУ',
        document_type_slug: 'nbu_resolution',
        reasons: ['title_match', 'rada_datred_match'],
      },
      {
        rada_nreg: 'v0001500-19',
        title: 'Про затвердження Положення про встановлення офіційного курсу гривні до іноземних валют та розрахунку довідкового значення курсу гривні до долара США',
        score: 2.2,
        category: 'finance',
        document_type: 'Постанова НБУ',
        document_type_slug: 'nbu_resolution',
        reasons: ['summary_match'],
      },
    ],
    plannerRationaleByNreg: new Map(),
    taxonomyNregs: new Set(['n0117500-26', 'v0001500-19']),
    actsSearchNregs: ['n0117500-26', 'v0001500-19'],
    domainHint: 'finance',
    documentTypeHints: [],
    taxonomyActCount: 2,
    aliasHitCount: 0,
    exactActHitCount: 0,
    exactActNregs: [],
    groundedActHitCount: 0,
    groundedActNregs: [],
    actSelectionLowConfidence: false,
    reasonCodes: [],
    useLowConfidenceFallback: false,
    queryRewriteMeta: { called: false, used: false, not_used_reason_codes: [] },
    topScore: 0.69,
    avgScore: 0.652,
    categoryHintsCount: 1,
    entitiesCount: 1,
    anchorsCount: 0,
    domainWeak: false,
    precomputedChunksEvidenceTopActs: [
      {
        rada_nreg: 'v0001500-19',
        count_in_top30: 7,
        avg_score_in_top30: 0.64,
        max_score: 0.66,
        best_rank_in_top30: 1,
        rank_mass_top30: 1.92,
        max_ordering_score: 0.48,
      },
      {
        rada_nreg: 'n0117500-26',
        count_in_top30: 1,
        avg_score_in_top30: 0.69,
        max_score: 0.69,
        best_rank_in_top30: 2,
        rank_mass_top30: 0.5,
        max_ordering_score: 0.4,
      },
    ],
    getActMeta: async (rada_nreg) => {
      if (rada_nreg === 'n0117500-26') {
        return {
          rada_nreg,
          title: 'Про офіційний курс гривні щодо іноземних валют',
          category: 'finance',
          document_type: 'Постанова НБУ',
          document_type_slug: 'nbu_resolution',
          storage_category: null,
          summary: null,
          aliases: [],
          validity_status: 'in_force',
        };
      }
      if (rada_nreg === 'v0001500-19') {
        return {
          rada_nreg,
          title: 'Про затвердження Положення про встановлення офіційного курсу гривні до іноземних валют та розрахунку довідкового значення курсу гривні до долара США',
          category: 'finance',
          document_type: 'Постанова НБУ',
          document_type_slug: 'nbu_resolution',
          storage_category: null,
          summary: null,
          aliases: [],
          validity_status: 'in_force',
        };
      }
      return null;
    },
    hydrateSelectedActsMeta: async (acts, confidence) =>
      acts.map((act) => ({
        ...act,
        act_kind: classifyActKind(
          act.act_title ?? '',
          act.document_type ?? null,
          act.category ?? null,
          act.document_type_slug ?? null
        ),
        confidence,
      })),
    searchActsForRouting: async () => [],
  });
  if (result.low_confidence_final) {
    throw new Error(`Expected recovered date-scoped recurring non-primary act to clear low confidence, got ${JSON.stringify(result.reasonCodes)}`);
  }
  if (result.selected_acts_final[0]?.rada_nreg !== 'n0117500-26') {
    throw new Error(`Expected recovered date-scoped recurring act to select n0117500-26, got ${JSON.stringify(result.selected_acts_final)}`);
  }
  if (
    !result.reasonCodes.includes('SOFT_NON_PRIMARY_SINGLE_ACT_RECOVERED') &&
    !result.reasonCodes.includes('EVIDENCE_ACT_SCOPE_RECOVERED') &&
    !result.reasonCodes.includes('METADATA_ACT_SCOPE_RECOVERED')
  ) {
    throw new Error(`Expected recurring non-primary recovery reason code, got ${JSON.stringify(result.reasonCodes)}`);
  }
  console.log('[OK] single-goal finalizer recovers date-scoped recurring non-primary acts after framework drift');
}

async function testResolveSingleGoalSelectedActsConfirmsRecoveredLiveLikeNbuDailyActCluster(): Promise<void> {
  const result = await resolveSingleGoalSelectedActs({
    query: 'Де НБУ на 24.03.2026 закріпив офіційний курс гривні щодо іноземних валют?',
    goalId: 'goal_0',
    finalHits: [
      {
        rada_nreg: 'v0001500-19',
        r2_key: 'r2://v0001500-19/27',
        json_path: '$.points[27]',
        score: 0.5861674,
        ordering_score: 0.49267761416478406,
        title:
          'Про затвердження Положення про структуру валютного ринку України, умови та порядок торгівлі іноземною валютою та банківськими металами на валютному ринку України',
        unit_type: 'point',
      },
      {
        rada_nreg: 'v0001500-19',
        r2_key: 'r2://v0001500-19/35',
        json_path: '$.points[35]',
        score: 0.57,
        ordering_score: 0.486,
        title:
          'Про затвердження Положення про структуру валютного ринку України, умови та порядок торгівлі іноземною валютою та банківськими металами на валютному ринку України',
        unit_type: 'point',
      },
      {
        rada_nreg: 'v0001500-19',
        r2_key: 'r2://v0001500-19/101',
        json_path: '$.points[101]',
        score: 0.56,
        ordering_score: 0.451,
        title:
          'Про затвердження Положення про структуру валютного ринку України, умови та порядок торгівлі іноземною валютою та банківськими металами на валютному ринку України',
        unit_type: 'point',
      },
      {
        rada_nreg: 'n0117500-26',
        r2_key: 'r2://n0117500-26/1',
        json_path: '$.paragraphs[1]',
        score: 0.7701485,
        ordering_score: 0.4338653400000001,
        title: 'Про офіційний курс гривні щодо іноземних валют',
        unit_type: 'paragraph',
      },
    ] as never,
    actCandidatesTopHydrated: [
      {
        rada_nreg: 'n0117500-26',
        title: 'Про офіційний курс гривні щодо іноземних валют',
        score: 59.356456885330765,
        category: 'finance_banking',
        document_type: 'Повідомлення НБУ',
        document_type_slug: 'nbu_letter',
        reasons: [
          'rada_datred_match',
          'summary_match',
          'keyword_match',
          'title_match',
          'alias_match',
          'exact_alias_match',
          'validity_in_force',
          'hits_evidence',
        ],
      },
      {
        rada_nreg: 'n0119500-26',
        title: 'Про офіційний курс гривні щодо іноземних валют',
        score: 55.58525245664431,
        category: 'finance_banking',
        document_type: 'Повідомлення НБУ',
        document_type_slug: 'nbu_letter',
        reasons: [
          'rada_datred_penalty',
          'keyword_match',
          'summary_match',
          'title_match',
          'alias_match',
          'exact_alias_match',
          'validity_in_force',
          'hits_evidence',
        ],
      },
      {
        rada_nreg: 'v0001500-19',
        title:
          'Про затвердження Положення про структуру валютного ринку України, умови та порядок торгівлі іноземною валютою та банківськими металами на валютному ринку України',
        score: 0.14999999999999983,
        category: 'finance_banking',
        document_type: 'Постанова НБУ',
        document_type_slug: 'nbu_resolution',
        reasons: [
          'rada_datred_penalty',
          'referenced_rada_datred_penalty',
          'keyword_match',
          'validity_in_force',
          'chunks_evidence_meta',
        ],
      },
      {
        rada_nreg: 'n0121500-26',
        title: 'Про офіційний курс гривні щодо іноземних валют',
        score: 53.90000000000003,
        category: 'finance_banking',
        document_type: 'Повідомлення НБУ',
        document_type_slug: 'nbu_letter',
        reasons: [
          'rada_datred_penalty',
          'alias_match',
          'keyword_match',
          'title_match',
          'exact_alias_match',
          'summary_match',
          'validity_in_force',
          'chunks_evidence_meta',
        ],
      },
      {
        rada_nreg: 'n0033500-26',
        title: 'Про офіційний курс гривні щодо іноземних валют',
        score: 55.15000000000003,
        category: 'finance_banking',
        document_type: 'Повідомлення НБУ',
        document_type_slug: 'nbu_letter',
        reasons: [
          'rada_datred_penalty',
          'alias_match',
          'keyword_match',
          'title_match',
          'exact_alias_match',
          'summary_match',
          'validity_in_force',
          'chunks_evidence_meta',
        ],
      },
      {
        rada_nreg: 'n0031500-26',
        title: 'Про офіційний курс гривні щодо іноземних валют',
        score: 52.65000000000003,
        category: 'finance_banking',
        document_type: 'Повідомлення НБУ',
        document_type_slug: 'nbu_letter',
        reasons: [
          'rada_datred_penalty',
          'alias_match',
          'keyword_match',
          'title_match',
          'exact_alias_match',
          'summary_match',
          'validity_in_force',
          'chunks_evidence_meta',
        ],
      },
    ],
    plannerRationaleByNreg: new Map(),
    taxonomyNregs: new Set(['n0117500-26', 'n0119500-26', 'v0001500-19', 'n0121500-26', 'n0033500-26', 'n0031500-26']),
    actsSearchNregs: ['n0117500-26', 'n0119500-26', 'v0001500-19', 'n0121500-26', 'n0033500-26', 'n0031500-26'],
    domainHint: 'general',
    documentTypeHints: [],
    taxonomyActCount: 6,
    aliasHitCount: 0,
    exactActHitCount: 0,
    exactActNregs: [],
    groundedActHitCount: 0,
    groundedActNregs: [],
    actSelectionLowConfidence: false,
    reasonCodes: [],
    useLowConfidenceFallback: false,
    queryRewriteMeta: { called: false, used: false, not_used_reason_codes: [] },
    topScore: 0.7701485,
    avgScore: 0.566043026,
    categoryHintsCount: 0,
    entitiesCount: 0,
    anchorsCount: 0,
    domainWeak: false,
    precomputedChunksEvidenceTopActs: [
      {
        rada_nreg: 'v0001500-19',
        count_in_top30: 5,
        avg_score_in_top30: 0.566043026,
        max_score: 0.5861674,
        best_rank_in_top30: 1,
        rank_mass_top30: 1.9388888888888889,
        max_ordering_score: 0.49267761416478406,
      },
      {
        rada_nreg: 'n0117500-26',
        count_in_top30: 1,
        avg_score_in_top30: 0.7701485,
        max_score: 0.7701485,
        best_rank_in_top30: 4,
        rank_mass_top30: 0.25,
        max_ordering_score: 0.4338653400000001,
      },
      {
        rada_nreg: 'n0121500-26',
        count_in_top30: 1,
        avg_score_in_top30: 0.7682724,
        max_score: 0.7682724,
        best_rank_in_top30: 5,
        rank_mass_top30: 0.2,
        max_ordering_score: 0.43303985600000006,
      },
      {
        rada_nreg: 'n0119500-26',
        count_in_top30: 1,
        avg_score_in_top30: 0.765533,
        max_score: 0.765533,
        best_rank_in_top30: 6,
        rank_mass_top30: 0.16666666666666666,
        max_ordering_score: 0.4318345200000001,
      },
      {
        rada_nreg: 'n0033500-26',
        count_in_top30: 1,
        avg_score_in_top30: 0.7651565,
        max_score: 0.7651565,
        best_rank_in_top30: 7,
        rank_mass_top30: 0.14285714285714285,
        max_ordering_score: 0.43166886000000004,
      },
      {
        rada_nreg: 'n0031500-26',
        count_in_top30: 1,
        avg_score_in_top30: 0.7645441,
        max_score: 0.7645441,
        best_rank_in_top30: 8,
        rank_mass_top30: 0.125,
        max_ordering_score: 0.431399404,
      },
    ],
    getActMeta: async (rada_nreg) => {
      if (rada_nreg === 'v0001500-19') {
        return {
          rada_nreg,
          title:
            'Про затвердження Положення про структуру валютного ринку України, умови та порядок торгівлі іноземною валютою та банківськими металами на валютному ринку України',
          category: 'finance_banking',
          document_type: 'Постанова НБУ',
          document_type_slug: 'nbu_resolution',
          storage_category: 'other',
          summary: null,
          aliases: [],
          validity_status: 'in_force',
        };
      }
      return {
        rada_nreg,
        title: 'Про офіційний курс гривні щодо іноземних валют',
        category: 'finance_banking',
        document_type: 'Повідомлення НБУ',
        document_type_slug: 'nbu_letter',
        storage_category: 'finance',
        summary: null,
        aliases: [],
        validity_status: 'in_force',
      };
    },
    hydrateSelectedActsMeta: async (acts, confidence) =>
      acts.map((act) => ({
        ...act,
        act_kind: classifyActKind(
          act.act_title ?? '',
          act.document_type ?? null,
          act.category ?? null,
          act.document_type_slug ?? null
        ),
        confidence,
      })),
    searchActsForRouting: async () => [],
  });
  if (result.low_confidence_final) {
    throw new Error(`Expected live-like recovered NBU daily act cluster to clear low confidence, got ${JSON.stringify(result.reasonCodes)}`);
  }
  if (result.coverageGap !== 'none') {
    throw new Error(`Expected live-like recovered NBU daily act cluster to clear coverage gap, got ${result.coverageGap}`);
  }
  if (result.selected_acts_final[0]?.rada_nreg !== 'n0117500-26') {
    throw new Error(`Expected live-like recovered NBU daily act cluster to select n0117500-26, got ${JSON.stringify(result.selected_acts_final)}`);
  }
  if (!result.reasonCodes.includes('SOFT_NON_PRIMARY_SINGLE_ACT_RECOVERED')) {
    throw new Error(`Expected live-like recovered NBU daily act cluster to keep recovery reason code, got ${JSON.stringify(result.reasonCodes)}`);
  }
  if (!result.reasonCodes.includes('SOFT_NON_PRIMARY_SINGLE_ACT_CONFIRMED')) {
    throw new Error(`Expected live-like recovered NBU daily act cluster to confirm recovered act, got ${JSON.stringify(result.reasonCodes)}`);
  }
  console.log('[OK] single-goal finalizer confirms recovered live-like NBU daily-act clusters');
}

async function testResolveSingleGoalSelectedActsRejectsSemanticNeighborForAbsentExplicitLawTitle(): Promise<void> {
  const result = await resolveSingleGoalSelectedActs({
    query:
      'За Законом України «Про захист населення від інфекційних хвороб», чи можуть працівників окремих професій відсторонити від роботи через відмову від обов\'язкових щеплень?',
    goalId: 'goal_0',
    finalHits: [
      {
        rada_nreg: '322-08',
        r2_key: 'r2://322/27',
        json_path: '$.chunks[27]',
        score: 0.736,
        ordering_score: 0.692,
        title: 'Про забезпечення санітарного та епідемічного благополуччя населення',
        article_number: '27',
      },
      {
        rada_nreg: '322-08',
        r2_key: 'r2://322/26',
        json_path: '$.chunks[26]',
        score: 0.721,
        ordering_score: 0.674,
        title: 'Про забезпечення санітарного та епідемічного благополуччя населення',
        article_number: '26',
      },
      {
        rada_nreg: '322-08',
        r2_key: 'r2://322/7',
        json_path: '$.chunks[7]',
        score: 0.703,
        ordering_score: 0.661,
        title: 'Про забезпечення санітарного та епідемічного благополуччя населення',
        article_number: '7',
      },
      {
        rada_nreg: '2341-14',
        r2_key: 'r2://2341/325',
        json_path: '$.chunks[325]',
        score: 0.624,
        ordering_score: 0.541,
        title: 'Кримінальний кодекс України',
        article_number: '325',
      },
    ] as never,
    actCandidatesTopHydrated: [
      {
        rada_nreg: '322-08',
        title: 'Про забезпечення санітарного та епідемічного благополуччя населення',
        score: 1.72,
        category: 'health',
        document_type: 'Закон',
        document_type_slug: 'law',
        reasons: ['title_match'],
      },
      {
        rada_nreg: '2341-14',
        title: 'Кримінальний кодекс України',
        score: 0.96,
        category: 'criminal',
        document_type: 'Кодекс',
        document_type_slug: 'code',
      },
    ],
    plannerRationaleByNreg: new Map(),
    taxonomyNregs: new Set(),
    actsSearchNregs: [],
    domainHint: 'general',
    documentTypeHints: ['law'],
    taxonomyActCount: 0,
    aliasHitCount: 0,
    exactActHitCount: 0,
    exactActNregs: [],
    groundedActHitCount: 0,
    groundedActNregs: [],
    actSelectionLowConfidence: false,
    reasonCodes: ['NON_PRIMARY_SUPPORT_BLOCKED_PRIMARY_PRESENT'],
    useLowConfidenceFallback: false,
    queryRewriteMeta: { called: false, used: false, not_used_reason_codes: [] },
    topScore: 0.736,
    avgScore: 0.68,
    categoryHintsCount: 0,
    entitiesCount: 1,
    anchorsCount: 0,
    domainWeak: false,
    precomputedChunksEvidenceTopActs: [
      {
        rada_nreg: '322-08',
        count_in_top30: 8,
        avg_score_in_top30: 0.71,
        max_score: 0.736,
        best_rank_in_top30: 1,
        rank_mass_top30: 1.64,
        max_ordering_score: 0.692,
      },
      {
        rada_nreg: '2341-14',
        count_in_top30: 2,
        avg_score_in_top30: 0.62,
        max_score: 0.624,
        best_rank_in_top30: 9,
        rank_mass_top30: 0.29,
        max_ordering_score: 0.541,
      },
    ],
    getActMeta: async (rada_nreg) => {
      const byNreg: Record<
        string,
        {
          title: string;
          category: string;
          document_type: string;
          document_type_slug: string;
          storage_category: string | null;
        }
      > = {
        '322-08': {
          title: 'Про забезпечення санітарного та епідемічного благополуччя населення',
          category: 'health',
          document_type: 'Закон',
          document_type_slug: 'law',
          storage_category: null,
        },
        '2341-14': {
          title: 'Кримінальний кодекс України',
          category: 'criminal',
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
        act_kind: classifyActKind(
          act.act_title ?? '',
          act.document_type ?? null,
          act.category ?? null,
          act.document_type_slug ?? null
        ),
        confidence,
      })),
    searchActsForRouting: async () => [],
  });
  if (!result.low_confidence_final) {
    throw new Error(`Expected absent explicit law-title semantic-neighbor query to stay low confidence, got ${JSON.stringify(result.reasonCodes)}`);
  }
  if (result.coverageGap !== 'likely_missing_act') {
    throw new Error(`Expected absent explicit law-title semantic-neighbor query to map to likely_missing_act, got ${result.coverageGap}`);
  }
  if (result.reasonCodes.includes('EVIDENCE_ACT_SCOPE_CONFIRMED') || result.reasonCodes.includes('METADATA_ACT_SCOPE_CONFIRMED')) {
    throw new Error(`Expected absent explicit law-title semantic-neighbor query to avoid fake act-scope confirmation, got ${JSON.stringify(result.reasonCodes)}`);
  }
  console.log('[OK] single-goal finalizer rejects semantic-neighbor fallback for absent explicit law-title queries');
}

async function testResolveSingleGoalSelectedActsRejectsBaseOrderFallbackForAbsentExplicitAmendmentOrder(): Promise<void> {
  const result = await resolveSingleGoalSelectedActs({
    query:
      'За постановою Кабінету Міністрів України «Про внесення зміни до пункту 14 Порядку здійснення закупівлі безпілотних систем, засобів радіоелектронної боротьби тактичного рівня вітчизняного виробництва та їх складових частин», порядок закупівлі яких саме засобів і виробів змінюється цією постановою?',
    goalId: 'goal_0',
    finalHits: [
      {
        rada_nreg: '955-2010-п',
        r2_key: 'r2://955/14',
        json_path: '$.chunks[14]',
        score: 0.838,
        ordering_score: 0.79,
        title:
          'Про затвердження Порядку здійснення закупівлі безпілотних систем, засобів радіоелектронної боротьби тактичного рівня вітчизняного виробництва та їх складових частин',
        unit_type: 'point',
      },
      {
        rada_nreg: '955-2010-п',
        r2_key: 'r2://955/9',
        json_path: '$.chunks[9]',
        score: 0.802,
        ordering_score: 0.76,
        title:
          'Про затвердження Порядку здійснення закупівлі безпілотних систем, засобів радіоелектронної боротьби тактичного рівня вітчизняного виробництва та їх складових частин',
        unit_type: 'point',
      },
      {
        rada_nreg: '907-2015-п',
        r2_key: 'r2://907/1',
        json_path: '$.chunks[1]',
        score: 0.74,
        ordering_score: 0.69,
        title: 'Про затвердження Порядку використання коштів для закупівлі безпілотних систем',
        unit_type: 'point',
      },
    ] as never,
    actCandidatesTopHydrated: [
      {
        rada_nreg: '955-2010-п',
        title:
          'Про затвердження Порядку здійснення закупівлі безпілотних систем, засобів радіоелектронної боротьби тактичного рівня вітчизняного виробництва та їх складових частин',
        score: 2.9,
        category: 'procurement',
        document_type: 'Постанова КМУ',
        document_type_slug: 'cmu_resolution',
        reasons: ['title_match', 'summary_match'],
      },
      {
        rada_nreg: '907-2015-п',
        title: 'Про затвердження Порядку використання коштів для закупівлі безпілотних систем',
        score: 1.4,
        category: 'procurement',
        document_type: 'Постанова КМУ',
        document_type_slug: 'cmu_resolution',
        reasons: ['summary_match'],
      },
    ],
    plannerRationaleByNreg: new Map(),
    taxonomyNregs: new Set(),
    actsSearchNregs: [],
    domainHint: 'general',
    documentTypeHints: ['cmu_resolution'],
    taxonomyActCount: 0,
    aliasHitCount: 0,
    exactActHitCount: 0,
    exactActNregs: [],
    groundedActHitCount: 0,
    groundedActNregs: [],
    actSelectionLowConfidence: false,
    reasonCodes: [],
    useLowConfidenceFallback: false,
    queryRewriteMeta: { called: false, used: false, not_used_reason_codes: [] },
    topScore: 0.838,
    avgScore: 0.793,
    categoryHintsCount: 0,
    entitiesCount: 1,
    anchorsCount: 0,
    domainWeak: false,
    precomputedChunksEvidenceTopActs: [
      {
        rada_nreg: '955-2010-п',
        count_in_top30: 7,
        avg_score_in_top30: 0.81,
        max_score: 0.838,
        best_rank_in_top30: 1,
        rank_mass_top30: 1.94,
        max_ordering_score: 0.79,
      },
      {
        rada_nreg: '907-2015-п',
        count_in_top30: 2,
        avg_score_in_top30: 0.74,
        max_score: 0.74,
        best_rank_in_top30: 4,
        rank_mass_top30: 0.28,
        max_ordering_score: 0.69,
      },
    ],
    getActMeta: async (rada_nreg) => {
      const byNreg: Record<
        string,
        {
          title: string;
          category: string;
          document_type: string;
          document_type_slug: string;
          storage_category: string | null;
        }
      > = {
        '955-2010-п': {
          title:
            'Про затвердження Порядку здійснення закупівлі безпілотних систем, засобів радіоелектронної боротьби тактичного рівня вітчизняного виробництва та їх складових частин',
          category: 'procurement',
          document_type: 'Постанова КМУ',
          document_type_slug: 'cmu_resolution',
          storage_category: null,
        },
        '907-2015-п': {
          title: 'Про затвердження Порядку використання коштів для закупівлі безпілотних систем',
          category: 'procurement',
          document_type: 'Постанова КМУ',
          document_type_slug: 'cmu_resolution',
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
        act_kind: classifyActKind(
          act.act_title ?? '',
          act.document_type ?? null,
          act.category ?? null,
          act.document_type_slug ?? null
        ),
        confidence,
      })),
    searchActsForRouting: async () => [],
  });
  if (!result.low_confidence_final) {
    throw new Error(`Expected absent amendment-order query to stay low confidence, got ${JSON.stringify(result.reasonCodes)}`);
  }
  if (result.coverageGap !== 'likely_missing_act') {
    throw new Error(`Expected absent amendment-order query to map to likely_missing_act, got ${result.coverageGap}`);
  }
  if (
    result.reasonCodes.includes('AUTHORITATIVE_NON_PRIMARY_SCOPE_CONFIRMED') ||
    result.reasonCodes.includes('METADATA_ACT_SCOPE_CONFIRMED') ||
    result.reasonCodes.includes('EVIDENCE_ACT_SCOPE_CONFIRMED')
  ) {
    throw new Error(`Expected absent amendment-order query not to confirm a neighboring base order, got ${JSON.stringify(result.reasonCodes)}`);
  }
  console.log('[OK] single-goal finalizer rejects base-order fallback for absent amendment-order queries');
}

async function testResolveSingleGoalSelectedActsRejectsPersonnelOrderNeighborForAbsentExplicitDismissalOrder(): Promise<void> {
  const result = await resolveSingleGoalSelectedActs({
    query: 'Яким розпорядженням Кабінету Міністрів України звільнено Мироненка Ю.М. з посади заступника Міністра оборони України?',
    goalId: 'goal_0',
    finalHits: [
      {
        rada_nreg: '50-2026-р',
        r2_key: 'r2://50/1',
        json_path: '$.chunks[1]',
        score: 0.625,
        ordering_score: 0.37,
        title: 'Про звільнення Шевцова М.М. з посади заступника Міністра оборони України',
        unit_type: 'paragraph',
      },
      {
        rada_nreg: '49-2026-р',
        r2_key: 'r2://49/1',
        json_path: '$.chunks[1]',
        score: 0.613,
        ordering_score: 0.365,
        title: 'Про звільнення Козенка О.В. з посади заступника Міністра оборони України',
        unit_type: 'paragraph',
      },
      {
        rada_nreg: '32-2026-р',
        r2_key: 'r2://32/1',
        json_path: '$.chunks[1]',
        score: 0.571,
        ordering_score: 0.346,
        title: 'Про звільнення Куцевола А.А. з посади заступника Міністра оборони України з питань європейської інтеграції',
        unit_type: 'paragraph',
      },
    ] as never,
    actCandidatesTopHydrated: [
      {
        rada_nreg: '32-2026-р',
        title: 'Про звільнення Куцевола А.А. з посади заступника Міністра оборони України з питань європейської інтеграції',
        score: 3.2,
        category: 'defense_mobilization',
        document_type: 'Розпорядження КМУ',
        document_type_slug: 'cmu_order',
        reasons: ['title_match', 'summary_match'],
      },
      {
        rada_nreg: '50-2026-р',
        title: 'Про звільнення Шевцова М.М. з посади заступника Міністра оборони України',
        score: 1.0,
        category: 'defense_mobilization',
        document_type: 'Розпорядження КМУ',
        document_type_slug: 'cmu_order',
        reasons: ['summary_match'],
      },
      {
        rada_nreg: '49-2026-р',
        title: 'Про звільнення Козенка О.В. з посади заступника Міністра оборони України',
        score: 0.9,
        category: 'defense_mobilization',
        document_type: 'Розпорядження КМУ',
        document_type_slug: 'cmu_order',
        reasons: ['summary_match'],
      },
    ],
    plannerRationaleByNreg: new Map(),
    taxonomyNregs: new Set(),
    actsSearchNregs: [],
    domainHint: 'administrative',
    documentTypeHints: ['cmu_order'],
    taxonomyActCount: 0,
    aliasHitCount: 0,
    exactActHitCount: 0,
    exactActNregs: [],
    groundedActHitCount: 0,
    groundedActNregs: [],
    actSelectionLowConfidence: false,
    reasonCodes: [],
    useLowConfidenceFallback: false,
    queryRewriteMeta: { called: false, used: false, not_used_reason_codes: [] },
    topScore: 0.831,
    avgScore: 0.603,
    categoryHintsCount: 0,
    entitiesCount: 1,
    anchorsCount: 0,
    domainWeak: false,
    precomputedChunksEvidenceTopActs: [
      {
        rada_nreg: '32-2026-р',
        count_in_top30: 2,
        avg_score_in_top30: 0.571,
        max_score: 0.571,
        best_rank_in_top30: 7,
        rank_mass_top30: 0.14,
        max_ordering_score: 0.346,
      },
      {
        rada_nreg: '50-2026-р',
        count_in_top30: 3,
        avg_score_in_top30: 0.625,
        max_score: 0.625,
        best_rank_in_top30: 1,
        rank_mass_top30: 0.22,
        max_ordering_score: 0.37,
      },
      {
        rada_nreg: '49-2026-р',
        count_in_top30: 2,
        avg_score_in_top30: 0.613,
        max_score: 0.613,
        best_rank_in_top30: 2,
        rank_mass_top30: 0.15,
        max_ordering_score: 0.365,
      },
    ],
    getActMeta: async (rada_nreg) => {
      const byNreg: Record<
        string,
        {
          title: string;
          category: string;
          document_type: string;
          document_type_slug: string;
          storage_category: string | null;
        }
      > = {
        '32-2026-р': {
          title: 'Про звільнення Куцевола А.А. з посади заступника Міністра оборони України з питань європейської інтеграції',
          category: 'defense_mobilization',
          document_type: 'Розпорядження КМУ',
          document_type_slug: 'cmu_order',
          storage_category: null,
        },
        '50-2026-р': {
          title: 'Про звільнення Шевцова М.М. з посади заступника Міністра оборони України',
          category: 'defense_mobilization',
          document_type: 'Розпорядження КМУ',
          document_type_slug: 'cmu_order',
          storage_category: null,
        },
        '49-2026-р': {
          title: 'Про звільнення Козенка О.В. з посади заступника Міністра оборони України',
          category: 'defense_mobilization',
          document_type: 'Розпорядження КМУ',
          document_type_slug: 'cmu_order',
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
        act_kind: classifyActKind(
          act.act_title ?? '',
          act.document_type ?? null,
          act.category ?? null,
          act.document_type_slug ?? null
        ),
        confidence,
      })),
    searchActsForRouting: async () => [],
  });
  if (!result.low_confidence_final) {
    throw new Error(`Expected absent personnel-order query to stay low confidence, got ${JSON.stringify(result.reasonCodes)}`);
  }
  if (result.coverageGap !== 'likely_missing_act') {
    throw new Error(`Expected absent personnel-order query to map to likely_missing_act, got ${result.coverageGap}`);
  }
  if (result.selected_acts_final.some((act) => act.rada_nreg === '32-2026-р')) {
    throw new Error(`Expected neighboring dismissal order to be cleared from selected acts, got ${JSON.stringify(result.selected_acts_final)}`);
  }
  if (
    result.reasonCodes.includes('AUTHORITATIVE_NON_PRIMARY_SCOPE_CONFIRMED') ||
    result.reasonCodes.includes('METADATA_ACT_SCOPE_CONFIRMED') ||
    result.reasonCodes.includes('EVIDENCE_ACT_SCOPE_CONFIRMED')
  ) {
    throw new Error(`Expected absent personnel-order query not to confirm neighboring dismissal orders, got ${JSON.stringify(result.reasonCodes)}`);
  }
  console.log('[OK] single-goal finalizer rejects neighboring personnel-order fallback for absent explicit dismissal query');
}

async function testResolveSingleGoalSelectedActsRejectsGenericGovernmentRegulationFallbackForAbsentExplicitContractExtensionOrder(): Promise<void> {
  const result = await resolveSingleGoalSelectedActs({
    query: 'Яким актом Кабінету Міністрів у березні 2026 року подовжено контракт із директором ДП "Енергоринок" Гнатюком Ю.Л.?',
    goalId: 'goal_0',
    finalHits: [
      {
        rada_nreg: '950-2007-п',
        r2_key: 'r2://950/4',
        json_path: '$.chunks[4]',
        score: 0.488,
        ordering_score: 0.477,
        title: 'Про затвердження Регламенту Кабінету Міністрів України',
        unit_type: 'point',
      },
      {
        rada_nreg: '950-2007-п',
        r2_key: 'r2://950/2',
        json_path: '$.chunks[2]',
        score: 0.444,
        ordering_score: 0.471,
        title: 'Про затвердження Регламенту Кабінету Міністрів України',
        unit_type: 'point',
      },
      {
        rada_nreg: '950-2007-п',
        r2_key: 'r2://950/531',
        json_path: '$.chunks[531]',
        score: 0.444,
        ordering_score: 0.459,
        title: 'Про затвердження Регламенту Кабінету Міністрів України',
        unit_type: 'point',
      },
      {
        rada_nreg: '43-2026-п',
        r2_key: 'r2://43/6',
        json_path: '$.chunks[6]',
        score: 0.528,
        ordering_score: 0.504,
        title:
          'Про внесення змін до постанов Кабінету Міністрів України від 8 липня 2020 р. № 573 і від 15 січня 2026 р. № 39',
        unit_type: 'point',
      },
      {
        rada_nreg: '41-2026-р',
        r2_key: 'r2://41/1',
        json_path: '$.chunks[1]',
        score: 0.535,
        ordering_score: 0.28,
        title:
          'Про передачу повноважень з управління корпоративними правами держави акціонерного товариства “Науково-технічний комплекс “Електронприлад”',
        unit_type: 'paragraph',
      },
      {
        rada_nreg: '36-2026-р',
        r2_key: 'r2://36/1',
        json_path: '$.chunks[1]',
        score: 0.502,
        ordering_score: 0.266,
        title:
          'Про призначення Куцевола А.А. заступником Міністра енергетики України з питань європейської інтеграції',
        unit_type: 'paragraph',
      },
    ] as never,
    actCandidatesTopHydrated: [
      {
        rada_nreg: '950-2007-п',
        title: 'Про затвердження Регламенту Кабінету Міністрів України',
        score: 3.4,
        category: 'administrative',
        document_type: 'Постанова КМУ',
        document_type_slug: 'cmu_resolution',
        reasons: ['summary_match'],
      },
      {
        rada_nreg: '43-2026-п',
        title:
          'Про внесення змін до постанов Кабінету Міністрів України від 8 липня 2020 р. № 573 і від 15 січня 2026 р. № 39',
        score: 2.9,
        category: 'administrative',
        document_type: 'Постанова КМУ',
        document_type_slug: 'cmu_resolution',
        reasons: ['summary_match'],
      },
      {
        rada_nreg: '41-2026-р',
        title:
          'Про передачу повноважень з управління корпоративними правами держави акціонерного товариства “Науково-технічний комплекс “Електронприлад”',
        score: 2.2,
        category: 'administrative',
        document_type: 'Розпорядження КМУ',
        document_type_slug: 'cmu_order',
        reasons: ['summary_match'],
      },
      {
        rada_nreg: '36-2026-р',
        title:
          'Про призначення Куцевола А.А. заступником Міністра енергетики України з питань європейської інтеграції',
        score: 2.0,
        category: 'administrative',
        document_type: 'Розпорядження КМУ',
        document_type_slug: 'cmu_order',
        reasons: ['summary_match'],
      },
    ],
    plannerRationaleByNreg: new Map(),
    taxonomyNregs: new Set(['950-2007-п', '43-2026-п', '41-2026-р', '36-2026-р']),
    actsSearchNregs: [],
    domainHint: 'administrative',
    documentTypeHints: ['cmu_order', 'cmu_resolution'],
    taxonomyActCount: 4,
    aliasHitCount: 0,
    exactActHitCount: 0,
    exactActNregs: [],
    groundedActHitCount: 0,
    groundedActNregs: [],
    actSelectionLowConfidence: false,
    reasonCodes: [],
    useLowConfidenceFallback: false,
    queryRewriteMeta: { called: false, used: false, not_used_reason_codes: [] },
    topScore: 0.5539477,
    avgScore: 0.49,
    categoryHintsCount: 0,
    entitiesCount: 1,
    anchorsCount: 0,
    domainWeak: false,
    precomputedChunksEvidenceTopActs: [
      {
        rada_nreg: '950-2007-п',
        count_in_top30: 5,
        avg_score_in_top30: 0.46,
        max_score: 0.488,
        best_rank_in_top30: 2,
        rank_mass_top30: 0.95,
        max_ordering_score: 0.477,
      },
      {
        rada_nreg: '43-2026-п',
        count_in_top30: 2,
        avg_score_in_top30: 0.528,
        max_score: 0.528,
        best_rank_in_top30: 1,
        rank_mass_top30: 0.58,
        max_ordering_score: 0.504,
      },
      {
        rada_nreg: '41-2026-р',
        count_in_top30: 1,
        avg_score_in_top30: 0.535,
        max_score: 0.535,
        best_rank_in_top30: 8,
        rank_mass_top30: 0.08,
        max_ordering_score: 0.28,
      },
      {
        rada_nreg: '36-2026-р',
        count_in_top30: 1,
        avg_score_in_top30: 0.502,
        max_score: 0.502,
        best_rank_in_top30: 10,
        rank_mass_top30: 0.06,
        max_ordering_score: 0.266,
      },
    ],
    getActMeta: async (rada_nreg) => {
      const byNreg: Record<
        string,
        {
          title: string;
          category: string;
          document_type: string;
          document_type_slug: string;
          storage_category: string | null;
        }
      > = {
        '950-2007-п': {
          title: 'Про затвердження Регламенту Кабінету Міністрів України',
          category: 'administrative',
          document_type: 'Постанова КМУ',
          document_type_slug: 'cmu_resolution',
          storage_category: null,
        },
        '43-2026-п': {
          title:
            'Про внесення змін до постанов Кабінету Міністрів України від 8 липня 2020 р. № 573 і від 15 січня 2026 р. № 39',
          category: 'administrative',
          document_type: 'Постанова КМУ',
          document_type_slug: 'cmu_resolution',
          storage_category: null,
        },
        '41-2026-р': {
          title:
            'Про передачу повноважень з управління корпоративними правами держави акціонерного товариства “Науково-технічний комплекс “Електронприлад”',
          category: 'administrative',
          document_type: 'Розпорядження КМУ',
          document_type_slug: 'cmu_order',
          storage_category: null,
        },
        '36-2026-р': {
          title:
            'Про призначення Куцевола А.А. заступником Міністра енергетики України з питань європейської інтеграції',
          category: 'administrative',
          document_type: 'Розпорядження КМУ',
          document_type_slug: 'cmu_order',
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
        act_kind: classifyActKind(
          act.act_title ?? '',
          act.document_type ?? null,
          act.category ?? null,
          act.document_type_slug ?? null
        ),
        confidence,
      })),
    searchActsForRouting: async () => [],
  });
  if (!result.low_confidence_final) {
    throw new Error(`Expected absent contract-extension order query to stay low confidence, got ${JSON.stringify(result.reasonCodes)}`);
  }
  if (result.coverageGap !== 'likely_missing_act') {
    throw new Error(`Expected absent contract-extension order query to map to likely_missing_act, got ${result.coverageGap}`);
  }
  if (result.selected_acts_final.some((act) => act.rada_nreg === '950-2007-п')) {
    throw new Error(`Expected generic CMU regulation fallback to be cleared, got ${JSON.stringify(result.selected_acts_final)}`);
  }
  if (
    result.reasonCodes.includes('AUTHORITATIVE_NON_PRIMARY_SCOPE_CONFIRMED') ||
    result.reasonCodes.includes('METADATA_ACT_SCOPE_CONFIRMED') ||
    result.reasonCodes.includes('EVIDENCE_ACT_SCOPE_CONFIRMED')
  ) {
    throw new Error(`Expected absent contract-extension order query not to confirm generic CMU regulation fallback, got ${JSON.stringify(result.reasonCodes)}`);
  }
  console.log('[OK] single-goal finalizer rejects generic CMU regulation fallback for absent explicit contract-extension order query');
}

async function testResolveSingleGoalSelectedActsRecoversExplicitPersonnelOrderWithMatchingIdentity(): Promise<void> {
  const result = await resolveSingleGoalSelectedActs({
    query: 'Яким розпорядженням Кабінету Міністрів України звільнено Клочка А.О. з посади заступника Міністра оборони України?',
    goalId: 'goal_0',
    finalHits: [
      {
        rada_nreg: '2469-19',
        r2_key: 'r2://2469/8',
        json_path: '$.chunks[8]',
        score: 0.661,
        ordering_score: 0.593,
        title: 'Про соціальний і правовий захист військовослужбовців та членів їх сімей',
        article_number: '8',
      },
      {
        rada_nreg: '48-2026-р',
        r2_key: 'r2://48/1',
        json_path: '$.chunks[1]',
        score: 0.647,
        ordering_score: 0.436,
        title: 'Про звільнення Клочка А.О. з посади заступника Міністра оборони України',
        unit_type: 'paragraph',
      },
      {
        rada_nreg: '32-2026-р',
        r2_key: 'r2://32/1',
        json_path: '$.chunks[1]',
        score: 0.643,
        ordering_score: 0.371,
        title: 'Про звільнення Куцевола А.А. з посади заступника Міністра оборони України з питань європейської інтеграції',
        unit_type: 'paragraph',
      },
    ] as never,
    actCandidatesTopHydrated: [
      {
        rada_nreg: '32-2026-р',
        title: 'Про звільнення Куцевола А.А. з посади заступника Міністра оборони України з питань європейської інтеграції',
        score: 4.3,
        category: 'defense_mobilization',
        document_type: 'Розпорядження КМУ',
        document_type_slug: 'cmu_order',
        reasons: ['title_match', 'summary_match'],
      },
      {
        rada_nreg: '48-2026-р',
        title: 'Про звільнення Клочка А.О. з посади заступника Міністра оборони України',
        score: 3.8,
        category: 'defense_mobilization',
        document_type: 'Розпорядження КМУ',
        document_type_slug: 'cmu_order',
        reasons: ['title_match', 'summary_match'],
      },
      {
        rada_nreg: '2469-19',
        title: 'Про соціальний і правовий захист військовослужбовців та членів їх сімей',
        score: 1.7,
        category: 'defense_mobilization',
        document_type: 'Закон',
        document_type_slug: 'law',
        reasons: ['summary_match'],
      },
    ],
    plannerRationaleByNreg: new Map(),
    taxonomyNregs: new Set(['32-2026-р', '48-2026-р', '2469-19']),
    actsSearchNregs: [],
    domainHint: 'administrative',
    documentTypeHints: ['cmu_order'],
    taxonomyActCount: 3,
    aliasHitCount: 0,
    exactActHitCount: 0,
    exactActNregs: [],
    groundedActHitCount: 0,
    groundedActNregs: [],
    actSelectionLowConfidence: false,
    reasonCodes: [],
    useLowConfidenceFallback: false,
    queryRewriteMeta: { called: false, used: false, not_used_reason_codes: [] },
    topScore: 0.661,
    avgScore: 0.65,
    categoryHintsCount: 1,
    entitiesCount: 1,
    anchorsCount: 1,
    domainWeak: false,
    precomputedChunksEvidenceTopActs: [
      {
        rada_nreg: '2469-19',
        count_in_top30: 4,
        avg_score_in_top30: 0.648,
        max_score: 0.661,
        best_rank_in_top30: 1,
        rank_mass_top30: 0.93,
        max_ordering_score: 0.593,
      },
      {
        rada_nreg: '48-2026-р',
        count_in_top30: 2,
        avg_score_in_top30: 0.647,
        max_score: 0.647,
        best_rank_in_top30: 2,
        rank_mass_top30: 0.35,
        max_ordering_score: 0.436,
      },
      {
        rada_nreg: '32-2026-р',
        count_in_top30: 2,
        avg_score_in_top30: 0.643,
        max_score: 0.643,
        best_rank_in_top30: 3,
        rank_mass_top30: 0.31,
        max_ordering_score: 0.371,
      },
    ],
    getActMeta: async (rada_nreg) => {
      const byNreg: Record<
        string,
        {
          title: string;
          category: string;
          document_type: string;
          document_type_slug: string;
          storage_category: string | null;
        }
      > = {
        '32-2026-р': {
          title: 'Про звільнення Куцевола А.А. з посади заступника Міністра оборони України з питань європейської інтеграції',
          category: 'defense_mobilization',
          document_type: 'Розпорядження КМУ',
          document_type_slug: 'cmu_order',
          storage_category: null,
        },
        '48-2026-р': {
          title: 'Про звільнення Клочка А.О. з посади заступника Міністра оборони України',
          category: 'defense_mobilization',
          document_type: 'Розпорядження КМУ',
          document_type_slug: 'cmu_order',
          storage_category: null,
        },
        '2469-19': {
          title: 'Про соціальний і правовий захист військовослужбовців та членів їх сімей',
          category: 'defense_mobilization',
          document_type: 'Закон',
          document_type_slug: 'law',
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
        act_kind: classifyActKind(
          act.act_title ?? '',
          act.document_type ?? null,
          act.category ?? null,
          act.document_type_slug ?? null
        ),
        confidence,
      })),
    searchActsForRouting: async () => [],
  });
  if (result.low_confidence_final) {
    throw new Error(`Expected present personnel-order query with matching identity to resolve confidently, got ${JSON.stringify(result.reasonCodes)}`);
  }
  if (result.coverageGap !== 'none') {
    throw new Error(`Expected present personnel-order query with matching identity to keep coverage_gap=none, got ${result.coverageGap}`);
  }
  if (result.selected_acts_final.length !== 1 || result.selected_acts_final[0]?.rada_nreg !== '48-2026-р') {
    throw new Error(`Expected explicit personnel-order query to recover 48-2026-р, got ${JSON.stringify(result.selected_acts_final)}`);
  }
  if (
    !result.reasonCodes.includes('METADATA_ACT_SCOPE_CONFIRMED') &&
    !result.reasonCodes.includes('GROUNDED_ACT_SCOPE_CONFIRMED') &&
    !result.reasonCodes.includes('EVIDENCE_ACT_SCOPE_CONFIRMED')
  ) {
    throw new Error(`Expected explicit personnel-order query to confirm act scope, got ${JSON.stringify(result.reasonCodes)}`);
  }
  console.log('[OK] single-goal finalizer keeps only the personnel order with matching named identity under noisy same-family evidence');
}

async function testResolveSingleGoalSelectedActsRecoversSoftPersonnelAppointmentOrderWithMatchingIdentity(): Promise<void> {
  const result = await resolveSingleGoalSelectedActs({
    query: 'Яким рішенням Кабміну призначили Компанійця О.С. державним секретарем Міністерства цифрової трансформації України?',
    goalId: 'goal_0',
    finalHits: [
      {
        rada_nreg: '950-2007-п',
        r2_key: 'r2://950/4',
        json_path: '$.chunks[4]',
        score: 0.547,
        ordering_score: 0.511,
        title: 'Про затвердження Регламенту Кабінету Міністрів України',
        unit_type: 'point',
      },
      {
        rada_nreg: '950-2007-п',
        r2_key: 'r2://950/31',
        json_path: '$.chunks[31]',
        score: 0.549,
        ordering_score: 0.508,
        title: 'Про затвердження Регламенту Кабінету Міністрів України',
        unit_type: 'point',
      },
      {
        rada_nreg: '950-2007-п',
        r2_key: 'r2://950/3',
        json_path: '$.chunks[3]',
        score: 0.538,
        ordering_score: 0.499,
        title: 'Про затвердження Регламенту Кабінету Міністрів України',
        unit_type: 'point',
      },
      {
        rada_nreg: '950-2007-п',
        r2_key: 'r2://950/2',
        json_path: '$.chunks[2]',
        score: 0.541,
        ordering_score: 0.485,
        title: 'Про затвердження Регламенту Кабінету Міністрів України',
        unit_type: 'point',
      },
      {
        rada_nreg: '950-2007-п',
        r2_key: 'r2://950/1',
        json_path: '$.chunks[1]',
        score: 0.531,
        ordering_score: 0.453,
        title: 'Про затвердження Регламенту Кабінету Міністрів України',
        unit_type: 'point',
      },
      {
        rada_nreg: '235-2026-р',
        r2_key: 'r2://235/1',
        json_path: '$.chunks[1]',
        score: 0.77,
        ordering_score: 0.384,
        title: 'Про призначення Компанійця О.С. державним секретарем Міністерства цифрової трансформації України',
        unit_type: 'paragraph',
      },
      {
        rada_nreg: '16-2026-р',
        r2_key: 'r2://16/1',
        json_path: '$.chunks[1]',
        score: 0.548,
        ordering_score: 0.336,
        title: 'Про тимчасове покладення виконання обов’язків Міністра цифрової трансформації України на Борнякова О.С.',
        unit_type: 'paragraph',
      },
      {
        rada_nreg: '34-2026-р',
        r2_key: 'r2://34/1',
        json_path: '$.chunks[1]',
        score: 0.584,
        ordering_score: 0.302,
        title: 'Про звільнення Турчака І.М. з посади державного секретаря Міністерства цифрової трансформації України',
        unit_type: 'paragraph',
      },
    ] as never,
    actCandidatesTopHydrated: [
      {
        rada_nreg: '950-2007-п',
        title: 'Про затвердження Регламенту Кабінету Міністрів України',
        score: 4.2,
        category: 'administrative',
        document_type: 'Постанова КМУ',
        document_type_slug: 'cmu_resolution',
        reasons: ['summary_match'],
      },
      {
        rada_nreg: '235-2026-р',
        title: 'Про призначення Компанійця О.С. державним секретарем Міністерства цифрової трансформації України',
        score: 3.6,
        category: 'administrative',
        document_type: 'Розпорядження КМУ',
        document_type_slug: 'cmu_order',
        reasons: ['title_match', 'summary_match'],
      },
      {
        rada_nreg: '34-2026-р',
        title: 'Про звільнення Турчака І.М. з посади державного секретаря Міністерства цифрової трансформації України',
        score: 2.5,
        category: 'administrative',
        document_type: 'Розпорядження КМУ',
        document_type_slug: 'cmu_order',
        reasons: ['summary_match'],
      },
      {
        rada_nreg: '16-2026-р',
        title: 'Про тимчасове покладення виконання обов’язків Міністра цифрової трансформації України на Борнякова О.С.',
        score: 2.2,
        category: 'administrative',
        document_type: 'Розпорядження КМУ',
        document_type_slug: 'cmu_order',
        reasons: ['summary_match'],
      },
    ],
    plannerRationaleByNreg: new Map(),
    taxonomyNregs: new Set(['950-2007-п', '235-2026-р', '34-2026-р', '16-2026-р']),
    actsSearchNregs: [],
    domainHint: 'general',
    documentTypeHints: ['cmu_resolution', 'cmu_order'],
    taxonomyActCount: 4,
    aliasHitCount: 0,
    exactActHitCount: 0,
    exactActNregs: [],
    groundedActHitCount: 0,
    groundedActNregs: [],
    actSelectionLowConfidence: false,
    reasonCodes: [],
    useLowConfidenceFallback: false,
    queryRewriteMeta: { called: false, used: false, not_used_reason_codes: [] },
    topScore: 0.7699319,
    avgScore: 0.589,
    categoryHintsCount: 0,
    entitiesCount: 1,
    anchorsCount: 0,
    domainWeak: false,
    precomputedChunksEvidenceTopActs: [
      {
        rada_nreg: '950-2007-п',
        count_in_top30: 5,
        avg_score_in_top30: 0.541,
        max_score: 0.549,
        best_rank_in_top30: 1,
        rank_mass_top30: 1.72,
        max_ordering_score: 0.511,
      },
      {
        rada_nreg: '235-2026-р',
        count_in_top30: 1,
        avg_score_in_top30: 0.77,
        max_score: 0.77,
        best_rank_in_top30: 6,
        rank_mass_top30: 0.09,
        max_ordering_score: 0.384,
      },
      {
        rada_nreg: '34-2026-р',
        count_in_top30: 1,
        avg_score_in_top30: 0.584,
        max_score: 0.584,
        best_rank_in_top30: 8,
        rank_mass_top30: 0.05,
        max_ordering_score: 0.302,
      },
      {
        rada_nreg: '16-2026-р',
        count_in_top30: 1,
        avg_score_in_top30: 0.548,
        max_score: 0.548,
        best_rank_in_top30: 7,
        rank_mass_top30: 0.06,
        max_ordering_score: 0.336,
      },
    ],
    getActMeta: async (rada_nreg) => {
      const byNreg: Record<
        string,
        {
          title: string;
          category: string;
          document_type: string;
          document_type_slug: string;
          storage_category: string | null;
        }
      > = {
        '950-2007-п': {
          title: 'Про затвердження Регламенту Кабінету Міністрів України',
          category: 'administrative',
          document_type: 'Постанова КМУ',
          document_type_slug: 'cmu_resolution',
          storage_category: null,
        },
        '235-2026-р': {
          title: 'Про призначення Компанійця О.С. державним секретарем Міністерства цифрової трансформації України',
          category: 'administrative',
          document_type: 'Розпорядження КМУ',
          document_type_slug: 'cmu_order',
          storage_category: null,
        },
        '34-2026-р': {
          title: 'Про звільнення Турчака І.М. з посади державного секретаря Міністерства цифрової трансформації України',
          category: 'administrative',
          document_type: 'Розпорядження КМУ',
          document_type_slug: 'cmu_order',
          storage_category: null,
        },
        '16-2026-р': {
          title: 'Про тимчасове покладення виконання обов’язків Міністра цифрової трансформації України на Борнякова О.С.',
          category: 'administrative',
          document_type: 'Розпорядження КМУ',
          document_type_slug: 'cmu_order',
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
        act_kind: classifyActKind(
          act.act_title ?? '',
          act.document_type ?? null,
          act.category ?? null,
          act.document_type_slug ?? null
        ),
        confidence,
      })),
    searchActsForRouting: async () => [],
  });
  if (result.low_confidence_final) {
    throw new Error(`Expected soft personnel-appointment query with matching identity to resolve confidently, got ${JSON.stringify(result.reasonCodes)}`);
  }
  if (result.coverageGap !== 'none') {
    throw new Error(`Expected soft personnel-appointment query with matching identity to keep coverage_gap=none, got ${result.coverageGap}`);
  }
  if (result.selected_acts_final.length !== 1 || result.selected_acts_final[0]?.rada_nreg !== '235-2026-р') {
    throw new Error(`Expected soft personnel-appointment query to recover 235-2026-р, got ${JSON.stringify(result.selected_acts_final)}`);
  }
  if (
    result.reasonCodes.includes('AUTHORITATIVE_NON_PRIMARY_SCOPE_CONFIRMED') !== true &&
    result.reasonCodes.includes('METADATA_ACT_SCOPE_CONFIRMED') !== true
  ) {
    throw new Error(`Expected soft personnel-appointment query to confirm non-primary act scope, got ${JSON.stringify(result.reasonCodes)}`);
  }
  console.log('[OK] single-goal finalizer recovers soft personnel-appointment order from generic CMU regulation noise when named identity converges');
}

async function testResolveSingleGoalSelectedActsRealignsSoftAmendmentOrderWhenChunksFavorSemanticNeighbor(): Promise<void> {
  const result = await resolveSingleGoalSelectedActs({
    query:
      'Де Кабмін у березні 2026 року скоригував порядок експериментального проекту допомоги покупцям товарів і послуг українського виробництва?',
    goalId: 'goal_0',
    finalHits: [
      {
        rada_nreg: '342-2026-п',
        r2_key: 'r2://342/6',
        json_path: '$.chunks[6]',
        score: 0.52452344,
        ordering_score: 0.4970839284547802,
        title:
          'Про внесення змін до Порядку реалізації експериментального проекту щодо надання державної грошової допомоги покупцям товарів та послуг українського виробництва в рамках Всеукраїнської економічної платформи “Зроблено в Україні”',
        unit_type: 'point',
      },
      {
        rada_nreg: '353-2026-п',
        r2_key: 'r2://353/5',
        json_path: '$.chunks[5]',
        score: 0.48764837,
        ordering_score: 0.49178923484059267,
        title:
          'Про реалізацію експериментального проекту щодо будівництва та/або розміщення систем незалежного резервного живлення в багатоквартирних будинках м. Києва',
        unit_type: 'point',
      },
      {
        rada_nreg: '353-2026-п',
        r2_key: 'r2://353/22',
        json_path: '$.chunks[22]',
        score: 0.5332604,
        ordering_score: 0.489861,
        title:
          'Про реалізацію експериментального проекту щодо будівництва та/або розміщення систем незалежного резервного живлення в багатоквартирних будинках м. Києва',
        unit_type: 'point',
      },
      {
        rada_nreg: '1178-2022-п',
        r2_key: 'r2://1178/8',
        json_path: '$.chunks[8]',
        score: 0.482,
        ordering_score: 0.48679557218666786,
        title:
          'Про затвердження особливостей здійснення публічних закупівель товарів, робіт і послуг для замовників, передбачених Законом України “Про публічні закупівлі”, на період дії правового режиму воєнного стану в Україні та протягом 90 днів з дня його припинення або скасування',
        unit_type: 'point',
      },
      {
        rada_nreg: '23-2026-п',
        r2_key: 'r2://23/5',
        json_path: '$.chunks[5]',
        score: 0.503,
        ordering_score: 0.40792775064358444,
        title:
          'Про реалізацію експериментального проекту щодо збирання, накопичення, оброблення та відображення в реальному часі та в динаміці інформації про стан реалізації державної політики',
        unit_type: 'point',
      },
    ] as never,
    actCandidatesTopHydrated: [
      {
        rada_nreg: '342-2026-п',
        title:
          'Про внесення змін до Порядку реалізації експериментального проекту щодо надання державної грошової допомоги покупцям товарів та послуг українського виробництва в рамках Всеукраїнської економічної платформи “Зроблено в Україні”',
        score: 32.90853360601289,
        category: 'finance_banking',
        document_type: 'Постанова КМУ',
        document_type_slug: 'cmu_resolution',
        reasons: ['title_match', 'summary_match', 'keyword_match', 'validity_in_force', 'amendment_act_penalty', 'hits_evidence'],
      },
      {
        rada_nreg: '353-2026-п',
        title:
          'Про реалізацію експериментального проекту щодо будівництва та/або розміщення систем незалежного резервного живлення в багатоквартирних будинках м. Києва',
        score: 4.08,
        category: 'energy_utilities',
        document_type: 'Постанова КМУ',
        document_type_slug: 'cmu_resolution',
        reasons: ['summary_match', 'title_match', 'validity_in_force'],
      },
      {
        rada_nreg: '23-2026-п',
        title:
          'Про реалізацію експериментального проекту щодо збирання, накопичення, оброблення та відображення в реальному часі та в динаміці інформації про стан реалізації державної політики',
        score: 4.53,
        category: 'administrative',
        document_type: 'Постанова КМУ',
        document_type_slug: 'cmu_resolution',
        reasons: ['summary_match', 'title_match', 'validity_in_force'],
      },
      {
        rada_nreg: '1178-2022-п',
        title:
          'Про затвердження особливостей здійснення публічних закупівель товарів, робіт і послуг для замовників, передбачених Законом України “Про публічні закупівлі”, на період дії правового режиму воєнного стану в Україні та протягом 90 днів з дня його припинення або скасування',
        score: 3.93,
        category: 'procurement',
        document_type: 'Постанова КМУ',
        document_type_slug: 'cmu_resolution',
        reasons: ['summary_match', 'title_match', 'validity_in_force'],
      },
      {
        rada_nreg: '950-2007-п',
        title: 'Про затвердження Регламенту Кабінету Міністрів України',
        score: 0.55,
        category: 'administrative',
        document_type: 'Постанова КМУ',
        document_type_slug: 'cmu_resolution',
        reasons: ['validity_in_force'],
      },
    ],
    plannerRationaleByNreg: new Map(),
    taxonomyNregs: new Set(['342-2026-п', '353-2026-п', '23-2026-п', '1178-2022-п', '950-2007-п']),
    actsSearchNregs: [],
    domainHint: 'general',
    documentTypeHints: ['cmu_resolution', 'cmu_order'],
    taxonomyActCount: 5,
    aliasHitCount: 0,
    exactActHitCount: 0,
    exactActNregs: [],
    groundedActHitCount: 0,
    groundedActNregs: [],
    actSelectionLowConfidence: false,
    reasonCodes: [],
    useLowConfidenceFallback: false,
    queryRewriteMeta: { called: false, used: false, not_used_reason_codes: [] },
    topScore: 0.57841873,
    avgScore: 0.4849302939,
    categoryHintsCount: 0,
    entitiesCount: 0,
    anchorsCount: 1,
    domainWeak: false,
    precomputedChunksEvidenceTopActs: [
      {
        rada_nreg: '353-2026-п',
        count_in_top30: 12,
        avg_score_in_top30: 0.48824658,
        max_score: 0.57841873,
        best_rank_in_top30: 2,
        rank_mass_top30: 1.7029318476580142,
        max_ordering_score: 0.49178923484059267,
      },
      {
        rada_nreg: '342-2026-п',
        count_in_top30: 4,
        avg_score_in_top30: 0.52523451,
        max_score: 0.53429925,
        best_rank_in_top30: 1,
        rank_mass_top30: 1.1244306418219463,
        max_ordering_score: 0.4970839284547802,
      },
      {
        rada_nreg: '1178-2022-п',
        count_in_top30: 7,
        avg_score_in_top30: 0.4924692457142857,
        max_score: 0.52415276,
        best_rank_in_top30: 4,
        rank_mass_top30: 0.6744627594627594,
        max_ordering_score: 0.48679557218666786,
      },
      {
        rada_nreg: '23-2026-п',
        count_in_top30: 5,
        avg_score_in_top30: 0.502179542,
        max_score: 0.56750804,
        best_rank_in_top30: 11,
        rank_mass_top30: 0.3014952153110048,
        max_ordering_score: 0.40792775064358444,
      },
      {
        rada_nreg: '950-2007-п',
        count_in_top30: 1,
        avg_score_in_top30: 0.5206867,
        max_score: 0.5206867,
        best_rank_in_top30: 8,
        rank_mass_top30: 0.125,
        max_ordering_score: 0.46206895718344976,
      },
    ],
    getActMeta: async (rada_nreg) => {
      const byNreg: Record<
        string,
        {
          title: string;
          category: string;
          document_type: string;
          document_type_slug: string;
          storage_category: string | null;
        }
      > = {
        '342-2026-п': {
          title:
            'Про внесення змін до Порядку реалізації експериментального проекту щодо надання державної грошової допомоги покупцям товарів та послуг українського виробництва в рамках Всеукраїнської економічної платформи “Зроблено в Україні”',
          category: 'finance_banking',
          document_type: 'Постанова КМУ',
          document_type_slug: 'cmu_resolution',
          storage_category: null,
        },
        '353-2026-п': {
          title:
            'Про реалізацію експериментального проекту щодо будівництва та/або розміщення систем незалежного резервного живлення в багатоквартирних будинках м. Києва',
          category: 'energy_utilities',
          document_type: 'Постанова КМУ',
          document_type_slug: 'cmu_resolution',
          storage_category: null,
        },
        '23-2026-п': {
          title:
            'Про реалізацію експериментального проекту щодо збирання, накопичення, оброблення та відображення в реальному часі та в динаміці інформації про стан реалізації державної політики',
          category: 'administrative',
          document_type: 'Постанова КМУ',
          document_type_slug: 'cmu_resolution',
          storage_category: null,
        },
        '1178-2022-п': {
          title:
            'Про затвердження особливостей здійснення публічних закупівель товарів, робіт і послуг для замовників, передбачених Законом України “Про публічні закупівлі”, на період дії правового режиму воєнного стану в Україні та протягом 90 днів з дня його припинення або скасування',
          category: 'procurement',
          document_type: 'Постанова КМУ',
          document_type_slug: 'cmu_resolution',
          storage_category: null,
        },
        '950-2007-п': {
          title: 'Про затвердження Регламенту Кабінету Міністрів України',
          category: 'administrative',
          document_type: 'Постанова КМУ',
          document_type_slug: 'cmu_resolution',
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
        act_kind: classifyActKind(
          act.act_title ?? '',
          act.document_type ?? null,
          act.category ?? null,
          act.document_type_slug ?? null
        ),
        confidence,
      })),
    searchActsForRouting: async () => [],
  });
  if (result.low_confidence_final) {
    throw new Error(`Expected soft amendment-order query with dominant title identity to resolve confidently, got ${JSON.stringify(result.reasonCodes)}`);
  }
  if (result.coverageGap !== 'none') {
    throw new Error(`Expected soft amendment-order query with dominant title identity to keep coverage_gap=none, got ${result.coverageGap}`);
  }
  if (result.selected_acts_final.length !== 1 || result.selected_acts_final[0]?.rada_nreg !== '342-2026-п') {
    throw new Error(`Expected soft amendment-order query to realign to 342-2026-п, got ${JSON.stringify(result.selected_acts_final)}`);
  }
  if (!result.reasonCodes.includes('AUTHORITATIVE_NON_PRIMARY_REALIGNED_TO_METADATA_EVIDENCE')) {
    throw new Error(`Expected soft amendment-order query to record metadata/evidence realignment, got ${JSON.stringify(result.reasonCodes)}`);
  }
  console.log('[OK] single-goal finalizer realigns soft amendment-order query back to the title-dominant act when chunk count favors a semantic neighbor');
}

async function testResolveSingleGoalSelectedActsConfirmsSoftPersonnelAppointmentOrderWithAbbreviatedOffice(): Promise<void> {
  const result = await resolveSingleGoalSelectedActs({
    query: 'Де уряд оформив призначення Компанійця О.С. держсекретарем Мінцифри?',
    goalId: 'goal_0',
    finalHits: [
      {
        rada_nreg: '235-2026-р',
        r2_key: 'r2://235/1',
        json_path: '$.chunks[1]',
        score: 0.634,
        ordering_score: 0.374,
        title: 'Про призначення Компанійця О.С. державним секретарем Міністерства цифрової трансформації України',
        unit_type: 'paragraph',
      },
      {
        rada_nreg: '37-2026-р',
        r2_key: 'r2://37/1',
        json_path: '$.chunks[1]',
        score: 0.404,
        ordering_score: 0.223,
        title: 'Про призначення Малашкіна М.А. державним секретарем Міністерства енергетики України',
        unit_type: 'paragraph',
      },
      {
        rada_nreg: '66/2026',
        r2_key: 'r2://66/1',
        json_path: '$.chunks[1]',
        score: 0.375,
        ordering_score: 0.21,
        title: 'Про призначення О. Кубракова Радником Президента України з питань інфраструктури та взаємодії з громадами',
        unit_type: 'paragraph',
      },
      {
        rada_nreg: '6-2026-р',
        r2_key: 'r2://6/1',
        json_path: '$.chunks[1]',
        score: 0.321,
        ordering_score: 0.186,
        title: 'Про призначення Шапірка В.Г. заступником Голови Державної служби України з питань геодезії, картографії та кадастру з питань цифрового розвитку, цифрових трансформацій і цифровізації',
        unit_type: 'paragraph',
      },
      {
        rada_nreg: '18-2026-р',
        r2_key: 'r2://18/1',
        json_path: '$.chunks[1]',
        score: 0.308,
        ordering_score: 0.18,
        title: 'Про призначення Голубоша В.В. заступником Голови Державної служби України з безпеки на транспорті',
        unit_type: 'paragraph',
      },
    ] as never,
    actCandidatesTopHydrated: [
      {
        rada_nreg: '235-2026-р',
        title: 'Про призначення Компанійця О.С. державним секретарем Міністерства цифрової трансформації України',
        score: 2.8,
        category: 'administrative',
        document_type: 'Розпорядження КМУ',
        document_type_slug: 'cmu_order',
        reasons: ['summary_match'],
      },
      {
        rada_nreg: '37-2026-р',
        title: 'Про призначення Малашкіна М.А. державним секретарем Міністерства енергетики України',
        score: 2.1,
        category: 'administrative',
        document_type: 'Розпорядження КМУ',
        document_type_slug: 'cmu_order',
        reasons: ['summary_match'],
      },
      {
        rada_nreg: '66/2026',
        title: 'Про призначення О. Кубракова Радником Президента України з питань інфраструктури та взаємодії з громадами',
        score: 1.8,
        category: 'administrative',
        document_type: 'Розпорядження Президента України',
        document_type_slug: 'presidential_order',
        reasons: ['summary_match'],
      },
    ],
    plannerRationaleByNreg: new Map(),
    taxonomyNregs: new Set(['235-2026-р', '37-2026-р', '66/2026']),
    actsSearchNregs: [],
    domainHint: 'general',
    documentTypeHints: ['cmu_order'],
    taxonomyActCount: 3,
    aliasHitCount: 0,
    exactActHitCount: 0,
    exactActNregs: [],
    groundedActHitCount: 0,
    groundedActNregs: [],
    actSelectionLowConfidence: false,
    reasonCodes: [],
    useLowConfidenceFallback: false,
    queryRewriteMeta: { called: false, used: false, not_used_reason_codes: [] },
    topScore: 0.63398093,
    avgScore: 0.408,
    categoryHintsCount: 0,
    entitiesCount: 1,
    anchorsCount: 0,
    domainWeak: false,
    precomputedChunksEvidenceTopActs: [
      {
        rada_nreg: '235-2026-р',
        count_in_top30: 1,
        avg_score_in_top30: 0.634,
        max_score: 0.634,
        best_rank_in_top30: 1,
        rank_mass_top30: 0.21,
        max_ordering_score: 0.374,
      },
      {
        rada_nreg: '37-2026-р',
        count_in_top30: 1,
        avg_score_in_top30: 0.404,
        max_score: 0.404,
        best_rank_in_top30: 2,
        rank_mass_top30: 0.1,
        max_ordering_score: 0.223,
      },
    ],
    getActMeta: async (rada_nreg) => {
      const byNreg: Record<
        string,
        {
          title: string;
          category: string;
          document_type: string;
          document_type_slug: string;
          storage_category: string | null;
        }
      > = {
        '235-2026-р': {
          title: 'Про призначення Компанійця О.С. державним секретарем Міністерства цифрової трансформації України',
          category: 'administrative',
          document_type: 'Розпорядження КМУ',
          document_type_slug: 'cmu_order',
          storage_category: null,
        },
        '37-2026-р': {
          title: 'Про призначення Малашкіна М.А. державним секретарем Міністерства енергетики України',
          category: 'administrative',
          document_type: 'Розпорядження КМУ',
          document_type_slug: 'cmu_order',
          storage_category: null,
        },
        '66/2026': {
          title: 'Про призначення О. Кубракова Радником Президента України з питань інфраструктури та взаємодії з громадами',
          category: 'administrative',
          document_type: 'Розпорядження Президента України',
          document_type_slug: 'presidential_order',
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
        act_kind: classifyActKind(
          act.act_title ?? '',
          act.document_type ?? null,
          act.category ?? null,
          act.document_type_slug ?? null
        ),
        confidence,
      })),
    searchActsForRouting: async () => [],
  });
  if (result.low_confidence_final) {
    throw new Error(`Expected abbreviated-office personnel-order query to resolve confidently, got ${JSON.stringify(result.reasonCodes)}`);
  }
  if (result.coverageGap !== 'none') {
    throw new Error(`Expected abbreviated-office personnel-order query to keep coverage_gap=none, got ${result.coverageGap}`);
  }
  if (result.selected_acts_final.length !== 1 || result.selected_acts_final[0]?.rada_nreg !== '235-2026-р') {
    throw new Error(`Expected abbreviated-office personnel-order query to keep 235-2026-р, got ${JSON.stringify(result.selected_acts_final)}`);
  }
  if (!result.reasonCodes.includes('AUTHORITATIVE_NON_PRIMARY_SCOPE_CONFIRMED')) {
    throw new Error(`Expected abbreviated-office personnel-order query to confirm authoritative non-primary scope, got ${JSON.stringify(result.reasonCodes)}`);
  }
  console.log('[OK] single-goal finalizer confirms soft personnel-appointment order with abbreviated office when named identity and early evidence converge');
}

async function testResolveSingleGoalSelectedActsFlagsUngroundedGeneralChunksOnlyPrimaryFallback(): Promise<void> {
  const result = await resolveSingleGoalSelectedActs({
    query: 'Які права має особа на видалення своїх персональних даних і які засоби захисту є при бездіяльності володільця?',
    goalId: 'goal_0',
    finalHits: [
      {
        rada_nreg: '1023-12',
        r2_key: 'r2://1023/31',
        json_path: '$.chunks[31]',
        score: 0.57,
        ordering_score: 0.0,
        title: 'Про захист прав споживачів',
        article_number: '31',
      },
      {
        rada_nreg: '435-15',
        r2_key: 'r2://435/200',
        json_path: '$.chunks[200]',
        score: 0.55,
        ordering_score: 0.0,
        title: 'Цивільний кодекс України',
        article_number: '200',
      },
    ] as never,
    actCandidatesTopHydrated: [
      {
        rada_nreg: '1023-12',
        title: 'Про захист прав споживачів',
        score: 1.6,
        category: 'civil',
        document_type: 'Закон',
        document_type_slug: 'law',
      },
      {
        rada_nreg: '435-15',
        title: 'Цивільний кодекс України',
        score: 1.5,
        category: 'civil',
        document_type: 'Кодекс',
        document_type_slug: 'code',
      },
    ],
    plannerRationaleByNreg: new Map(),
    taxonomyNregs: new Set(),
    actsSearchNregs: [],
    domainHint: 'general',
    documentTypeHints: [],
    taxonomyActCount: 0,
    aliasHitCount: 0,
    exactActHitCount: 0,
    exactActNregs: [],
    groundedActHitCount: 0,
    groundedActNregs: [],
    actSelectionLowConfidence: false,
    reasonCodes: ['CHUNKS_FAMILY_MISMATCH_DEMOTED', 'SUPPORT_FAMILY_MISMATCH_BLOCKED', 'ORDER_UNRELATED_BLOCKED'],
    useLowConfidenceFallback: false,
    queryRewriteMeta: { called: false, used: false, not_used_reason_codes: [] },
    topScore: 0.57,
    avgScore: 0.56,
    categoryHintsCount: 0,
    entitiesCount: 1,
    anchorsCount: 1,
    domainWeak: false,
    precomputedChunksEvidenceTopActs: [
      {
        rada_nreg: '1023-12',
        count_in_top30: 4,
        avg_score_in_top30: 0.55,
        max_score: 0.57,
        best_rank_in_top30: 1,
        rank_mass_top30: 0.42,
        max_ordering_score: 0.0,
      },
      {
        rada_nreg: '435-15',
        count_in_top30: 3,
        avg_score_in_top30: 0.53,
        max_score: 0.55,
        best_rank_in_top30: 5,
        rank_mass_top30: 0.21,
        max_ordering_score: 0.0,
      },
    ],
    getActMeta: async (rada_nreg) => {
      const byNreg: Record<string, { title: string; category: string; document_type: string; document_type_slug: string; storage_category: string | null }> = {
        '1023-12': {
          title: 'Про захист прав споживачів',
          category: 'civil',
          document_type: 'Закон',
          document_type_slug: 'law',
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
        act_kind: classifyActKind(
          act.act_title ?? '',
          act.document_type ?? null,
          act.category ?? null,
          act.document_type_slug ?? null
        ),
        confidence,
      })),
    searchActsForRouting: async () => [],
  });
  if (!result.low_confidence_final) {
    throw new Error(`Expected chunks-only general primary fallback to be low confidence, got ${JSON.stringify(result.reasonCodes)}`);
  }
  if (!result.reasonCodes.includes('UNGROUNDED_GENERAL_PRIMARY_FALLBACK')) {
    throw new Error(`Expected UNGROUNDED_GENERAL_PRIMARY_FALLBACK reason code, got ${JSON.stringify(result.reasonCodes)}`);
  }
  console.log('[OK] single-goal finalizer flags chunks-only general primary fallback despite structural query detail');
}

async function testResolveSingleGoalSelectedActsFlagsUngroundedPrimaryCompanionFallback(): Promise<void> {
  const result = await resolveSingleGoalSelectedActs({
    query: 'Хочу стерти свої персональні дані: які строки для відповіді і куди скаржитися, якщо мені відмовляють?',
    goalId: 'goal_0',
    finalHits: [
      {
        rada_nreg: '1023-12',
        r2_key: 'r2://1023/31',
        json_path: '$.chunks[31]',
        score: 0.586,
        ordering_score: 0.0,
        title: 'Про захист прав споживачів',
        article_number: '31',
      },
      {
        rada_nreg: '435-15',
        r2_key: 'r2://435/200',
        json_path: '$.chunks[200]',
        score: 0.55,
        ordering_score: 0.0,
        title: 'Цивільний кодекс України',
        article_number: '200',
      },
      {
        rada_nreg: '80731-10',
        r2_key: 'r2://80731/188',
        json_path: '$.chunks[188]',
        score: 0.549,
        ordering_score: 0.0,
        title: 'Кодекс України про адміністративні правопорушення',
        article_number: '188-39',
      },
    ] as never,
    actCandidatesTopHydrated: [
      {
        rada_nreg: '1023-12',
        title: 'Про захист прав споживачів',
        score: 0.826,
        category: 'civil',
        document_type: 'Закон',
        document_type_slug: 'law',
      },
      {
        rada_nreg: '435-15',
        title: 'Цивільний кодекс України',
        score: 0.67,
        category: 'civil',
        document_type: 'Кодекс',
        document_type_slug: 'code',
        reasons: ['exact_title_match'],
      },
      {
        rada_nreg: '80731-10',
        title: 'Кодекс України про адміністративні правопорушення',
        score: 0.669,
        category: 'administrative_offenses',
        document_type: 'Кодекс',
        document_type_slug: 'code',
      },
    ],
    plannerRationaleByNreg: new Map(),
    taxonomyNregs: new Set(['435-15']),
    actsSearchNregs: ['435-15'],
    domainHint: 'general',
    documentTypeHints: [],
    taxonomyActCount: 1,
    aliasHitCount: 0,
    exactActHitCount: 0,
    exactActNregs: [],
    groundedActHitCount: 0,
    groundedActNregs: [],
    actSelectionLowConfidence: false,
    reasonCodes: ['CHUNKS_FAMILY_MISMATCH_DEMOTED', 'SUPPORT_FAMILY_MISMATCH_BLOCKED'],
    useLowConfidenceFallback: false,
    queryRewriteMeta: { called: false, used: false, not_used_reason_codes: [] },
    topScore: 0.586,
    avgScore: 0.57,
    categoryHintsCount: 0,
    entitiesCount: 0,
    anchorsCount: 0,
    domainWeak: false,
    precomputedChunksEvidenceTopActs: [
      {
        rada_nreg: '1023-12',
        count_in_top30: 5,
        avg_score_in_top30: 0.57,
        max_score: 0.586,
        best_rank_in_top30: 1,
        rank_mass_top30: 0.45,
        max_ordering_score: 0.0,
      },
      {
        rada_nreg: '435-15',
        count_in_top30: 1,
        avg_score_in_top30: 0.55,
        max_score: 0.55,
        best_rank_in_top30: 6,
        rank_mass_top30: 0.06,
        max_ordering_score: 0.0,
      },
      {
        rada_nreg: '80731-10',
        count_in_top30: 2,
        avg_score_in_top30: 0.547,
        max_score: 0.549,
        best_rank_in_top30: 7,
        rank_mass_top30: 0.09,
        max_ordering_score: 0.0,
      },
    ],
    getActMeta: async (rada_nreg) => {
      const byNreg: Record<
        string,
        { title: string; category: string; document_type: string; document_type_slug: string; storage_category: string | null }
      > = {
        '1023-12': {
          title: 'Про захист прав споживачів',
          category: 'civil',
          document_type: 'Закон',
          document_type_slug: 'law',
          storage_category: null,
        },
        '435-15': {
          title: 'Цивільний кодекс України',
          category: 'civil',
          document_type: 'Кодекс',
          document_type_slug: 'code',
          storage_category: null,
        },
        '80731-10': {
          title: 'Кодекс України про адміністративні правопорушення',
          category: 'administrative_offenses',
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
        act_kind: classifyActKind(
          act.act_title ?? '',
          act.document_type ?? null,
          act.category ?? null,
          act.document_type_slug ?? null
        ),
        confidence,
      })),
    searchActsForRouting: async () => [],
  });
  if (!result.low_confidence_final) {
    throw new Error(
      `Expected metadata-companion primary fallback to be low confidence, got ${JSON.stringify(result.reasonCodes)}`
    );
  }
  if (!result.reasonCodes.includes('UNGROUNDED_PRIMARY_COMPANION_FALLBACK')) {
    throw new Error(
      `Expected metadata-companion fallback reason code, got ${JSON.stringify(result.reasonCodes)}`
    );
  }
  if (result.coverageGap !== 'weak_evidence') {
    throw new Error(
      `Expected metadata-companion primary fallback to stay weak_evidence after indexed grounding, got ${result.coverageGap}`
    );
  }
  console.log('[OK] single-goal finalizer flags metadata-companion primary fallback as low confidence');
}

async function testResolveSingleGoalSelectedActsFlagsBroadSameFamilyChunksOnlyFallback(): Promise<void> {
  const result = await resolveSingleGoalSelectedActs({
    query: 'Які права має особа на видалення своїх персональних даних і які засоби захисту є при бездіяльності володільця?',
    goalId: 'goal_0',
    finalHits: [
      {
        rada_nreg: '80731-10',
        r2_key: 'r2://80731/1',
        json_path: '$.chunks[1]',
        score: 0.533,
        ordering_score: 0.533,
        title: 'Кодекс України про адміністративні правопорушення',
      },
      {
        rada_nreg: '580-19',
        r2_key: 'r2://580/1',
        json_path: '$.chunks[1]',
        score: 0.531,
        ordering_score: 0.531,
        title: 'Про Національну поліцію',
      },
      {
        rada_nreg: '1023-12',
        r2_key: 'r2://1023/31',
        json_path: '$.chunks[31]',
        score: 0.524,
        ordering_score: 0.524,
        title: 'Про захист прав споживачів',
      },
      {
        rada_nreg: '435-15',
        r2_key: 'r2://435/200',
        json_path: '$.chunks[200]',
        score: 0.553,
        ordering_score: 0.520,
        title: 'Цивільний кодекс України',
      },
      {
        rada_nreg: '4651-17',
        r2_key: 'r2://4651/1',
        json_path: '$.chunks[1]',
        score: 0.519,
        ordering_score: 0.519,
        title: 'Кримінальний процесуальний кодекс України',
      },
    ] as never,
    actCandidatesTopHydrated: [
      {
        rada_nreg: '435-15',
        title: 'Цивільний кодекс України',
        score: 0.874,
        category: 'civil',
        document_type: 'Кодекс',
        document_type_slug: 'code',
      },
      {
        rada_nreg: '80731-10',
        title: 'Кодекс України про адміністративні правопорушення',
        score: 0.733,
        category: 'administrative_offenses',
        document_type: 'Кодекс',
        document_type_slug: 'code',
      },
      {
        rada_nreg: '580-19',
        title: 'Про Національну поліцію',
        score: 0.691,
        category: 'administrative',
        document_type: 'Закон',
        document_type_slug: 'law',
      },
      {
        rada_nreg: '1023-12',
        title: 'Про захист прав споживачів',
        score: 0.684,
        category: 'civil',
        document_type: 'Закон',
        document_type_slug: 'law',
      },
      {
        rada_nreg: '4651-17',
        title: 'Кримінальний процесуальний кодекс України',
        score: 0.679,
        category: 'criminal_procedure',
        document_type: 'Кодекс',
        document_type_slug: 'code',
      },
    ],
    plannerRationaleByNreg: new Map(),
    taxonomyNregs: new Set(),
    actsSearchNregs: [],
    domainHint: 'general',
    documentTypeHints: [],
    taxonomyActCount: 3,
    aliasHitCount: 0,
    exactActHitCount: 0,
    exactActNregs: [],
    groundedActHitCount: 0,
    groundedActNregs: [],
    actSelectionLowConfidence: false,
    reasonCodes: ['CHUNKS_FAMILY_MISMATCH_DEMOTED', 'SUPPORT_FAMILY_MISMATCH_BLOCKED', 'ORDER_UNRELATED_BLOCKED'],
    useLowConfidenceFallback: false,
    queryRewriteMeta: { called: true, used: true, not_used_reason_codes: [] },
    topScore: 0.57,
    avgScore: 0.52,
    categoryHintsCount: 0,
    entitiesCount: 0,
    anchorsCount: 0,
    domainWeak: false,
    precomputedChunksEvidenceTopActs: [
      {
        rada_nreg: '80731-10',
        count_in_top30: 4,
        avg_score_in_top30: 0.52,
        max_score: 0.533,
        best_rank_in_top30: 1,
        rank_mass_top30: 1.44,
        max_ordering_score: 0.533,
      },
      {
        rada_nreg: '1023-12',
        count_in_top30: 4,
        avg_score_in_top30: 0.516,
        max_score: 0.524,
        best_rank_in_top30: 3,
        rank_mass_top30: 0.64,
        max_ordering_score: 0.524,
      },
      {
        rada_nreg: '580-19',
        count_in_top30: 2,
        avg_score_in_top30: 0.514,
        max_score: 0.531,
        best_rank_in_top30: 2,
        rank_mass_top30: 0.54,
        max_ordering_score: 0.531,
      },
      {
        rada_nreg: '435-15',
        count_in_top30: 6,
        avg_score_in_top30: 0.508,
        max_score: 0.554,
        best_rank_in_top30: 5,
        rank_mass_top30: 0.44,
        max_ordering_score: 0.520,
      },
      {
        rada_nreg: '4651-17',
        count_in_top30: 4,
        avg_score_in_top30: 0.513,
        max_score: 0.519,
        best_rank_in_top30: 6,
        rank_mass_top30: 0.41,
        max_ordering_score: 0.519,
      },
    ],
    getActMeta: async (rada_nreg) => {
      const byNreg: Record<string, { title: string; category: string; document_type: string; document_type_slug: string; storage_category: string | null }> = {
        '1023-12': {
          title: 'Про захист прав споживачів',
          category: 'civil',
          document_type: 'Закон',
          document_type_slug: 'law',
          storage_category: null,
        },
        '435-15': {
          title: 'Цивільний кодекс України',
          category: 'civil',
          document_type: 'Кодекс',
          document_type_slug: 'code',
          storage_category: null,
        },
        '80731-10': {
          title: 'Кодекс України про адміністративні правопорушення',
          category: 'administrative_offenses',
          document_type: 'Кодекс',
          document_type_slug: 'code',
          storage_category: null,
        },
        '580-19': {
          title: 'Про Національну поліцію',
          category: 'administrative',
          document_type: 'Закон',
          document_type_slug: 'law',
          storage_category: null,
        },
        '4651-17': {
          title: 'Кримінальний процесуальний кодекс України',
          category: 'criminal_procedure',
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
        act_kind: classifyActKind(
          act.act_title ?? '',
          act.document_type ?? null,
          act.category ?? null,
          act.document_type_slug ?? null
        ),
        confidence,
      })),
    searchActsForRouting: async () => [],
  });
  if (!result.low_confidence_final) {
    throw new Error(`Expected broad same-family chunks-only fallback to be low confidence, got ${JSON.stringify(result.reasonCodes)}`);
  }
  if (!result.reasonCodes.includes('UNGROUNDED_GENERAL_PRIMARY_FALLBACK')) {
    throw new Error(`Expected UNGROUNDED_GENERAL_PRIMARY_FALLBACK, got ${JSON.stringify(result.reasonCodes)}`);
  }
  if (result.coverageGap !== 'weak_evidence' && result.coverageGap !== 'likely_missing_act') {
    throw new Error(`Expected broad same-family chunks-only fallback to map to non-none coverage gap, got ${result.coverageGap}`);
  }
  console.log('[OK] single-goal finalizer flags broad same-family chunks-only fallback when taxonomy never converges');
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

function testCoverageGapUsesUngroundedNonPrimaryOnlyWeakSelectionForLikelyMissingAct(): void {
  const coverageGap = deriveCoverageGap({
    lowConfidence: true,
    reasonCodes: ['LOW_EVIDENCE', 'ACT_SELECTION_LOW_CONFIDENCE', 'NON_PRIMARY_ONLY_WEAK_CONFIDENCE', 'NO_PRIMARY_LAW_EVIDENCE'],
    selectedActsCount: 0,
    selectedActsConfidence: 0.55,
    selectedActKinds: [],
    hitsCount: 100,
    topScore: 0.5,
    domainHint: 'general',
    categoryHintCount: 0,
    documentTypeHintCount: 1,
    entitiesCount: 2,
    anchorsCount: 0,
  });
  if (coverageGap !== 'likely_missing_act') {
    throw new Error(
      `Expected ungrounded legally specific non-primary-only weak selection to map to likely_missing_act, got ${coverageGap}`
    );
  }
  console.log('[OK] coverage-gap promotes ungrounded non-primary-only weak selection to likely_missing_act');
}

function testCoverageGapKeepsGroundedNonPrimaryOnlyWeakSelectionAsWeakEvidence(): void {
  const coverageGap = deriveCoverageGap({
    lowConfidence: true,
    reasonCodes: ['LOW_EVIDENCE', 'ACT_SELECTION_LOW_CONFIDENCE', 'NON_PRIMARY_ONLY_WEAK_CONFIDENCE', 'NO_PRIMARY_LAW_EVIDENCE'],
    selectedActsCount: 1,
    selectedActsConfidence: 0.44,
    selectedActKinds: ['SECONDARY_ORDER'],
    metadataGroundedActCount: 1,
    hitsCount: 80,
    topScore: 0.52,
    domainHint: 'general',
    categoryHintCount: 0,
    documentTypeHintCount: 1,
    entitiesCount: 1,
    anchorsCount: 0,
  });
  if (coverageGap !== 'weak_evidence') {
    throw new Error(
      `Expected grounded non-primary-only weak selection to stay weak_evidence, got ${coverageGap}`
    );
  }
  console.log('[OK] coverage-gap keeps grounded non-primary-only weak selection as weak_evidence');
}

function testCoverageGapKeepsGroundedSparseNonPrimarySelectionAsWeakEvidence(): void {
  const coverageGap = deriveCoverageGap({
    lowConfidence: true,
    reasonCodes: ['LOW_EVIDENCE', 'ACT_SELECTION_LOW_CONFIDENCE', 'NON_PRIMARY_ONLY_WEAK_CONFIDENCE', 'NO_PRIMARY_LAW_EVIDENCE'],
    selectedActsCount: 1,
    selectedActsConfidence: 0.44,
    selectedActKinds: ['SECONDARY_ORDER'],
    exactActHitCount: 1,
    hitsCount: 4,
    topScore: 0.39,
    domainHint: 'general',
    categoryHintCount: 0,
    documentTypeHintCount: 1,
    entitiesCount: 1,
    anchorsCount: 0,
  });
  if (coverageGap !== 'weak_evidence') {
    throw new Error(
      `Expected grounded sparse non-primary weak selection to stay weak_evidence, got ${coverageGap}`
    );
  }
  console.log('[OK] coverage-gap keeps grounded sparse non-primary selection as weak_evidence');
}

function testCoverageGapUsesUngroundedMultiGoalFallbackForLikelyMissingAct(): void {
  const coverageGap = deriveCoverageGap({
    lowConfidence: true,
    reasonCodes: ['UNGROUNDED_MULTI_GOAL_FALLBACK', 'LOW_EVIDENCE'],
    selectedActsCount: 2,
    selectedActsConfidence: 0.5,
    selectedActKinds: ['PRIMARY_LAW', 'PRIMARY_LAW'],
    hitsCount: 14,
    topScore: 0.57,
    domainHint: 'general',
    categoryHintCount: 0,
    documentTypeHintCount: 1,
    entitiesCount: 1,
    anchorsCount: 0,
  });
  if (coverageGap !== 'likely_missing_act') {
    throw new Error(`Expected ungrounded multi-goal fallback to map to likely_missing_act, got ${coverageGap}`);
  }
  console.log('[OK] coverage-gap promotes ungrounded multi-goal fallback to likely_missing_act');
}

function testCoverageGapKeepsMetadataGroundedMultiGoalFallbackAsWeakEvidence(): void {
  const coverageGap = deriveCoverageGap({
    lowConfidence: true,
    reasonCodes: ['UNGROUNDED_MULTI_GOAL_FALLBACK', 'LOW_EVIDENCE'],
    selectedActsCount: 2,
    selectedActsConfidence: 0.5,
    selectedActKinds: ['PRIMARY_LAW', 'SECONDARY_ORDER'],
    metadataGroundedActCount: 1,
    hitsCount: 16,
    topScore: 0.57,
    domainHint: 'general',
    categoryHintCount: 0,
    documentTypeHintCount: 1,
    entitiesCount: 1,
    anchorsCount: 0,
  });
  if (coverageGap !== 'weak_evidence') {
    throw new Error(`Expected metadata-grounded multi-goal fallback to stay weak_evidence, got ${coverageGap}`);
  }
  console.log('[OK] coverage-gap keeps metadata-grounded multi-goal fallback as weak_evidence');
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

function testCoverageGapTreatsMetadataOnlyExplicitActScopeMissAsLikelyMissingAct(): void {
  const coverageGap = deriveCoverageGap({
    lowConfidence: true,
    reasonCodes: ['EXPLICIT_ACT_SCOPE_NO_CONVERGENCE', 'NO_STRONG_ACT_EVIDENCE'],
    selectedActsCount: 0,
    selectedActsConfidence: 0.4,
    selectedActKinds: [],
    exactActHitCount: 0,
    groundedActHitCount: 0,
    metadataGroundedActCount: 1,
    explicitActScopeCue: true,
    hitsCount: 91,
    topScore: 0.69,
    domainHint: 'general',
    categoryHintCount: 0,
    documentTypeHintCount: 1,
    entitiesCount: 0,
    anchorsCount: 0,
  });
  if (coverageGap !== 'likely_missing_act') {
    throw new Error(
      `Expected explicit-act-scope no-convergence with metadata-only neighbor grounding to map to likely_missing_act, got ${coverageGap}`
    );
  }
  console.log('[OK] coverage-gap treats metadata-only explicit-act-scope miss as likely_missing_act');
}

function testCoverageGapUsesExplicitActScopeForLikelyMissingActWithoutGrounding(): void {
  const coverageGap = deriveCoverageGap({
    lowConfidence: true,
    reasonCodes: ['LOW_EVIDENCE', 'LOW_CONFIDENCE_SELECTED_ACTS_CLEARED'],
    selectedActsCount: 0,
    selectedActsConfidence: 0.4,
    selectedActKinds: [],
    exactActHitCount: 0,
    groundedActHitCount: 0,
    metadataGroundedActCount: 0,
    explicitActScopeCue: true,
    hitsCount: 24,
    topScore: 0.59,
    domainHint: 'general',
    categoryHintCount: 0,
    documentTypeHintCount: 1,
    entitiesCount: 0,
    anchorsCount: 0,
  });
  if (coverageGap !== 'likely_missing_act') {
    throw new Error(`Expected explicit act-scope low-confidence run without grounding to map to likely_missing_act, got ${coverageGap}`);
  }
  console.log('[OK] coverage-gap uses explicit act scope to signal likely missing act without grounding');
}

function testCoverageGapPrefersLikelyMissingActOverOutOfScopeForExplicitActScope(): void {
  const coverageGap = deriveCoverageGap({
    lowConfidence: true,
    reasonCodes: ['OUT_OF_SCOPE', 'LOW_EVIDENCE', 'EXPLICIT_ACT_SCOPE_NO_CONVERGENCE'],
    selectedActsCount: 0,
    selectedActsConfidence: 0.4,
    selectedActKinds: [],
    exactActHitCount: 0,
    groundedActHitCount: 0,
    metadataGroundedActCount: 0,
    explicitActScopeCue: true,
    hitsCount: 12,
    topScore: 0.47,
    domainHint: 'general',
    categoryHintCount: 0,
    documentTypeHintCount: 1,
    entitiesCount: 0,
    anchorsCount: 0,
  });
  if (coverageGap !== 'likely_missing_act') {
    throw new Error(`Expected explicit act-scope miss to stay likely_missing_act instead of out_of_scope, got ${coverageGap}`);
  }
  console.log('[OK] coverage-gap prefers likely_missing_act over out_of_scope for explicit act-scope misses');
}

function testCoverageGapPromotesSpecificNonPrimaryOnlyWeakSelectionToLikelyMissingAct(): void {
  const coverageGap = deriveCoverageGap({
    lowConfidence: true,
    reasonCodes: ['NON_PRIMARY_ONLY_WEAK_CONFIDENCE', 'FAMILY_GUARD_NO_EVIDENCE', 'ACT_SELECTION_LOW_CONFIDENCE'],
    selectedActsCount: 2,
    selectedActsConfidence: 0.55,
    selectedActKinds: ['INTERNATIONAL_TREATY', 'SECONDARY_ORDER'],
    exactActHitCount: 0,
    groundedActHitCount: 0,
    metadataGroundedActCount: 0,
    hitsCount: 14,
    topScore: 0.56,
    domainHint: 'environmental',
    categoryHintCount: 1,
    documentTypeHintCount: 1,
    entitiesCount: 0,
    anchorsCount: 0,
  });
  if (coverageGap !== 'likely_missing_act') {
    throw new Error(`Expected specific non-primary-only weak selection to map to likely_missing_act, got ${coverageGap}`);
  }
  console.log('[OK] coverage-gap promotes specific non-primary-only weak selection to likely_missing_act');
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

function testCoverageGapKeepsGroundedSinglePrimaryProceduralBundleAsWeakEvidence(): void {
  const coverageGap = deriveCoverageGap({
    lowConfidence: true,
    reasonCodes: ['MULTI_GOAL_PROCEDURAL_SINGLE_ACT_BLOCKED', 'MULTI_GOAL_PRIMARY_COVERAGE_WEAK', 'LOW_EVIDENCE'],
    selectedActsCount: 1,
    selectedActsConfidence: 0.5,
    selectedActKinds: ['PRIMARY_LAW'],
    groundedActHitCount: 1,
    mixedProcedureAndNonProcedureGoals: false,
    proceduralOnlySelection: true,
    hitsCount: 18,
    topScore: 0.58,
    domainHint: 'civil',
    categoryHintCount: 1,
    documentTypeHintCount: 1,
    entitiesCount: 1,
    anchorsCount: 1,
  });
  if (coverageGap !== 'weak_evidence') {
    throw new Error(`Expected grounded same-act procedural bundle to stay weak_evidence, got ${coverageGap}`);
  }
  console.log('[OK] coverage-gap keeps grounded single-primary procedural bundles as weak_evidence');
}

function testCoverageGapKeepsUngroundedSinglePrimaryProceduralBundleAsWeakEvidence(): void {
  const coverageGap = deriveCoverageGap({
    lowConfidence: true,
    reasonCodes: ['MULTI_GOAL_PROCEDURAL_SINGLE_ACT_BLOCKED', 'MULTI_GOAL_PRIMARY_COVERAGE_WEAK', 'LOW_EVIDENCE'],
    selectedActsCount: 1,
    selectedActsConfidence: 0.5,
    selectedActKinds: ['PRIMARY_LAW'],
    mixedProcedureAndNonProcedureGoals: false,
    proceduralOnlySelection: true,
    hitsCount: 18,
    topScore: 0.58,
    domainHint: 'civil',
    categoryHintCount: 1,
    documentTypeHintCount: 1,
    entitiesCount: 1,
    anchorsCount: 1,
  });
  if (coverageGap !== 'weak_evidence') {
    throw new Error(`Expected same-act procedural bundle without act grounding to stay weak_evidence, got ${coverageGap}`);
  }
  console.log('[OK] coverage-gap keeps ungrounded same-act procedural bundles as weak_evidence');
}

function testCoverageGapKeepsProceduralSinglePrimaryBundleWeakEvenWhenUngroundedFallbackFires(): void {
  const coverageGap = deriveCoverageGap({
    lowConfidence: true,
    reasonCodes: [
      'MULTI_GOAL_PROCEDURAL_SINGLE_ACT_BLOCKED',
      'UNGROUNDED_MULTI_GOAL_FALLBACK',
      'LOW_EVIDENCE',
    ],
    selectedActsCount: 1,
    selectedActsConfidence: 0.5,
    selectedActKinds: ['PRIMARY_LAW'],
    mixedProcedureAndNonProcedureGoals: false,
    proceduralOnlySelection: true,
    hitsCount: 30,
    topScore: 0.61,
    domainHint: 'civil',
    categoryHintCount: 1,
    documentTypeHintCount: 1,
    entitiesCount: 1,
    anchorsCount: 1,
  });
  if (coverageGap !== 'weak_evidence') {
    throw new Error(
      `Expected same-act procedural bundle with ungrounded fallback to stay weak_evidence, got ${coverageGap}`
    );
  }
  console.log('[OK] coverage-gap keeps same-act procedural bundle weak even when ungrounded fallback fires');
}

function testCoverageGapKeepsProceduralSinglePrimaryFallbackWeakWithoutBlockedReason(): void {
  const coverageGap = deriveCoverageGap({
    lowConfidence: true,
    reasonCodes: ['UNGROUNDED_MULTI_GOAL_FALLBACK', 'LOW_EVIDENCE'],
    selectedActsCount: 1,
    selectedActsConfidence: 0.5,
    selectedActKinds: ['PRIMARY_LAW'],
    mixedProcedureAndNonProcedureGoals: false,
    proceduralOnlySelection: true,
    hitsCount: 30,
    topScore: 0.6,
    domainHint: 'civil',
    categoryHintCount: 1,
    documentTypeHintCount: 1,
    entitiesCount: 1,
    anchorsCount: 1,
  });
  if (coverageGap !== 'weak_evidence') {
    throw new Error(
      `Expected single-primary procedural fallback without blocked reason to stay weak_evidence, got ${coverageGap}`
    );
  }
  console.log('[OK] coverage-gap keeps single-primary procedural fallback weak without blocked reason');
}

function testCoverageGapUsesLikelyMissingActForMixedProceduralFallbackWithOnlyMetadataGrounding(): void {
  const coverageGap = deriveCoverageGap({
    lowConfidence: true,
    reasonCodes: [
      'UNGROUNDED_MULTI_GOAL_FALLBACK',
      'MULTI_GOAL_PROCEDURAL_SINGLE_ACT_BLOCKED',
      'LOW_EVIDENCE',
    ],
    selectedActsCount: 1,
    selectedActsConfidence: 0.52,
    selectedActKinds: ['PRIMARY_LAW'],
    metadataGroundedActCount: 1,
    mixedProcedureAndNonProcedureGoals: true,
    proceduralOnlySelection: true,
    hitsCount: 30,
    topScore: 0.61,
    domainHint: 'administrative',
    categoryHintCount: 1,
    documentTypeHintCount: 1,
    entitiesCount: 1,
    anchorsCount: 0,
  });
  if (coverageGap !== 'likely_missing_act') {
    throw new Error(
      `Expected mixed-goal procedural fallback with only metadata grounding to map to likely_missing_act, got ${coverageGap}`
    );
  }
  console.log('[OK] coverage-gap promotes mixed-goal procedural fallback with metadata-only grounding to likely_missing_act');
}

function testCoverageGapUsesLikelyMissingActForMixedProceduralFallbackWithFamilyMismatchTail(): void {
  const coverageGap = deriveCoverageGap({
    lowConfidence: true,
    reasonCodes: [
      'UNGROUNDED_MULTI_GOAL_FALLBACK',
      'MULTI_GOAL_PROCEDURAL_SINGLE_ACT_BLOCKED',
      'MULTI_GOAL_FAMILY_MISMATCH_TAIL',
      'LOW_EVIDENCE',
    ],
    selectedActsCount: 1,
    selectedActsConfidence: 0.52,
    selectedActKinds: ['PRIMARY_LAW'],
    mixedProcedureAndNonProcedureGoals: true,
    proceduralOnlySelection: true,
    hitsCount: 30,
    topScore: 0.61,
    domainHint: 'general',
    categoryHintCount: 0,
    documentTypeHintCount: 1,
    entitiesCount: 0,
    anchorsCount: 0,
  });
  if (coverageGap !== 'likely_missing_act') {
    throw new Error(
      `Expected mixed-goal procedural fallback with family mismatch tail to map to likely_missing_act, got ${coverageGap}`
    );
  }
  console.log('[OK] coverage-gap promotes mixed-goal procedural fallback with family mismatch tail to likely_missing_act');
}

function testCoverageGapKeepsStrongSingleActProceduralSurfaceAsWeakEvidenceEvenWhenGoalTypesLookMixed(): void {
  const coverageGap = deriveCoverageGap({
    lowConfidence: true,
    reasonCodes: ['MULTI_GOAL_PROCEDURAL_SINGLE_ACT_BLOCKED', 'LOW_EVIDENCE'],
    selectedActsCount: 1,
    selectedActsConfidence: 0.5,
    selectedActKinds: ['PRIMARY_LAW'],
    mixedProcedureAndNonProcedureGoals: true,
    proceduralOnlySelection: true,
    hitsCount: 30,
    topScore: 0.63,
    domainHint: 'civil',
    categoryHintCount: 1,
    documentTypeHintCount: 1,
    entitiesCount: 1,
    anchorsCount: 1,
  });
  if (coverageGap !== 'weak_evidence') {
    throw new Error(
      `Expected strong same-act procedural surface to stay weak_evidence even with mixed goal labels, got ${coverageGap}`
    );
  }
  console.log('[OK] coverage-gap keeps strong same-act procedural surface as weak_evidence even when goal types look mixed');
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
    interrogativePrimaryLawLocatorQuery: false,
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
    interrogativePrimaryLawLocatorQuery: false,
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
  const shouldNotFlagSoftLocatorProcedure = shouldFlagProceduralPrimaryWithoutActGrounding({
    proceduralOnlyPrimarySelection: true,
    explicitActScopeCue: true,
    interrogativePrimaryLawLocatorQuery: true,
    structuredActIdentifiersCount: 0,
    documentTypeHintsCount: 1,
    anchorsCount: 0,
    exactActHitCount: 0,
    groundedActHitCount: 0,
    metadataGroundedPrimaryActsCount: 0,
    leadSelectedMetadataGrounded: false,
  });
  if (shouldNotFlagSoftLocatorProcedure) {
    throw new Error('Expected soft interrogative primary-law locator to stay eligible for dominant-evidence recovery');
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

function testBuildTaxonomyQuerySignalsCanonicalizesInflectedLawCuePhrase(): void {
  const signals = buildTaxonomyQuerySignals('За законом про нацбезпеку хто затверджує Стратегію національної безпеки?');
  if (!signals.phrases.includes('закон нацбезпеку')) {
    throw new Error(`Expected cue-canonicalized phrase for inflected law-title query, got ${JSON.stringify(signals.phrases)}`);
  }
  console.log('[OK] buildTaxonomyQuerySignals canonicalizes inflected act-cue phrases');
}

function testBuildTaxonomyQuerySignalsStripsPrimaryLawLocatorEnvelope(): void {
  const signals = buildTaxonomyQuerySignals(
    'Який профільний закон визначає підстави відрахування з університету та право здобувача на академічну мобільність?'
  );
  if (signals.tokens.includes('профільний') || signals.tokens.includes('закон') || signals.tokens.includes('визначає')) {
    throw new Error(`Expected primary-law locator envelope tokens to be stripped, got ${JSON.stringify(signals.tokens)}`);
  }
  if (signals.phrases.includes('профільний закон') || signals.phrases.includes('закон визначає')) {
    throw new Error(`Expected primary-law locator envelope phrases to be stripped, got ${JSON.stringify(signals.phrases)}`);
  }
  if (!signals.phrases.includes('підстави відрахування')) {
    throw new Error(`Expected residual subject phrase to survive signal build, got ${JSON.stringify(signals.phrases)}`);
  }
  if (!signals.phrases.includes('академічну мобільність')) {
    throw new Error(`Expected discriminative education phrase to survive signal build, got ${JSON.stringify(signals.phrases)}`);
  }
  console.log('[OK] buildTaxonomyQuerySignals strips interrogative primary-law locator envelope');
}

async function testScoreActCandidateUsesTokenizedSignalsForSpecialLawLocator(): Promise<void> {
  const defenseLaw = await getActMeta('808-20');
  if (!defenseLaw) {
    console.log('[SKIP] tokenized special-law locator scoring test (808-20 not present in current LLDBI snapshot)');
    return;
  }
  const query =
    'Який спеціальний закон визначає процедури defense procurement і підстави для закриття інформації про таку закупівлю?';
  const taxonomySignals = buildTaxonomyQuerySignals(query);
  const querySignals = uniqueStrings([
    query,
    ...extractActReferenceSignals(query),
    ...extractQuotedActTitleFragments(query),
    ...taxonomySignals.phrases,
    ...taxonomySignals.tokens,
  ]);
  const scored = await scoreActCandidate('808-20', querySignals, 'general');
  if (!scored.reasons.some((reason) => ['title_match', 'summary_match', 'keyword_match', 'topic_match'].includes(reason))) {
    throw new Error(
      `Expected tokenized special-law locator query to surface semantic LLDBI metadata reasons for 808-20, got ${JSON.stringify(scored)}`
    );
  }
  if (scored.score <= 0.1) {
    throw new Error(`Expected semantic scoring above validity-only floor for 808-20, got ${JSON.stringify(scored)}`);
  }
  console.log('[OK] scoreActCandidate uses tokenized special-law locator signals to surface LLDBI semantic metadata');
}

async function testScoreActCandidatePrefersHigherEducationLawForAcademicMobilityLocator(): Promise<void> {
  const higherEducationLaw = await getActMeta('1556-18');
  const umbrellaEducationLaw = await getActMeta('2145-19');
  if (!higherEducationLaw || !umbrellaEducationLaw) {
    console.log('[SKIP] higher-education special-law locator scoring test (1556-18 or 2145-19 not present in current LLDBI snapshot)');
    return;
  }
  const query =
    'Який профільний закон визначає підстави відрахування з університету та право здобувача на академічну мобільність?';
  const taxonomySignals = buildTaxonomyQuerySignals(query);
  const querySignals = uniqueStrings([
    query,
    ...extractActReferenceSignals(query),
    ...extractQuotedActTitleFragments(query),
    ...taxonomySignals.phrases,
    ...taxonomySignals.tokens,
  ]);
  const [specializedScore, umbrellaScore] = await Promise.all([
    scoreActCandidate('1556-18', querySignals, 'general'),
    scoreActCandidate('2145-19', querySignals, 'general'),
  ]);
  if (specializedScore.score <= umbrellaScore.score) {
    throw new Error(
      `Expected higher-education law to outrank umbrella education law for academic-mobility locator, got ${JSON.stringify({ specializedScore, umbrellaScore })}`
    );
  }
  console.log('[OK] scoreActCandidate prefers higher-education law for academic-mobility special-law locator');
}

async function testScoreActCandidatePrefersDatedNbuDailyActOverGenericCurrencyRegulation(): Promise<void> {
  const targetDailyAct = await getActMeta('n0123500-26');
  const genericCurrencyRegulation = await getActMeta('v0001500-19');
  if (!targetDailyAct || !genericCurrencyRegulation) {
    console.log('[SKIP] dated NBU daily-act scoring test (n0123500-26 or v0001500-19 not present in current LLDBI snapshot)');
    return;
  }
  const query =
    'Яким нормативним актом Нацбанку на 27 березня 2026 року зафіксовано офіційний курс гривні щодо іноземних валют для валютного розрахунку?';
  const taxonomySignals = buildTaxonomyQuerySignals(query);
  const querySignals = uniqueStrings([
    query,
    ...extractActReferenceSignals(query),
    ...extractQuotedActTitleFragments(query),
    ...taxonomySignals.phrases,
    ...taxonomySignals.tokens,
  ]);
  const [dailyScore, regulationScore] = await Promise.all([
    scoreActCandidate('n0123500-26', querySignals, 'general'),
    scoreActCandidate('v0001500-19', querySignals, 'general'),
  ]);
  if (dailyScore.score <= regulationScore.score) {
    throw new Error(
      `Expected dated NBU daily act to outrank generic currency regulation, got ${JSON.stringify({ dailyScore, regulationScore })}`
    );
  }
  console.log('[OK] scoreActCandidate prefers dated NBU daily acts over generic framework regulations');
}

async function testScoreActCandidatePrefersExactDateRecurringSeriesMemberOverSameTitleNeighbors(): Promise<void> {
  const exactDateAct = await getActMeta('n0116500-26');
  const laterNeighbor = await getActMeta('n0120500-26');
  if (!exactDateAct || !laterNeighbor) {
    console.log('[SKIP] recurring exact-date same-title scoring test (n0116500-26 or n0120500-26 not present in current LLDBI snapshot)');
    return;
  }
  const query = 'Де Нацбанк на 23 березня 2026 року зафіксував облікову ціну банківських металів?';
  const taxonomySignals = buildTaxonomyQuerySignals(query);
  const querySignals = uniqueStrings([
    query,
    ...extractActReferenceSignals(query),
    ...extractQuotedActTitleFragments(query),
    ...taxonomySignals.phrases,
    ...taxonomySignals.tokens,
  ]);
  const [exactDateScore, laterNeighborScore] = await Promise.all([
    scoreActCandidate('n0116500-26', querySignals, 'general'),
    scoreActCandidate('n0120500-26', querySignals, 'general'),
  ]);
  if (exactDateScore.score <= laterNeighborScore.score) {
    throw new Error(
      `Expected exact-date recurring same-title act to outrank later same-title neighbor, got ${JSON.stringify({ exactDateScore, laterNeighborScore })}`
    );
  }
  if (!exactDateScore.reasons.includes('recurring_series_rada_datred_match')) {
    throw new Error(`Expected recurring-series exact-date reason on target act, got ${JSON.stringify(exactDateScore)}`);
  }
  console.log('[OK] scoreActCandidate prefers exact-date recurring same-title act over neighboring daily acts');
}

async function testGetTaxonomyCandidatesInjectsCompatibleProcedureFamilyForSoftErdrBundle(): Promise<void> {
  const criminalProcedureCode = await getActMeta('4651-17');
  if (!criminalProcedureCode) {
    console.log('[SKIP] ERDR soft procedural taxonomy test (4651-17 not present in current LLDBI snapshot)');
    return;
  }
  const query =
    'До якого суду і в який строк скаржаться на невнесення відомостей до ЄРДР після заяви про злочин?';
  const result = await getTaxonomyCandidates({
    query,
    domainHint: 'criminal',
  });
  if (!result.category_hints.includes('criminal_procedure')) {
    throw new Error(
      `Expected criminal domain envelope to include criminal_procedure category hint, got ${JSON.stringify(result.category_hints)}`
    );
  }
  if (!result.rada_nreg_candidates.includes('4651-17')) {
    throw new Error(
      `Expected taxonomy candidates to include КПК for soft ЄРДР bundle, got ${JSON.stringify(result.rada_nreg_candidates.slice(0, 12))}`
    );
  }
  console.log('[OK] taxonomy injects compatible criminal procedure family for soft ЄРДР procedural bundle');
}

async function testGetTaxonomyCandidatesGroundsCuedNumericRepealOrderWithDateContext(): Promise<void> {
  const target = await getActMeta('262-2026-р');
  const neighbor = await getActMeta('15-2026-р');
  if (!target || !neighbor) {
    console.log('[SKIP] cued-numeric repeal grounding test (262-2026-р or 15-2026-р not present in current LLDBI snapshot)');
    return;
  }
  const result = await getTaxonomyCandidates({
    query: 'Розпорядження про втрату чинності розпорядження КМУ №177 від 25 лютого 2026 року',
    domainHint: 'administrative',
    documentTypeHints: ['cmu_order'],
  });
  if (!result.grounded_act_nregs.some((radaNreg) => radaNreg.toLowerCase() === '262-2026-р')) {
    throw new Error(
      `Expected cue+number repeal-order query to ground onto 262-2026-р, got ${JSON.stringify(result)}`
    );
  }
  const targetRank = result.rada_nreg_candidates.findIndex((radaNreg) => radaNreg.toLowerCase() === '262-2026-р');
  const neighborRank = result.rada_nreg_candidates.findIndex((radaNreg) => radaNreg.toLowerCase() === '15-2026-р');
  if (targetRank === -1 || neighborRank === -1 || targetRank > neighborRank) {
    throw new Error(
      `Expected repeal-order cue+number query to rank 262-2026-р ahead of neighboring repeal orders, got ${JSON.stringify(result.rada_nreg_candidates.slice(0, 8))}`
    );
  }
  console.log('[OK] taxonomy grounding resolves cue+number repeal-order queries using title/date context');
}

async function testGetTaxonomyCandidatesRanksAmendmentOrderByReferencedBaseActIdentity(): Promise<void> {
  const target = await getActMeta('250-2026-р');
  if (!target) {
    console.log('[SKIP] amendment-order referenced-identity taxonomy test (250-2026-р not present in current LLDBI snapshot)');
    return;
  }
  const result = await getTaxonomyCandidates({
    query: 'Яким актом Кабмін скоригував розпорядження №625 від 25.06.2025?',
    domainHint: 'general',
    documentTypeHints: ['cmu_order'],
  });
  const targetRank = result.rada_nreg_candidates.findIndex((radaNreg) => radaNreg.toLowerCase() === '250-2026-р');
  const neighborRanks = ['3-2026-р', '4-2026-р', '15-2026-р']
    .map((radaNreg) => result.rada_nreg_candidates.findIndex((candidate) => candidate.toLowerCase() === radaNreg))
    .filter((rank) => rank >= 0);
  if (targetRank === -1 || targetRank > 4) {
    throw new Error(
      `Expected amendment-order query to keep 250-2026-р near the top candidates, got ${JSON.stringify(result.rada_nreg_candidates.slice(0, 8))}`
    );
  }
  if (neighborRanks.length > 0 && neighborRanks.some((rank) => targetRank > rank)) {
    throw new Error(
      `Expected referenced-base-act identity to rank 250-2026-р ahead of generic neighboring CMU orders, got ${JSON.stringify(result.rada_nreg_candidates.slice(0, 8))}`
    );
  }
  console.log('[OK] taxonomy ranking prefers amendment orders when query identity matches the referenced base act');
}

async function testGetTaxonomyCandidatesRanksDatedNbuDailyActOverSameTitleNeighbors(): Promise<void> {
  const target = await getActMeta('n0117500-26');
  const genericFramework = await getActMeta('v0001500-19');
  if (!target || !genericFramework) {
    console.log('[SKIP] dated NBU daily-act taxonomy ranking test (n0117500-26 or v0001500-19 not present in current LLDBI snapshot)');
    return;
  }
  const result = await getTaxonomyCandidates({
    query: 'Де НБУ на 24.03.2026 закріпив офіційний курс гривні щодо іноземних валют?',
    domainHint: 'general',
  });
  const targetRank = result.rada_nreg_candidates.findIndex((radaNreg) => radaNreg.toLowerCase() === 'n0117500-26');
  const frameworkRank = result.rada_nreg_candidates.findIndex((radaNreg) => radaNreg.toLowerCase() === 'v0001500-19');
  const neighborRanks = ['n0021500-26', 'n0029500-26', 'n0033500-26']
    .map((radaNreg) => result.rada_nreg_candidates.findIndex((candidate) => candidate.toLowerCase() === radaNreg))
    .filter((rank) => rank >= 0);
  if (targetRank === -1 || targetRank > 4) {
    throw new Error(
      `Expected exact-date NBU daily act to stay near the top candidates, got ${JSON.stringify(result.rada_nreg_candidates.slice(0, 8))}`
    );
  }
  if (frameworkRank !== -1 && targetRank > frameworkRank) {
    throw new Error(
      `Expected dated daily act to outrank generic NBU framework regulation, got ${JSON.stringify(result.rada_nreg_candidates.slice(0, 8))}`
    );
  }
  if (neighborRanks.some((rank) => targetRank > rank)) {
    throw new Error(
      `Expected exact-date daily act to outrank same-title neighboring daily acts, got ${JSON.stringify(result.rada_nreg_candidates.slice(0, 8))}`
    );
  }
  console.log('[OK] taxonomy ranking prefers the date-matched NBU daily act over same-title neighbors');
}

async function testGetTaxonomyCandidatesGroundsRecurringSameTitleDailyActByDateScopedSoftQuery(): Promise<void> {
  const target = await getActMeta('n0116500-26');
  const neighbor = await getActMeta('n0120500-26');
  if (!target || !neighbor) {
    console.log('[SKIP] recurring same-title date-scoped grounding test (n0116500-26 or n0120500-26 not present in current LLDBI snapshot)');
    return;
  }
  const result = await getTaxonomyCandidates({
    query: 'Де Нацбанк на 23 березня 2026 року зафіксував облікову ціну банківських металів?',
    domainHint: 'general',
    documentTypeHints: ['nbu_letter'],
  });
  if (!result.grounded_act_nregs.some((radaNreg) => radaNreg.toLowerCase() === 'n0116500-26')) {
    throw new Error(
      `Expected date-scoped recurring daily-act soft query to ground onto n0116500-26, got ${JSON.stringify(result)}`
    );
  }
  const targetRank = result.rada_nreg_candidates.findIndex((radaNreg) => radaNreg.toLowerCase() === 'n0116500-26');
  const neighborRank = result.rada_nreg_candidates.findIndex((radaNreg) => radaNreg.toLowerCase() === 'n0120500-26');
  if (targetRank === -1 || neighborRank === -1 || targetRank > neighborRank) {
    throw new Error(
      `Expected date-scoped recurring daily-act query to rank n0116500-26 ahead of same-title neighbor, got ${JSON.stringify(result.rada_nreg_candidates.slice(0, 10))}`
    );
  }
  console.log('[OK] taxonomy grounds recurring same-title daily acts from date-scoped soft queries');
}

async function testGetTaxonomyCandidatesGroundsRecurringFxDailyActByLawyerStyleQuery(): Promise<void> {
  const target = await getActMeta('n0115500-26');
  const framework = await getActMeta('v0001500-19');
  if (!target || !framework) {
    console.log('[SKIP] recurring FX daily-act lawyer-style grounding test (n0115500-26 or v0001500-19 not present in current LLDBI snapshot)');
    return;
  }
  const result = await getTaxonomyCandidates({
    query: 'Яким документом НБУ на 23.03.2026 встановлено офіційний валютний курс гривні для щоденного застосування?',
    domainHint: 'general',
    documentTypeHints: ['nbu_letter'],
  });
  if (!result.grounded_act_nregs.some((radaNreg) => radaNreg.toLowerCase() === 'n0115500-26')) {
    throw new Error(
      `Expected lawyer-style recurring FX query to ground onto n0115500-26, got ${JSON.stringify(result)}`
    );
  }
  const targetRank = result.rada_nreg_candidates.findIndex((radaNreg) => radaNreg.toLowerCase() === 'n0115500-26');
  const frameworkRank = result.rada_nreg_candidates.findIndex((radaNreg) => radaNreg.toLowerCase() === 'v0001500-19');
  if (targetRank === -1 || targetRank > 4) {
    throw new Error(
      `Expected lawyer-style recurring FX query to keep n0115500-26 near the top candidates, got ${JSON.stringify(result.rada_nreg_candidates.slice(0, 10))}`
    );
  }
  if (frameworkRank !== -1 && targetRank > frameworkRank) {
    throw new Error(
      `Expected lawyer-style recurring FX query to rank n0115500-26 ahead of generic currency framework noise, got ${JSON.stringify(result.rada_nreg_candidates.slice(0, 10))}`
    );
  }
  console.log('[OK] taxonomy grounds lawyer-style recurring FX daily-act queries ahead of framework noise');
}

function testExtractActReferenceSignalsCapturesExplicitDocumentTitles(): void {
  const signals = extractActReferenceSignals('Що регулює Указ про призначення Кубраков?');
  if (!signals.some((signal) => signal.toLowerCase().includes('указ про призначення кубраков'))) {
    throw new Error(`Expected explicit document-title signal for decree query, got ${JSON.stringify(signals)}`);
  }
  console.log('[OK] act-reference signal extraction captures explicit title-heavy act references');
}

function testExtractActReferenceSignalsCapturesModifiedGovernmentDecisionCue(): void {
  const signals = extractActReferenceSignals(
    'Яким урядовим рішенням у березні 2026 року оформили виділення коштів з резервного фонду державного бюджету?'
  );
  if (!signals.some((signal) => signal.toLowerCase().includes('урядовим рішенням'))) {
    throw new Error(`Expected modified government-decision locator signal, got ${JSON.stringify(signals)}`);
  }
  if (!signals.some((signal) => signal.toLowerCase().startsWith('рішення'))) {
    throw new Error(`Expected compact cue-normalized decision signal, got ${JSON.stringify(signals)}`);
  }
  console.log('[OK] act-reference signal extraction captures modified government-decision locators');
}

function testExtractActReferenceSignalsTrimsMetadataTailFromInterrogativeLocator(): void {
  const signals = extractActReferenceSignals(
    'Яким розпорядженням закрито дисциплінарне провадження і хто прийняв це рішення?'
  );
  if (!signals.some((signal) => signal.toLowerCase().includes('яким розпорядженням закрито дисциплінарне провадження'))) {
    throw new Error(`Expected trimmed interrogative act-locator signal, got ${JSON.stringify(signals)}`);
  }
  if (!signals.some((signal) => signal.toLowerCase() === 'закрито дисциплінарне провадження')) {
    throw new Error(`Expected descriptive fragment without metadata tail, got ${JSON.stringify(signals)}`);
  }
  console.log('[OK] act-reference signal extraction trims metadata tail from interrogative locator query');
}

function testExtractActReferenceSignalsPreservesCueForInterrogativeLocator(): void {
  const signals = extractActReferenceSignals(
    'Яким розпорядженням Кабінету Міністрів України звільнено Клочка А.О. з посади заступника Міністра оборони України?'
  );
  if (!signals.some((signal) => signal.toLowerCase().startsWith('розпорядженням кабінету міністрів україни звільнено клочка'))) {
    throw new Error(`Expected cue-preserving interrogative locator signal, got ${JSON.stringify(signals)}`);
  }
  console.log('[OK] act-reference signal extraction preserves the subordinate-act cue for interrogative locators');
}

function testExtractActReferenceSignalsCompactsInflectedShortLawAliasQuery(): void {
  const signals = extractActReferenceSignals(
    'За законом про ТОВ який строк повідомлення про загальні збори і що має бути в повідомленні?'
  );
  if (!signals.some((signal) => signal.toLowerCase() === 'закон про тов')) {
    throw new Error(`Expected compact canonical short-law alias signal, got ${JSON.stringify(signals)}`);
  }
  console.log('[OK] act-reference signal extraction compacts inflected short-law alias queries');
}

function testMetadataGroundedActCandidateAcceptsDistinctDescriptiveLocator(): void {
  const grounded = isMetadataGroundedActCandidate(
    {
      title: 'Про закриття дисциплінарного провадження',
      document_type: 'Розпорядження КМУ',
      reasons: ['title_match', 'summary_match'],
    },
    'Яким розпорядженням закрито дисциплінарне провадження і хто прийняв це рішення?',
    new Set(['exact_alias_match', 'exact_title_match'])
  );
  if (!grounded) {
    throw new Error('Expected distinct descriptive subordinate-act locator to qualify for metadata grounding');
  }
  console.log('[OK] metadata act grounding accepts distinct descriptive subordinate-act locator');
}

function testActReferenceCueCompatibilitySupportsBroadGovernmentDecisionEnvelope(): void {
  if (
    !areActReferenceCuesCompatible(
      'рішення',
      'розпорядження',
      'Яким урядовим рішенням у березні 2026 року оформили виділення коштів з резервного фонду державного бюджету?'
    )
  ) {
    throw new Error('Expected broad government-decision envelope to stay compatible with executive orders');
  }
  if (
    areActReferenceCuesCompatible(
      'рішення',
      'розпорядження',
      'Яким рішенням суду затверджено мирову угоду?'
    )
  ) {
    throw new Error('Did not expect generic court decision wording to collapse onto executive orders');
  }
  console.log('[OK] act-reference cue compatibility keeps broad government-decision envelope distinct from generic decisions');
}

function testMetadataGroundedActCandidateAcceptsBroadGovernmentDecisionEnvelope(): void {
  const grounded = isMetadataGroundedActCandidate(
    {
      rada_nreg: '257-2026-р',
      title: 'Про виділення коштів з резервного фонду державного бюджету',
      document_type: 'Розпорядження КМУ',
      document_type_slug: 'cmu_order',
      reasons: ['title_match', 'summary_match', 'rada_month_match'],
      score: 3.4,
    },
    'Яким урядовим рішенням у березні 2026 року оформили виділення коштів з резервного фонду державного бюджету?',
    new Set(['exact_alias_match', 'exact_title_match', 'alias_match', 'title_match', 'summary_match'])
  );
  if (!grounded) {
    throw new Error('Expected broad government-decision wording to metadata-ground onto a matching CMU order');
  }
  console.log('[OK] metadata act grounding accepts broad government-decision envelope for matching CMU orders');
}

function testMetadataGroundedActCandidateAcceptsCompactTitleFragment(): void {
  const grounded = isMetadataGroundedActCandidate(
    {
      title: 'Про звільнення Кислиці С.О. з посади першого заступника Міністра закордонних справ України',
      document_type: 'Розпорядження КМУ',
      reasons: ['title_match', 'summary_match'],
    },
    'Про звільнення Кислиці посади першого заступника Міністра закордонних',
    new Set(['exact_alias_match', 'exact_title_match'])
  );
  if (!grounded) {
    throw new Error('Expected compact act title fragment to qualify for metadata grounding when one title dominates');
  }
  console.log('[OK] metadata act grounding accepts compact title fragments for descriptive subordinate acts');
}

function testMetadataGroundedActCandidateAcceptsAliasBackedShortLawTitle(): void {
  const grounded = isMetadataGroundedActCandidate(
    {
      title: 'Про національну безпеку України',
      document_type: 'Закон',
      score: 2.8,
      reasons: ['alias_match'],
    },
    'За законом про нацбезпеку хто затверджує Стратегію національної безпеки?',
    new Set(['exact_alias_match', 'exact_title_match', 'alias_match', 'title_match'])
  );
  if (!grounded) {
    throw new Error('Expected alias-backed short law-title cue to qualify for metadata grounding');
  }
  console.log('[OK] metadata act grounding accepts alias-backed short law-title cues');
}

function testMetadataGroundedActCandidateRejectsExplicitLawTitleSemanticNeighbor(): void {
  const grounded = isMetadataGroundedActCandidate(
    {
      title: 'Про запобігання корупції',
      document_type: 'Закон',
      reasons: ['title_match'],
    },
    'За Законом України «Про медіацію», які істотні умови має містити договір про проведення медіації та коли медіатор зобов\'язаний повідомити про конфлікт інтересів?',
    new Set(['exact_alias_match', 'exact_title_match', 'alias_match', 'title_match'])
  );
  if (grounded) {
    throw new Error('Expected explicit absent law-title query not to metadata-ground onto a semantically neighboring law');
  }
  console.log('[OK] metadata act grounding rejects semantic neighbor when explicit law title names another act');
}

function testMetadataGroundedActCandidateRejectsStructuredIdentifierNeighbor(): void {
  const grounded = isMetadataGroundedActCandidate(
    {
      rada_nreg: '33-2026-п',
      title: 'Про внесення змін до порядку закупівлі безпілотних систем та засобів РЕБ',
      document_type: 'Постанова КМУ',
      reasons: ['title_match', 'summary_match'],
      score: 2.7,
    },
    'Постанова 351-2026-п про зміни до закупівлі яких безпілотних і РЕБ-систем?',
    new Set(['exact_alias_match', 'exact_title_match', 'alias_match', 'title_match', 'summary_match'])
  );
  if (grounded) {
    throw new Error('Expected exact structured identifier query not to metadata-ground onto a different act number');
  }
  console.log('[OK] metadata act grounding rejects structured-identifier neighbors');
}

function testMetadataGroundedActCandidateRejectsBaseOrderForAmendmentTitle(): void {
  const grounded = isMetadataGroundedActCandidate(
    {
      rada_nreg: '955-2010-п',
      title:
        'Про затвердження Порядку здійснення закупівлі безпілотних систем, засобів радіоелектронної боротьби тактичного рівня вітчизняного виробництва та їх складових частин',
      document_type: 'Постанова КМУ',
      reasons: ['title_match', 'summary_match'],
      score: 2.9,
    },
    'За постановою Кабінету Міністрів України «Про внесення зміни до пункту 14 Порядку здійснення закупівлі безпілотних систем, засобів радіоелектронної боротьби тактичного рівня вітчизняного виробництва та їх складових частин», порядок закупівлі яких саме засобів і виробів змінюється цією постановою?',
    new Set(['exact_alias_match', 'exact_title_match', 'alias_match', 'title_match', 'summary_match'])
  );
  if (grounded) {
    throw new Error('Expected explicit amendment-order title query not to metadata-ground onto the underlying base order');
  }
  console.log('[OK] metadata act grounding rejects base-order fallback for amendment-title queries');
}

function testMetadataGroundedActCandidateRejectsPersonnelOrderNeighborWithDifferentPersonSignature(): void {
  const grounded = isMetadataGroundedActCandidate(
    {
      rada_nreg: '32-2026-р',
      title: 'Про звільнення Куцевола А.А. з посади заступника Міністра оборони України з питань європейської інтеграції',
      document_type: 'Розпорядження КМУ',
      reasons: ['title_match', 'summary_match'],
      score: 3.2,
    },
    'Яким розпорядженням Кабінету Міністрів України звільнено Мироненка Ю.М. з посади заступника Міністра оборони України?',
    new Set(['exact_alias_match', 'exact_title_match', 'alias_match', 'title_match', 'summary_match'])
  );
  if (grounded) {
    throw new Error('Expected explicit personnel-order query not to metadata-ground onto a neighboring dismissal order with another person identity');
  }
  console.log('[OK] metadata act grounding rejects personnel-order neighbors with different person signature');
}

function testMetadataGroundedActCandidateRejectsPresidentialDelegationNeighbor(): void {
  const grounded = isMetadataGroundedActCandidate(
    {
      rada_nreg: '6/2026-рп',
      title:
        'Про делегацію України для участі у переговорах з Міжнародним банком реконструкції та розвитку щодо укладення Угоди про грант Фонду фінансового посередництва зі сприяння залученню ресурсів для інвестування в зміцнення України',
      document_type: 'Розпорядження Президента',
      document_type_slug: 'president_order',
      reasons: ['title_match', 'summary_match'],
      score: 3.1,
    },
    'Розпорядження Президента про делегацію України на 15-те засідання Конференції Сторін Конвенції про збереження мігруючих видів диких тварин',
    new Set(['exact_alias_match', 'exact_title_match', 'alias_match', 'title_match', 'summary_match'])
  );
  if (grounded) {
    throw new Error('Expected explicit presidential delegation query not to metadata-ground onto an unrelated delegation order');
  }
  console.log('[OK] metadata act grounding rejects neighboring presidential delegation orders without distinct title identity');
}

function testMetadataGroundedActCandidateRejectsKsuDecisionForPresidentialRepresentationQuery(): void {
  const grounded = isMetadataGroundedActCandidate(
    {
      rada_nreg: 'v006p710-19',
      title:
        'Рішення Конституційного Суду України у справі за конституційним поданням 62 народних депутатів України щодо відповідності Конституції України (конституційності) Указу Президента України „Про дострокове припинення повноважень Верховної Ради України та призначення позачергових виборів“',
      document_type: 'Рішення КСУ',
      document_type_slug: 'ksu_decision',
      reasons: ['title_match', 'summary_match'],
      score: 3.2,
    },
    'Яким указом Президента України визначено Представника України у Виконавчій раді ЮНЕСКО?',
    new Set(['exact_alias_match', 'exact_title_match', 'alias_match', 'title_match', 'summary_match'])
  );
  if (grounded) {
    throw new Error('Expected presidential representation query not to metadata-ground onto a KSU decision that only mentions another presidential decree');
  }
  console.log('[OK] metadata act grounding rejects KSU decree neighbors for explicit presidential-act locators');
}

function testMetadataGroundedActCandidateRejectsBoilerplateRepealLocator(): void {
  const grounded = isMetadataGroundedActCandidate(
    {
      title: 'Про визнання таким, що втратив чинність, наказу від 31.07.2002 N 228',
      document_type: 'Наказ',
      reasons: ['title_match', 'summary_match'],
    },
    'Яким наказом визнано таким, що втратив чинність, попередній порядок або інструкцію, і з якого моменту припинилося її застосування?',
    new Set(['exact_alias_match', 'exact_title_match'])
  );
  if (grounded) {
    throw new Error('Expected boilerplate repeal-order locator to remain non-grounded without distinct act identity');
  }
  console.log('[OK] metadata act grounding rejects boilerplate repeal-order locator without distinct identity');
}

function testInterrogativePrimaryLawLocatorQueryDetectsSpecialLawLocators(): void {
  if (
    !isInterrogativePrimaryLawLocatorQuery(
      "Який спеціальний закон воєнного часу дозволяє призупинення трудового договору та по-особливому регулює відпустки працівників?"
    )
  ) {
    throw new Error('Expected special-law locator query to be detected');
  }
  if (
    !isInterrogativePrimaryLawLocatorQuery(
      'Який профільний закон визначає систему громадського здоровʼя та епідемічний нагляд?'
    )
  ) {
    throw new Error('Expected profile-law locator query to be detected');
  }
  if (isInterrogativePrimaryLawLocatorQuery('Який строк оскарження податкового повідомлення-рішення?')) {
    throw new Error('Did not expect generic deadline question to look like a primary-law locator');
  }
  console.log('[OK] primary-law locator detector distinguishes special-law queries from generic legal questions');
}

function testExtractStrictActScopeReferenceSignalsIgnoresTaxNoticeDecisionCompound(): void {
  const signals = extractStrictActScopeReferenceSignals(
    'Компанія отримала податкове повідомлення-рішення і хоче зрозуміти строки адміністративного оскарження та звернення до суду.'
  );
  if (signals.length > 0) {
    throw new Error(`Expected tax-notice soft query to stay outside strict act-scope signals, got ${JSON.stringify(signals)}`);
  }
  console.log('[OK] strict act-scope reference signals ignore compound decision nouns in soft tax queries');
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

function testExtractStructuredActIdentifiersIgnoresTemporalHyphenatedTerms(): void {
  const query =
    'Продавець не дав повної інформації про товар. Чи можу я повернути непродовольчий товар у 14-денний строк і на які норми посилатися?';
  const ids = extractStructuredActIdentifiers(query);
  if (ids.includes('14-денний')) {
    throw new Error(`Expected temporal hyphenated term to stay out of structured act ids, got ${JSON.stringify(ids)}`);
  }
  if (hasExplicitActScopeCue(query)) {
    throw new Error('Expected generic consumer mixed-source query with 14-денний term to remain outside explicit act scope');
  }
  console.log('[OK] extractStructuredActIdentifiers ignores temporal hyphenated terms');
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

function testSelectedActsAllowsProceduralSingleActCoverageWhenMixedGoalTailIsWeak(): void {
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
        count_in_top30: 2,
        avg_score_in_top30: 0.52,
        max_score: 0.59,
        best_rank_in_top30: 1,
        rank_mass_top30: 0.31,
        max_ordering_score: 0.49,
      },
    ],
  });
  if (!result.selected_acts_reason_codes.includes('MULTI_GOAL_SINGLE_ACT_COVERAGE_ALLOWED')) {
    throw new Error(
      `Expected MULTI_GOAL_SINGLE_ACT_COVERAGE_ALLOWED for weak mixed-goal procedural tail, got ${JSON.stringify(result.selected_acts_reason_codes)}`
    );
  }
  if (result.selected_acts_reason_codes.includes('MULTI_GOAL_PROCEDURAL_SINGLE_ACT_BLOCKED')) {
    throw new Error(
      `Did not expect MULTI_GOAL_PROCEDURAL_SINGLE_ACT_BLOCKED for weak mixed-goal procedural tail, got ${JSON.stringify(result.selected_acts_reason_codes)}`
    );
  }
  if (result.selected_acts.length !== 1 || result.selected_acts[0]?.rada_nreg !== '2747-15') {
    throw new Error(`Expected dominant procedural code to remain selected, got ${JSON.stringify(result.selected_acts)}`);
  }
  if ((result.selected_acts_confidence ?? 0) < 0.75) {
    throw new Error(
      `Expected materially confident single-act procedural coverage after trimming weak tail, got ${result.selected_acts_confidence}`
    );
  }
  console.log('[OK] weak mixed-goal procedural tail does not block single-act procedural coverage');
}

function testSelectedActsBlocksProceduralSingleActCoverageWhenStrongNonProceduralCompanionRemains(): void {
  const result = buildSelectedActs({
    finalHits: [
      {
        rada_nreg: '1618-15',
        r2_key: 'legislation/civil_procedure/1618-15.json',
        json_path: '$.content.chunks[0].text',
        score: 0.59,
        ordering_score: 0.76,
        source: 'lldbi_chunks',
        goal_id: 'goal_0',
      } as never,
      {
        rada_nreg: '1618-15',
        r2_key: 'legislation/civil_procedure/1618-15.json',
        json_path: '$.content.chunks[1].text',
        score: 0.57,
        ordering_score: 0.72,
        source: 'lldbi_chunks',
        goal_id: 'goal_1',
      } as never,
      {
        rada_nreg: '2947-14',
        r2_key: 'legislation/civil/2947-14.json',
        json_path: '$.content.chunks[0].text',
        score: 0.64,
        ordering_score: 0.64,
        source: 'lldbi_chunks',
      } as never,
    ],
    actCandidatesTop: [
      {
        rada_nreg: '1618-15',
        title: 'Цивільний процесуальний кодекс України',
        score: 0.92,
        category: 'civil_procedure',
        document_type: 'Кодекс',
        source_tier: 'ACTS_1',
      },
      {
        rada_nreg: '2947-14',
        title: 'Сімейний кодекс України',
        score: 0.83,
        category: 'civil',
        document_type: 'Кодекс',
        source_tier: 'ACTS_1',
      },
    ],
    goals_summary: [{ goal_id: 'goal_0' }, { goal_id: 'goal_1' }],
    goal_support_by_act: {
      '1618-15': ['goal_0', 'goal_1'],
    },
    taxonomyNregs: new Set(['1618-15', '2947-14']),
    actsSearchNregs: ['1618-15', '2947-14'],
    chunks_evidence_top_acts: [
      {
        rada_nreg: '1618-15',
        count_in_top30: 8,
        avg_score_in_top30: 0.58,
        max_score: 0.64,
        best_rank_in_top30: 1,
        rank_mass_top30: 1.92,
        max_ordering_score: 0.76,
      },
      {
        rada_nreg: '2947-14',
        count_in_top30: 4,
        avg_score_in_top30: 0.61,
        max_score: 0.64,
        best_rank_in_top30: 8,
        rank_mass_top30: 0.56,
        max_ordering_score: 0.64,
      },
    ],
  });
  if (result.selected_acts_reason_codes.includes('MULTI_GOAL_SINGLE_ACT_COVERAGE_ALLOWED')) {
    throw new Error(
      `Did not expect MULTI_GOAL_SINGLE_ACT_COVERAGE_ALLOWED when strong non-procedural companion evidence remains, got ${JSON.stringify(result.selected_acts_reason_codes)}`
    );
  }
  if (!result.selected_acts_reason_codes.includes('MULTI_GOAL_PROCEDURAL_SINGLE_ACT_BLOCKED')) {
    throw new Error(
      `Expected MULTI_GOAL_PROCEDURAL_SINGLE_ACT_BLOCKED when strong non-procedural companion evidence remains, got ${JSON.stringify(result.selected_acts_reason_codes)}`
    );
  }
  if (!result.selected_acts.some((act) => act.rada_nreg === '2947-14')) {
    throw new Error(`Expected family-law companion to remain selected, got ${JSON.stringify(result.selected_acts)}`);
  }
  console.log('[OK] strong non-procedural companion evidence blocks procedural single-act collapse');
}

function testSelectedActsRecoversMixedGoalPrimaryCompanionFromHitBackfill(): void {
  const result = buildSelectedActs({
    finalHits: [
      {
        rada_nreg: '1618-15',
        title: 'Цивільний процесуальний кодекс України',
        category: 'civil_procedure',
        document_type: 'Кодекс',
        r2_key: 'legislation/civil_procedure/1618-15.json',
        json_path: '$.content.chunks[0].text',
        score: 0.59,
        ordering_score: 0.76,
        source: 'lldbi_chunks',
        goal_id: 'goal_0',
      } as never,
      {
        rada_nreg: '1618-15',
        title: 'Цивільний процесуальний кодекс України',
        category: 'civil_procedure',
        document_type: 'Кодекс',
        r2_key: 'legislation/civil_procedure/1618-15.json',
        json_path: '$.content.chunks[1].text',
        score: 0.57,
        ordering_score: 0.72,
        source: 'lldbi_chunks',
        goal_id: 'goal_1',
      } as never,
      {
        rada_nreg: '2947-14',
        title: 'Сімейний кодекс України',
        category: 'family',
        document_type: 'Кодекс',
        r2_key: 'legislation/family/2947-14.json',
        json_path: '$.content.chunks[0].text',
        score: 0.67,
        ordering_score: 0.59,
        source: 'lldbi_chunks',
        goal_id: 'goal_0',
      } as never,
      {
        rada_nreg: '2947-14',
        title: 'Сімейний кодекс України',
        category: 'family',
        document_type: 'Кодекс',
        r2_key: 'legislation/family/2947-14.json',
        json_path: '$.content.chunks[1].text',
        score: 0.58,
        ordering_score: 0.56,
        source: 'lldbi_chunks',
      } as never,
    ],
    actCandidatesTop: [
      {
        rada_nreg: '1618-15',
        title: 'Цивільний процесуальний кодекс України',
        score: 0.92,
        category: 'civil_procedure',
        document_type: 'Кодекс',
        source_tier: 'ACTS_1',
      },
    ],
    goals_summary: [{ goal_id: 'goal_0' }, { goal_id: 'goal_1' }],
    goal_support_by_act: {
      '1618-15': ['goal_0', 'goal_1'],
      '2947-14': ['goal_0'],
    },
    taxonomyNregs: new Set(['1618-15']),
    actsSearchNregs: ['1618-15'],
    chunks_evidence_top_acts: [
      {
        rada_nreg: '1618-15',
        count_in_top30: 8,
        avg_score_in_top30: 0.58,
        max_score: 0.64,
        best_rank_in_top30: 1,
        rank_mass_top30: 1.92,
        max_ordering_score: 0.76,
      },
      {
        rada_nreg: '2947-14',
        count_in_top30: 2,
        avg_score_in_top30: 0.625,
        max_score: 0.67,
        best_rank_in_top30: 9,
        rank_mass_top30: 0.23,
        max_ordering_score: 0.59,
      },
    ],
  });
  if (!result.selected_acts.some((act) => act.rada_nreg === '2947-14')) {
    throw new Error(`Expected hit-backed family-law companion to be recovered, got ${JSON.stringify(result.selected_acts)}`);
  }
  if (!result.selected_acts_reason_codes.includes('MULTI_GOAL_PRIMARY_COMPANION_RECOVERED_FROM_HITS')) {
    throw new Error(
      `Expected MULTI_GOAL_PRIMARY_COMPANION_RECOVERED_FROM_HITS, got ${JSON.stringify(result.selected_acts_reason_codes)}`
    );
  }
  console.log('[OK] hit-backed substantive companion is recovered for mixed procedural bundle');
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

function testSelectedActsBlocksWeakNonPrimaryNoiseUnderMultiGoalPrimaryDominance(): void {
  const result = buildSelectedActs({
    finalHits: [
      {
        rada_nreg: '2341-14',
        r2_key: 'legislation/criminal/2341-14.json',
        json_path: '$.content.chunks[0].text',
        score: 0.72,
        ordering_score: 0.77,
        source: 'lldbi_chunks',
        goal_id: 'goal_0',
      } as never,
      {
        rada_nreg: '995_004',
        r2_key: 'legislation/treaty/995_004.json',
        json_path: '$.content.chunks[0].text',
        score: 0.53,
        ordering_score: 0.54,
        source: 'lldbi_chunks',
        goal_id: 'goal_1',
      } as never,
      {
        rada_nreg: '995_004',
        r2_key: 'legislation/treaty/995_004.json',
        json_path: '$.content.chunks[1].text',
        score: 0.51,
        ordering_score: 0.52,
        source: 'lldbi_chunks',
        goal_id: 'goal_1',
      } as never,
    ],
    actCandidatesTop: [
      {
        rada_nreg: '2341-14',
        title: 'Кримінальний кодекс України',
        score: 0.93,
        category: 'criminal',
        document_type: 'Кодекс',
        source_tier: 'ACTS_1',
      },
      {
        rada_nreg: '995_004',
        title: 'Конвенція про захист прав людини і основоположних свобод',
        score: 0.71,
        category: 'international',
        document_type_slug: 'convention',
        source_tier: 'ACTS_1',
      },
    ],
    goals_summary: [{ goal_id: 'goal_0' }, { goal_id: 'goal_1' }],
    goal_support_by_act: {
      '2341-14': ['goal_0'],
      '995_004': ['goal_1'],
    },
    taxonomyNregs: new Set(['2341-14', '995_004']),
    actsSearchNregs: ['2341-14', '995_004'],
    chunks_evidence_top_acts: [
      {
        rada_nreg: '2341-14',
        count_in_top30: 9,
        avg_score_in_top30: 0.61,
        max_score: 0.67,
        best_rank_in_top30: 1,
        rank_mass_top30: 2.4,
        max_ordering_score: 0.79,
      },
      {
        rada_nreg: '995_004',
        count_in_top30: 2,
        avg_score_in_top30: 0.52,
        max_score: 0.54,
        best_rank_in_top30: 7,
        rank_mass_top30: 0.26,
        max_ordering_score: 0.54,
      },
    ],
    familyEvidence: {
      dominant_family_key: 'criminal',
      family_confidence: 0.71,
      family_conflict: false,
      top2: [
        { family_key: 'criminal', support_score: 0.74 },
        { family_key: 'international', support_score: 0.18 },
      ],
    },
  });
  if (result.selected_acts.some((act) => act.rada_nreg === '995_004')) {
    throw new Error(`Expected weak non-primary treaty tail to be blocked under primary-law dominance, got ${JSON.stringify(result.selected_acts)}`);
  }
  console.log('[OK] selected_acts blocks weak non-primary noise under multi-goal primary-law dominance');
}

function testSelectedActsKeepsExplicitlyHintedNonPrimaryActInMultiGoalSelection(): void {
  const result = buildSelectedActs({
    finalHits: [
      {
        rada_nreg: '2341-14',
        r2_key: 'legislation/criminal/2341-14.json',
        json_path: '$.content.chunks[0].text',
        score: 0.72,
        ordering_score: 0.77,
        source: 'lldbi_chunks',
        goal_id: 'goal_0',
      } as never,
      {
        rada_nreg: '995_004',
        r2_key: 'legislation/treaty/995_004.json',
        json_path: '$.content.chunks[0].text',
        score: 0.53,
        ordering_score: 0.54,
        source: 'lldbi_chunks',
        goal_id: 'goal_1',
      } as never,
      {
        rada_nreg: '995_004',
        r2_key: 'legislation/treaty/995_004.json',
        json_path: '$.content.chunks[1].text',
        score: 0.51,
        ordering_score: 0.52,
        source: 'lldbi_chunks',
        goal_id: 'goal_1',
      } as never,
    ],
    actCandidatesTop: [
      {
        rada_nreg: '2341-14',
        title: 'Кримінальний кодекс України',
        score: 0.93,
        category: 'criminal',
        document_type: 'Кодекс',
        source_tier: 'ACTS_1',
      },
      {
        rada_nreg: '995_004',
        title: 'Конвенція про захист прав людини і основоположних свобод',
        score: 0.71,
        category: 'international',
        document_type_slug: 'convention',
        source_tier: 'ACTS_1',
      },
    ],
    goals_summary: [{ goal_id: 'goal_0' }, { goal_id: 'goal_1' }],
    goal_support_by_act: {
      '2341-14': ['goal_0'],
      '995_004': ['goal_1'],
    },
    taxonomyNregs: new Set(['2341-14', '995_004']),
    actsSearchNregs: ['2341-14', '995_004'],
    documentTypeHints: ['Конвенція'],
    chunks_evidence_top_acts: [
      {
        rada_nreg: '2341-14',
        count_in_top30: 9,
        avg_score_in_top30: 0.61,
        max_score: 0.67,
        best_rank_in_top30: 1,
        rank_mass_top30: 2.4,
        max_ordering_score: 0.79,
      },
      {
        rada_nreg: '995_004',
        count_in_top30: 2,
        avg_score_in_top30: 0.52,
        max_score: 0.54,
        best_rank_in_top30: 7,
        rank_mass_top30: 0.26,
        max_ordering_score: 0.54,
      },
    ],
    familyEvidence: {
      dominant_family_key: 'criminal',
      family_confidence: 0.71,
      family_conflict: false,
      top2: [
        { family_key: 'criminal', support_score: 0.74 },
        { family_key: 'international', support_score: 0.18 },
      ],
    },
  });
  if (!result.selected_acts.some((act) => act.rada_nreg === '995_004')) {
    throw new Error(`Expected explicit treaty hint to preserve non-primary act, got ${JSON.stringify(result.selected_acts)}`);
  }
  if (result.selected_acts_reason_codes.includes('MULTI_GOAL_NON_PRIMARY_NOISE_BLOCKED_PRIMARY_PRESENT')) {
    throw new Error(`Did not expect non-primary noise trim when treaty hint is explicit, got ${JSON.stringify(result.selected_acts_reason_codes)}`);
  }
  console.log('[OK] selected_acts keeps explicitly hinted non-primary act in multi-goal selection');
}

function testSelectedActsTrimsWeakOffFamilyPrimaryTailButKeepsProceduralPrimaryCompanion(): void {
  const result = buildSelectedActs({
    finalHits: [
      {
        rada_nreg: '2341-14',
        r2_key: 'legislation/criminal/2341-14.json',
        json_path: '$.content.chunks[0].text',
        score: 0.72,
        ordering_score: 0.78,
        source: 'lldbi_chunks',
        goal_id: 'goal_0',
      } as never,
      {
        rada_nreg: '2341-14',
        r2_key: 'legislation/criminal/2341-14.json',
        json_path: '$.content.chunks[1].text',
        score: 0.69,
        ordering_score: 0.74,
        source: 'lldbi_chunks',
        goal_id: 'goal_0',
      } as never,
      {
        rada_nreg: '4651-17',
        r2_key: 'legislation/criminal-procedure/4651-17.json',
        json_path: '$.content.chunks[0].text',
        score: 0.63,
        ordering_score: 0.61,
        source: 'lldbi_chunks',
        goal_id: 'goal_1',
      } as never,
      {
        rada_nreg: '4651-17',
        r2_key: 'legislation/criminal-procedure/4651-17.json',
        json_path: '$.content.chunks[1].text',
        score: 0.61,
        ordering_score: 0.58,
        source: 'lldbi_chunks',
        goal_id: 'goal_1',
      } as never,
      {
        rada_nreg: '80731-10',
        r2_key: 'legislation/admin-offenses/80731-10.json',
        json_path: '$.content.chunks[0].text',
        score: 0.6,
        ordering_score: 0.57,
        source: 'lldbi_chunks',
      } as never,
      {
        rada_nreg: '80731-10',
        r2_key: 'legislation/admin-offenses/80731-10.json',
        json_path: '$.content.chunks[1].text',
        score: 0.58,
        ordering_score: 0.54,
        source: 'lldbi_chunks',
      } as never,
    ],
    actCandidatesTop: [
      {
        rada_nreg: '2341-14',
        title: 'Кримінальний кодекс України',
        score: 0.95,
        category: 'criminal',
        document_type: 'Кодекс',
        document_type_slug: 'code',
        source_tier: 'ACTS_1',
      },
      {
        rada_nreg: '4651-17',
        title: 'Кримінальний процесуальний кодекс України',
        score: 0.82,
        category: 'criminal_procedure',
        document_type: 'Кодекс',
        document_type_slug: 'code',
        source_tier: 'ACTS_1',
      },
      {
        rada_nreg: '80731-10',
        title: 'Кодекс України про адміністративні правопорушення',
        score: 0.79,
        category: 'administrative_offenses',
        document_type: 'Кодекс',
        document_type_slug: 'code',
        source_tier: 'ACTS_1',
      },
    ],
    goals_summary: [
      { goal_id: 'goal_0', goal_type: 'substantive' },
      { goal_id: 'goal_1', goal_type: 'procedure' },
    ],
    goal_support_by_act: {
      '2341-14': ['goal_0'],
      '4651-17': ['goal_1'],
    },
    taxonomyNregs: new Set(['2341-14', '4651-17', '80731-10']),
    actsSearchNregs: ['2341-14', '4651-17', '80731-10'],
    chunks_evidence_top_acts: [
      {
        rada_nreg: '2341-14',
        count_in_top30: 9,
        avg_score_in_top30: 0.64,
        max_score: 0.72,
        best_rank_in_top30: 1,
        rank_mass_top30: 2.8,
        max_ordering_score: 0.78,
      },
      {
        rada_nreg: '4651-17',
        count_in_top30: 6,
        avg_score_in_top30: 0.59,
        max_score: 0.63,
        best_rank_in_top30: 4,
        rank_mass_top30: 0.74,
        max_ordering_score: 0.61,
      },
      {
        rada_nreg: '80731-10',
        count_in_top30: 4,
        avg_score_in_top30: 0.55,
        max_score: 0.6,
        best_rank_in_top30: 3,
        rank_mass_top30: 0.17,
        max_ordering_score: 0.57,
      },
    ],
    familyEvidence: {
      dominant_family_key: 'criminal',
      family_confidence: 0.74,
      family_conflict: false,
      top2: [
        { family_key: 'criminal', support_score: 0.76 },
        { family_key: 'criminal_procedure', support_score: 0.33 },
      ],
    },
  });

  const selectedNregs = result.selected_acts.map((act) => act.rada_nreg);
  if (!selectedNregs.includes('2341-14') || !selectedNregs.includes('4651-17')) {
    throw new Error(`Expected substantive + procedural primary laws to remain selected, got ${JSON.stringify(result.selected_acts)}`);
  }
  if (selectedNregs.includes('80731-10')) {
    throw new Error(`Expected weak off-family primary tail to be trimmed, got ${JSON.stringify(result.selected_acts)}`);
  }
  if (!result.selected_acts_reason_codes.includes('MULTI_GOAL_WEAK_PRIMARY_FAMILY_MISMATCH_TAIL_TRIMMED')) {
    throw new Error(
      `Expected weak off-family primary tail trim reason code, got ${JSON.stringify(result.selected_acts_reason_codes)}`
    );
  }
  console.log('[OK] selected_acts trims weak off-family primary-law tail while keeping procedural companion');
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

function testFinalizeMultiGoalSelectedActsRecomputesConfidenceAfterTailTrim(): void {
  const result = finalizeMultiGoalSelectedActs({
    selectedActs: [
      {
        rada_nreg: '2341-14',
        act_title: 'Кримінальний кодекс України',
        act_kind: 'PRIMARY_LAW',
        category: 'criminal',
        document_type: 'Кодекс',
      },
      {
        rada_nreg: '4651-17',
        act_title: 'Кримінальний процесуальний кодекс України',
        act_kind: 'PRIMARY_LAW',
        category: 'criminal_procedure',
        document_type: 'Кодекс',
      },
    ],
    originalSelectedActs: [
      {
        rada_nreg: '2341-14',
        act_title: 'Кримінальний кодекс України',
        act_kind: 'PRIMARY_LAW',
        category: 'criminal',
        document_type: 'Кодекс',
      },
      {
        rada_nreg: '4651-17',
        act_title: 'Кримінальний процесуальний кодекс України',
        act_kind: 'PRIMARY_LAW',
        category: 'criminal_procedure',
        document_type: 'Кодекс',
      },
      {
        rada_nreg: '80731-10',
        act_title: 'Кодекс України про адміністративні правопорушення',
        act_kind: 'PRIMARY_LAW',
        category: 'administrative_offenses',
        document_type: 'Кодекс',
      },
    ],
    baseSelectedActsConfidence: 0.5,
    selectedActsSourcesBreakdown: {
      from_taxonomy: [],
      from_acts_search: [],
      from_chunks_evidence: ['2341-14', '4651-17', '80731-10'],
    },
    chunksEvidenceTopActs: [
      {
        rada_nreg: '2341-14',
        count_in_top30: 7,
        avg_score_in_top30: 0.66,
        max_score: 0.72,
        best_rank_in_top30: 1,
        rank_mass_top30: 2.2,
        max_ordering_score: 0.77,
      },
      {
        rada_nreg: '4651-17',
        count_in_top30: 6,
        avg_score_in_top30: 0.61,
        max_score: 0.65,
        best_rank_in_top30: 4,
        rank_mass_top30: 0.81,
        max_ordering_score: 0.62,
      },
      {
        rada_nreg: '80731-10',
        count_in_top30: 1,
        avg_score_in_top30: 0.42,
        max_score: 0.47,
        best_rank_in_top30: 18,
        rank_mass_top30: 0.07,
        max_ordering_score: 0.29,
      },
    ],
    goalsSummary: [
      { goal_id: 'goal_0', goal_type: 'definition' },
      { goal_id: 'goal_1', goal_type: 'procedure' },
    ],
    goalSupportByAct: new Map([
      ['2341-14', new Set(['goal_0'])],
      ['4651-17', new Set(['goal_1'])],
      ['80731-10', new Set()],
    ]),
  });
  if (result.selectedActsConfidence < 0.75) {
    throw new Error(`Expected tail-trimmed strong bundle to recover confidence, got ${result.selectedActsConfidence}`);
  }
  if ((result.selectedActsKindsCount.PRIMARY_LAW ?? 0) !== 2) {
    throw new Error(`Expected final kinds count to reflect trimmed primary-law bundle, got ${JSON.stringify(result.selectedActsKindsCount)}`);
  }
  if (
    JSON.stringify(result.selectedActsSourcesBreakdown.from_chunks_evidence.sort()) !==
    JSON.stringify(['2341-14', '4651-17'])
  ) {
    throw new Error(`Expected final chunks-only breakdown to drop trimmed tail, got ${JSON.stringify(result.selectedActsSourcesBreakdown)}`);
  }
  console.log('[OK] multi-goal finalizer recomputes confidence and breakdown after tail trim');
}

function testFinalizeMultiGoalSelectedActsKeepsOnlyFinalMetadataGrounding(): void {
  const result = finalizeMultiGoalSelectedActs({
    selectedActs: [
      {
        rada_nreg: '19-2026-р',
        act_title: 'Про закриття дисциплінарного провадження',
        act_kind: 'SECONDARY_ORDER',
        category: 'administrative',
        document_type: 'Розпорядження КМУ',
      },
    ],
    originalSelectedActs: [
      {
        rada_nreg: '19-2026-р',
        act_title: 'Про закриття дисциплінарного провадження',
        act_kind: 'SECONDARY_ORDER',
        category: 'administrative',
        document_type: 'Розпорядження КМУ',
      },
      {
        rada_nreg: '435-15',
        act_title: 'Цивільний кодекс України',
        act_kind: 'PRIMARY_LAW',
        category: 'civil',
        document_type: 'Кодекс',
      },
    ],
    baseSelectedActsConfidence: 0.5,
    selectedActsSourcesBreakdown: {
      from_taxonomy: ['19-2026-р', '435-15'],
      from_acts_search: ['19-2026-р'],
      from_chunks_evidence: ['435-15'],
    },
    chunksEvidenceTopActs: [],
    goalsSummary: [
      { goal_id: 'goal_0', goal_type: 'definition' },
      { goal_id: 'goal_1', goal_type: 'definition' },
    ],
    goalSupportByAct: new Map([
      ['19-2026-р', new Set(['goal_0'])],
      ['435-15', new Set(['goal_1'])],
    ]),
  });
  if (result.metadataGroundedActCount !== 1) {
    throw new Error(`Expected final metadata grounding count to reflect only surviving act, got ${result.metadataGroundedActCount}`);
  }
  if (JSON.stringify(result.selectedActsSourcesBreakdown.from_taxonomy) !== JSON.stringify(['19-2026-р'])) {
    throw new Error(`Expected final taxonomy breakdown to keep only surviving act, got ${JSON.stringify(result.selectedActsSourcesBreakdown)}`);
  }
  console.log('[OK] multi-goal finalizer keeps only final metadata grounding signals');
}

function testFinalizeMultiGoalSelectedActsDoesNotTreatActsSearchAsMetadataGrounding(): void {
  const result = finalizeMultiGoalSelectedActs({
    selectedActs: [
      {
        rada_nreg: '1023-12',
        act_title: 'Про захист прав споживачів',
        act_kind: 'PRIMARY_LAW',
        category: 'civil',
        document_type: 'Закон',
      },
      {
        rada_nreg: '435-15',
        act_title: 'Цивільний кодекс України',
        act_kind: 'PRIMARY_LAW',
        category: 'civil',
        document_type: 'Кодекс',
      },
    ],
    originalSelectedActs: [
      {
        rada_nreg: '1023-12',
        act_title: 'Про захист прав споживачів',
        act_kind: 'PRIMARY_LAW',
        category: 'civil',
        document_type: 'Закон',
      },
      {
        rada_nreg: '435-15',
        act_title: 'Цивільний кодекс України',
        act_kind: 'PRIMARY_LAW',
        category: 'civil',
        document_type: 'Кодекс',
      },
    ],
    baseSelectedActsConfidence: 0.75,
    selectedActsSourcesBreakdown: {
      from_taxonomy: [],
      from_acts_search: ['1023-12', '435-15'],
      from_chunks_evidence: ['1023-12', '435-15'],
    },
    chunksEvidenceTopActs: [],
    goalsSummary: [
      { goal_id: 'goal_0', goal_type: 'definition' },
      { goal_id: 'goal_1', goal_type: 'procedure' },
    ],
    goalSupportByAct: new Map([
      ['1023-12', new Set(['goal_0'])],
      ['435-15', new Set(['goal_1'])],
    ]),
  });
  if (result.metadataGroundedActCount !== 0) {
    throw new Error(`Expected acts_search-only support to not count as metadata grounding, got ${result.metadataGroundedActCount}`);
  }
  console.log('[OK] multi-goal finalizer does not treat acts_search as metadata grounding');
}

function testTrimUngroundedMultiGoalFallbackSelectionKeepsTopTwoEvidenceActs(): void {
  const trimmed = trimUngroundedMultiGoalFallbackSelection({
    selectedActs: [
      {
        rada_nreg: '2755-17',
        act_title: 'Податковий кодекс України',
        act_kind: 'PRIMARY_LAW',
        category: 'tax_customs',
        document_type: 'Кодекс',
        score: 0.49,
      },
      {
        rada_nreg: '2947-14',
        act_title: 'Сімейний кодекс України',
        act_kind: 'PRIMARY_LAW',
        category: 'civil',
        document_type: 'Кодекс',
        score: 0.43,
      },
      {
        rada_nreg: '4651-17',
        act_title: 'Кримінальний процесуальний кодекс України',
        act_kind: 'PRIMARY_LAW',
        category: 'criminal_procedure',
        document_type: 'Кодекс',
        score: 0.39,
      },
    ],
    chunksEvidenceTopActs: [
      {
        rada_nreg: '2755-17',
        count_in_top30: 17,
        avg_score_in_top30: 0.44,
        max_score: 0.48,
        best_rank_in_top30: 1,
        rank_mass_top30: 1.89,
        max_ordering_score: 0.50,
      },
      {
        rada_nreg: '2947-14',
        count_in_top30: 8,
        avg_score_in_top30: 0.25,
        max_score: 0.27,
        best_rank_in_top30: 2,
        rank_mass_top30: 1.41,
        max_ordering_score: 0.43,
      },
      {
        rada_nreg: '4651-17',
        count_in_top30: 5,
        avg_score_in_top30: 0.44,
        max_score: 0.47,
        best_rank_in_top30: 5,
        rank_mass_top30: 0.68,
        max_ordering_score: 0.39,
      },
    ],
    maxActs: 2,
  });
  const trimmedNregs = trimmed.map((act) => act.rada_nreg);
  if (JSON.stringify(trimmedNregs) !== JSON.stringify(['2755-17', '2947-14'])) {
    throw new Error(`Expected ungrounded multi-goal tail trim to keep top two evidence acts, got ${JSON.stringify(trimmedNregs)}`);
  }
  console.log('[OK] ungrounded multi-goal tail trim keeps top two evidence acts');
}

function testTrimLowConfidenceMultiGoalSelectionPreservesUniqueGoalCoverageWithoutMismatchSignal(): void {
  const trimmed = trimLowConfidenceMultiGoalSelection({
    selectedActs: [
      {
        rada_nreg: '1023-12',
        act_title: 'Про захист прав споживачів',
        act_kind: 'PRIMARY_LAW',
        category: 'civil',
        document_type: 'Закон',
        score: 0.57,
      },
      {
        rada_nreg: '4651-17',
        act_title: 'Кримінальний процесуальний кодекс України',
        act_kind: 'PRIMARY_LAW',
        category: 'criminal_procedure',
        document_type: 'Кодекс',
        score: 0.46,
      },
      {
        rada_nreg: '435-15',
        act_title: 'Цивільний кодекс України',
        act_kind: 'PRIMARY_LAW',
        category: 'civil',
        document_type: 'Кодекс',
        score: 0.55,
      },
    ],
    chunksEvidenceTopActs: [
      {
        rada_nreg: '1023-12',
        count_in_top30: 11,
        avg_score_in_top30: 0.53,
        max_score: 0.57,
        best_rank_in_top30: 1,
        rank_mass_top30: 1.8,
        max_ordering_score: 0.58,
      },
      {
        rada_nreg: '435-15',
        count_in_top30: 10,
        avg_score_in_top30: 0.5,
        max_score: 0.55,
        best_rank_in_top30: 2,
        rank_mass_top30: 1.62,
        max_ordering_score: 0.56,
      },
      {
        rada_nreg: '4651-17',
        count_in_top30: 5,
        avg_score_in_top30: 0.45,
        max_score: 0.47,
        best_rank_in_top30: 4,
        rank_mass_top30: 0.74,
        max_ordering_score: 0.48,
      },
    ],
    goalsSummary: [
      { goal_id: 'goal_0', goal_type: 'definition' },
      { goal_id: 'goal_1', goal_type: 'procedure' },
    ],
    goalSupportByAct: new Map([
      ['1023-12', new Set(['goal_0'])],
      ['435-15', new Set(['goal_0'])],
      ['4651-17', new Set(['goal_1'])],
    ]),
    domainHint: 'general',
    mismatchSignalsPresent: false,
    maxActs: 2,
  });
  const trimmedNregs = [...trimmed.map((act) => act.rada_nreg)].sort();
  if (JSON.stringify(trimmedNregs) !== JSON.stringify(['1023-12', '4651-17'])) {
    throw new Error(`Expected low-confidence trim to preserve the unique-goal pair, got ${JSON.stringify(trimmedNregs)}`);
  }
  console.log('[OK] low-confidence multi-goal trim preserves unique goal coverage without mismatch signal');
}

function testResolveExplicitPrimaryActMultiGoalSelectionAllowsAnchoredThinLaw(): void {
  const result = resolveExplicitPrimaryActMultiGoalSelection({
    query:
      'За Законом України «Про ратифікацію Угоди (у формі обміну нотами) між Україною та Європейським Союзом про відновлення дії Угоди між Україною та Європейським Співтовариством про наукове і технологічне співробітництво», яку саме угоду відновлено та між якими сторонами вона укладена?',
    documentTypeHints: ['Закон'],
    selectedActs: [
      {
        rada_nreg: '984_011',
        act_title:
          'Угода про асоціацію між Україною, з однієї сторони, та Європейським Союзом, Європейським співтовариством з атомної енергії і їхніми державами-членами, з іншої сторони',
        act_kind: 'INTERNATIONAL_TREATY',
        category: 'international_eu',
        document_type: 'Угода',
        score: 0.56,
      },
      {
        rada_nreg: '4805-20',
        act_title:
          'Про ратифікацію Угоди (у формі обміну нотами) між Україною та Європейським Союзом про відновлення дії Угоди між Україною та Європейським Співтовариством про наукове і технологічне співробітництво',
        act_kind: 'PRIMARY_LAW',
        category: 'international_eu',
        document_type: 'Закон',
        score: 0.56,
      },
    ],
    selectedActsSourcesBreakdown: {
      from_taxonomy: [],
      from_acts_search: [],
      from_chunks_evidence: ['984_011', '4805-20'],
    },
    actCandidatesTop: [
      {
        rada_nreg: '4805-20',
        title:
          'Про ратифікацію Угоди (у формі обміну нотами) між Україною та Європейським Союзом про відновлення дії Угоди між Україною та Європейським Співтовариством про наукове і технологічне співробітництво',
        score: 3.4,
        reasons: ['exact_title_match'],
        category: 'international_eu',
        document_type: 'Закон',
        document_type_slug: 'law',
      },
      {
        rada_nreg: '984_011',
        title:
          'Угода про асоціацію між Україною, з однієї сторони, та Європейським Союзом, Європейським співтовариством з атомної енергії і їхніми державами-членами, з іншої сторони',
        score: 2.2,
        reasons: ['title_match'],
        category: 'international_eu',
        document_type: 'Угода',
        document_type_slug: 'agreement',
      },
    ],
    chunksEvidenceTopActs: [
      {
        rada_nreg: '4805-20',
        count_in_top30: 1,
        avg_score_in_top30: 0.79,
        max_score: 0.79,
        best_rank_in_top30: 1,
        rank_mass_top30: 1,
        max_ordering_score: 0.56,
      },
      {
        rada_nreg: '984_011',
        count_in_top30: 29,
        avg_score_in_top30: 0.55,
        max_score: 0.62,
        best_rank_in_top30: 2,
        rank_mass_top30: 2.8,
        max_ordering_score: 0.56,
      },
    ],
    goalsSummary: [
      { goal_id: 'goal_0', goal_type: 'compliance_check', act_candidates_top3: ['4805-20', '4804-20'] },
      { goal_id: 'goal_1', goal_type: 'compliance_check', act_candidates_top3: ['984_011', '4805-20'] },
    ],
    goalSupportByAct: new Map([
      ['4805-20', new Set(['goal_0', 'goal_1'])],
      ['984_011', new Set(['goal_1'])],
    ]),
  });
  if (!result.allowSingleActCoverage) {
    throw new Error(`Expected explicit anchored thin law to allow single-act coverage, got ${JSON.stringify(result)}`);
  }
  if (!result.selectedActsSourcesBreakdown.from_taxonomy.includes('4805-20')) {
    throw new Error(
      `Expected explicit anchored thin law to add taxonomy grounding for 4805-20, got ${JSON.stringify(result.selectedActsSourcesBreakdown)}`
    );
  }
  if (!result.reasonCodes.includes('MULTI_GOAL_EXPLICIT_PRIMARY_SINGLE_ACT_ALLOWED')) {
    throw new Error(`Expected explicit primary single-act allowance reason, got ${JSON.stringify(result.reasonCodes)}`);
  }
  console.log('[OK] explicit anchored thin law allows multi-goal single-act coverage');
}

function testResolveExplicitPrimaryActMultiGoalSelectionRecoversThinLawAndTrimsUnhintedOrderNoise(): void {
  const result = resolveExplicitPrimaryActMultiGoalSelection({
    query:
      'За Законом України «Про ратифікацію Угоди між Урядом України та Урядом Республіки Польща про діяльність Bank Gospodarstwa Krajowego в Україні», діяльність якої саме установи дозволена в Україні і між якими сторонами укладено угоду?',
    documentTypeHints: ['Закон'],
    selectedActs: [
      {
        rada_nreg: '984_011',
        act_title:
          'Угода про асоціацію між Україною, з однієї сторони, та Європейським Союзом, Європейським співтовариством з атомної енергії і їхніми державами-членами, з іншої сторони',
        act_kind: 'INTERNATIONAL_TREATY',
        category: 'international_eu',
        document_type: 'Угода',
        score: 0.57,
      },
      {
        rada_nreg: 'z0841-01',
        act_title: 'Про затвердження Інструкції про порядок регулювання діяльності банків в Україні',
        act_kind: 'SECONDARY_ORDER',
        category: 'finance_banking',
        document_type: 'Постанова НБУ',
        score: 0.65,
      },
    ],
    selectedActsSourcesBreakdown: {
      from_taxonomy: [],
      from_acts_search: [],
      from_chunks_evidence: ['984_011', 'z0841-01'],
    },
    actCandidatesTop: [
      {
        rada_nreg: '4800-20',
        title:
          'Про ратифікацію Угоди між Урядом України та Урядом Республіки Польща про діяльність Bank Gospodarstwa Krajowego в Україні',
        score: 3.2,
        reasons: ['exact_title_match'],
        category: 'international_bilateral',
        document_type: 'Закон',
        document_type_slug: 'law',
      },
      {
        rada_nreg: '984_011',
        title:
          'Угода про асоціацію між Україною, з однієї сторони, та Європейським Союзом, Європейським співтовариством з атомної енергії і їхніми державами-членами, з іншої сторони',
        score: 2.1,
        reasons: ['title_match'],
        category: 'international_eu',
        document_type: 'Угода',
        document_type_slug: 'agreement',
      },
      {
        rada_nreg: 'z0841-01',
        title: 'Про затвердження Інструкції про порядок регулювання діяльності банків в Україні',
        score: 2.6,
        reasons: ['title_match'],
        category: 'finance_banking',
        document_type: 'Постанова НБУ',
        document_type_slug: 'nbu_resolution',
      },
    ],
    chunksEvidenceTopActs: [
      {
        rada_nreg: 'z0841-01',
        count_in_top30: 17,
        avg_score_in_top30: 0.63,
        max_score: 0.65,
        best_rank_in_top30: 1,
        rank_mass_top30: 3.1,
        max_ordering_score: 0.65,
      },
      {
        rada_nreg: '984_011',
        count_in_top30: 8,
        avg_score_in_top30: 0.56,
        max_score: 0.61,
        best_rank_in_top30: 8,
        rank_mass_top30: 0.79,
        max_ordering_score: 0.57,
      },
      {
        rada_nreg: '4800-20',
        count_in_top30: 1,
        avg_score_in_top30: 0.79,
        max_score: 0.79,
        best_rank_in_top30: 9,
        rank_mass_top30: 0.11,
        max_ordering_score: 0.56,
      },
    ],
    goalsSummary: [
      { goal_id: 'goal_0', goal_type: 'compliance_check', act_candidates_top3: ['4800-20', '4803-20', '4804-20'] },
      { goal_id: 'goal_1', goal_type: 'compliance_check', act_candidates_top3: ['4801-20', '984_011', '4804-20'] },
    ],
    goalSupportByAct: new Map([
      ['4800-20', new Set(['goal_0', 'goal_1'])],
      ['984_011', new Set(['goal_1'])],
      ['z0841-01', new Set(['goal_0'])],
    ]),
  });
  const selectedNregs = result.selectedActs.map((act) => act.rada_nreg);
  if (!selectedNregs.includes('4800-20')) {
    throw new Error(`Expected explicit thin law recovery to include 4800-20, got ${JSON.stringify(result.selectedActs)}`);
  }
  if (selectedNregs.includes('z0841-01')) {
    throw new Error(`Expected explicit thin law recovery to trim unrelated order noise, got ${JSON.stringify(result.selectedActs)}`);
  }
  if (!result.reasonCodes.includes('MULTI_GOAL_EXPLICIT_PRIMARY_ACT_RECOVERED')) {
    throw new Error(`Expected explicit primary act recovery reason, got ${JSON.stringify(result.reasonCodes)}`);
  }
  console.log('[OK] explicit anchored thin law recovery trims unrelated order noise');
}

function testResolveExplicitPrimaryActMultiGoalSelectionPrefersQuotedAmendmentLawOverBaseLaw(): void {
  const result = resolveExplicitPrimaryActMultiGoalSelection({
    query:
      'За Законом України «Про внесення змін до Закону України "Про наукову і науково-технічну діяльність" щодо питань дослідницької інфраструктури та підтримки молодих вчених», яких саме питань стосується цей закон про зміни?',
    documentTypeHints: ['Закон'],
    selectedActs: [
      {
        rada_nreg: '848-19',
        act_title: 'Про наукову і науково-технічну діяльність',
        act_kind: 'PRIMARY_LAW',
        category: 'education_science',
        document_type: 'Закон',
        score: 0.83,
      },
    ],
    selectedActsSourcesBreakdown: {
      from_taxonomy: [],
      from_acts_search: [],
      from_chunks_evidence: ['848-19'],
    },
    actCandidatesTop: [
      {
        rada_nreg: '848-19',
        title: 'Про наукову і науково-технічну діяльність',
        score: 4.2,
        reasons: ['title_match'],
        category: 'education_science',
        document_type: 'Закон',
        document_type_slug: 'law',
      },
      {
        rada_nreg: '4794-20',
        title:
          'Про внесення змін до Закону України "Про наукову і науково-технічну діяльність" щодо питань дослідницької інфраструктури та підтримки молодих вчених',
        score: 3.7,
        reasons: ['exact_title_match'],
        category: 'education_science',
        document_type: 'Закон',
        document_type_slug: 'law',
      },
    ],
    chunksEvidenceTopActs: [
      {
        rada_nreg: '848-19',
        count_in_top30: 8,
        avg_score_in_top30: 0.62,
        max_score: 0.71,
        best_rank_in_top30: 1,
        rank_mass_top30: 1.82,
        max_ordering_score: 0.71,
      },
      {
        rada_nreg: '4794-20',
        count_in_top30: 4,
        avg_score_in_top30: 0.69,
        max_score: 0.76,
        best_rank_in_top30: 4,
        rank_mass_top30: 0.93,
        max_ordering_score: 0.64,
      },
    ],
    goalsSummary: [
      { goal_id: 'goal_0', goal_type: 'definition', act_candidates_top3: ['848-19', '4794-20'] },
      { goal_id: 'goal_1', goal_type: 'compliance_check', act_candidates_top3: ['848-19', '4794-20'] },
    ],
    goalSupportByAct: new Map([
      ['848-19', new Set(['goal_0', 'goal_1'])],
      ['4794-20', new Set(['goal_0', 'goal_1'])],
    ]),
  });
  if (!result.allowSingleActCoverage) {
    throw new Error(`Expected quoted amendment law to allow anchored single-act coverage, got ${JSON.stringify(result)}`);
  }
  if (result.selectedActs[0]?.rada_nreg !== '4794-20') {
    throw new Error(`Expected quoted amendment title to recover 4794-20 over base law, got ${JSON.stringify(result.selectedActs)}`);
  }
  if (result.selectedActs.some((act) => act.rada_nreg === '848-19')) {
    throw new Error(`Expected quoted amendment title recovery to trim base-law fallback, got ${JSON.stringify(result.selectedActs)}`);
  }
  console.log('[OK] quoted amendment title prefers amendment law over base-law fallback');
}

function testResolveExplicitPrimaryActMultiGoalSelectionTrimsUnhintedTreatyTailForQuotedPrimaryLawLocator(): void {
  const result = resolveExplicitPrimaryActMultiGoalSelection({
    query:
      'За Законом України «Про ратифікацію Угоди між Кабінетом Міністрів України та Урядом Словацької Республіки про взаєморозуміння щодо розміщення дипломатичного представництва України в Словацькій Республіці та дипломатичного представництва Словацької Республіки в Україні», про розміщення яких саме дипломатичних представництв і між якими державами йдеться?',
    documentTypeHints: ['Закон'],
    selectedActs: [
      {
        rada_nreg: '4799-20',
        act_title:
          'Про ратифікацію Угоди між Кабінетом Міністрів України та Урядом Словацької Республіки про взаєморозуміння щодо розміщення дипломатичного представництва України в Словацькій Республіці та дипломатичного представництва Словацької Республіки в Україні',
        act_kind: 'PRIMARY_LAW',
        category: 'international_eu',
        document_type: 'Закон',
        score: 0.57,
      },
      {
        rada_nreg: '995_153',
        act_title: 'Женевська конвенція про поводження з військовополоненими',
        act_kind: 'INTERNATIONAL_TREATY',
        category: 'international_eu',
        document_type: 'Конвенція',
        score: 0.53,
      },
    ],
    selectedActsSourcesBreakdown: {
      from_taxonomy: [],
      from_acts_search: [],
      from_chunks_evidence: ['4799-20', '995_153'],
    },
    actCandidatesTop: [
      {
        rada_nreg: '4799-20',
        title:
          'Про ратифікацію Угоди між Кабінетом Міністрів України та Урядом Словацької Республіки про взаєморозуміння щодо розміщення дипломатичного представництва України в Словацькій Республіці та дипломатичного представництва Словацької Республіки в Україні',
        score: 3.4,
        reasons: ['exact_title_match'],
        category: 'international_eu',
        document_type: 'Закон',
        document_type_slug: 'law',
      },
      {
        rada_nreg: '995_153',
        title: 'Женевська конвенція про поводження з військовополоненими',
        score: 1.7,
        reasons: ['title_match'],
        category: 'international_eu',
        document_type: 'Конвенція',
        document_type_slug: 'convention',
      },
    ],
    chunksEvidenceTopActs: [
      {
        rada_nreg: '4799-20',
        count_in_top30: 1,
        avg_score_in_top30: 0.81,
        max_score: 0.81,
        best_rank_in_top30: 1,
        rank_mass_top30: 0.21,
        max_ordering_score: 0.57,
      },
      {
        rada_nreg: '995_153',
        count_in_top30: 4,
        avg_score_in_top30: 0.5,
        max_score: 0.53,
        best_rank_in_top30: 2,
        rank_mass_top30: 0.71,
        max_ordering_score: 0.51,
      },
    ],
    goalsSummary: [
      { goal_id: 'goal_0', goal_type: 'definition', act_candidates_top3: ['4799-20', '995_153'] },
      { goal_id: 'goal_1', goal_type: 'definition', act_candidates_top3: ['4799-20', '995_153'] },
    ],
    goalSupportByAct: new Map([
      ['4799-20', new Set(['goal_0', 'goal_1'])],
      ['995_153', new Set(['goal_0', 'goal_1'])],
    ]),
  });
  if (!result.allowSingleActCoverage) {
    throw new Error(`Expected quoted ratification law to keep anchored single-act coverage, got ${JSON.stringify(result)}`);
  }
  const selectedNregs = result.selectedActs.map((act) => act.rada_nreg);
  if (JSON.stringify(selectedNregs) !== JSON.stringify(['4799-20'])) {
    throw new Error(`Expected quoted ratification law to trim unhinted treaty tail, got ${JSON.stringify(result.selectedActs)}`);
  }
  if (!result.reasonCodes.includes('MULTI_GOAL_EXPLICIT_PRIMARY_TAIL_TRIMMED')) {
    throw new Error(`Expected quoted ratification law to record tail trim, got ${JSON.stringify(result.reasonCodes)}`);
  }
  console.log('[OK] quoted primary-law locator trims unhinted treaty tail');
}

function testResolveExplicitPrimaryActMultiGoalSelectionDoesNotRelaxGenericMixedBundle(): void {
  const result = resolveExplicitPrimaryActMultiGoalSelection({
    query: 'Бандитизм: визначення і яка це юрисдикція підслідність?',
    documentTypeHints: [],
    selectedActs: [
      {
        rada_nreg: '2341-14',
        act_title: 'Кримінальний кодекс України',
        act_kind: 'PRIMARY_LAW',
        category: 'criminal',
        document_type: 'Кодекс',
        score: 0.66,
      },
      {
        rada_nreg: '4651-17',
        act_title: 'Кримінальний процесуальний кодекс України',
        act_kind: 'PRIMARY_LAW',
        category: 'criminal_procedure',
        document_type: 'Кодекс',
        score: 0.61,
      },
    ],
    selectedActsSourcesBreakdown: {
      from_taxonomy: [],
      from_acts_search: [],
      from_chunks_evidence: ['2341-14', '4651-17'],
    },
    actCandidatesTop: [
      {
        rada_nreg: '2341-14',
        title: 'Кримінальний кодекс України',
        score: 2.0,
        reasons: ['title_match'],
        category: 'criminal',
        document_type: 'Кодекс',
        document_type_slug: 'code',
      },
      {
        rada_nreg: '4651-17',
        title: 'Кримінальний процесуальний кодекс України',
        score: 1.8,
        reasons: ['title_match'],
        category: 'criminal_procedure',
        document_type: 'Кодекс',
        document_type_slug: 'code',
      },
    ],
    chunksEvidenceTopActs: [
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
        count_in_top30: 7,
        avg_score_in_top30: 0.54,
        max_score: 0.58,
        best_rank_in_top30: 2,
        rank_mass_top30: 1.4,
        max_ordering_score: 0.6,
      },
    ],
    goalsSummary: [
      { goal_id: 'goal_0', goal_type: 'definition', act_candidates_top3: ['2341-14', '4651-17'] },
      { goal_id: 'goal_1', goal_type: 'procedure', act_candidates_top3: ['4651-17', '2341-14'] },
    ],
    goalSupportByAct: new Map([
      ['2341-14', new Set(['goal_0'])],
      ['4651-17', new Set(['goal_1'])],
    ]),
  });
  if (result.allowSingleActCoverage) {
    throw new Error(`Did not expect generic mixed bundle to relax into explicit single-act coverage, got ${JSON.stringify(result)}`);
  }
  console.log('[OK] explicit primary single-act relaxation does not trigger for generic mixed bundles');
}

function testResolveExplicitPrimaryActMultiGoalSelectionDoesNotRelaxUngroundedSpecialLawLocator(): void {
  const result = resolveExplicitPrimaryActMultiGoalSelection({
    query:
      'Який спеціальний закон воєнного часу дозволяє призупинення трудового договору та по-особливому регулює відпустки працівників?',
    documentTypeHints: ['Закон'],
    selectedActs: [
      {
        rada_nreg: '322-08',
        act_title: 'Кодекс законів про працю України',
        act_kind: 'PRIMARY_LAW',
        category: 'labor_social',
        document_type: 'Кодекс',
        score: 0.71,
      },
    ],
    selectedActsSourcesBreakdown: {
      from_taxonomy: [],
      from_acts_search: [],
      from_chunks_evidence: ['322-08'],
    },
    actCandidatesTop: [
      {
        rada_nreg: '322-08',
        title: 'Кодекс законів про працю України',
        score: 0.92,
        reasons: ['title_match'],
        category: 'labor_social',
        document_type: 'Кодекс',
        document_type_slug: 'code',
      },
    ],
    chunksEvidenceTopActs: [
      {
        rada_nreg: '322-08',
        count_in_top30: 12,
        avg_score_in_top30: 0.63,
        max_score: 0.71,
        best_rank_in_top30: 1,
        rank_mass_top30: 2.2,
        max_ordering_score: 0.67,
      },
    ],
    goalsSummary: [
      { goal_id: 'goal_0', goal_type: 'definition', act_candidates_top3: ['322-08'] },
      { goal_id: 'goal_1', goal_type: 'procedure', act_candidates_top3: ['322-08'] },
    ],
    goalSupportByAct: new Map([
      ['322-08', new Set(['goal_0', 'goal_1'])],
    ]),
  });
  if (result.allowSingleActCoverage) {
    throw new Error(`Expected ungrounded special-law locator to avoid generic single-act relaxation, got ${JSON.stringify(result)}`);
  }
  console.log('[OK] explicit primary relaxation stays blocked for ungrounded special-law locator queries');
}

function testResolveExplicitPrimaryActMultiGoalSelectionAllowsSemanticSpecialLawLocator(): void {
  const result = resolveExplicitPrimaryActMultiGoalSelection({
    query:
      'Який спеціальний закон воєнного часу дозволяє призупинення трудового договору та по-особливому регулює відпустки працівників?',
    documentTypeHints: ['Закон'],
    selectedActs: [
      {
        rada_nreg: '2136-20',
        act_title: 'Про організацію трудових відносин в умовах воєнного стану',
        act_kind: 'PRIMARY_LAW',
        category: 'labor_social',
        document_type: 'Закон',
        score: 0.79,
      },
    ],
    selectedActsSourcesBreakdown: {
      from_taxonomy: [],
      from_acts_search: [],
      from_chunks_evidence: ['2136-20'],
    },
    actCandidatesTop: [
      {
        rada_nreg: '2136-20',
        title: 'Про організацію трудових відносин в умовах воєнного стану',
        score: 1.18,
        reasons: ['summary_match', 'keyword_match'],
        category: 'labor_social',
        document_type: 'Закон',
        document_type_slug: 'law',
      },
    ],
    chunksEvidenceTopActs: [
      {
        rada_nreg: '2136-20',
        count_in_top30: 9,
        avg_score_in_top30: 0.68,
        max_score: 0.8,
        best_rank_in_top30: 1,
        rank_mass_top30: 2.05,
        max_ordering_score: 0.74,
      },
    ],
    goalsSummary: [
      { goal_id: 'goal_0', goal_type: 'definition', act_candidates_top3: ['2136-20'] },
      { goal_id: 'goal_1', goal_type: 'procedure', act_candidates_top3: ['2136-20'] },
    ],
    goalSupportByAct: new Map([
      ['2136-20', new Set(['goal_0', 'goal_1'])],
    ]),
  });
  if (!result.allowSingleActCoverage) {
    throw new Error(`Expected semantic special-law locator to allow single-act coverage when the act exists, got ${JSON.stringify(result)}`);
  }
  if (result.selectedActs[0]?.rada_nreg !== '2136-20') {
    throw new Error(`Expected semantic special-law locator to keep the specialized law, got ${JSON.stringify(result.selectedActs)}`);
  }
  console.log('[OK] explicit primary relaxation still allows semantic special-law locator when the target law exists');
}

function testResolveExplicitPrimaryActMultiGoalSelectionPreservesGoalDistinctPrimaryCompanion(): void {
  const result = resolveExplicitPrimaryActMultiGoalSelection({
    query: 'За Кримінальним кодексом України що таке бандитизм і хто це розслідує на практиці?',
    documentTypeHints: ['Закон'],
    selectedActs: [
      {
        rada_nreg: '2341-14',
        act_title: 'Кримінальний кодекс України',
        act_kind: 'PRIMARY_LAW',
        category: 'criminal',
        document_type: 'Кодекс',
        score: 0.68,
      },
      {
        rada_nreg: '4651-17',
        act_title: 'Кримінальний процесуальний кодекс України',
        act_kind: 'PRIMARY_LAW',
        category: 'criminal_procedure',
        document_type: 'Кодекс',
        score: 0.64,
      },
    ],
    selectedActsSourcesBreakdown: {
      from_taxonomy: [],
      from_acts_search: [],
      from_chunks_evidence: ['2341-14', '4651-17'],
    },
    actCandidatesTop: [
      {
        rada_nreg: '2341-14',
        title: 'Кримінальний кодекс України',
        score: 2.9,
        reasons: ['exact_title_match'],
        category: 'criminal',
        document_type: 'Кодекс',
        document_type_slug: 'code',
      },
      {
        rada_nreg: '4651-17',
        title: 'Кримінальний процесуальний кодекс України',
        score: 2.4,
        reasons: ['title_match'],
        category: 'criminal_procedure',
        document_type: 'Кодекс',
        document_type_slug: 'code',
      },
    ],
    chunksEvidenceTopActs: [
      {
        rada_nreg: '2341-14',
        count_in_top30: 9,
        avg_score_in_top30: 0.61,
        max_score: 0.66,
        best_rank_in_top30: 1,
        rank_mass_top30: 2.1,
        max_ordering_score: 0.66,
      },
      {
        rada_nreg: '4651-17',
        count_in_top30: 8,
        avg_score_in_top30: 0.58,
        max_score: 0.63,
        best_rank_in_top30: 2,
        rank_mass_top30: 1.85,
        max_ordering_score: 0.63,
      },
    ],
    goalsSummary: [
      { goal_id: 'goal_0', goal_type: 'definition', act_candidates_top3: ['2341-14', '4651-17'] },
      { goal_id: 'goal_1', goal_type: 'procedure', act_candidates_top3: ['4651-17', '2341-14'] },
    ],
    goalSupportByAct: new Map([
      ['2341-14', new Set(['goal_0'])],
      ['4651-17', new Set(['goal_1'])],
    ]),
  });
  const selectedNregs = result.selectedActs.map((act) => act.rada_nreg).sort();
  if (JSON.stringify(selectedNregs) !== JSON.stringify(['2341-14', '4651-17'])) {
    throw new Error(`Expected distinct-goal criminal bundle to preserve both primary acts, got ${JSON.stringify(result.selectedActs)}`);
  }
  if (result.allowSingleActCoverage) {
    throw new Error(`Expected distinct-goal criminal bundle to block single-act coverage relaxation, got ${JSON.stringify(result)}`);
  }
  if (!result.reasonCodes.includes('MULTI_GOAL_EXPLICIT_PRIMARY_COMPANION_PRESERVED')) {
    throw new Error(`Expected explicit primary companion preservation reason, got ${JSON.stringify(result.reasonCodes)}`);
  }
  console.log('[OK] explicit primary multi-goal resolution preserves a strong companion primary act with unique goal coverage');
}

function testTrimUngroundedMultiGoalFallbackSelectionCollapsesOffFamilyTwoActBundle(): void {
  const trimmed = trimUngroundedMultiGoalFallbackSelection({
    selectedActs: [
      {
        rada_nreg: '1023-12',
        act_title: 'Про захист прав споживачів',
        act_kind: 'PRIMARY_LAW',
        category: 'civil',
        document_type: 'Закон',
        score: 0.58,
      },
      {
        rada_nreg: '435-15',
        act_title: 'Цивільний кодекс України',
        act_kind: 'PRIMARY_LAW',
        category: 'civil',
        document_type: 'Кодекс',
        score: 0.52,
      },
    ],
    chunksEvidenceTopActs: [
      {
        rada_nreg: '1023-12',
        count_in_top30: 10,
        avg_score_in_top30: 0.54,
        max_score: 0.58,
        best_rank_in_top30: 1,
        rank_mass_top30: 1.71,
        max_ordering_score: 0.59,
      },
      {
        rada_nreg: '435-15',
        count_in_top30: 5,
        avg_score_in_top30: 0.49,
        max_score: 0.52,
        best_rank_in_top30: 6,
        rank_mass_top30: 0.64,
        max_ordering_score: 0.52,
      },
    ],
    goalsSummary: [
      { goal_id: 'goal_0', goal_type: 'definition' },
      { goal_id: 'goal_1', goal_type: 'procedure' },
    ],
    goalSupportByAct: new Map([
      ['1023-12', new Set(['goal_0'])],
      ['435-15', new Set(['goal_1'])],
    ]),
    domainHint: 'admin',
    mismatchSignalsPresent: true,
    maxActs: 2,
  });
  const trimmedNregs = trimmed.map((act) => act.rada_nreg);
  if (JSON.stringify(trimmedNregs) !== JSON.stringify(['1023-12'])) {
    throw new Error(`Expected off-family two-act fallback to collapse to strongest candidate, got ${JSON.stringify(trimmedNregs)}`);
  }
  console.log('[OK] ungrounded multi-goal trim collapses off-family two-act fallback');
}

function testTrimUngroundedMultiGoalFallbackSelectionPreservesUniqueMixedCoverageWhenCompatible(): void {
  const trimmed = trimUngroundedMultiGoalFallbackSelection({
    selectedActs: [
      {
        rada_nreg: '2341-14',
        act_title: 'Кримінальний кодекс України',
        act_kind: 'PRIMARY_LAW',
        category: 'criminal',
        document_type: 'Кодекс',
        score: 0.56,
      },
      {
        rada_nreg: '4651-17',
        act_title: 'Кримінальний процесуальний кодекс України',
        act_kind: 'PRIMARY_LAW',
        category: 'criminal_procedure',
        document_type: 'Кодекс',
        score: 0.53,
      },
    ],
    chunksEvidenceTopActs: [
      {
        rada_nreg: '2341-14',
        count_in_top30: 8,
        avg_score_in_top30: 0.57,
        max_score: 0.6,
        best_rank_in_top30: 2,
        rank_mass_top30: 1.31,
        max_ordering_score: 0.61,
      },
      {
        rada_nreg: '4651-17',
        count_in_top30: 7,
        avg_score_in_top30: 0.52,
        max_score: 0.56,
        best_rank_in_top30: 3,
        rank_mass_top30: 1.08,
        max_ordering_score: 0.55,
      },
    ],
    goalsSummary: [
      { goal_id: 'goal_0', goal_type: 'definition' },
      { goal_id: 'goal_1', goal_type: 'procedure' },
    ],
    goalSupportByAct: new Map([
      ['2341-14', new Set(['goal_0'])],
      ['4651-17', new Set(['goal_1'])],
    ]),
    domainHint: 'criminal',
    mismatchSignalsPresent: true,
    maxActs: 2,
  });
  const trimmedNregs = trimmed.map((act) => act.rada_nreg);
  if (JSON.stringify(trimmedNregs) !== JSON.stringify(['2341-14', '4651-17'])) {
    throw new Error(`Expected compatible mixed-goal bundle to stay intact, got ${JSON.stringify(trimmedNregs)}`);
  }
  console.log('[OK] ungrounded multi-goal trim preserves compatible unique-goal coverage');
}

function testTrimUngroundedMultiGoalFallbackSelectionPrefersUniqueGoalCoverageOverRedundantEvidence(): void {
  const trimmed = trimUngroundedMultiGoalFallbackSelection({
    selectedActs: [
      {
        rada_nreg: '1023-12',
        act_title: 'Про захист прав споживачів',
        act_kind: 'PRIMARY_LAW',
        category: 'civil',
        document_type: 'Закон',
        score: 0.57,
      },
      {
        rada_nreg: '4651-17',
        act_title: 'Кримінальний процесуальний кодекс України',
        act_kind: 'PRIMARY_LAW',
        category: 'criminal_procedure',
        document_type: 'Кодекс',
        score: 0.46,
      },
      {
        rada_nreg: '435-15',
        act_title: 'Цивільний кодекс України',
        act_kind: 'PRIMARY_LAW',
        category: 'civil',
        document_type: 'Кодекс',
        score: 0.55,
      },
    ],
    chunksEvidenceTopActs: [
      {
        rada_nreg: '1023-12',
        count_in_top30: 11,
        avg_score_in_top30: 0.53,
        max_score: 0.57,
        best_rank_in_top30: 1,
        rank_mass_top30: 1.8,
        max_ordering_score: 0.58,
      },
      {
        rada_nreg: '435-15',
        count_in_top30: 10,
        avg_score_in_top30: 0.5,
        max_score: 0.55,
        best_rank_in_top30: 2,
        rank_mass_top30: 1.62,
        max_ordering_score: 0.56,
      },
      {
        rada_nreg: '4651-17',
        count_in_top30: 5,
        avg_score_in_top30: 0.45,
        max_score: 0.47,
        best_rank_in_top30: 4,
        rank_mass_top30: 0.74,
        max_ordering_score: 0.48,
      },
    ],
    goalsSummary: [
      { goal_id: 'goal_0', goal_type: 'definition' },
      { goal_id: 'goal_1', goal_type: 'procedure' },
    ],
    goalSupportByAct: new Map([
      ['1023-12', new Set(['goal_0'])],
      ['435-15', new Set(['goal_0'])],
      ['4651-17', new Set(['goal_1'])],
    ]),
    domainHint: 'general',
    mismatchSignalsPresent: true,
    maxActs: 2,
  });
  const trimmedNregs = [...trimmed.map((act) => act.rada_nreg)].sort();
  if (JSON.stringify(trimmedNregs) !== JSON.stringify(['1023-12', '4651-17'])) {
    throw new Error(`Expected trim to keep the unique-goal pair over redundant evidence act, got ${JSON.stringify(trimmedNregs)}`);
  }
  console.log('[OK] ungrounded multi-goal trim prioritizes unique goal coverage over redundant evidence');
}

function testStrongGoalSupportedMultiPrimaryCoverageRecognizesLegitimateMixedBundle(): void {
  const ok = hasStrongGoalSupportedMultiPrimaryCoverage({
    selectedActs: [
      {
        rada_nreg: '2341-14',
        act_title: 'Кримінальний кодекс України',
        act_kind: 'PRIMARY_LAW',
        category: 'criminal',
      },
      {
        rada_nreg: '4651-17',
        act_title: 'Кримінальний процесуальний кодекс України',
        act_kind: 'PRIMARY_LAW',
        category: 'criminal_procedure',
      },
    ],
    goalsSummary: [
      { goal_id: 'goal_0', goal_type: 'definition' },
      { goal_id: 'goal_1', goal_type: 'procedure' },
    ],
    goalSupportByAct: new Map([
      ['2341-14', new Set(['goal_0'])],
      ['4651-17', new Set(['goal_1'])],
    ]),
    chunksEvidenceTopActs: [
      {
        rada_nreg: '2341-14',
        count_in_top30: 7,
        avg_score_in_top30: 0.66,
        max_score: 0.72,
        best_rank_in_top30: 1,
        rank_mass_top30: 2.2,
        max_ordering_score: 0.77,
      },
      {
        rada_nreg: '4651-17',
        count_in_top30: 6,
        avg_score_in_top30: 0.61,
        max_score: 0.65,
        best_rank_in_top30: 4,
        rank_mass_top30: 0.81,
        max_ordering_score: 0.62,
      },
    ],
    actCandidatesTop: [
      { rada_nreg: '2341-14', category: 'criminal' },
      { rada_nreg: '4651-17', category: 'criminal_procedure' },
    ],
  });
  if (!ok) {
    throw new Error('Expected strong goal-supported multi-primary coverage to be recognized');
  }
  console.log('[OK] multi-goal confidence helper recognizes legitimate mixed primary-law coverage');
}

function testStrongGoalSupportedMultiPrimaryCoverageRequiresFullGoalCoverage(): void {
  const ok = hasStrongGoalSupportedMultiPrimaryCoverage({
    selectedActs: [
      {
        rada_nreg: '2341-14',
        act_title: 'Кримінальний кодекс України',
        act_kind: 'PRIMARY_LAW',
        category: 'criminal',
      },
      {
        rada_nreg: '4651-17',
        act_title: 'Кримінальний процесуальний кодекс України',
        act_kind: 'PRIMARY_LAW',
        category: 'criminal_procedure',
      },
    ],
    goalsSummary: [
      { goal_id: 'goal_0', goal_type: 'definition' },
      { goal_id: 'goal_1', goal_type: 'procedure' },
    ],
    goalSupportByAct: new Map([
      ['2341-14', new Set(['goal_0'])],
      ['4651-17', new Set()],
    ]),
    chunksEvidenceTopActs: [
      {
        rada_nreg: '2341-14',
        count_in_top30: 7,
        avg_score_in_top30: 0.66,
        max_score: 0.72,
        best_rank_in_top30: 1,
        rank_mass_top30: 2.2,
        max_ordering_score: 0.77,
      },
      {
        rada_nreg: '4651-17',
        count_in_top30: 6,
        avg_score_in_top30: 0.61,
        max_score: 0.65,
        best_rank_in_top30: 4,
        rank_mass_top30: 0.81,
        max_ordering_score: 0.62,
      },
    ],
    actCandidatesTop: [
      { rada_nreg: '2341-14', category: 'criminal' },
      { rada_nreg: '4651-17', category: 'criminal_procedure' },
    ],
  });
  if (ok) {
    throw new Error('Did not expect confidence helper to pass without full goal coverage');
  }
  console.log('[OK] multi-goal confidence helper requires full goal coverage');
}

function testStrongGoalSupportedMultiPrimaryCoverageRejectsIncompatibleThreeFamilyBundle(): void {
  const ok = hasStrongGoalSupportedMultiPrimaryCoverage({
    selectedActs: [
      {
        rada_nreg: '2755-17',
        act_title: 'Податковий кодекс України',
        act_kind: 'PRIMARY_LAW',
        category: 'tax_customs',
      },
      {
        rada_nreg: '2947-14',
        act_title: 'Сімейний кодекс України',
        act_kind: 'PRIMARY_LAW',
        category: 'civil',
      },
      {
        rada_nreg: '4651-17',
        act_title: 'Кримінальний процесуальний кодекс України',
        act_kind: 'PRIMARY_LAW',
        category: 'criminal_procedure',
      },
    ],
    goalsSummary: [
      { goal_id: 'goal_0', goal_type: 'definition' },
      { goal_id: 'goal_1', goal_type: 'definition' },
    ],
    goalSupportByAct: new Map([
      ['2755-17', new Set(['goal_0'])],
      ['2947-14', new Set(['goal_1'])],
      ['4651-17', new Set(['goal_1'])],
    ]),
    chunksEvidenceTopActs: [
      {
        rada_nreg: '2755-17',
        count_in_top30: 6,
        avg_score_in_top30: 0.62,
        max_score: 0.69,
        best_rank_in_top30: 1,
        rank_mass_top30: 1.7,
        max_ordering_score: 0.71,
      },
      {
        rada_nreg: '2947-14',
        count_in_top30: 5,
        avg_score_in_top30: 0.58,
        max_score: 0.63,
        best_rank_in_top30: 4,
        rank_mass_top30: 0.82,
        max_ordering_score: 0.6,
      },
      {
        rada_nreg: '4651-17',
        count_in_top30: 5,
        avg_score_in_top30: 0.57,
        max_score: 0.61,
        best_rank_in_top30: 5,
        rank_mass_top30: 0.74,
        max_ordering_score: 0.59,
      },
    ],
    actCandidatesTop: [
      { rada_nreg: '2755-17', category: 'tax_customs' },
      { rada_nreg: '2947-14', category: 'civil' },
      { rada_nreg: '4651-17', category: 'criminal_procedure' },
    ],
  });
  if (ok) {
    throw new Error('Did not expect incompatible three-family bundle to count as strong multi-primary coverage');
  }
  console.log('[OK] multi-goal confidence helper rejects incompatible three-family bundles');
}

function testShouldFlagUngroundedMultiGoalFallbackOnChunksOnlyBroadPrimarySelection(): void {
  const flagged = shouldFlagUngroundedMultiGoalFallback({
    domainHint: 'general',
    goalsSummary: [
      { goal_id: 'goal_0', goal_type: 'definition' },
      { goal_id: 'goal_1', goal_type: 'definition' },
    ],
    selectedActs: [
      {
        rada_nreg: '1023-12',
        act_title: 'Про захист прав споживачів',
        act_kind: 'PRIMARY_LAW',
        category: 'civil',
      },
      {
        rada_nreg: '435-15',
        act_title: 'Цивільний кодекс України',
        act_kind: 'PRIMARY_LAW',
        category: 'civil',
      },
    ],
    goalSupportByAct: new Map(),
    selectedActsSourcesBreakdown: {
      from_taxonomy: [],
      from_acts_search: [],
      from_chunks_evidence: ['1023-12', '435-15'],
    },
    topScore: 0.57,
    mismatchSignalsPresent: true,
  });
  if (!flagged) {
    throw new Error('Expected chunks-only broad multi-goal primary fallback to be flagged as ungrounded');
  }
  console.log('[OK] multi-goal confidence helper flags ungrounded chunks-only broad primary fallback');
}

function testShouldFlagUngroundedMultiGoalFallbackOnIncompatibleGoalCoveredBundle(): void {
  const flagged = shouldFlagUngroundedMultiGoalFallback({
    domainHint: 'general',
    goalsSummary: [
      { goal_id: 'goal_0', goal_type: 'definition' },
      { goal_id: 'goal_1', goal_type: 'definition' },
    ],
    selectedActs: [
      {
        rada_nreg: '3543-12',
        act_title: 'Про мобілізаційну підготовку та мобілізацію',
        act_kind: 'PRIMARY_LAW',
        category: 'defense_mobilization',
      },
      {
        rada_nreg: '4651-17',
        act_title: 'Кримінальний процесуальний кодекс України',
        act_kind: 'PRIMARY_LAW',
        category: 'criminal_procedure',
      },
    ],
    goalSupportByAct: new Map([
      ['3543-12', new Set(['goal_0'])],
      ['4651-17', new Set(['goal_1'])],
    ]),
    selectedActsSourcesBreakdown: {
      from_taxonomy: [],
      from_acts_search: [],
      from_chunks_evidence: ['3543-12', '4651-17'],
    },
    topScore: 0.61,
    mismatchSignalsPresent: true,
  });
  if (!flagged) {
    throw new Error('Expected incompatible chunk-only goal-covered bundle to be flagged as ungrounded fallback');
  }
  console.log('[OK] multi-goal confidence helper flags incompatible chunk-only goal-covered bundles');
}

function testShouldFlagUngroundedMultiGoalFallbackOnExplicitActScopedChunksOnlyBundle(): void {
  const flagged = shouldFlagUngroundedMultiGoalFallback({
    domainHint: 'administrative',
    goalsSummary: [
      { goal_id: 'goal_0', goal_type: 'definition' },
      { goal_id: 'goal_1', goal_type: 'procedure' },
    ],
    selectedActs: [
      {
        rada_nreg: '1618-15',
        act_title: 'Про звернення громадян',
        act_kind: 'PRIMARY_LAW',
        category: 'administrative',
      },
      {
        rada_nreg: '2747-15',
        act_title: 'Кодекс адміністративного судочинства України',
        act_kind: 'PRIMARY_LAW',
        category: 'judiciary_justice',
      },
      {
        rada_nreg: '80731-10',
        act_title: 'Податковий кодекс України',
        act_kind: 'PRIMARY_LAW',
        category: 'tax_customs',
      },
    ],
    goalSupportByAct: new Map([
      ['1618-15', new Set(['goal_0'])],
      ['2747-15', new Set(['goal_1'])],
      ['80731-10', new Set(['goal_1'])],
    ]),
    selectedActsSourcesBreakdown: {
      from_taxonomy: [],
      from_acts_search: [],
      from_chunks_evidence: ['1618-15', '2747-15', '80731-10'],
    },
    topScore: 0.59,
    mismatchSignalsPresent: false,
    metadataGroundedActCount: 0,
    explicitActScopeCue: true,
  });
  if (!flagged) {
    throw new Error('Expected explicit act-scoped multi-goal chunks-only bundle without grounding to be flagged');
  }
  console.log('[OK] multi-goal confidence helper flags explicit act-scoped chunks-only fallback without grounding');
}

function testShouldFlagUngroundedMultiGoalFallbackOnThreeFamilyChunksOnlyBundleWithoutMismatchSignal(): void {
  const flagged = shouldFlagUngroundedMultiGoalFallback({
    domainHint: 'general',
    goalsSummary: [
      { goal_id: 'goal_0', goal_type: 'definition' },
      { goal_id: 'goal_1', goal_type: 'definition' },
    ],
    selectedActs: [
      {
        rada_nreg: '2755-17',
        act_title: 'Податковий кодекс України',
        act_kind: 'PRIMARY_LAW',
        category: 'tax_customs',
      },
      {
        rada_nreg: '2947-14',
        act_title: 'Сімейний кодекс України',
        act_kind: 'PRIMARY_LAW',
        category: 'civil',
      },
      {
        rada_nreg: '4651-17',
        act_title: 'Кримінальний процесуальний кодекс України',
        act_kind: 'PRIMARY_LAW',
        category: 'criminal_procedure',
      },
    ],
    goalSupportByAct: new Map([
      ['2755-17', new Set(['goal_0'])],
      ['2947-14', new Set(['goal_0'])],
      ['4651-17', new Set(['goal_1'])],
    ]),
    selectedActsSourcesBreakdown: {
      from_taxonomy: [],
      from_acts_search: [],
      from_chunks_evidence: ['2755-17', '2947-14', '4651-17'],
    },
    topScore: 0.58,
    mismatchSignalsPresent: false,
  });
  if (!flagged) {
    throw new Error('Expected three-family chunk-only bundle to be flagged even without explicit mismatch signal');
  }
  console.log('[OK] multi-goal confidence helper flags three-family chunk-only bundles without explicit mismatch signal');
}

function testShouldNotFlagUngroundedMultiGoalFallbackWhenGoalCoverageIsReal(): void {
  const flagged = shouldFlagUngroundedMultiGoalFallback({
    domainHint: 'general',
    goalsSummary: [
      { goal_id: 'goal_0', goal_type: 'definition' },
      { goal_id: 'goal_1', goal_type: 'procedure' },
    ],
    selectedActs: [
      {
        rada_nreg: '2341-14',
        act_title: 'Кримінальний кодекс України',
        act_kind: 'PRIMARY_LAW',
        category: 'criminal',
      },
      {
        rada_nreg: '4651-17',
        act_title: 'Кримінальний процесуальний кодекс України',
        act_kind: 'PRIMARY_LAW',
        category: 'criminal_procedure',
      },
    ],
    goalSupportByAct: new Map([
      ['2341-14', new Set(['goal_0'])],
      ['4651-17', new Set(['goal_1'])],
    ]),
    selectedActsSourcesBreakdown: {
      from_taxonomy: [],
      from_acts_search: [],
      from_chunks_evidence: ['2341-14', '4651-17'],
    },
    topScore: 0.57,
    mismatchSignalsPresent: true,
  });
  if (flagged) {
    throw new Error('Did not expect legitimate mixed-goal coverage to be flagged as ungrounded fallback');
  }
  console.log('[OK] multi-goal confidence helper keeps legitimate mixed-goal primary coverage');
}

function testShouldNotFlagUngroundedMultiGoalFallbackWhenDefinitionGoalsAreCovered(): void {
  const flagged = shouldFlagUngroundedMultiGoalFallback({
    domainHint: 'general',
    goalsSummary: [
      { goal_id: 'goal_0', goal_type: 'definition' },
      { goal_id: 'goal_1', goal_type: 'definition' },
    ],
    selectedActs: [
      {
        rada_nreg: '1023-12',
        act_title: 'Про захист прав споживачів',
        act_kind: 'PRIMARY_LAW',
        category: 'civil',
      },
      {
        rada_nreg: '435-15',
        act_title: 'Цивільний кодекс України',
        act_kind: 'PRIMARY_LAW',
        category: 'civil',
      },
    ],
    goalSupportByAct: new Map([
      ['1023-12', new Set(['goal_0'])],
      ['435-15', new Set(['goal_1'])],
    ]),
    selectedActsSourcesBreakdown: {
      from_taxonomy: [],
      from_acts_search: [],
      from_chunks_evidence: ['1023-12', '435-15'],
    },
    topScore: 0.57,
    mismatchSignalsPresent: true,
  });
  if (flagged) {
    throw new Error('Did not expect fully covered definition-goal bundle to be flagged as ungrounded fallback');
  }
  console.log('[OK] multi-goal confidence helper keeps covered definition-goal bundles');
}

function testShouldNotFlagUngroundedMultiGoalFallbackForStrongSingleActProceduralBundle(): void {
  const flagged = shouldFlagUngroundedMultiGoalFallback({
    domainHint: 'criminal',
    goalsSummary: [
      { goal_id: 'goal_0', goal_type: 'procedure' },
      { goal_id: 'goal_1', goal_type: 'definition' },
    ],
    selectedActs: [
      {
        rada_nreg: '4651-17',
        act_title: 'Кримінальний процесуальний кодекс України',
        act_kind: 'PRIMARY_LAW',
        category: 'criminal_procedure',
      },
    ],
    goalSupportByAct: new Map([
      ['4651-17', new Set(['goal_0', 'goal_1'])],
    ]),
    selectedActsSourcesBreakdown: {
      from_taxonomy: [],
      from_acts_search: [],
      from_chunks_evidence: ['4651-17'],
    },
    topScore: 0.56,
    mismatchSignalsPresent: true,
    explicitActScopeCue: false,
  });
  if (flagged) {
    throw new Error('Did not expect strong same-act procedural bundle to be flagged as ungrounded fallback');
  }
  console.log('[OK] multi-goal confidence helper keeps strong same-act procedural bundles');
}

function testShouldFlagUngroundedMultiGoalFallbackWhenSameFamilyBundleMasksStrongSecondaryCompetition(): void {
  const flagged = shouldFlagUngroundedMultiGoalFallback({
    domainHint: 'general',
    goalsSummary: [
      { goal_id: 'goal_0', goal_type: 'definition' },
      { goal_id: 'goal_1', goal_type: 'definition' },
    ],
    selectedActs: [
      {
        rada_nreg: '1023-12',
        act_title: 'Про захист прав споживачів',
        act_kind: 'PRIMARY_LAW',
        category: 'civil',
      },
      {
        rada_nreg: '435-15',
        act_title: 'Цивільний кодекс України',
        act_kind: 'PRIMARY_LAW',
        category: 'civil',
      },
    ],
    goalSupportByAct: new Map([
      ['1023-12', new Set(['goal_0'])],
      ['435-15', new Set(['goal_1'])],
    ]),
    selectedActsSourcesBreakdown: {
      from_taxonomy: [],
      from_acts_search: [],
      from_chunks_evidence: ['1023-12', '435-15'],
    },
    topScore: 0.57,
    mismatchSignalsPresent: true,
    secondaryFamilySupportScore: 0.47,
  });
  if (!flagged) {
    throw new Error('Expected same-family covered bundle with strong secondary-family competition to be flagged');
  }
  console.log('[OK] multi-goal confidence helper flags same-family covered bundle when strong secondary-family competition remains');
}

function testShouldFlagUngroundedMultiGoalFallbackWhenSpecificDomainMapsToOffFamilyActs(): void {
  const flagged = shouldFlagUngroundedMultiGoalFallback({
    domainHint: 'admin',
    goalsSummary: [
      { goal_id: 'goal_0', goal_type: 'definition' },
      { goal_id: 'goal_1', goal_type: 'procedure' },
    ],
    selectedActs: [
      {
        rada_nreg: '1023-12',
        act_title: 'Про захист прав споживачів',
        act_kind: 'PRIMARY_LAW',
        category: 'civil',
      },
      {
        rada_nreg: '435-15',
        act_title: 'Цивільний кодекс України',
        act_kind: 'PRIMARY_LAW',
        category: 'civil',
      },
    ],
    goalSupportByAct: new Map([
      ['1023-12', new Set(['goal_0'])],
      ['435-15', new Set(['goal_1'])],
    ]),
    selectedActsSourcesBreakdown: {
      from_taxonomy: [],
      from_acts_search: ['1023-12', '435-15'],
      from_chunks_evidence: ['1023-12', '435-15'],
    },
    topScore: 0.58,
    mismatchSignalsPresent: true,
  });
  if (!flagged) {
    throw new Error('Expected specific-domain off-family acts_search fallback to be flagged as ungrounded');
  }
  console.log('[OK] multi-goal confidence helper flags specific-domain off-family fallback');
}

function testShouldFlagUngroundedMultiGoalFallbackWhenOnlyTaxonomyBacksBroadOffFamilyBundle(): void {
  const flagged = shouldFlagUngroundedMultiGoalFallback({
    domainHint: 'admin',
    goalsSummary: [
      { goal_id: 'goal_0', goal_type: 'definition' },
      { goal_id: 'goal_1', goal_type: 'procedure' },
    ],
    selectedActs: [
      {
        rada_nreg: '3543-12',
        act_title: 'Про мобілізаційну підготовку та мобілізацію',
        act_kind: 'PRIMARY_LAW',
        category: 'defense_mobilization',
      },
      {
        rada_nreg: '389-2003-п',
        act_title: 'Порядок бронювання військовозобов’язаних',
        act_kind: 'PRIMARY_LAW',
        category: 'defense_mobilization',
      },
    ],
    goalSupportByAct: new Map([
      ['3543-12', new Set(['goal_0'])],
      ['389-2003-п', new Set(['goal_1'])],
    ]),
    selectedActsSourcesBreakdown: {
      from_taxonomy: ['3543-12', '389-2003-п'],
      from_acts_search: [],
      from_chunks_evidence: ['3543-12', '389-2003-п'],
    },
    topScore: 0.58,
    mismatchSignalsPresent: true,
    exactActHitCount: 0,
    groundedActHitCount: 0,
  });
  if (!flagged) {
    throw new Error('Expected taxonomy-backed but ungrounded off-family bundle to stay flagged as ungrounded fallback');
  }
  console.log('[OK] multi-goal confidence helper keeps taxonomy-only off-family bundles flagged without indexed grounding');
}

function testShouldNotFlagUngroundedMultiGoalFallbackWhenExactIndexedGroundingExists(): void {
  const flagged = shouldFlagUngroundedMultiGoalFallback({
    domainHint: 'admin',
    goalsSummary: [
      { goal_id: 'goal_0', goal_type: 'definition' },
      { goal_id: 'goal_1', goal_type: 'procedure' },
    ],
    selectedActs: [
      {
        rada_nreg: '3543-12',
        act_title: 'Про мобілізаційну підготовку та мобілізацію',
        act_kind: 'PRIMARY_LAW',
        category: 'defense_mobilization',
      },
      {
        rada_nreg: '389-2003-п',
        act_title: 'Порядок бронювання військовозобов’язаних',
        act_kind: 'PRIMARY_LAW',
        category: 'defense_mobilization',
      },
    ],
    goalSupportByAct: new Map([
      ['3543-12', new Set(['goal_0'])],
      ['389-2003-п', new Set(['goal_1'])],
    ]),
    selectedActsSourcesBreakdown: {
      from_taxonomy: ['3543-12', '389-2003-п'],
      from_acts_search: [],
      from_chunks_evidence: ['3543-12', '389-2003-п'],
    },
    topScore: 0.58,
    mismatchSignalsPresent: true,
    exactActHitCount: 1,
    groundedActHitCount: 0,
  });
  if (flagged) {
    throw new Error('Did not expect exact indexed grounding to be treated as ungrounded multi-goal fallback');
  }
  console.log('[OK] multi-goal confidence helper does not flag bundles with exact indexed grounding');
}

function testSkipMultiGoalVariantSearchOnStrongPerGoalCoverage(): void {
  const ok = shouldSkipMultiGoalVariantSearch({
    goalsSummary: [
      { goal_id: 'goal_0', hits_count: 9, top_score: 0.58, required_categories: ['criminal'] },
      { goal_id: 'goal_1', hits_count: 8, top_score: 0.53, required_categories: ['criminal_procedure'] },
    ],
    goalSupportByAct: new Map([
      ['2341-14', new Set(['goal_0'])],
      ['4651-17', new Set(['goal_1'])],
    ]),
    supportedActs: [
      { rada_nreg: '2341-14', act_kind: 'PRIMARY_LAW', category: 'criminal' },
      { rada_nreg: '4651-17', act_kind: 'PRIMARY_LAW', category: 'criminal_procedure' },
    ],
  });
  if (!ok) {
    throw new Error('Expected multi-goal variant search to be skipped when per-goal coverage is already strong');
  }
  console.log('[OK] multi-goal variant search is skipped on strong per-goal coverage');
}

function testSkipMultiGoalVariantSearchRequiresMaterialCoverage(): void {
  const ok = shouldSkipMultiGoalVariantSearch({
    goalsSummary: [
      { goal_id: 'goal_0', hits_count: 9, top_score: 0.58, required_categories: ['criminal'] },
      { goal_id: 'goal_1', hits_count: 2, top_score: 0.31, required_categories: ['criminal_procedure'] },
    ],
    goalSupportByAct: new Map([
      ['2341-14', new Set(['goal_0'])],
      ['4651-17', new Set(['goal_1'])],
    ]),
    supportedActs: [
      { rada_nreg: '2341-14', act_kind: 'PRIMARY_LAW', category: 'criminal' },
      { rada_nreg: '4651-17', act_kind: 'PRIMARY_LAW', category: 'criminal_procedure' },
    ],
  });
  if (ok) {
    throw new Error('Did not expect multi-goal variant search skip without material per-goal coverage');
  }
  console.log('[OK] multi-goal variant search still runs when a goal remains weak');
}

function testSkipMultiGoalVariantSearchRequiresPrimaryLawCoverage(): void {
  const ok = shouldSkipMultiGoalVariantSearch({
    goalsSummary: [
      { goal_id: 'goal_0', hits_count: 9, top_score: 0.58, required_categories: ['criminal'] },
      { goal_id: 'goal_1', hits_count: 8, top_score: 0.53, required_categories: ['criminal_procedure'] },
    ],
    goalSupportByAct: new Map([
      ['2341-14', new Set(['goal_0'])],
      ['995_004', new Set(['goal_1'])],
    ]),
    supportedActs: [
      { rada_nreg: '2341-14', act_kind: 'PRIMARY_LAW', category: 'criminal' },
      { rada_nreg: '995_004', act_kind: 'INTERNATIONAL_TREATY', category: 'international_treaty' },
    ],
  });
  if (ok) {
    throw new Error('Did not expect multi-goal variant search skip when one goal is covered only by non-primary law');
  }
  console.log('[OK] multi-goal variant search requires primary-law goal coverage');
}

function testSkipMultiGoalVariantSearchRequiresCategoryAlignment(): void {
  const ok = shouldSkipMultiGoalVariantSearch({
    goalsSummary: [
      { goal_id: 'goal_0', hits_count: 9, top_score: 0.58, required_categories: ['criminal'] },
      { goal_id: 'goal_1', hits_count: 8, top_score: 0.53, required_categories: ['criminal_procedure'] },
    ],
    goalSupportByAct: new Map([
      ['2341-14', new Set(['goal_0'])],
      ['1618-15', new Set(['goal_1'])],
    ]),
    supportedActs: [
      { rada_nreg: '2341-14', act_kind: 'PRIMARY_LAW', category: 'criminal' },
      { rada_nreg: '1618-15', act_kind: 'PRIMARY_LAW', category: 'civil_procedure' },
    ],
  });
  if (ok) {
    throw new Error('Did not expect multi-goal variant search skip when procedural coverage is off-family');
  }
  console.log('[OK] multi-goal variant search requires category-aligned goal coverage');
}

function testSkipMultiGoalVariantSearchRequiresExplicitGoalCategories(): void {
  const ok = shouldSkipMultiGoalVariantSearch({
    goalsSummary: [
      { goal_id: 'goal_0', hits_count: 9, top_score: 0.58 },
      { goal_id: 'goal_1', hits_count: 8, top_score: 0.53, required_categories: ['criminal_procedure'] },
    ],
    goalSupportByAct: new Map([
      ['2341-14', new Set(['goal_0'])],
      ['4651-17', new Set(['goal_1'])],
    ]),
    supportedActs: [
      { rada_nreg: '2341-14', act_kind: 'PRIMARY_LAW', category: 'criminal' },
      { rada_nreg: '4651-17', act_kind: 'PRIMARY_LAW', category: 'criminal_procedure' },
    ],
  });
  if (ok) {
    throw new Error('Did not expect multi-goal variant search skip without explicit categories for every goal');
  }
  console.log('[OK] multi-goal variant search requires explicit categories for every goal');
}

function testPreferEvidenceBackedGoalSupportUsesHitBackedSignalsWhenAvailable(): void {
  const result = preferEvidenceBackedGoalSupport(
    new Map([
      ['2341-14', new Set(['goal_0'])],
      ['4651-17', new Set(['goal_1'])],
    ]),
    new Map([
      ['2341-14', new Set(['goal_0'])],
      ['995_004', new Set(['goal_1'])],
    ])
  );
  const keys = [...result.keys()].sort();
  if (JSON.stringify(keys) !== JSON.stringify(['2341-14', '4651-17'])) {
    throw new Error(`Expected hit-backed goal support map to win, got ${JSON.stringify(keys)}`);
  }
  console.log('[OK] preferred goal support uses hit-backed signals when available');
}

function testPreferEvidenceBackedGoalSupportFallsBackToSummaryWhenHitsAreEmpty(): void {
  const result = preferEvidenceBackedGoalSupport(
    new Map(),
    new Map([
      ['2947-14', new Set(['goal_0'])],
      ['435-15', new Set(['goal_1'])],
    ])
  );
  const keys = [...result.keys()].sort();
  if (JSON.stringify(keys) !== JSON.stringify(['2947-14', '435-15'])) {
    throw new Error(`Expected summary-derived goal support fallback, got ${JSON.stringify(keys)}`);
  }
  console.log('[OK] preferred goal support falls back to summary support when hit-backed signals are absent');
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
  testGoalSplitKeepsSingleQuestionCoordinatedObjectBundleAsOneGoal();
  testGoalSplitKeepsAnchoredActTitleWithInternalConjunctionAsSingleGoal();
  testGoalSplitKeepsCompactTitleFragmentWithInternalConjunctionAsSingleGoal();
  testGoalSplitKeepsQuotedRatificationTitleWithInternalConjunctionAsSingleGoal();
  testGoalSplitKeepsQuotedRatificationTitleSingleGoalWhenContractLike();
  testExplicitActScopeCueCoversStructuredIdsAndSubordinateActs();
  testStrongActScopeCueCountDistinguishesSingleAndMixedActScope();
  testGoalSplitDoesNotCompactMixedActScopeBundle();
  testGoalSplitCompactsSingleStrongActScopeBundle();
  testGoalSplitCompactsActMetadataBundle();
  testGoalSplitCompactsActMetadataBundleWithNeuterLocator();
  testGoalSplitCompactsProfileLawMetadataBundle();
  testGoalSplitCompactsRepealOrderMetadataBundle();
  testGoalSplitDoesNotCompactActLocatorWithSubstantiveProcedureBundle();
  testGoalSplitDoesNotCompactActMetadataBundleWithProceduralRemedyFollowUp();
  testGoalSplitDoesNotCompactGroundedSameActSubstanceProcedureBundle();
  testGoalSplitDoesNotOverSplitSelectorBundleOnGenericDeadlineWording();
  testGoalSplitCarriesSubjectIntoProceduralQuestion();
  testGoalSplitCarriesSubjectIntoYesNoFollowUp();
  testGoalSplitCarriesActorSubjectIntoPoliceFollowUp();
  testGoalSplitCarriesActorSubjectIntoLaborNeedFollowUp();
  testGoalSplitAddsSpecificTaxAppealSignals();
  testGoalSplitCompactsExplicitActBundleAcrossQuestions();
  testGoalSplitCompactsExplicitActClauseBundle();
  testGoalSplitCompactsProceduralBundleWithDocumentsFollowUp();
  testCategoryClusterSplitSkipsGroundedSingleAct();
  testCategoryClusterSplitSkipsDominantTitleFragmentSingleAct();
  testCategoryClusterSplitSkipsQuotedExplicitLawTitleScope();
  testGoalSplitMarksProceduralSingleGoal();
  testGoalSplitCompactsProceduralBundleWithAnaphora();
  testGoalSplitCompactsProceduralBundleWithSharedProcessReference();
  testGoalSplitCompactsSameActNormBundle();
  testGoalSplitAddsErdrProceduralSignal();
  testGoalSplitCompactsErdrComplaintBundle();
  testGoalSplitCompactsErdrCourtDeadlineBundle();
  testTagLegalDomainTreatsErdrAsCriminalCue();
  testActPlannerTierSkipsSingleGoalWhenTaxonomySignalExists();
  testActPlannerTierUsesTierOneWhenSignalsAreMissing();
  testActPlannerTierKeepsTierTwoForMultiGoal();
  testStrongTaxonomySignalHelperMatchesSingleGoalPolicy();
  await testTaxonomyGroundsSingleLogicalActFamilyFromExactAlias();
  await testTaxonomyGroundsRepealOrderByDerivedTitleAlias();
  await testTaxonomyPrefersInForceLogicalActSuccessorForTruncatedQuotedLawTitle();
  testStrongTaxonomySignalTreatsExactActHitAsStrong();
  testStrongTaxonomySignalTreatsGroundedAliasAsStrong();
  testStrongTaxonomySignalRejectsCalendarScopedVolumeWithoutGrounding();
  testStrongTaxonomySignalRejectsFuzzyAliasVolumeOnly();
  testDomainHintAlignedFamilyHelper();
  testSingleGoalFirstPassPlanSkipsActsSearchOnStrongTaxonomySignal();
  testSingleGoalFirstPassPlanKeepsActsSearchWhenTaxonomyWeak();
  testSingleGoalFirstPassPlanKeepsActsSearchForDescriptiveActTitleScope();
  testSingleGoalFirstPassPlanKeepsActsSearchForCalendarScopedTaxonomyVolume();
  testSingleGoalFirstPassPlanKeepsActsSearchOnFuzzyAliasVolumeOnly();
  testSingleGoalFirstPassPlanRespectsExplicitChunksOnlyRequest();
  testSingleGoalFirstPassPlanPreservesExplicitActsOnlyRequest();
  testReferenceExpansionSkipForStrongHeadCoverage();
  testReferenceExpansionDoesNotSkipOnExplicitSelectors();
  testExtractActSearchNregsFromHitsUsesOnlyActSearchHits();
  testExtractChunkEvidenceNregsFromHitsRanksByRepeatedChunkEvidence();
  testSummarizeChunkEvidenceActsCapturesStrongHeadConsensus();
  testBuildWithinActPoolPrefersTaxonomyWhenHintsExist();
  testBuildWithinActPoolCanPreferChunkEvidenceOnStrongRuns();
  testBuildWithinActPoolPrioritizesGroundedSingleAct();
  testBuildWithinActPoolPrefersTaxonomyForExplicitActScopeQueries();
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
  testWithinActExpansionCompactsGroundedStructuralSingleActQueries();
  testWithinActExpansionSupportsExplicitActScopeWithoutExactGrounding();
  testWithinActExpansionCollapsesExplicitActScopeOnStrongHeadConsensus();
  testWithinActExpansionSupportsGroundedDescriptiveActTitleQueries();
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
  testDocumentTypeHintMatchesSupportsSlugHints();
  await testTaxonomyKeywordTopicNotInScore();
  await testFindActByTitleFragmentExport();
  await testFindActByTitleFragmentRecoversLongOfficialTitleVariant();
  await testFindActByTitleFragmentUsesFullQueryDateToResolveRecurringSeriesAmbiguity();
  await testFindActByTitleFragmentRecoversCurrencyRateAliasVariant();
  await testQuotedActTitleFragmentsSupportGroundingSignals();
  testQuotedActTitleFragmentsRemainStableAcrossCallsForShortLawTitles();
  testQuotedActTitleFragmentsPreserveOuterNestedQuotedLawTitles();
  testApproximateGroundingSkipsQuotedAnchoredActTitles();
  await testDocsOnlyNoSemanticPlanIsNotMarkedDegraded();
  testChunkStructuralScorePrefersBaseArticleTitle();
  testOrderingScoreBeatsRawVectorScore();
  testHybridOrderingPrefersGroundedActSearchHitForTitleLocator();
  testDiscriminativeStructuralScorePrefersMobilizationArticle();
  testStructuralScoreRemainsFiniteWhenMatchesAppearOutOfOrder();
  testStructuralScoreSoftensZeroOverlapPenaltyForStrongArticleHits();
  testStructuralScorePrefersProceduralAnchorArticleTitle();
  testStructuralScorePrefersExplicitPointCitation();
  testStructuralScoreDemotesWrongPointEvenWithLexicalOverlap();
  testSingleGoalSelectedActsTailTrim();
  testSelectedActsTrimNonPrimaryOnlyTailAndLowerConfidence();
  testCoverageGapTreatsNoPrimaryLawAsWeakEvidence();
  testSingleGoalDegradedTraceMarksWeakEvidenceHonestly();
  testNormalizeSingleGoalLowConfidenceSelectionClearsOutOfScopeNoise();
  testNormalizeSingleGoalLowConfidenceSelectionKeepsSingleDomainAlignedPrimaryLaw();
  testNormalizeSingleGoalLowConfidenceSelectionKeepsDominantDomainAlignedProceduralPrimaryLaw();
  testShouldConfirmSoftProceduralSingleAct();
  testShouldConfirmSoftPrimarySingleAct();
  testNormalizeSingleGoalLowConfidenceSelectionClearsExplicitScopeFallbackNoise();
  testNormalizeSingleGoalLowConfidenceSelectionPreservesStrongFamilyCivilBundle();
  testNormalizeSingleGoalLowConfidenceSelectionPreservesTaxonomyBackedCivilBundle();
  testNormalizeSingleGoalLowConfidenceSelectionRecoversCompanionFromActCandidates();
  testNormalizeSingleGoalLowConfidenceSelectionNarrowsMetadataCompanionFallback();
  await testResolveSingleGoalSelectedActsConfirmsExplicitNonPrimaryScope();
  await testResolveSingleGoalSelectedActsClearsOutOfScopeForExactActScope();
  await testResolveSingleGoalSelectedActsRecoversExplicitIdentifierFromTailEvidence();
  await testResolveSingleGoalSelectedActsRecoversGroundedDescriptiveSubordinateAct();
  await testResolveSingleGoalSelectedActsPreservesProceduralPrimarySupportForGroundedMixedBundle();
  await testResolveSingleGoalSelectedActsPreservesExplicitHintedNonPrimarySupportForGroundedBundle();
  await testResolveSingleGoalSelectedActsPreservesTitleAnchoredNonPrimarySupportWithoutDocumentHints();
  await testResolveSingleGoalSelectedActsDoesNotPreserveProceduralSupportOnGenericDeadlineWording();
  await testResolveSingleGoalSelectedActsRecoversMetadataGroundedExplicitSubordinateAct();
  await testResolveSingleGoalSelectedActsRecoversAnchoredDescriptiveSubordinateAct();
  await testResolveSingleGoalSelectedActsKeepsGroundedSubordinateActAsWeakEvidenceWhenChunksMiss();
  await testResolveSingleGoalSelectedActsFlagsUngroundedGeneralMultiFamilySelection();
  await testResolveSingleGoalSelectedActsRecoversEvidenceDominantExplicitActScope();
  await testResolveSingleGoalSelectedActsRecoversSpecialLawLocatorFromCoverageWeightedEvidence();
  await testResolveSingleGoalSelectedActsKeepsShortExplicitLawTitleWhenMetadataAndChunksConverge();
  await testResolveSingleActScopeSelectionRecoversAnchorWhenOnlyHintedSupportActRemains();
  await testResolveSingleActScopeSelectionRejectsUntrustedGroundedPersonnelOrder();
  await testResolveSingleActScopeSelectionRecoversGroundedRepealOrderWithTrustedDateNumberIdentity();
  await testResolveSingleGoalSelectedActsPrefersDominantEvidenceOverSemanticNeighborMetadataScope();
  await testResolveSingleGoalSelectedActsPrefersEarlyRankMassLawOverCoverageTailForSoftLocator();
  await testResolveSingleGoalSelectedActsRecoversInterrogativePrimaryLawLocatorAfterLowConfidenceNarrowing();
  await testResolveSingleGoalSelectedActsRejectsCalendarScopedRecurringActWithoutUniqueConvergence();
  await testResolveSingleGoalSelectedActsRecoversCalendarScopedRecurringActWithUniqueDateMatch();
  await testResolveSingleGoalSelectedActsRejectsDomainAlignedPrimaryFallbackForAbsentExplicitLawTitle();
  await testResolveSingleGoalSelectedActsRejectsSupportOnlySecondaryActForAbsentExplicitLawTitle();
  await testResolveSingleGoalSelectedActsRecoversSoftNonPrimaryAmendmentOrderAfterExplicitScopeClear();
  await testResolveSingleGoalSelectedActsRecoversDateScopedRecurringNonPrimaryActAfterFrameworkDrift();
  await testResolveSingleGoalSelectedActsConfirmsRecoveredLiveLikeNbuDailyActCluster();
  await testResolveSingleGoalSelectedActsRejectsSemanticNeighborForAbsentExplicitLawTitle();
  await testResolveSingleGoalSelectedActsRejectsBaseOrderFallbackForAbsentExplicitAmendmentOrder();
  await testResolveSingleGoalSelectedActsRejectsPersonnelOrderNeighborForAbsentExplicitDismissalOrder();
  await testResolveSingleGoalSelectedActsRejectsGenericGovernmentRegulationFallbackForAbsentExplicitContractExtensionOrder();
  await testResolveSingleGoalSelectedActsRecoversExplicitPersonnelOrderWithMatchingIdentity();
  await testResolveSingleGoalSelectedActsRecoversSoftPersonnelAppointmentOrderWithMatchingIdentity();
  await testResolveSingleGoalSelectedActsRealignsSoftAmendmentOrderWhenChunksFavorSemanticNeighbor();
  await testResolveSingleGoalSelectedActsConfirmsSoftPersonnelAppointmentOrderWithAbbreviatedOffice();
  await testResolveSingleGoalSelectedActsFlagsUngroundedGeneralChunksOnlyPrimaryFallback();
  await testResolveSingleGoalSelectedActsFlagsUngroundedPrimaryCompanionFallback();
  await testResolveSingleGoalSelectedActsFlagsBroadSameFamilyChunksOnlyFallback();
  testCoverageGapUsesSpecificDomainHintForLikelyMissingAct();
  testCoverageGapUsesUngroundedNonPrimaryOnlyWeakSelectionForLikelyMissingAct();
  testCoverageGapKeepsGroundedNonPrimaryOnlyWeakSelectionAsWeakEvidence();
  testCoverageGapKeepsGroundedSparseNonPrimarySelectionAsWeakEvidence();
  testCoverageGapUsesUngroundedMultiGoalFallbackForLikelyMissingAct();
  testCoverageGapKeepsMetadataGroundedMultiGoalFallbackAsWeakEvidence();
  testCoverageGapUsesMissingTaxonomyConvergenceForLikelyMissingAct();
  testCoverageGapUsesFamilyGuardNoEvidenceForLikelyMissingAct();
  testCoverageGapUsesExplicitActScopeNoConvergenceForWeakEvidenceWhenActIsGrounded();
  testCoverageGapTreatsMetadataOnlyExplicitActScopeMissAsLikelyMissingAct();
  testCoverageGapUsesExplicitActScopeForLikelyMissingActWithoutGrounding();
  testCoverageGapPrefersLikelyMissingActOverOutOfScopeForExplicitActScope();
  testCoverageGapPromotesSpecificNonPrimaryOnlyWeakSelectionToLikelyMissingAct();
  testCoverageGapUsesProceduralOnlyMixedGoalFallbackForLikelyMissingAct();
  testCoverageGapKeepsGroundedSinglePrimaryProceduralBundleAsWeakEvidence();
  testCoverageGapKeepsUngroundedSinglePrimaryProceduralBundleAsWeakEvidence();
  testCoverageGapKeepsProceduralSinglePrimaryBundleWeakEvenWhenUngroundedFallbackFires();
  testCoverageGapKeepsProceduralSinglePrimaryFallbackWeakWithoutBlockedReason();
  testCoverageGapUsesLikelyMissingActForMixedProceduralFallbackWithOnlyMetadataGrounding();
  testCoverageGapUsesLikelyMissingActForMixedProceduralFallbackWithFamilyMismatchTail();
  testCoverageGapKeepsStrongSingleActProceduralSurfaceAsWeakEvidenceEvenWhenGoalTypesLookMixed();
  testCoverageGapUsesGroundedActScopeNoConvergenceForWeakEvidenceWhenActIsGrounded();
  testCoverageGapUsesMetadataActScopeNoConvergenceForWeakEvidenceWhenActIsGrounded();
  testCoverageGapUsesProceduralPrimaryWithoutActGroundingForLikelyMissingAct();
  testDeriveTopScoreFromHitsUsesPostprocessedHits();
  testNormalizeFinalReasonCodesDropsRecoveredWeakSignals();
  testCoverageGuardRecoveryRequiresActGrounding();
  testStickySingleGoalLowConfidenceReasonsBlockRecovery();
  testProceduralPrimaryWithoutGroundingRequiresActSignals();
  testProcedureCategoryEnvelopeFallsBackToProcedureFamilies();
  testShouldConfirmSoftNonPrimarySingleAct();
  testBuildTaxonomyQuerySignalsIncludesMultiWordPhrases();
  testBuildTaxonomyQuerySignalsPreservesStructuredActIdentifiers();
  testBuildTaxonomyQuerySignalsCanonicalizesInflectedLawCuePhrase();
  testBuildTaxonomyQuerySignalsStripsPrimaryLawLocatorEnvelope();
  await testScoreActCandidateUsesTokenizedSignalsForSpecialLawLocator();
  await testScoreActCandidatePrefersHigherEducationLawForAcademicMobilityLocator();
  await testScoreActCandidatePrefersDatedNbuDailyActOverGenericCurrencyRegulation();
  await testScoreActCandidatePrefersExactDateRecurringSeriesMemberOverSameTitleNeighbors();
  await testGetTaxonomyCandidatesInjectsCompatibleProcedureFamilyForSoftErdrBundle();
  await testGetTaxonomyCandidatesGroundsCuedNumericRepealOrderWithDateContext();
  await testGetTaxonomyCandidatesRanksAmendmentOrderByReferencedBaseActIdentity();
  await testGetTaxonomyCandidatesRanksDatedNbuDailyActOverSameTitleNeighbors();
  await testGetTaxonomyCandidatesGroundsRecurringSameTitleDailyActByDateScopedSoftQuery();
  await testGetTaxonomyCandidatesGroundsRecurringFxDailyActByLawyerStyleQuery();
  testExtractActReferenceSignalsCapturesExplicitDocumentTitles();
  testExtractActReferenceSignalsCapturesModifiedGovernmentDecisionCue();
  testExtractActReferenceSignalsTrimsMetadataTailFromInterrogativeLocator();
  testExtractActReferenceSignalsPreservesCueForInterrogativeLocator();
  testExtractActReferenceSignalsCompactsInflectedShortLawAliasQuery();
  testMetadataGroundedActCandidateAcceptsDistinctDescriptiveLocator();
  testActReferenceCueCompatibilitySupportsBroadGovernmentDecisionEnvelope();
  testMetadataGroundedActCandidateAcceptsBroadGovernmentDecisionEnvelope();
  testMetadataGroundedActCandidateAcceptsCompactTitleFragment();
  testMetadataGroundedActCandidateAcceptsAliasBackedShortLawTitle();
  testMetadataGroundedActCandidateRejectsExplicitLawTitleSemanticNeighbor();
  testMetadataGroundedActCandidateRejectsStructuredIdentifierNeighbor();
  testMetadataGroundedActCandidateRejectsBaseOrderForAmendmentTitle();
  testMetadataGroundedActCandidateRejectsPersonnelOrderNeighborWithDifferentPersonSignature();
  testMetadataGroundedActCandidateRejectsPresidentialDelegationNeighbor();
  testMetadataGroundedActCandidateRejectsKsuDecisionForPresidentialRepresentationQuery();
  testMetadataGroundedActCandidateRejectsBoilerplateRepealLocator();
  testInterrogativePrimaryLawLocatorQueryDetectsSpecialLawLocators();
  testExtractStrictActScopeReferenceSignalsIgnoresTaxNoticeDecisionCompound();
  testEntityExtractorCapturesExplicitDecreeTitleAsLawTitle();
  testExtractStructuredActIdentifiersIgnoresDates();
  testExtractStructuredActIdentifiersIgnoresTemporalHyphenatedTerms();
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
  testSelectedActsAllowsProceduralSingleActCoverageWhenMixedGoalTailIsWeak();
  testSelectedActsBlocksProceduralSingleActCoverageWhenStrongNonProceduralCompanionRemains();
  testSelectedActsRecoversMixedGoalPrimaryCompanionFromHitBackfill();
  testSelectedActsDocumentTypeSlugHintsAllowTreatyAndDraft();
  testSelectedActsBlocksWeakNonPrimaryNoiseUnderMultiGoalPrimaryDominance();
  testSelectedActsKeepsExplicitlyHintedNonPrimaryActInMultiGoalSelection();
  testSelectedActsTrimsWeakOffFamilyPrimaryTailButKeepsProceduralPrimaryCompanion();
  testSelectedActsFallbackDoesNotReAddBlockedNoiseAct();
  testSelectedActsTrimWeakOffFamilyPrimaryLawInSingleGoal();
  testSelectedActsRequireEvidenceForPrimaryLawSupportTail();
  testFinalizeMultiGoalSelectedActsRecomputesConfidenceAfterTailTrim();
  testFinalizeMultiGoalSelectedActsKeepsOnlyFinalMetadataGrounding();
  testFinalizeMultiGoalSelectedActsDoesNotTreatActsSearchAsMetadataGrounding();
  testTrimUngroundedMultiGoalFallbackSelectionKeepsTopTwoEvidenceActs();
  testTrimLowConfidenceMultiGoalSelectionPreservesUniqueGoalCoverageWithoutMismatchSignal();
  testResolveExplicitPrimaryActMultiGoalSelectionAllowsAnchoredThinLaw();
  testResolveExplicitPrimaryActMultiGoalSelectionRecoversThinLawAndTrimsUnhintedOrderNoise();
  testResolveExplicitPrimaryActMultiGoalSelectionPrefersQuotedAmendmentLawOverBaseLaw();
  testResolveExplicitPrimaryActMultiGoalSelectionTrimsUnhintedTreatyTailForQuotedPrimaryLawLocator();
  testResolveExplicitPrimaryActMultiGoalSelectionDoesNotRelaxGenericMixedBundle();
  testResolveExplicitPrimaryActMultiGoalSelectionDoesNotRelaxUngroundedSpecialLawLocator();
  testResolveExplicitPrimaryActMultiGoalSelectionAllowsSemanticSpecialLawLocator();
  testResolveExplicitPrimaryActMultiGoalSelectionPreservesGoalDistinctPrimaryCompanion();
  testTrimUngroundedMultiGoalFallbackSelectionCollapsesOffFamilyTwoActBundle();
  testTrimUngroundedMultiGoalFallbackSelectionPreservesUniqueMixedCoverageWhenCompatible();
  testTrimUngroundedMultiGoalFallbackSelectionPrefersUniqueGoalCoverageOverRedundantEvidence();
  testStrongGoalSupportedMultiPrimaryCoverageRecognizesLegitimateMixedBundle();
  testStrongGoalSupportedMultiPrimaryCoverageRequiresFullGoalCoverage();
  testStrongGoalSupportedMultiPrimaryCoverageRejectsIncompatibleThreeFamilyBundle();
  testShouldFlagUngroundedMultiGoalFallbackOnChunksOnlyBroadPrimarySelection();
  testShouldFlagUngroundedMultiGoalFallbackOnExplicitActScopedChunksOnlyBundle();
  testShouldFlagUngroundedMultiGoalFallbackOnIncompatibleGoalCoveredBundle();
  testShouldFlagUngroundedMultiGoalFallbackOnThreeFamilyChunksOnlyBundleWithoutMismatchSignal();
  testShouldNotFlagUngroundedMultiGoalFallbackWhenGoalCoverageIsReal();
  testShouldNotFlagUngroundedMultiGoalFallbackWhenDefinitionGoalsAreCovered();
  testShouldNotFlagUngroundedMultiGoalFallbackForStrongSingleActProceduralBundle();
  testShouldFlagUngroundedMultiGoalFallbackWhenSameFamilyBundleMasksStrongSecondaryCompetition();
  testShouldFlagUngroundedMultiGoalFallbackWhenSpecificDomainMapsToOffFamilyActs();
  testShouldFlagUngroundedMultiGoalFallbackWhenOnlyTaxonomyBacksBroadOffFamilyBundle();
  testShouldNotFlagUngroundedMultiGoalFallbackWhenExactIndexedGroundingExists();
  testSkipMultiGoalVariantSearchOnStrongPerGoalCoverage();
  testSkipMultiGoalVariantSearchRequiresMaterialCoverage();
  testSkipMultiGoalVariantSearchRequiresPrimaryLawCoverage();
  testSkipMultiGoalVariantSearchRequiresCategoryAlignment();
  testSkipMultiGoalVariantSearchRequiresExplicitGoalCategories();
  testPreferEvidenceBackedGoalSupportUsesHitBackedSignalsWhenAvailable();
  testPreferEvidenceBackedGoalSupportFallsBackToSummaryWhenHitsAreEmpty();
  console.log('\nAll RAG unit tests passed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
