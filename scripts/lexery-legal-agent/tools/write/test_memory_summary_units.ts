/**
 * Memory summary normalization unit tests (bounded, plain, no markdown/legal structure).
 * Run: pnpm exec tsx scripts/lexery-legal-agent/tools/write/test_memory_summary_units.ts
 */
import { strict as assert } from 'assert';
import {
  normalizeMemorySummary,
  splitIntoClauses,
  mergeRollingSummary,
  buildSummaryFromFacts,
} from '../../write/memorySummary.js';

function ok(cond: boolean, msg: string): void {
  assert(cond, `[FAIL] ${msg}`);
}

function testBoundedLength(): void {
  const long = 'a '.repeat(400);
  const out = normalizeMemorySummary(long, 100);
  ok(out.length <= 101, 'output bounded by maxChars (+ ellipsis)');
  ok(out.endsWith('…') || out.length <= 100, 'ends with ellipsis when truncated');
  console.log('[OK] summary bounded by length');
}

function testNoMarkdownHeadings(): void {
  const withHeaders = '## Норма\nЦитата статті.\n### Пояснення\nТекст пояснення.';
  const out = normalizeMemorySummary(withHeaders, 500);
  ok(!out.includes('##'), 'no ## in output');
  ok(!out.includes('###'), 'no ### in output');
  ok(out.includes('Норма') || out.includes('Цитата') || out.includes('Пояснення') || out.includes('Текст'), 'content preserved');
  console.log('[OK] no multi-block markdown headings');
}

function testNoNoisyLegalFormatting(): void {
  const legal = 'Норма (цитування): ст. 123 ККУ.\nАналіз:\nВисновок: крадіжка.';
  const out = normalizeMemorySummary(legal, 200);
  ok(out.length <= 201, 'bounded');
  ok(!/^#+\s/m.test(out), 'no leading ### in output');
  console.log('[OK] no noisy legal formatting (structural strip)');
}

function testStableExtractionQuality(): void {
  const same = 'Short factual sentence.';
  const a = normalizeMemorySummary(same, 500);
  const b = normalizeMemorySummary(same, 500);
  ok(a === b, 'deterministic for same input');
  ok(a === 'Short factual sentence.', 'short input unchanged');
  console.log('[OK] stable extraction quality');
}

function testEmptyInput(): void {
  ok(normalizeMemorySummary('') === '', 'empty string');
  ok(normalizeMemorySummary('   \n##\n###  ') === '', 'only headers/whitespace');
  console.log('[OK] empty input');
}

function testSplitIntoClauses(): void {
  ok(splitIntoClauses('').length === 0, 'empty -> []');
  ok(splitIntoClauses('A. B. C').length >= 2, 'sentence split');
  ok(splitIntoClauses('one | two').length === 2, 'pipe split');
  ok(splitIntoClauses('  a  |  b  ').every((p) => p === 'a' || p === 'b'), 'trimmed');
  console.log('[OK] splitIntoClauses');
}

function testMergeDedupe(): void {
  const existing = 'First fact. Second fact.';
  const newText = 'Second fact. Third fact.';
  const out = mergeRollingSummary(existing, newText, 500);
  ok(out.length <= 501, 'merge bounded');
  const secondFactCount = out.match(/Second fact/g)?.length ?? 0;
  ok(secondFactCount <= 1, 'dedupe: repeated clause "Second fact" appears at most once');
  console.log('[OK] merge dedupe');
}

function testMergePreservesChronology(): void {
  const existing = 'Favorite color is blue. Dog name is Rori.';
  const newText = 'User prefers short answers.';
  const out = mergeRollingSummary(existing, newText, 500);
  const idxBlue = out.indexOf('Favorite color is blue');
  const idxDog = out.indexOf('Dog name is Rori');
  const idxShort = out.indexOf('User prefers short answers');
  ok(idxBlue >= 0 && idxDog >= 0 && idxShort >= 0, 'all clauses preserved');
  ok(idxBlue < idxShort && idxDog < idxShort, 'early facts stay before later appended facts');
  console.log('[OK] merge preserves chronology');
}

function testMergeDedupeEllipsisTail(): void {
  const existing = 'Tenant is Petro Ivanovych Kovalenko…';
  const newText = 'Tenant is Petro Ivanovych Kovalenko. Lease term is 12 months.';
  const out = mergeRollingSummary(existing, newText, 500);
  const tenantFactCount = out.match(/Tenant is Petro Ivanovych Kovalenko/g)?.length ?? 0;
  ok(tenantFactCount === 1, 'dedupe: ellipsis-truncated tail does not survive as duplicate');
  ok(out.includes('Lease term is 12 months'), 'new non-duplicate fact preserved');
  console.log('[OK] merge dedupe for ellipsis-truncated tail');
}

function testMergeBound(): void {
  const long = 'word '.repeat(120);
  const out = mergeRollingSummary('old.', long, 100);
  ok(out.length <= 101, 'merge output bounded');
  console.log('[OK] merge bound');
}

function testMergeNoRunawayGrowth(): void {
  let acc = 'Start.';
  for (let i = 0; i < 5; i++) {
    acc = mergeRollingSummary(acc, `New sentence ${i}.`, 200);
  }
  ok(acc.length <= 201, 'repeated appends stay bounded');
  console.log('[OK] merge no runaway growth');
}

function testMergeNoMarkdown(): void {
  const withHash = '## Heading\nContent here.';
  const out = mergeRollingSummary('existing.', withHash, 500);
  ok(!out.includes('##'), 'no markdown headings in merged output');
  console.log('[OK] merge no markdown');
}

function testBuildSummaryFromFacts(): void {
  ok(buildSummaryFromFacts([]) === '', 'empty facts -> empty');
  const one = buildSummaryFromFacts(['User prefers Ukrainian language.'], 100);
  ok(one.length <= 101 && one.includes('Ukrainian'), 'one fact bounded');
  const two = buildSummaryFromFacts(['Fact A.', 'Fact B.'], 500);
  ok(two.includes('Fact A') && two.includes('Fact B'), 'multiple facts joined');
  const noisy = buildSummaryFromFacts(['## Норма\nКороткий факт.']);
  ok(!noisy.includes('##'), 'facts: no markdown in output');
  const deduped = buildSummaryFromFacts(['Fact A', 'Fact A.', 'Fact B'], 500);
  const factACount = deduped.match(/Fact A/g)?.length ?? 0;
  ok(factACount === 1, 'duplicate facts deduped before summary build');
  ok(deduped.includes('Fact A.') && deduped.includes('Fact B.'), 'facts normalized to sentence-like clauses');
  console.log('[OK] buildSummaryFromFacts');
}

function main(): void {
  testBoundedLength();
  testNoMarkdownHeadings();
  testNoNoisyLegalFormatting();
  testStableExtractionQuality();
  testEmptyInput();
  testSplitIntoClauses();
  testMergeDedupe();
  testMergePreservesChronology();
  testMergeDedupeEllipsisTail();
  testMergeBound();
  testMergeNoRunawayGrowth();
  testMergeNoMarkdown();
  testBuildSummaryFromFacts();
  console.log('All memory summary unit tests passed.');
}

main();
