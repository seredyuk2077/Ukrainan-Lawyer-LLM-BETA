#!/usr/bin/env node
/**
 * Verify U2: structural domain cue (entity-based) + tagLegalDomain (structural-only) edge cases.
 * No server — pure logic. Run: pnpm exec tsx scripts/lexery-legal-agent/tools/u2/verify_u2_domain_cues.ts
 */
import { tagLegalDomain } from '../../classify/legal-domain-tagger.js';
import { extractEntities } from '../../classify/entity-extractor.js';
import { detectAmbiguity } from '../../classify/ambiguity-detector.js';
import { normalizeInput } from '../../classify/input-normalizer.js';
import { deriveLldbiHintsFromVocabulary } from '../../classify/lldbi-hints-from-vocabulary.js';
import type { LldbiVocabularyResult } from '../../retrieval/lldbi-vocabulary.js';

/** Structural cue from entities only (aligned with consumer hasStructuralDomainCue). */
function hasStructuralDomainCueFromQuery(query: string): boolean {
  const { entities } = extractEntities(query ?? '');
  return entities.some(
    (e) => e.type === 'article_ref' || e.type === 'act_abbrev' || e.type === 'law_title'
  );
}

const CUE_CASES: Array<{ q: string; expectCue: boolean }> = [
  { q: 'Кваліфікація за ст. 119 ККУ', expectCue: true },
  { q: 'ст. 121 ККУ', expectCue: true },
  { q: 'ПКУ податки', expectCue: true },
  { q: 'ЦКУ договір', expectCue: true },
  { q: 'МОЗ наказ', expectCue: false },
  { q: 'ТОВ статут', expectCue: false },
  { q: 'АТ «Банк»', expectCue: false },
  { q: 'А. та Б. уклали договір', expectCue: false },
  { q: 'А. насипав отруту в колодязь сусідки Б.', expectCue: false },
  { q: 'Чи можна стягнути відшкодування за заподіяння шкоди?', expectCue: false },
  { q: 'строк апеляції на рішення суду', expectCue: false },
  { q: 'кримінальний кодекс ст 115', expectCue: true },
  { q: 'ЗУ «Про освіту»', expectCue: false },
  { q: 'Хто має право перетинати державний кордон за пунктом 21 Правил перетинання державного кордону?', expectCue: true },
  { q: 'Що повинен зробити продавець за пунктом 12 Правил роздрібної торгівлі непродовольчими товарами?', expectCue: true },
  { q: 'Що повинен зробити продавець за пунктом 12 Правила роздрібної торгівлі непродовольчими товарами?', expectCue: true },
  { q: 'ПКМ №100', expectCue: true },
  { q: 'постанова КМУ №1178', expectCue: true },
  { q: 'наказ МОЗ №385', expectCue: true },
  { q: '1697-18', expectCue: true },
  { q: '100-95-п', expectCue: true },
  { q: 'v0003359-26', expectCue: true },
  { q: '', expectCue: false },
  { q: 'аб', expectCue: false },
];

/** Tagger is structural-only (act abbrevs); no topic words. */
const TAGGER_CASES: Array<{ q: string; expectDomain: string }> = [
  { q: 'ККУ ст. 115', expectDomain: 'criminal' },
  { q: 'ст. 119 ККУ кваліфікація', expectDomain: 'criminal' },
  { q: 'ЦКУ договір', expectDomain: 'civil' },
  { q: 'КЗпП трудовий', expectDomain: 'labor' },
  { q: 'ПКУ податки', expectDomain: 'tax' },
  { q: 'КАС адмін', expectDomain: 'admin' },
  { q: 'договір купівлі-продажу', expectDomain: 'general' },
  { q: 'звільнення за прогул', expectDomain: 'general' },
  { q: 'податковий кодекс', expectDomain: 'general' },
  { q: 'А. насипав отруту сусідці', expectDomain: 'general' },
  { q: 'відшкодування моральної шкоди', expectDomain: 'general' },
  { q: 'МОЗ наказ 2559', expectDomain: 'general' },
];

const STRUCTURAL_FAST_PATH_CASES: Array<{ q: string; expectAmbiguous: boolean; expectComplex: boolean }> = [
  {
    q: 'Хто має право перетинати державний кордон за пунктом 21 Правил перетинання державного кордону?',
    expectAmbiguous: false,
    expectComplex: false,
  },
  {
    q: 'Що повинен зробити продавець за пунктом 12 Правил роздрібної торгівлі непродовольчими товарами?',
    expectAmbiguous: false,
    expectComplex: false,
  },
  {
    q: 'Що повинен зробити продавець за пунктом 12 Правила роздрібної торгівлі непродовольчими товарами?',
    expectAmbiguous: false,
    expectComplex: false,
  },
  {
    q: 'ПКМ №100',
    expectAmbiguous: false,
    expectComplex: false,
  },
  {
    q: 'постанова КМУ №1178',
    expectAmbiguous: false,
    expectComplex: false,
  },
  {
    q: 'наказ МОЗ №385',
    expectAmbiguous: false,
    expectComplex: false,
  },
  {
    q: '1697-18',
    expectAmbiguous: false,
    expectComplex: false,
  },
  {
    q: '100-95-п',
    expectAmbiguous: false,
    expectComplex: false,
  },
  {
    q: 'v0003359-26',
    expectAmbiguous: false,
    expectComplex: false,
  },
];

