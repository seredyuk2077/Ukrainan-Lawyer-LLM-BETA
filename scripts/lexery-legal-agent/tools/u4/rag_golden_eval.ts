export interface GoldenHitExpectation {
  rada_nreg: string;
  article_numbers?: string[];
  max_rank: number;
}

export type GoldenLatencyBudgetClass = 'fast' | 'standard' | 'complex';

export type GoldenFailureCode =
  | 'primary_miss'
  | 'primary_rank_miss'
  | 'expected_hit_miss'
  | 'expected_hit_rank_miss'
  | 'selected_acts_missing'
  | 'selected_acts_forbidden'
  | 'selected_acts_forbidden_kind'
  | 'selected_acts_budget'
  | 'latency_breach'
  | 'qdrant_budget_breach';

export interface GoldenCase {
  id: string;
  query: string;
  description: string;
  bucket?: string;
  priority?: 'high' | 'normal';
  smoke?: boolean;
  latency_budget_class?: GoldenLatencyBudgetClass;
  max_latency_ms?: number;
  max_qdrant_calls?: number;
  expected_primary?: GoldenHitExpectation;
  expected_hits?: GoldenHitExpectation[];
  expected_selected_acts?: string[];
  forbidden_selected_acts?: string[];
  forbidden_selected_act_kinds?: string[];
  max_selected_acts?: number;
}

export interface RetrievalHitLike {
  rada_nreg?: string;
  article_number?: string | null;
  title?: string;
  act_title?: string;
  score?: number;
}

export interface RetrievalTraceLike {
  hits?: RetrievalHitLike[];
  meta?: {
    selected_acts?: Array<{ rada_nreg?: string; act_title?: string; act_kind?: string }>;
    hits_count?: number;
    low_confidence?: boolean;
    qdrant_calls_count_total?: number;
  };
}

export interface GoldenRuntimeMetrics {
  latency_ms?: number;
  qdrant_calls_count_total?: number;
}

export interface GoldenEvaluationResult {
  pass: boolean;
  reasons: string[];
  failure_codes: GoldenFailureCode[];
  metrics: {
    hits_count: number;
    low_confidence: boolean;
    primary_rank?: number;
    expected_hit_ranks: Record<string, number | null>;
    selected_acts_present: string[];
    latency_ms?: number;
    latency_budget_ms?: number;
    qdrant_calls_count_total?: number;
    max_qdrant_calls?: number;
  };
}

export function getLatencyBudgetMs(goldenCase: GoldenCase): number | undefined {
  if (typeof goldenCase.max_latency_ms === 'number' && goldenCase.max_latency_ms >= 0) {
    return goldenCase.max_latency_ms;
  }
  switch (goldenCase.latency_budget_class) {
    case 'fast':
      return 12_000;
    case 'complex':
      return 20_000;
    case 'standard':
      return 16_000;
    default:
      return undefined;
  }
}

function normalizeArticle(article: string | null | undefined): string {
  return String(article ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\s\-–—]+/g, '')
    .trim();
}

function matchesExpectation(hit: RetrievalHitLike, expectation: GoldenHitExpectation): boolean {
  if ((hit.rada_nreg ?? '') !== expectation.rada_nreg) return false;
  if (!expectation.article_numbers?.length) return true;
  const actual = normalizeArticle(hit.article_number);
  if (!actual) return false;
  return expectation.article_numbers.some((article) => normalizeArticle(article) === actual);
}

export function findExpectationRank(
  hits: RetrievalHitLike[],
  expectation: GoldenHitExpectation
): number | null {
  for (let i = 0; i < hits.length; i += 1) {
    if (matchesExpectation(hits[i], expectation)) return i + 1;
  }
  return null;
}

