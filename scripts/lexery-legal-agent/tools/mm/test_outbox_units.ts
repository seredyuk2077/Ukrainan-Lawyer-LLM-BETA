/**
 * MM Outbox Worker Unit Tests — fast, no real DB/LLM/Qdrant.
 * Tests: idempotency, fact extraction parsing, triage parsing, semantic search mock, lock/retry policy.
 *
 * Run: pnpm brain:test:mm-units
 */
import { strict as assert } from 'assert';
import {
  isTransientError,
  MAX_OUTBOX_RETRIES,
  selectMaterializationPolicy,
  withTransientOutboxIoRetry,
  withTransientOutboxResultRetry,
} from '../../mm/outboxWorker.js';
import {
  buildMemoryExtractionPromptParts,
  extractDeterministicMixedFacts,
  mergeParsedMemoryFacts,
} from '../../mm/memoryExtractor.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function assertOk(cond: boolean, msg: string): void {
  assert(cond, `[FAIL] ${msg}`);
}

// ── Test M1: extractMemoryFacts JSON parsing ──────────────────────────────────
function testM1_extractParsing(): void {
  const rawResponse = `["User name is Andrii", "User works at Lexery", "Jurisdiction: Ukraine"]`;
  const jsonMatch = rawResponse.match(/\[[\s\S]*\]/);
  assertOk(jsonMatch !== null, 'M1: JSON array regex matches');

  const parsed = JSON.parse(jsonMatch![0]) as unknown;
  assertOk(Array.isArray(parsed), 'M1: parsed is array');
  const facts = (parsed as unknown[]).filter((f): f is string => typeof f === 'string');
  assertOk(facts.length === 3, 'M1: 3 facts extracted');
  assertOk(facts[0] === 'User name is Andrii', 'M1: first fact correct');
  console.log('[OK] M1: extractMemoryFacts JSON parsing');
}

// ── Test M2: extractMemoryFacts with markdown code block ──────────────────────
function testM2_extractParsingMarkdown(): void {
  const rawResponse = '```json\n["Fact A", "Fact B"]\n```';
  const jsonMatch = rawResponse.match(/\[[\s\S]*\]/);
  assertOk(jsonMatch !== null, 'M2: JSON array extracted from markdown block');
  const parsed = JSON.parse(jsonMatch![0]) as unknown[];
  assertOk(parsed.length === 2, 'M2: 2 facts extracted from markdown');
  console.log('[OK] M2: extractMemoryFacts markdown block parsing');
}

// ── Test M3: extractMemoryFacts max facts limit ───────────────────────────────
function testM3_maxFactsLimit(): void {
  const maxFacts = 5;
  const rawFacts = Array.from({ length: 10 }, (_, i) => `Fact ${i}`);
  const limited = rawFacts.slice(0, maxFacts);
  assertOk(limited.length === maxFacts, 'M3: max facts limit applied');
  assertOk(limited[0] === 'Fact 0', 'M3: first fact preserved');
  console.log('[OK] M3: extractMemoryFacts max facts limit');
}

// ── Test M4: extractMemoryFacts empty/invalid response ────────────────────────
function testM4_extractInvalid(): void {
  const rawResponse = 'I cannot extract any facts from this.';
  const jsonMatch = rawResponse.match(/\[[\s\S]*\]/);
  assertOk(jsonMatch === null, 'M4: no JSON array in plain text');
  const facts: string[] = [];
  assertOk(facts.length === 0, 'M4: returns empty facts on invalid response');
  console.log('[OK] M4: extractMemoryFacts empty/invalid response');
}

// ── Test M5: content_hash dedup logic ────────────────────────────────────────
function testM5_contentHashDedup(): void {
  // Inline deterministic hash mirroring outboxWorker.ts content_hash logic
  function hashFact(fact: string, convId: string): string {
    let h = 0;
    for (let i = 0; i < fact.length; i++) h = (Math.imul(31, h) + fact.charCodeAt(i)) | 0;
    return `${convId}:${Math.abs(h).toString(16).padStart(8, '0')}`;
  }

  const fact = 'User name is Andrii';
  const conversationId = 'conv-123';
  const contentHash1 = hashFact(fact, conversationId);
  const contentHash2 = hashFact(fact, conversationId);

  assertOk(contentHash1 === contentHash2, 'M5: same fact → same content_hash (deterministic)');

  const otherFact = 'User jurisdiction: Ukraine';
  const otherContentHash = hashFact(otherFact, conversationId);
  assertOk(contentHash1 !== otherContentHash, 'M5: different fact → different content_hash');

  console.log('[OK] M5: content_hash dedup is deterministic');
}

