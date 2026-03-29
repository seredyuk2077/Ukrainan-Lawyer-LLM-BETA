import { normalizeContextModeForLldbiHints } from '../../classify/consumer.js';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERT FAIL: ${message}`);
}

function testLegalHintsPromoteUndefinedContextModeToLaw(): void {
  const query = 'Де Нацбанк на 25 березня 2026 року закріпив офіційний курс гривні до іноземних валют?';
  const contextMode = normalizeContextModeForLldbiHints(query, undefined, {
    categories_ranked_top3: [],
    document_types_ranked_top3: ['Повідомлення НБУ'],
  });
  assert(contextMode === 'law', `Expected law context mode, got ${String(contextMode)}`);
  console.log('[OK] LLDBI hints promote unresolved soft legal query to law');
}

function testLegalHintsCorrectWrongMemoryModeWithoutExplicitRecall(): void {
  const query = 'Де Нацбанк на 25 березня 2026 року зафіксував облікову ціну банківських металів?';
  const contextMode = normalizeContextModeForLldbiHints(query, 'memory', {
    categories_ranked_top3: [],
    document_types_ranked_top3: ['Повідомлення НБУ'],
  });
  assert(contextMode === 'law', `Expected memory drift to normalize to law, got ${String(contextMode)}`);
  console.log('[OK] LLDBI hints correct accidental memory mode for soft legal query');
}

function testExplicitMemoryRecallStaysMixedWhenLegalHintsExist(): void {
  const query = "З урахуванням того, що ми обговорювали, де НБУ встановлює офіційний курс гривні?";
  const contextMode = normalizeContextModeForLldbiHints(query, 'memory', {
    categories_ranked_top3: [],
    document_types_ranked_top3: ['Повідомлення НБУ'],
  });
  assert(contextMode === 'mixed', `Expected mixed context mode, got ${String(contextMode)}`);
  console.log('[OK] explicit memory recall stays mixed when legal hints exist');
}

function testNoHintsLeaveContextModeUntouched(): void {
  const query = 'Що ти памʼятаєш про наші попередні запити?';
  const contextMode = normalizeContextModeForLldbiHints(query, undefined, {
    categories_ranked_top3: [],
    document_types_ranked_top3: [],
  });
  assert(contextMode === undefined, `Expected undefined without LLDBI hints, got ${String(contextMode)}`);
  console.log('[OK] no LLDBI hints leave context mode untouched');
}

function main(): void {
  console.log('context mode hints unit tests\n');
  testLegalHintsPromoteUndefinedContextModeToLaw();
  testLegalHintsCorrectWrongMemoryModeWithoutExplicitRecall();
  testExplicitMemoryRecallStaysMixedWhenLegalHintsExist();
  testNoHintsLeaveContextModeUntouched();
  console.log('\nAll context mode hints unit tests passed.');
}

main();
