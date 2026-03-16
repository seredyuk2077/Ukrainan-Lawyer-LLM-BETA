export interface GoldenHitExpectation {
  rada_nreg: string;
  article_numbers?: string[];
  max_rank: number;
}

export interface GoldenCase {
  id: string;
  query: string;
  description: string;
  expected_primary?: GoldenHitExpectation;
  expected_hits?: GoldenHitExpectation[];
  expected_selected_acts?: string[];
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
    selected_acts?: Array<{ rada_nreg?: string; act_title?: string }>;
    hits_count?: number;
    low_confidence?: boolean;
  };
}

export interface GoldenEvaluationResult {
  pass: boolean;
  reasons: string[];
  metrics: {
    hits_count: number;
    low_confidence: boolean;
    primary_rank?: number;
    expected_hit_ranks: Record<string, number | null>;
    selected_acts_present: string[];
  };
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
  retrievalTrace: RetrievalTraceLike | null | undefined
): GoldenEvaluationResult {
  const hits = retrievalTrace?.hits ?? [];
  const meta = retrievalTrace?.meta;
  const reasons: string[] = [];
  const selectedActs = meta?.selected_acts ?? [];
  const selectedActNregs = new Set(
    selectedActs.map((act) => act.rada_nreg ?? '').filter((nreg) => nreg.length > 0)
  );

  let primaryRank: number | undefined;
  if (goldenCase.expected_primary) {
    const rank = findExpectationRank(hits, goldenCase.expected_primary);
    primaryRank = rank ?? undefined;
    if (rank == null) {
      reasons.push(
        `primary miss: ${goldenCase.expected_primary.rada_nreg} ${goldenCase.expected_primary.article_numbers?.join(',') ?? ''}`.trim()
      );
    } else if (rank > goldenCase.expected_primary.max_rank) {
      reasons.push(`primary rank ${rank} > ${goldenCase.expected_primary.max_rank}`);
    }
  }

  const expectedHitRanks: Record<string, number | null> = {};
  for (const expectation of goldenCase.expected_hits ?? []) {
    const key = `${expectation.rada_nreg}:${(expectation.article_numbers ?? []).join('|') || '*'}`;
    const rank = findExpectationRank(hits, expectation);
    expectedHitRanks[key] = rank;
    if (rank == null) {
      reasons.push(`missing expected hit ${key}`);
    } else if (rank > expectation.max_rank) {
      reasons.push(`expected hit ${key} rank ${rank} > ${expectation.max_rank}`);
    }
  }

  const selectedActsPresent: string[] = [];
  for (const expectedNreg of goldenCase.expected_selected_acts ?? []) {
    if (selectedActNregs.has(expectedNreg)) {
      selectedActsPresent.push(expectedNreg);
    } else {
      reasons.push(`selected_acts missing ${expectedNreg}`);
    }
  }

  return {
    pass: reasons.length === 0,
    reasons,
    metrics: {
      hits_count: meta?.hits_count ?? hits.length,
      low_confidence: meta?.low_confidence === true,
      primary_rank: primaryRank,
      expected_hit_ranks: expectedHitRanks,
      selected_acts_present: selectedActsPresent,
    },
  };
}
