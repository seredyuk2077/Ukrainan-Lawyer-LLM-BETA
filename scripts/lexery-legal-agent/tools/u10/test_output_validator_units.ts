/**
 * Output validator unit tests (DEV RUN v14; PHASE 2: citation count).
 */
import {
  validateOutput,
  countArticleRefs,
  stripGratuitousLegalCitation,
  sanitizeUnsupportedDocAbsenceAnswer,
  sanitizeDocsOnlyNoEvidenceAnswer,
  hasFalseDocAbsenceClaim,
} from '../../write/outputValidator.js';
import type { FocusSpec } from '../../write/focusSpec.js';

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`ASSERT FAIL: ${msg}`);
}

const FOCUS_CRIME: FocusSpec = {
  taskType: 'crime_composition',
  primaryNormSourceId: 'kku_115::$.content.chunks[0].text',
  primaryNormConfidence: 'high',
  requiredSections: ['NormQuote', 'Composition', 'Sanction'],
  maxLawSnippets: 3,
  citationStyle: 'ua_dstu_npa',
  bannedPhrases: ['надані матеріали', 'наданих матеріалів'],
  tone: 'юридична українська',
};

function testBadAnswerBannedPhrase(): void {
  const bad = 'Відповідно до наданих матеріалів, умисне вбивство передбачено ст. 115.';
  const r = validateOutput(bad, FOCUS_CRIME);
  assert(!r.pass, 'fail when banned phrase present');
  assert(r.warnings.some((w) => w.includes('banned_phrase')), 'warning for banned phrase');
  console.log('[OK] Validator: banned phrase triggers fail');
}

function testGoodAnswerPasses(): void {
  const good =
    'Норма: Кримінальний кодекс України, ч. 1 ст. 115. Цитата: Умисне вбивство — вчинення з умислом заподіяння смерті. ' +
    'Склад злочину: Об\'єкт — життя; об\'єктивна сторона — дія; суб\'єкт — фізична особа; суб\'єктивна сторона — умисел. Санкція: 7–15 років.';
  const r = validateOutput(good, FOCUS_CRIME);
  assert(r.pass, 'pass when citation + composition present, no banned phrase');
  console.log('[OK] Validator: good answer passes');
}

function testCountArticleRefsVariants(): void {
  assert(countArticleRefs('ст. 185 та ст. 186') >= 2, 'ст. N counted');
  assert(countArticleRefs('ст 231') >= 1, 'ст N (no dot) counted');
  assert(countArticleRefs('стаття 115 ККУ') >= 1, 'стаття N counted');
  const partArt = countArticleRefs('відповідальність за ч. 1 ст. 185 ККУ');
  assert(partArt >= 1, 'ч. N ст. M counted as citation');
  console.log('[OK] Validator: countArticleRefs ст/стаття/ч. N ст. M');
}

const FOCUS_MEMORY: FocusSpec = {
  taskType: 'memory_recall',
  primaryNormSourceId: null,
  primaryNormConfidence: 'low',
  requiredSections: [],
  maxLawSnippets: 2,
  citationStyle: 'ua_dstu_npa',
  bannedPhrases: [],
  tone: 'нейтральна',
};

function testMemoryRecallGratuitousCitation(): void {
  const withLaw = 'Користувач питав про крадіжку. Закон України від 05.04.2001 ст. 185 передбачає відповідальність.';
  const r = validateOutput(withLaw, FOCUS_MEMORY, { lawCount: 0, memoryCount: 1, historyCount: 0 });
  assert(r.warnings.includes('gratuitous_legal_citation_in_memory_mode'), 'memory_recall+law0+article refs -> gratuitous citation warning');
  const noLaw = 'Користувач питав про крадіжку та грабіж. Ви обговорювали різницю.';
  const r2 = validateOutput(noLaw, FOCUS_MEMORY, { lawCount: 0 });
  assert(!r2.warnings.includes('gratuitous_legal_citation_in_memory_mode'), 'no gratuitous when no article refs');
  console.log('[OK] Validator: memory_recall law0 flags gratuitous citation');
}

function testStripGratuitousLegalCitation(): void {
  const raw = 'Пам\'ятаю: ви питали про ст. 115. Закон України від 05.04.2001 передбачає вбивство.';
  const stripped = stripGratuitousLegalCitation(raw);
  assert(countArticleRefs(stripped) < countArticleRefs(raw), 'strip reduces article ref count');
  console.log('[OK] Validator: stripGratuitousLegalCitation reduces refs');
}