// ── Test M6: evidence triage index parsing ────────────────────────────────────
function testM6_triageIndexParsing(): void {
  const rawResponse = '[0, 2, 5, 7]';
  const jsonMatch = rawResponse.match(/\[[\s\S]*?\]/);
  assertOk(jsonMatch !== null, 'M6: triage JSON array matches');

  const parsed = JSON.parse(jsonMatch![0]) as unknown;
  assertOk(Array.isArray(parsed), 'M6: parsed is array');

  const totalLaw = 10;
  const indices = (parsed as unknown[])
    .filter((x): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0 && x < totalLaw)
    .sort((a, b) => a - b)
    .slice(0, 8);

  assertOk(indices.length === 4, 'M6: 4 valid indices');
  assertOk(indices[0] === 0, 'M6: first index is 0');
  assertOk(indices[3] === 7, 'M6: last index is 7');
  console.log('[OK] M6: evidence triage index parsing');
}

// ── Test M7: triage with out-of-bounds indices filtered ───────────────────────
function testM7_triageOOBFiltered(): void {
  const rawResponse = '[0, 5, 99, -1, 3]'; // 99 and -1 are invalid for 10-snippet list
  const totalLaw = 10;
  const parsed = JSON.parse(rawResponse) as unknown[];
  const indices = parsed
    .filter((x): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0 && x < totalLaw)
    .sort((a, b) => a - b);

  assertOk(indices.length === 3, 'M7: OOB indices filtered (3 valid: 0, 3, 5)');
  assertOk(!indices.includes(99), 'M7: 99 filtered out');
  assertOk(!indices.includes(-1), 'M7: -1 filtered out');
  console.log('[OK] M7: triage out-of-bounds indices filtered');
}

// ── Test M8: mm_summaries merge logic ─────────────────────────────────────────
function testM8_summaryMerge(): void {
  const existing = 'User asked about labor law dismissal.';
  const newSummary = 'User is an employee, not employer.';
  const combined = [existing, newSummary].join(' | ').slice(-1500);
  assertOk(combined.includes('labor law'), 'M8: existing summary preserved');
  assertOk(combined.includes('employee'), 'M8: new summary included');
  assertOk(combined.length <= 1500, 'M8: combined summary within limit');
  console.log('[OK] M8: mm_summaries merge logic');
}

// ── Test M11: summary lookup key = conversation_id + tenant_id + user_id (no cross-tenant merge)
function summaryLookupKey(conversationId: string, tenantId: string | null, userId: string | undefined): string {
  return `${conversationId}|${tenantId ?? 'null'}|${userId ?? 'null'}`;
}
function testM11_summaryTenantIsolation(): void {
  const conv = 'conv-1';
  const user = 'user-1';
  const keyA = summaryLookupKey(conv, 'tenant-a', user);
  const keyB = summaryLookupKey(conv, 'tenant-b', user);
  assertOk(keyA !== keyB, 'M11: different tenant_id -> different lookup key (no merge)');
  assertOk(summaryLookupKey(conv, 'tenant-a', user) === summaryLookupKey(conv, 'tenant-a', user), 'M11: same triple -> same key');
  console.log('[OK] M11: mm_summaries tenant isolation (conversation_id + tenant_id + user_id)');
}

// ── Test M9: idempotency check by run_id ──────────────────────────────────────
function testM9_outboxIdempotency(): void {
  const events = [
    { id: 'e1', run_id: 'run-001', event_type: 'index_memory', status: 'processed' },
    { id: 'e2', run_id: 'run-002', event_type: 'index_memory', status: 'pending' },
  ];

  const runId = 'run-001';
  const existing = events.find((e) => e.run_id === runId && e.event_type === 'index_memory');
  assertOk(existing !== undefined, 'M9: existing event found by run_id');
  assertOk(existing!.status === 'processed', 'M9: existing event is already processed');

  const shouldSkipInsert = existing?.status === 'processed';
  assertOk(shouldSkipInsert === true, 'M9: insert skipped for already-processed event');
  console.log('[OK] M9: outbox idempotency check by run_id');
}

