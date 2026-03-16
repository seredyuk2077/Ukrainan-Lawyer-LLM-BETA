#!/usr/bin/env node
/**
 * Verify U2: structural domain cue (entity-based) + tagLegalDomain (structural-only) edge cases.
 * No server — pure logic. Run: pnpm exec tsx scripts/lexery-legal-agent/tools/u2/verify_u2_domain_cues.ts
 */
import { tagLegalDomain } from '../../classify/legal-domain-tagger.js';
import { extractEntities } from '../../classify/entity-extractor.js';

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
  console.log(`\nCue: ${cueOk}/${CUE_CASES.length} pass${cueFail ? `, ${cueFail} fail` : ''}`);
  console.log(`Tagger: ${tagOk}/${TAGGER_CASES.length} pass${tagFail ? `, ${tagFail} fail` : ''}`);
  process.exit(cueFail + tagFail > 0 ? 1 : 0);
}

main();