function testMemoryRecallSubstantiveLegalWithoutArticleRefs(): void {
  const substantive =
    'Крадіжка означає таємне викрадення майна, а грабіж - відкрите заволодіння майном.';
  const r = validateOutput(substantive, FOCUS_MEMORY, { lawCount: 0, memoryCount: 1, historyCount: 0 });
  assert(
    !r.warnings.includes('substantive_legal_answer_in_memory_mode'),
    'heuristic removed: validator does not add substantive_legal_answer_in_memory_mode (judge path in consumer)'
  );
  assert(!r.warnings.includes('gratuitous_legal_citation_in_memory_mode'), 'no ст. refs in this answer');
  console.log('[OK] Validator: memory_recall law0 no heuristic substantive flag (grounded judge in consumer)');
}

function testMemoryRecallValidConversationRecall(): void {
  const conversationRecall =
    'Ми обговорювали різницю між крадіжкою і грабежем, а також ваш фокус на memory stabilization.';
  const r = validateOutput(conversationRecall, FOCUS_MEMORY, { lawCount: 0, memoryCount: 1, historyCount: 0 });
  assert(
    !r.warnings.includes('substantive_legal_answer_in_memory_mode'),
    'conversation-recall phrasing must not be flagged as substantive legal'
  );
  console.log('[OK] Validator: valid memory recall about legal topic passes');
}

function testSanitizeUnsupportedDocAbsenceAnswer(): void {
  const sanitized = sanitizeUnsupportedDocAbsenceAnswer({
    answerText:
      'У наданих витягах відсутні відповідні положення щодо "манго 99 відсотків" або "FOREIGN_CHAT_NEEDLE".',
    queryText: 'манго 99 відсотків FOREIGN_CHAT_NEEDLE',
    evidenceTexts: ['Закон України про зовнішньоекономічну діяльність'],
    docCount: 0,
  });
  assert(!sanitized.includes('FOREIGN_CHAT_NEEDLE'), 'sanitizer must remove unsupported marker echo');
  assert(!sanitized.includes('99 відсотків'), 'sanitizer must remove unsupported numeric echo');
  assert(sanitized.includes('підтвердження не знайдено'), 'sanitizer should emit neutral no-doc message');

  const unchangedWithDocs = sanitizeUnsupportedDocAbsenceAnswer({
    answerText: 'У документі є штраф 12 відсотків.',
    queryText: 'штраф 12 відсотків',
    evidenceTexts: ['штраф 12 відсотків'],
    docCount: 1,
  });
  assert(unchangedWithDocs === 'У документі є штраф 12 відсотків.', 'sanitizer must not change supported doc answer');
  console.log('[OK] Validator: unsupported doc absence echo is sanitized');
}

function testDocsOnlyNoLawCitationGuard(): void {
  const docsOnlyWithLaw =
    '• Норма (цитування): Цивільний кодекс України: ст. 563, ч. 2.\n• Цитата: "гарантійний платіж повертається за 7 банківських днів".';
  const warned = validateOutput(docsOnlyWithLaw, DOC_ONLY_FOCUS, {
    lawCount: 0,
    docCount: 1,
    historyCount: 1,
  });
  assert(
    warned.warnings.includes('gratuitous_legal_citation_without_law_evidence'),
    'docs-only + law0 + article refs must be flagged'
  );
  assert(
    warned.warnings.includes('legal_norm_section_without_law_evidence'),
    'docs-only + law0 + norm section must be flagged'
  );
  const docsOnlyWithLegalRagFraming =
    'Витяги з норм законодавства з внутрішньої бази Lexery не містять інформації про передсудове врегулювання.';
  const ragFraming = validateOutput(docsOnlyWithLegalRagFraming, DOC_ONLY_FOCUS, {
    lawCount: 0,
    docCount: 1,
    historyCount: 1,
  });
  assert(
    ragFraming.warnings.includes('legal_rag_framing_without_law_evidence'),
    'docs-only + law0 + legal RAG framing must be flagged'
  );
  const docsOnlyWithLegalAbsenceFraming =
    'Гарантійний платіж повертається за 7 банківських днів. Норм законодавства щодо цього питання не було надано.';
  const absenceFraming = validateOutput(docsOnlyWithLegalAbsenceFraming, DOC_ONLY_FOCUS, {
    lawCount: 0,
    docCount: 1,
    historyCount: 1,
  });
  assert(
    absenceFraming.warnings.includes('legal_rag_framing_without_law_evidence'),
    'docs-only + law0 + legislation-absence framing must be flagged'
  );

  const docsOnlyClean = 'У вашому документі зазначено, що гарантійний платіж повертається за 7 банківських днів.';
  const clean = validateOutput(docsOnlyClean, DOC_ONLY_FOCUS, { lawCount: 0, docCount: 1 });
  assert(
    !clean.warnings.includes('gratuitous_legal_citation_without_law_evidence'),
    'clean docs-only answer must not be flagged'
  );
  assert(
    !clean.warnings.includes('missing_citation'),
    'docs-only answer with no law evidence must not demand legal citations'
  );
  console.log('[OK] Validator: docs-only answers do not require law citations and flag invented ones');
}

