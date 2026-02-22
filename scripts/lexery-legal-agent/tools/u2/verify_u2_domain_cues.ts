#!/usr/bin/env node
/**
 * Verify U2: hasExplicitDomainCue logic + tagLegalDomain edge cases.
 * No server — pure logic. Run: pnpm exec tsx scripts/lexery-legal-agent/tools/verify_u2_domain_cues.ts
 */
import { tagLegalDomain } from '../../classify/legal-domain-tagger.js';

// Копія cues з consumer.ts — мають збігатися з hasExplicitDomainCue
function hasExplicitDomainCue(query: string): boolean {
  const q = (query ?? '').trim();
  if (!q || q.length < 3) return false;
  const cues = [
    /(?:^|[\s\W])ККУ(?:[\s\W]|$)/i,
    /(?:^|[\s\W])ПКУ(?:[\s\W]|$)/i,
    /(?:^|[\s\W])ЦКУ(?:[\s\W]|$)/i,
    /(?:^|[\s\W])КЗпП(?:[\s\W]|$)/i,
    /(?:^|[\s\W])КАС(?:[\s\W]|$)/i,
    /кримінальний\s+кодекс/i,
    /податковий\s+кодекс/i,
    /цивільний\s+кодекс/i,
    /ст\.\s*\d+\s*ККУ/i,
    /закон\s+про\s+(освіту|охорону\s+здоров'я)/i,
    /(?:^|[\s\W])МОЗ(?:[\s\W]|$)/i,
    /(?:^|[\s\W])ТОВ(?:[\s\W]|$)/i,
    /(?:^|[\s\W])АТ\s+[«""\w]/i,
  ];
  return cues.some((re) => re.test(q));
}

const CUE_CASES: Array<{ q: string; expectCue: boolean }> = [
  { q: 'Кваліфікація за ст. 119 ККУ', expectCue: true },
  { q: 'ст. 121 ККУ', expectCue: true },
  { q: 'ПКУ податки', expectCue: true },
  { q: 'ЦКУ договір', expectCue: true },
  { q: 'МОЗ наказ', expectCue: true },
  { q: 'ТОВ статут', expectCue: true },
  { q: 'АТ «Банк»', expectCue: true },
  { q: 'А. та Б. уклали договір', expectCue: false },
  { q: 'А. насипав отруту в колодязь сусідки Б.', expectCue: false },
  { q: 'Чи можна стягнути відшкодування за заподіяння шкоди?', expectCue: false },
  { q: 'строк апеляції на рішення суду', expectCue: false },
  { q: 'кримінальний кодекс ст 115', expectCue: true },
  { q: 'закон про освіту', expectCue: true },
  { q: '', expectCue: false },
  { q: 'аб', expectCue: false },
];

const TAGGER_CASES: Array<{ q: string; expectDomain: string }> = [
  { q: 'ККУ ст. 115', expectDomain: 'criminal' },
  { q: 'ст. 119 ККУ кваліфікація', expectDomain: 'criminal' },
  { q: 'договір купівлі-продажу', expectDomain: 'civil' },
  { q: 'звільнення за прогул', expectDomain: 'labor' },
  { q: 'податковий кодекс', expectDomain: 'tax' },
  { q: 'А. насипав отруту сусідці', expectDomain: 'general' },
  { q: 'відшкодування моральної шкоди', expectDomain: 'general' },
  { q: 'МОЗ наказ 2559', expectDomain: 'health' },
];

function main() {
  let cueOk = 0;
  let cueFail = 0;
  for (const { q, expectCue } of CUE_CASES) {
    const got = hasExplicitDomainCue(q);
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
