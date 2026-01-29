/**
 * Priority Ladder — пріоритети сигналів для визначення document type
 * 
 * Документований порядок перевірки сигналів (від найсильніших до найслабших):
 * 
 * 1. document_number suffix rules (найсильніші)
 *    - -РП → presidential_order
 *    - -РГ → vr_speaker_order
 *    - z****-** → vr_resolution
 *    - v*/va* → court_decision/ccu_decision
 *    - 995_* → international_treaty
 *    - 984_* → eu_directive/eu_regulation
 * 
 * 2. raw_txt prefix sniff (якщо доступний)
 *    - "ДЕКРЕТ КАБІНЕТУ МІНІСТРІВ УКРАЇНИ" → cmu_decree
 *    - "НАЦІОНАЛЬНА КОМІСІЯ ... ПОСТАНОВА" → nerc_resolution
 *    - "ЦЕНТРАЛЬНА ВИБОРЧА КОМІСІЯ ... ПОСТАНОВА" → cec_resolution
 *    - "РІШЕННЯ РНБО" → rnbo_decision
 *    - "УКАЗ ПРЕЗИДЕНТА" → presidential_decree
 *    - "КАБІНЕТ МІНІСТРІВ УКРАЇНИ ПОСТАНОВА" → cmu_resolution
 *    - "ВЕРХОВНА РАДА УКРАЇНИ ПОСТАНОВА" → vr_resolution
 * 
 * 3. snippet200 prefix sniff (аналогічно raw_txt, але коротший)
 *    - Те самі правила що і для raw_txt
 * 
 * 4. summary_prefix signals (тільки якщо snippet/raw_txt недоступні або слабкі)
 *    - Перевірка на ЦВК/РНБО/НБУ/НКРЕКП
 * 
 * 5. organs/typ metadata (ЛИШЕ ЯК fallback, не навпаки)
 *    - organs="2:..." → КМУ (але перевіряємо snippet/raw_txt ПЕРЕД довірянням)
 *    - organs="1:..." → ВРУ (але перевіряємо snippet/raw_txt ПЕРЕД довірянням)
 *    - typ=1 → law
 *    - typ=2 → resolution (але потрібно визначити issuer)
 * 
 * 6. title heuristics (останній fallback)
 *    - "Кодекс" → code
 *    - "Конституція" → constitution
 * 
 * 7. default "cmu_resolution" — ЗАБОРОНЕНО як дефолт без перевірки issuer/kind signals
 *    - Якщо issuer signal ≠ CMU → не дефолтимо на cmu_resolution
 *    - Якщо issuer signal = OTHER → unknown (потрібен AI fallback)
 */

export const PRIORITY_LADDER = {
  SUFFIX_RULES: 1,
  RAW_TXT_PREFIX: 2,
  SNIPPET_PREFIX: 3,
  SUMMARY_PREFIX: 4,
  ORGANS_TYP: 5,
  TITLE_HEURISTICS: 6,
  DEFAULT: 7,
} as const;

/**
 * Документація priority ladder для використання в коді
 */
export function getPriorityLadderDoc(): string {
  return `
Priority Ladder для визначення document type:

1. document_number suffix rules (найсильніші)
2. raw_txt prefix sniff (якщо доступний)
3. snippet200 prefix sniff
4. summary_prefix signals
5. organs/typ metadata (fallback)
6. title heuristics
7. default (заборонено без перевірки issuer)
`;
}