export function evaluateGoldenCase(
  goldenCase: GoldenCase,
  retrievalTrace: RetrievalTraceLike | null | undefined,
  runtimeMetrics?: GoldenRuntimeMetrics
): GoldenEvaluationResult {
  const hits = retrievalTrace?.hits ?? [];
  const meta = retrievalTrace?.meta;
  const reasons: string[] = [];
  const failureCodes = new Set<GoldenFailureCode>();
  const selectedActs = meta?.selected_acts ?? [];
  const selectedActNregs = new Set(
    selectedActs.map((act) => act.rada_nreg ?? '').filter((nreg) => nreg.length > 0)
  );
  const selectedActKinds = new Set(
    selectedActs
      .map((act) => String(act.act_kind ?? '').trim().toUpperCase())
      .filter((actKind) => actKind.length > 0)
  );

  let primaryRank: number | undefined;
  if (goldenCase.expected_primary) {
    const rank = findExpectationRank(hits, goldenCase.expected_primary);
    primaryRank = rank ?? undefined;
    if (rank == null) {
      reasons.push(
        `primary miss: ${goldenCase.expected_primary.rada_nreg} ${goldenCase.expected_primary.article_numbers?.join(',') ?? ''}`.trim()
      );
      failureCodes.add('primary_miss');
    } else if (rank > goldenCase.expected_primary.max_rank) {
      reasons.push(`primary rank ${rank} > ${goldenCase.expected_primary.max_rank}`);
      failureCodes.add('primary_rank_miss');
    }
  }

  const expectedHitRanks: Record<string, number | null> = {};
  for (const expectation of goldenCase.expected_hits ?? []) {
    const key = `${expectation.rada_nreg}:${(expectation.article_numbers ?? []).join('|') || '*'}`;
    const rank = findExpectationRank(hits, expectation);
    expectedHitRanks[key] = rank;
    if (rank == null) {
      reasons.push(`missing expected hit ${key}`);
      failureCodes.add('expected_hit_miss');
    } else if (rank > expectation.max_rank) {
      reasons.push(`expected hit ${key} rank ${rank} > ${expectation.max_rank}`);
      failureCodes.add('expected_hit_rank_miss');
    }
  }

  const selectedActsPresent: string[] = [];
  for (const expectedNreg of goldenCase.expected_selected_acts ?? []) {
    if (selectedActNregs.has(expectedNreg)) {
      selectedActsPresent.push(expectedNreg);
    } else {
      reasons.push(`selected_acts missing ${expectedNreg}`);
      failureCodes.add('selected_acts_missing');
    }
  }

  for (const forbiddenNreg of goldenCase.forbidden_selected_acts ?? []) {
    if (selectedActNregs.has(forbiddenNreg)) {
      reasons.push(`selected_acts contains forbidden ${forbiddenNreg}`);
      failureCodes.add('selected_acts_forbidden');
    }
  }

  for (const forbiddenKind of goldenCase.forbidden_selected_act_kinds ?? []) {
    const normalizedKind = String(forbiddenKind).trim().toUpperCase();
    if (normalizedKind.length > 0 && selectedActKinds.has(normalizedKind)) {
      reasons.push(`selected_acts contains forbidden kind ${normalizedKind}`);
      failureCodes.add('selected_acts_forbidden_kind');
    }
  }

  if (
    typeof goldenCase.max_selected_acts === 'number' &&
    goldenCase.max_selected_acts >= 0 &&
    selectedActs.length > goldenCase.max_selected_acts
  ) {
    reasons.push(`selected_acts size ${selectedActs.length} > ${goldenCase.max_selected_acts}`);
    failureCodes.add('selected_acts_budget');
  }

  const latencyBudgetMs = getLatencyBudgetMs(goldenCase);
  const runtimeLatencyMs = runtimeMetrics?.latency_ms;
  if (
    typeof latencyBudgetMs === 'number' &&
    typeof runtimeLatencyMs === 'number' &&
    runtimeLatencyMs > latencyBudgetMs
  ) {
    reasons.push(`latency ${runtimeLatencyMs}ms > ${latencyBudgetMs}ms`);
    failureCodes.add('latency_breach');
  }

  const qdrantCallsCount =
    runtimeMetrics?.qdrant_calls_count_total ?? meta?.qdrant_calls_count_total;
  if (
    typeof goldenCase.max_qdrant_calls === 'number' &&
    goldenCase.max_qdrant_calls >= 0 &&
    typeof qdrantCallsCount === 'number' &&
    qdrantCallsCount > goldenCase.max_qdrant_calls
  ) {
    reasons.push(`qdrant_calls ${qdrantCallsCount} > ${goldenCase.max_qdrant_calls}`);
    failureCodes.add('qdrant_budget_breach');
  }

  return {
    pass: reasons.length === 0,
    reasons,
    failure_codes: [...failureCodes],
    metrics: {
      hits_count: meta?.hits_count ?? hits.length,
      low_confidence: meta?.low_confidence === true,
      primary_rank: primaryRank,
      expected_hit_ranks: expectedHitRanks,
      selected_acts_present: selectedActsPresent,
      latency_ms: runtimeLatencyMs,
      latency_budget_ms: latencyBudgetMs,
      qdrant_calls_count_total: qdrantCallsCount,
      max_qdrant_calls: goldenCase.max_qdrant_calls,
    },
  };
}