const LLDBI_HINT_CASES: Array<{
  q: string;
  expectDocTypes: string[];
  rejectDocTypes: string[];
}> = [
  {
    q: 'Де НБУ на 24.03.2026 закріпив офіційний курс гривні щодо іноземних валют?',
    expectDocTypes: ['Повідомлення НБУ'],
    rejectDocTypes: ['Міжнародний договір', 'Декрет Кабінету Міністрів України'],
  },
  {
    q: 'Яким рішенням Кабміну затвердили воєнні особливості закупівель?',
    expectDocTypes: ['Постанова КМУ', 'Розпорядження КМУ'],
    rejectDocTypes: ['Повідомлення НБУ', 'Рішення РНБО'],
  },
];

function buildStubVocabulary(documentTypes: string[]): LldbiVocabularyResult {
  return {
    categories: ['finance_banking', 'public_procurement'],
    documentTypes,
    stats: {
      totalDocs: documentTypes.length,
      distinctCategories: 2,
      distinctDocumentTypes: documentTypes.length,
    },
    fetchedAt: Date.now(),
    source: 'stub',
  };
}

function main() {
  let cueOk = 0;
  let cueFail = 0;
  for (const { q, expectCue } of CUE_CASES) {
    const got = hasStructuralDomainCueFromQuery(q);
    if (got === expectCue) {
      cueOk++;
    } else {
      cueFail++;
      console.error(`[CUE FAIL] "${q.slice(0, 50)}..." expectCue=${expectCue} got=${got}`);
    }
  }
  let tagOk = 0;
  let tagFail = 0;
  for (const { q, expectDomain } of TAGGER_CASES) {
    const got = tagLegalDomain(q);
    if (got === expectDomain) {
      tagOk++;
    } else {
      tagFail++;
      console.error(`[TAG FAIL] "${q.slice(0, 50)}..." expectDomain=${expectDomain} got=${got}`);
    }
  }
  let structuralOk = 0;
  let structuralFail = 0;
  for (const { q, expectAmbiguous, expectComplex } of STRUCTURAL_FAST_PATH_CASES) {
    const { entities } = extractEntities(q);
    const normalizer = normalizeInput(q, entities);
    const domain = tagLegalDomain(normalizer.effectiveQuery);
    const ambiguity = detectAmbiguity(normalizer.effectiveQuery, domain, entities);
    const pass = ambiguity.is_ambiguous === expectAmbiguous && normalizer.isComplexInput === expectComplex;
    if (pass) {
      structuralOk++;
    } else {
      structuralFail++;
      console.error(
        `[STRUCT FAIL] "${q.slice(0, 60)}..." expectAmbiguous=${expectAmbiguous} gotAmbiguous=${ambiguity.is_ambiguous} expectComplex=${expectComplex} gotComplex=${normalizer.isComplexInput}`
      );
    }
  }
  let lldbiOk = 0;
  let lldbiFail = 0;
  const stubVocabulary = buildStubVocabulary([
    'Повідомлення НБУ',
    'Постанова НБУ',
    'Постанова КМУ',
    'Розпорядження КМУ',
    'Міжнародний договір',
    'Декрет Кабінету Міністрів України',
    'Рішення РНБО',
  ]);
  for (const { q, expectDocTypes, rejectDocTypes } of LLDBI_HINT_CASES) {
    const { entities } = extractEntities(q);
    const derived = deriveLldbiHintsFromVocabulary({
      queryText: q,
      heuristicConfidence: 0.7,
      vocabulary: stubVocabulary,
      entities,
    });
    const gotDocTypes = derived.document_types_ranked_top3;
    const expectedOk = expectDocTypes.some((docType) => gotDocTypes.includes(docType));
    const rejectOk = rejectDocTypes.every((docType) => !gotDocTypes.includes(docType));
    if (expectedOk && rejectOk) {
      lldbiOk++;
    } else {
      lldbiFail++;
      console.error(
        `[LLDBI FAIL] "${q.slice(0, 80)}..." expected some of=${JSON.stringify(expectDocTypes)} reject=${JSON.stringify(rejectDocTypes)} got=${JSON.stringify(gotDocTypes)}`
      );
    }
  }
  console.log(`\nCue: ${cueOk}/${CUE_CASES.length} pass${cueFail ? `, ${cueFail} fail` : ''}`);
  console.log(`Tagger: ${tagOk}/${TAGGER_CASES.length} pass${tagFail ? `, ${tagFail} fail` : ''}`);
  console.log(
    `Structural fast-path: ${structuralOk}/${STRUCTURAL_FAST_PATH_CASES.length} pass${structuralFail ? `, ${structuralFail} fail` : ''}`
  );
  console.log(`LLDBI hints: ${lldbiOk}/${LLDBI_HINT_CASES.length} pass${lldbiFail ? `, ${lldbiFail} fail` : ''}`);
  process.exit(cueFail + tagFail + structuralFail + lldbiFail > 0 ? 1 : 0);
}

main();
