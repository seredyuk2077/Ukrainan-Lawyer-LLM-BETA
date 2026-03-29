import { alignLlmEntitiesToSurface } from '../../classify/entity-alignment.js';
import type { ExtractedEntity } from '../../classify/types.js';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERT FAIL: ${message}`);
}

function testHallucinatedArticleRefIsDropped(): void {
  const query = "Яка відповідальність за керування авто в стані алкогольного сп'яніння вперше?";
  const preEntities: ExtractedEntity[] = [];
  const llmEntities: ExtractedEntity[] = [
    {
      type: 'article_ref',
      value: 'ст. 130 ККУ',
      norm: { act: 'ККУ', article: '130}}]},' },
    },
    {
      type: 'term',
      value: "керування авто в стані алкогольного сп'яніння",
    },
  ];
  const aligned = alignLlmEntitiesToSurface(query, preEntities, llmEntities);
  assert(aligned.length === 1, `Expected only non-structural term to remain, got ${JSON.stringify(aligned)}`);
  assert(aligned[0]?.type === 'term', `Expected hallucinated article_ref to be dropped, got ${JSON.stringify(aligned)}`);
  console.log('[OK] hallucinated structural article ref is dropped when absent from surface query');
}

function testSurfaceAlignedArticleRefIsKept(): void {
  const query = 'Яка відповідальність за ст. 130 КУпАП?';
  const preEntities: ExtractedEntity[] = [
    { type: 'article_ref', value: 'ст. 130', norm: { article: '130' } },
  ];
  const llmEntities: ExtractedEntity[] = [
    { type: 'article_ref', value: 'ст. 130 КУпАП', norm: { article: '130', act: 'КУпАП' } },
  ];
  const aligned = alignLlmEntitiesToSurface(query, preEntities, llmEntities);
  assert(aligned.length === 1, `Expected aligned article ref to remain, got ${JSON.stringify(aligned)}`);
  console.log('[OK] surface-aligned structural article ref is preserved');
}

function testSurfaceAlignedLawTitleIsKept(): void {
  const query = 'Що передбачає пункт 21 Правил перетинання державного кордону?';
  const preEntities: ExtractedEntity[] = [
    { type: 'law_title', value: 'Правил перетинання державного кордону' },
  ];
  const llmEntities: ExtractedEntity[] = [
    { type: 'law_title', value: 'Правила перетинання державного кордону' },
  ];
  const aligned = alignLlmEntitiesToSurface(query, preEntities, llmEntities);
  assert(aligned.length === 1, `Expected surface-aligned law title to remain, got ${JSON.stringify(aligned)}`);
  console.log('[OK] surface-aligned law title is preserved');
}

function main(): void {
  console.log('entity alignment unit tests\n');
  testHallucinatedArticleRefIsDropped();
  testSurfaceAlignedArticleRefIsKept();
  testSurfaceAlignedLawTitleIsKept();
  console.log('\nAll entity alignment unit tests passed.');
}

main();