function testFalseDocAbsenceClaim(): void {
  const flagged = hasFalseDocAbsenceClaim({
    answerText: 'У ваших документах не міститься інформації про передсудове врегулювання.',
    queryText: 'Повтори лише строк з таблиці щодо передсудового врегулювання з мого документа.',
    evidenceTexts: [
      'Передсудове врегулювання триває 15 робочих днів до подання позову.',
      'Передсудове врегулювання | 15 робочих днів',
    ],
    docCount: 2,
  });
  assert(flagged, 'false docs absence with supporting evidence must be detected');

  const clean = hasFalseDocAbsenceClaim({
    answerText: 'У ваших документах не міститься інформації про арбітраж у Лондоні.',
    queryText: 'Який арбітраж у Лондоні?',
    evidenceTexts: ['Гарантійний платіж | 7 банківських днів'],
    docCount: 1,
  });
  assert(!clean, 'absence claim without supporting evidence must not be flagged');
  console.log('[OK] Validator: false doc absence claim detection');
}

const DEFAULT_GENERAL_FOCUS: FocusSpec = {
  taskType: 'general',
  primaryNormSourceId: null,
  primaryNormConfidence: 'low',
  requiredSections: [],
  maxLawSnippets: 4,
  citationStyle: 'ua_dstu_npa',
  bannedPhrases: [],
  tone: 'нейтральна',
};

const DOC_ONLY_FOCUS: FocusSpec = {
  ...DEFAULT_GENERAL_FOCUS,
  maxLawSnippets: 0,
};

function testDocsOnlyNoEvidenceSanitizer(): void {
  const warned = validateOutput(
    'Витяги з норм законодавства з внутрішньої бази Lexery не містять інформації про ICC.',
    DOC_ONLY_FOCUS,
    { lawCount: 0, docCount: 0 }
  );
  assert(
    warned.warnings.includes('legal_rag_framing_without_law_evidence'),
    'docs-only no-hit answer with legal RAG framing must be flagged'
  );

  const sanitized = sanitizeDocsOnlyNoEvidenceAnswer({
    answerText: 'Витяги з норм законодавства з внутрішньої бази Lexery не містять інформації про ICC.',
    focusSpec: DOC_ONLY_FOCUS,
    lawCount: 0,
    docCount: 0,
  });
  assert(!/внутрішнь(?:ої|я)\s+бази\s+lexery/i.test(sanitized), 'sanitizer must remove LLDBI framing');
  assert(/доступних документах/i.test(sanitized), 'sanitizer should produce neutral docs-only no-hit wording');
  console.log('[OK] Validator: docs-only no-hit answers are neutralized');
}

function main(): void {
  console.log('Output validator unit tests\n');
  testBadAnswerBannedPhrase();
  testGoodAnswerPasses();
  testCountArticleRefsVariants();
  testMemoryRecallGratuitousCitation();
  testStripGratuitousLegalCitation();
  testMemoryRecallSubstantiveLegalWithoutArticleRefs();
  testMemoryRecallValidConversationRecall();
  testSanitizeUnsupportedDocAbsenceAnswer();
  testDocsOnlyNoLawCitationGuard();
  testFalseDocAbsenceClaim();
  testDocsOnlyNoEvidenceSanitizer();
  console.log('\nAll output validator unit tests passed.');
}

main();