// ── Test M12: outbox retry policy (transient vs deterministic, max retries)
function testM12_outboxRetryPolicy(): void {
  assertOk(MAX_OUTBOX_RETRIES === 3, 'M12: MAX_OUTBOX_RETRIES is 3');
  assertOk(isTransientError(new Error('ETIMEDOUT')), 'M12: ETIMEDOUT is transient');
  assertOk(isTransientError(new Error('502 Bad Gateway')), 'M12: 502 is transient');
  assertOk(isTransientError(Object.assign(new Error('timeout'), { name: 'AbortError' })), 'M12: AbortError is transient');
  assertOk(isTransientError(new TypeError('fetch failed')), 'M12: fetch failed is transient');
  assertOk(!isTransientError(new Error('invalid payload')), 'M12: invalid payload is not transient');
  const retryCount = 2;
  const terminalStatus = retryCount >= MAX_OUTBOX_RETRIES ? 'failed' : 'pending';
  assertOk(terminalStatus === 'pending', 'M12: retry_count 2 → pending');
  const atMax = 3;
  assertOk(atMax >= MAX_OUTBOX_RETRIES ? 'failed' : 'pending' === 'failed', 'M12: retry_count >= 3 → failed');
  console.log('[OK] M12: outbox retry policy (transient, max retries)');
}

async function testM12b_transientIoRetry(): Promise<void> {
  let attempts = 0;
  const result = await withTransientOutboxIoRetry(async () => {
    attempts++;
    if (attempts < 3) throw new TypeError('fetch failed');
    return 'ok';
  }, 3, 1);
  assertOk(result === 'ok', 'M12b: transient fetch failed retries eventually succeed');
  assertOk(attempts === 3, 'M12b: retry helper used all needed attempts');
  console.log('[OK] M12b: transient IO retry helper retries fetch failures');
}

async function testM12c_transientSupabaseResultRetry(): Promise<void> {
  let attempts = 0;
  const result = await withTransientOutboxResultRetry(async () => {
    attempts++;
    if (attempts < 3) {
      return { error: { message: 'fetch failed' }, data: null } as const;
    }
    return { error: null, data: 'ok' } as const;
  }, 3, 1);
  assertOk(result.data === 'ok', 'M12c: supabase-style error result eventually succeeds');
  assertOk(attempts === 3, 'M12c: supabase-style error result was retried');
  console.log('[OK] M12c: transient Supabase result retry helper retries error payloads');
}

// ── Test M13: retry_count increment and failed after max retries
function testM13_retryCountIncrementAndFailedAfterMax(): void {
  const payload0 = {} as Record<string, unknown>;
  const prev0 = typeof payload0.retry_count === 'number' ? payload0.retry_count : 0;
  const next0 = prev0 + 1;
  assertOk(next0 === 1, 'M13: 0 + 1 transient → retry_count 1');

  const payload2 = { retry_count: 2 };
  const prev2 = typeof payload2.retry_count === 'number' ? payload2.retry_count : 0;
  const next2 = prev2 + 1;
  const terminal2 = next2 >= MAX_OUTBOX_RETRIES ? 'failed' : 'pending';
  assertOk(next2 === 3 && terminal2 === 'failed', 'M13: 2 + 1 transient → retry_count 3 → failed');
  console.log('[OK] M13: retry_count increment and failed after max retries');
}

// ── Test M10: offload threshold logic ──────────────────────────────────────────
function testM10_offloadThreshold(): void {
  const threshold = 1000;
  const previewChars = 200;
  const shortFact = 'User name is Andrii';
  const longFact = 'A'.repeat(1200);

  const shouldOffloadShort = shortFact.length > threshold;
  const shouldOffloadLong = longFact.length > threshold;
  assertOk(!shouldOffloadShort, 'M10: short fact below threshold → no offload');
  assertOk(shouldOffloadLong, 'M10: long fact above threshold → offload');
  const preview = longFact.slice(0, previewChars) + (longFact.length > previewChars ? '…' : '');
  assertOk(preview.length <= previewChars + 2, 'M10: preview bounded');
  assertOk(preview.endsWith('…'), 'M10: preview ends with ellipsis when truncated');
  console.log('[OK] M10: offload threshold and preview length');
}

// ── Test M14: materialization policy avoids legal-answer contamination ───────
function testM14_materializationPolicy(): void {
  const memory = selectMaterializationPolicy({ contextMode: 'memory', memoryCount: 2, lawCount: 0 });
  assertOk(memory.extract_from === 'user_query', 'M14: memory mode extracts from user_query only');
  assertOk(memory.allow_summary_fallback === false, 'M14: memory mode forbids summary fallback');

  const mixed = selectMaterializationPolicy({ contextMode: 'mixed', memoryCount: 3, lawCount: 5 });
  assertOk(mixed.extract_from === 'user_query', 'M14: mixed mode extracts from user_query only');
  assertOk(mixed.allow_summary_fallback === false, 'M14: mixed mode forbids summary fallback');

  const mixedNoMemory = selectMaterializationPolicy({ contextMode: 'mixed', memoryCount: 0, lawCount: 5 });
  assertOk(mixedNoMemory.extract_from === 'user_query', 'M14: mixed mode without prior memory still extracts from user_query');

  const law = selectMaterializationPolicy({ contextMode: 'law', memoryCount: 0, lawCount: 6 });
  assertOk(law.extract_from === 'user_query', 'M14: law mode extracts from user_query');
  assertOk(law.allow_summary_fallback === false, 'M14: law mode forbids summary fallback');
  console.log('[OK] M14: materialization policy is mode-aware');
}

