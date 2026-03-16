import {
  evaluateGoldenCase,
  findExpectationRank,
  type GoldenCase,
  type RetrievalTraceLike,
} from './rag_golden_eval.js';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERT FAIL: ${message}`);
}

function testFindExpectationRankNormalizesHyphenatedArticles(): void {
  const hits = [
    { rada_nreg: '80731-10', article_number: '2101' },
    { rada_nreg: '2341-14', article_number: '336' },
  ];
  const rank = findExpectationRank(hits, {
    rada_nreg: '80731-10',
    article_numbers: ['210-1'],
    max_rank: 5,
  });
  assert(rank === 1, '210-1 must match 2101 payload format');
  console.log('[OK] hyphenated article normalization works');
}

function testEvaluateGoldenCaseFailsOnLatePrimaryHit(): void {
  const goldenCase: GoldenCase = {
    id: 'dui',
    query: '...',
    description: '...',
    expected_primary: {
      rada_nreg: '80731-10',
      article_numbers: ['130'],
      max_rank: 2,
    },
    expected_selected_acts: ['80731-10'],
  };
  const trace: RetrievalTraceLike = {
    hits: [
      { rada_nreg: '2341-14', article_number: '21' },
      { rada_nreg: '2341-14', article_number: '2861' },
      { rada_nreg: '80731-10', article_number: '130' },
    ],
    meta: {
      selected_acts: [{ rada_nreg: '80731-10' }],
      hits_count: 3,
    },
  };
  const result = evaluateGoldenCase(goldenCase, trace);
  assert(result.pass === false, 'late primary hit must fail the golden case');
  assert(result.metrics.primary_rank === 3, 'primary rank should be reported as 3');
  console.log('[OK] golden eval fails when the correct norm is too low');
}

function testEvaluateGoldenCaseRequiresSelectedActsCoverage(): void {
  const goldenCase: GoldenCase = {
    id: 'multi',
    query: '...',
    description: '...',
    expected_hits: [
      { rada_nreg: '2341-14', article_numbers: ['336'], max_rank: 10 },
      { rada_nreg: '80731-10', article_numbers: ['210-1'], max_rank: 10 },
    ],
    expected_selected_acts: ['2341-14', '80731-10'],
  };
  const trace: RetrievalTraceLike = {
    hits: [
      { rada_nreg: '2341-14', article_number: '336' },
      { rada_nreg: '80731-10', article_number: '2101' },
    ],
    meta: {
      selected_acts: [{ rada_nreg: '2341-14' }],
      hits_count: 2,
    },
  };
  const result = evaluateGoldenCase(goldenCase, trace);
  assert(result.pass === false, 'missing selected act must fail');
  assert(
    result.reasons.some((reason) => reason.includes('selected_acts missing 80731-10')),
    'must explain missing selected act'
  );
  console.log('[OK] golden eval enforces selected_acts coverage');
}

function testEvaluateGoldenCaseFailsOnForbiddenSelectedActNoise(): void {
  const goldenCase: GoldenCase = {
    id: 'noise',
    query: '...',
    description: '...',
    expected_selected_acts: ['1023-12'],
    forbidden_selected_act_kinds: ['CASELAW_OPINION'],
    max_selected_acts: 2,
  };
  const trace: RetrievalTraceLike = {
    hits: [{ rada_nreg: '1023-12', article_number: '9' }],
    meta: {
      selected_acts: [
        { rada_nreg: '1023-12', act_kind: 'PRIMARY_LAW' },
        { rada_nreg: 'v0007700-08', act_kind: 'CASELAW_OPINION' },
        { rada_nreg: '435-15', act_kind: 'PRIMARY_LAW' },
      ],
      hits_count: 1,
    },
  };
  const result = evaluateGoldenCase(goldenCase, trace);
  assert(result.pass === false, 'forbidden selected_act noise must fail');
  assert(
    result.reasons.some((reason) => reason.includes('forbidden kind CASELAW_OPINION')),
    'must explain forbidden selected_act kind'
  );
  assert(
    result.reasons.some((reason) => reason.includes('selected_acts size 3 > 2')),
    'must enforce selected_acts size budget'
  );
  console.log('[OK] golden eval enforces forbidden selected_act noise and size budget');
}

function main(): void {
  console.log('rag_golden_eval unit tests\n');
  testFindExpectationRankNormalizesHyphenatedArticles();
  testEvaluateGoldenCaseFailsOnLatePrimaryHit();
  testEvaluateGoldenCaseRequiresSelectedActsCoverage();
  testEvaluateGoldenCaseFailsOnForbiddenSelectedActNoise();
  console.log('\nAll rag_golden_eval unit tests passed.');
}

main();
