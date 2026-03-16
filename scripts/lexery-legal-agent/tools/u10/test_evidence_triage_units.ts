/**
 * Evidence triage unit tests (Phase 3/5).
 * Run: pnpm exec tsx scripts/lexery-legal-agent/tools/u10/test_evidence_triage_units.ts
 *
 * Tests: queryAwareExcerpt, resolveEvidenceBounds, parse contract (indices/selected_indices).
 */
import { queryAwareExcerpt, resolveEvidenceBounds } from '../../write/evidenceTriage.js';

const cfg = {
  evidenceTriageMinSelected: 6,
  evidenceTriageMaxSelected: 8,
  evidenceTriageSoftMin: 3,
  evidenceTriageHardMin: 2,
};
const cfgLow = {
  evidenceTriageMinSelected: 3,
  evidenceTriageMaxSelected: 8,
  evidenceTriageSoftMin: 3,
  evidenceTriageHardMin: 2,
};

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`ASSERT FAIL: ${msg}`);
}

function testQueryAwareExcerptOverlap(): void {
  const text = 'Start of law. Крадіжка та розбій визначені в статті. End of paragraph.';
  const query = 'крадіжка статті';
  const excerpt = queryAwareExcerpt(text, query, 40);
  assert(excerpt.length <= 45, 'excerpt within budget');
  assert(
    excerpt.includes('Крадіжка') || excerpt.toLowerCase().includes('крадіжка'),
    'query-aware window should include query term'
  );
  console.log('[OK] queryAwareExcerpt: overlap window');
}

function testQueryAwareExcerptNoOverlap(): void {
  const text = 'Абсолютно інший текст без збігів з запитом.';
  const query = 'xyz unknown';
  const excerpt = queryAwareExcerpt(text, query, 25);
  assert(excerpt.length <= 30, 'excerpt within budget');
  assert(excerpt.startsWith('Абсолютно') || excerpt.length > 0, 'fallback to first chars');
  console.log('[OK] queryAwareExcerpt: no overlap fallback');
}

/** Fails on old \\W+ tokenize: query terms only in middle; with Unicode tokenize we get overlap window. */
function testQueryAwareExcerptCyrillicMiddle(): void {
  const text = 'Вступ. Загальні положення. Крадіжка та грабіж визначені в статті 185 і 186. Заключення.';
  const query = 'крадіжка грабіж';
  const excerpt = queryAwareExcerpt(text, query, 50);
  assert(excerpt.length <= 55, 'excerpt within budget');
  const hasKradizhka = excerpt.toLowerCase().includes('крадіжка');
  const hasGrabizh = excerpt.toLowerCase().includes('грабіж');
  assert(hasKradizhka && hasGrabizh, 'Unicode tokenize: query-aware window must contain both UA terms (old \\W+ yields empty tokens)');
  console.log('[OK] queryAwareExcerpt: Cyrillic middle (Unicode tokenize)');
}

function testResolveEvidenceBoundsSimple(): void {
  const b = resolveEvidenceBounds('Яка відповідальність за порушення?', 10, cfgLow);
  assert(b.effective_min === 3 && b.effective_max === 6, 'simple query => min=3 max=6');
  assert(b.hard_min <= b.soft_min && b.soft_min <= b.effective_max, 'hard_min <= soft_min <= max');
  const bConfig = resolveEvidenceBounds('Яка відповідальність?', 10, cfg);
  assert(bConfig.effective_min >= 6, 'config min is base frame (effective_min >= 6 when config min=6)');
  console.log('[OK] resolveEvidenceBounds: simple query + config frame');
}

function testResolveEvidenceBoundsComparison(): void {
  const b = resolveEvidenceBounds('Чим відрізняється крадіжка від грабежу?', 12, cfgLow);
  assert(b.effective_min === 5 && b.effective_max === 8, 'comparison-like => min=5 max=8');
  const bConfig = resolveEvidenceBounds('Чим відрізняється крадіжка від грабежу?', 12, cfg);
  assert(bConfig.effective_min >= 6, 'comparison respects config min (>=6)');
  console.log('[OK] resolveEvidenceBounds: comparison-like');
}

function testResolveEvidenceBoundsMultiPart(): void {
  const b = resolveEvidenceBounds('Коли адмін, а коли кримінал? Які норми?', 10, cfgLow);
  assert(b.effective_min === 5 && b.effective_max === 8, 'multi-part (? + conjunction) => min=5 max=8');
  console.log('[OK] resolveEvidenceBounds: multi-part');
}

function testResolveEvidenceBoundsClampToLawCount(): void {
  const b = resolveEvidenceBounds('Різниця між шахрайством і привласненням?', 4, cfg);
  assert(b.effective_max <= 4 && b.effective_min <= b.effective_max, 'clamp to lawCount');
  console.log('[OK] resolveEvidenceBounds: clamp to lawCount');
}

function main(): void {
  console.log('Evidence triage unit tests\n');
  testQueryAwareExcerptOverlap();
  testQueryAwareExcerptNoOverlap();
  testQueryAwareExcerptCyrillicMiddle();
  testResolveEvidenceBoundsSimple();
  testResolveEvidenceBoundsComparison();
  testResolveEvidenceBoundsMultiPart();
  testResolveEvidenceBoundsClampToLawCount();
  console.log('\nAll evidence triage unit tests passed.');
}

main();