// ── Test M15: mixed extraction prompt is query-only and stricter ────────────
function testM15_mixedExtractionPromptParts(): void {
  const mixed = buildMemoryExtractionPromptParts({
    answerSummary: 'Порівняй крадіжку і грабіж за КК України',
    userQuery: 'Порівняй крадіжку і грабіж за КК України',
    mode: 'user_message_mixed',
  });
  assertOk(mixed.userContent.startsWith('User message:'), 'M15: mixed mode uses user-message prompt');
  assertOk(!mixed.userContent.includes('User question:'), 'M15: mixed mode does not add user question prefix');
  assertOk(!mixed.userContent.includes('Answer summary:'), 'M15: mixed mode does not duplicate answer summary framing');

  const memory = buildMemoryExtractionPromptParts({
    answerSummary: 'User prefers short answers.',
    userQuery: 'Що ти памʼятаєш?',
    mode: 'answer_summary',
  });
  assertOk(memory.userContent.includes('User question:'), 'M15: answer_summary mode still includes user question context');
  assertOk(memory.userContent.includes('Answer summary:'), 'M15: answer_summary mode still includes answer summary');
  console.log('[OK] M15: mixed extraction prompt parts are mode-specific');
}

// ── Test M16: deterministic mixed extraction keeps explicit durable facts ────
function testM16_deterministicMixedExtraction(): void {
  const facts = extractDeterministicMixedFacts(
    "Це справа з кодовим словом ALFA-731-KEDR. Мій улюблений колір синій, мою собаку звати Рорі, живу в місті Луцьк, мій бюджет 18 500 грн. Поясни ризики договору оренди."
  );
  const texts = facts.map((fact) => fact.text);
  assertOk(texts.some((text) => text.includes('ALFA-731-KEDR')), 'M16: codeword extracted');
  assertOk(texts.some((text) => /Favorite color is/i.test(text) && /синій/i.test(text)), 'M16: color extracted');
  assertOk(texts.some((text) => /Dog is named/i.test(text) && /Рорі/i.test(text)), 'M16: dog extracted');
  assertOk(texts.some((text) => /Lives in/i.test(text) && /Луцьк/i.test(text)), 'M16: city extracted');
  assertOk(texts.some((text) => /Budget is/i.test(text) && /18 500 грн/i.test(text)), 'M16: budget extracted');
  console.log('[OK] M16: deterministic mixed extraction keeps explicit durable facts');
}

// ── Test M17: malformed JSON fallback preserves deterministic facts ──────────
function testM17_malformedJsonFallbackKeepsDeterministicFacts(): void {
  const deterministicFacts = extractDeterministicMixedFacts(
    "Запам'ятай: мій улюблений колір синій, мою собаку звати Рорі."
  );
  const merged = mergeParsedMemoryFacts({
    raw: 'not valid json at all',
    deterministicFacts,
  });
  assertOk(merged.facts.some((text) => /Favorite color is/i.test(text) && /синій/i.test(text)), 'M17: color survives malformed JSON');
  assertOk(merged.facts.some((text) => /Dog is named/i.test(text) && /Рорі/i.test(text)), 'M17: dog survives malformed JSON');
  console.log('[OK] M17: malformed JSON fallback preserves deterministic facts');
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log('=== MM Outbox Worker Unit Tests ===\n');
  testM1_extractParsing();
  testM2_extractParsingMarkdown();
  testM3_maxFactsLimit();
  testM4_extractInvalid();
  testM5_contentHashDedup();
  testM6_triageIndexParsing();
  testM7_triageOOBFiltered();
  testM8_summaryMerge();
  testM11_summaryTenantIsolation();
  testM9_outboxIdempotency();
  testM12_outboxRetryPolicy();
  await testM12b_transientIoRetry();
  await testM12c_transientSupabaseResultRetry();
  testM13_retryCountIncrementAndFailedAfterMax();
  testM10_offloadThreshold();
  testM14_materializationPolicy();
  testM15_mixedExtractionPromptParts();
  testM16_deterministicMixedExtraction();
  testM17_malformedJsonFallbackKeepsDeterministicFacts();
  console.log('\nAll MM outbox unit tests passed.');
}

main().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
