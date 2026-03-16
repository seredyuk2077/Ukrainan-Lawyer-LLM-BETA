/**
 * U9 Assemble unit tests — assemblePrompt with mock RunContext/U4Result/GateDecision.
 * Run: pnpm brain:test:u9-units
 *
 * Tests:
 *   1) basic law/memory/history channel presence
 *   2) missing R2 (no config) → graceful placeholder, no crash, loadErrorsCount > 0
 *   3) dedup: identical r2_key+json_path → single snippet
 *   4) budgeting: deterministic (same input → same output)
 *   5) provenance: sourceRef present per contextPart
 *   6) token estimate populated in meta
 */
import { assemblePrompt } from '../../assemble/assemblePrompt.js';
import {
  isTransientMmDocsContextError,
  loadRunRecordForU9,
  shouldRetrieveMmDocsContext,
  withTransientMmDocsContextRetry,
} from '../../assemble/consumer.js';
import {
  parseMetaTriageIndices,
  fallbackTopNByScore,
  coveragePreservingFallback,
  gapFreeDeterministicFallback,
  extractArticleNumbersFromQuery,
  shouldUseDirectRefDeterministicTriage,
  shouldUseStructuredMetaTriageOutput,
  shouldFallbackImmediatelyOnEmptyMetaTriageOutput,
} from '../../assemble/metaTriage.js';
import { getStrongArticleRefsNormalized } from '../../lib/articleRefs.js';
import {
  extractTextByJsonPath,
  truncateSnippetText,
  _setR2ClientForTest,
} from '../../retrieval/r2-fragment.js';
import type { RunContext, U4Result, GateDecision, LawSourceRef } from '../../lib/pipeline/contracts.js';
import type { S3Client } from '@aws-sdk/client-s3';
import { RunRepository, StorageError } from '../../gateway/storage.js';

// ---- helpers ----

function hasContextPartType(parts: { type: string }[], type: string): boolean {
  return parts.some((p) => p.type === type);
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`ASSERT FAIL: ${msg}`);
}

const GATE_OK: GateDecision = {
  expand: false,
  reason_codes: ['OK'],
  thresholds: { min_hits: 3, min_avg_score: 0.18 },
  signals: { hits_count: 0, top_score: null, avg_score: null },
  meta: {},
};

// ---- Mock R2 client ----

const MOCK_SNIPPET = 'Стаття 185. Крадіжка — позбавлення волі строком до 3 років.';

function makeMockR2Client(text = MOCK_SNIPPET): S3Client {
  const fakeBody = {
    transformToString: async (_enc: string) => {
      return JSON.stringify({ content: { chunks: [{ text }] } });
    },
  };
  return {
    send: async () => ({ Body: fakeBody }),
  } as unknown as S3Client;
}

// ---- Test 1: law + memory + history channels ----

async function testBasicChannels(): Promise<void> {
  _setR2ClientForTest(null); // no R2 — law snippets will be missing markers
  const runContext: RunContext = {
    run_id: 'test-1',
    tenant_id: null,
    user_id: 'user-1',
    user_input: 'Що карається за ст. 115 ККУ?',
    query_profile: { routing_flags: { context_mode: 'mixed' } },
    search_plan: { sources: { use_memory: true, use_lldbi: true } },
    history: [
      { role: 'user', content: 'Перше повідомлення' },
      { role: 'assistant', content: 'Відповідь' },
      { role: 'user', content: 'Друге питання' },
    ],
    memory_items: [{ id: 'mem-1', content_preview: 'Preview from memory' }],
    memory_summaries: [{ scope: 'case', summary_text: 'Summary text' }],
  };
  const u4: U4Result = { rawHits: [], retrievalTrace: { version: 1, hits: [] } };

  const assembled = await assemblePrompt({ runContext, u4, gate: GATE_OK });

  assert(assembled.systemPrompt.length > 10, 'systemPrompt not empty');
  assert(assembled.userPrompt === runContext.user_input, 'userPrompt = user_input');
  assert(hasContextPartType(assembled.contextParts, 'memory'), 'has memory parts');
  assert(hasContextPartType(assembled.contextParts, 'history'), 'has history parts');
  assert(assembled.contextParts.filter((p) => p.type === 'memory').length >= 2, 'at least 2 memory parts');
  const historyParts = assembled.contextParts.filter((p) => p.type === 'history');
  assert(historyParts.length >= 1 && historyParts.length <= 3, 'history parts within per-mode cap (mixed=1)');
  assert(assembled.meta?.budget !== undefined, 'budget present in meta');
  assert(typeof assembled.meta?.budget?.tokenEstimateTotal === 'number', 'tokenEstimateTotal is number');
  console.log('[OK] test 1: basic channels (law=0 + memory + history)');
}

async function testDocsChannelIncludedAheadOfMemory(): Promise<void> {
  _setR2ClientForTest(makeMockR2Client());
  const runContext: RunContext = {
    run_id: 'test-doc-channel',
    tenant_id: 'tenant-1',
    user_id: 'user-doc',
    user_input: 'Що сказано про штраф у моєму договорі?',
    query_profile: { routing_flags: { context_mode: 'mixed' } },
    search_plan: { sources: { use_memory: true, use_lldbi: true } },
    doc_snippets: [
      {
        doc_id: 'doc-1',
        text: 'Умови договору: штраф за прострочення платежу становить 15 відсотків.',
        score: 0.91,
        r2_key: 'mm-docs/doc-1.json',
        json_path: '$.content.chunks[0].text',
        scope_type: 'project',
        scope_id: 'project-1',
        filename: 'contract.docx',
      },
    ],
    memory_summaries: [{ scope: 'conversation', summary_text: 'Памʼять про інший факт' }],
  };
  const u4: U4Result = { rawHits: [], retrievalTrace: { version: 1, hits: [] } };

  const assembled = await assemblePrompt({ runContext, u4, gate: GATE_OK });
  const docParts = assembled.contextParts.filter((p) => p.type === 'doc');

  assert(docParts.length === 1, 'expected 1 doc part');
  assert(docParts[0].text.includes('15 відсотків'), 'doc snippet text preserved');
  assert((assembled.meta?.sources?.docCount ?? 0) === 1, 'meta.sources.docCount=1');
  assert(
    assembled.contextParts.findIndex((p) => p.type === 'doc') <
      assembled.contextParts.findIndex((p) => p.type === 'memory'),
    'doc evidence must be placed ahead of memory in non-memory mode'
  );
  console.log('[OK] test docs channel: docs included and ordered before memory');
}

async function testExplicitDocQuerySkipsLawAssembly(): Promise<void> {
  _setR2ClientForTest(makeMockR2Client());
  const runContext: RunContext = {
    run_id: 'test-doc-only-no-law',
    tenant_id: 'tenant-1',
    user_id: 'user-doc-only',
    user_input: 'Що сказано у моєму договорі про штраф за прострочення?',
    query_profile: { routing_flags: { context_mode: 'law' } },
    search_plan: { sources: { use_memory: false, use_lldbi: true } },
    doc_snippets: [
      {
        doc_id: 'doc-1',
        text: 'Умови договору: штраф за прострочення платежу становить 15 відсотків.',
        score: 0.92,
        r2_key: 'mm-docs/doc-1.json',
        json_path: '$.content.chunks[0].text',
        scope_type: 'project',
        scope_id: 'project-1',
        filename: 'contract.docx',
      },
    ],
  };
  const u4: U4Result = {
    rawHits: [{ r2_key: 'acts/625.json', json_path: '$.content.chunks[0].text', score: 0.95, title: 'ЦК України', article_number: '625' }],
    retrievalTrace: { version: 1, hits: [] },
  };

  const assembled = await assemblePrompt({ runContext, u4, gate: GATE_OK });

  assert(assembled.contextParts.filter((p) => p.type === 'law').length === 0, 'explicit docs-only query must skip law parts in U9');
  assert((assembled.meta?.sources?.lawCount ?? -1) === 0, 'explicit docs-only query must report lawCount=0');
  assert((assembled.meta?.sources?.docCount ?? 0) === 1, 'explicit docs-only query must keep doc evidence');
  console.log('[OK] test docs-only query: U9 skips law assembly when docs evidence is explicit and no legal reference is requested');
}

async function testLongDocSnippetTruncatesSafely(): Promise<void> {
  _setR2ClientForTest(makeMockR2Client());
  const longDocText = `${'Дуже довгий фрагмент договору. '.repeat(140)} Кінцева унікальна умова.`;
  const runContext: RunContext = {
    run_id: 'test-doc-long-truncate',
    tenant_id: 'tenant-1',
    user_id: 'user-doc-long',
    user_input: 'Що сказано у моєму договорі?',
    query_profile: { routing_flags: { context_mode: 'mixed' } },
    search_plan: { sources: { use_memory: false, use_lldbi: false } },
    doc_snippets: [
      {
        doc_id: 'doc-long-1',
        text: longDocText,
        score: 0.93,
        r2_key: 'mm-docs/doc-long.json',
        json_path: '$.content.chunks[0].text',
        scope_type: 'project',
        scope_id: 'project-1',
        filename: 'large-contract.docx',
      },
    ],
  };
  const u4: U4Result = { rawHits: [], retrievalTrace: { version: 1, hits: [] } };

  const assembled = await assemblePrompt({ runContext, u4, gate: GATE_OK });
  const docPart = assembled.contextParts.find((p) => p.type === 'doc');

  assert(Boolean(docPart), 'long MM Docs snippet should still produce a doc context part');
  assert((docPart?.text.length ?? 0) <= 2000, `long MM Docs snippet must be truncated to a safe size (got ${docPart?.text.length ?? 0})`);
  console.log('[OK] test long doc snippet: truncates safely without runtime error');
}

async function testMemoryModeExcludesLawContext(): Promise<void> {
  _setR2ClientForTest(makeMockR2Client());
  const runContext: RunContext = {
    run_id: 'test-memory-mode',
    tenant_id: null,
    user_id: 'user-memory',
    user_input: 'Що ти пам\'ятаєш про мої попередні запити?',
    query_profile: { routing_flags: { context_mode: 'memory' } },
    search_plan: { sources: { use_memory: true, use_lldbi: false } },
    history: [{ role: 'user', content: 'Попередній контекст' }],
    memory_items: [{ id: 'mem-1', content_preview: 'Клієнт питає про memory mode' }],
    memory_summaries: [{ scope: 'case', summary_text: 'Обговорювали тільки попередню розмову' }],
  };
  const u4: U4Result = {
    rawHits: [{ r2_key: 'acts/185.json', json_path: '$.content.chunks[0].text', score: 0.95 }],
    retrievalTrace: { version: 1, hits: [] },
  };

  const assembled = await assemblePrompt({ runContext, u4, gate: GATE_OK });

  const lawParts = assembled.contextParts.filter((p) => p.type === 'law');
  assert(lawParts.length === 0, `memory mode must exclude law context (got ${lawParts.length})`);
  assert(assembled.meta?.sources?.lawCount === 0, 'memory mode sources.lawCount=0');
  assert(assembled.contextParts[0]?.type === 'memory', 'memory mode keeps memory/history first');
  console.log('[OK] test memory mode: pure memory excludes law context even with raw hits present');
}

async function testMemoryModeUsesUserHistoryOnly(): Promise<void> {
  _setR2ClientForTest(makeMockR2Client());
  const runContext: RunContext = {
    run_id: 'test-memory-history-users-only',
    tenant_id: null,
    user_id: 'user-memory-history',
    user_input: 'Що ти пам\'ятаєш про мене з початку розмови?',
    query_profile: { routing_flags: { context_mode: 'memory' } },
    search_plan: { sources: { use_memory: true, use_lldbi: false } },
    history: [
      { role: 'user', content: 'Мій улюблений колір — синій.' },
      { role: 'assistant', content: 'Крадіжка — це таємне викрадення майна.' },
      { role: 'user', content: 'Мою собаку звати Рорі.' },
      { role: 'assistant', content: 'Грабіж — це відкрите викрадення майна.' },
    ],
    memory_items: [{ id: 'mem-1', content_preview: 'Favorite color is blue' }],
    memory_summaries: [{ scope: 'conversation', summary_text: "Dog's name is Rori" }],
  };
  const u4: U4Result = {
    rawHits: [{ r2_key: 'acts/185.json', json_path: '$.content.chunks[0].text', score: 0.9 }],
    retrievalTrace: { version: 1, hits: [] },
  };

  const assembled = await assemblePrompt({ runContext, u4, gate: GATE_OK });
  const historyTexts = assembled.contextParts.filter((p) => p.type === 'history').map((p) => p.text);

  assert(historyTexts.length === 2, `memory mode should keep only user history (got ${historyTexts.length})`);
  assert(historyTexts.every((text) => text.startsWith('user: ')), 'memory mode history contains only user messages');
  assert(!historyTexts.some((text) => text.includes('Крадіжка') || text.includes('Грабіж')), 'assistant legal answers are excluded from memory-mode history');
  console.log('[OK] test memory mode: history excludes assistant legal answers');
}

async function testMemoryModePromotesDocBackedRecallWhenNoMemoryArtifacts(): Promise<void> {
  _setR2ClientForTest(makeMockR2Client());
  const runContext: RunContext = {
    run_id: 'test-memory-doc-backed',
    tenant_id: 'tenant-1',
    user_id: 'user-doc-backed',
    user_input: 'Яка арбітражна обмовка в моїх документах?',
    query_profile: { routing_flags: { context_mode: 'memory' } },
    search_plan: { sources: { use_memory: true, use_lldbi: false } },
    history: [{ role: 'user', content: 'Покажи мені умову з документів' }],
    doc_snippets: [
      {
        doc_id: 'doc-global-1',
        text: 'Арбітражна обмовка: усі спори розглядаються за правилами ICC у Парижі.',
        score: 0.95,
        r2_key: 'mm-docs/global/doc.json',
        json_path: '$.content.chunks[0].text',
        scope_type: 'user_global',
        scope_id: null,
        filename: 'policy.txt',
      },
    ],
    memory_items: [],
    memory_summaries: [],
  };
  const u4: U4Result = { rawHits: [], retrievalTrace: { version: 1, hits: [] } };

  const assembled = await assemblePrompt({ runContext, u4, gate: GATE_OK });
  const docParts = assembled.contextParts.filter((p) => p.type === 'doc');

  assert(docParts.length === 1, 'doc-backed recall must include docs even if upstream mode was memory');
  assert((assembled.meta?.sources?.docCount ?? 0) === 1, 'docCount must reflect included doc evidence');
  assert(assembled.contextParts[0]?.type === 'doc', 'doc-backed recall should place docs before memory/history-only fallback');
  console.log('[OK] test memory mode: doc-backed recall keeps docs when no memory artifacts exist');
}

async function testMemoryModeKeepsDocsWhenExplicitDocQueryAlsoNeedsMemory(): Promise<void> {
  _setR2ClientForTest(makeMockR2Client());
  const runContext: RunContext = {
    run_id: 'test-memory-docs-explicit',
    tenant_id: 'tenant-1',
    user_id: 'user-doc-memory',
    user_input: 'Нагадай мій улюблений колір і скажи, коли повертається гарантійний платіж у моєму документі.',
    query_profile: { routing_flags: { context_mode: 'memory' } },
    search_plan: { sources: { use_memory: true, use_lldbi: false } },
    history: [{ role: 'user', content: 'Попередньо говорили про мої вподобання' }],
    memory_items: [{ id: 'mem-1', content_preview: 'Улюблений колір клієнта — синій.' }],
    memory_summaries: [{ scope: 'conversation', summary_text: 'Улюблений колір — синій.' }],
    doc_snippets: [
      {
        doc_id: 'doc-project-1',
        text: 'Гарантійний платіж повертається за 7 банківських днів після підписання акта.',
        score: 0.95,
        r2_key: 'mm-docs/project/doc.json',
        json_path: '$.content.chunks[0].text',
        scope_type: 'project',
        scope_id: 'project-1',
        filename: 'contract.docx',
      },
    ],
  };
  const u4: U4Result = { rawHits: [], retrievalTrace: { version: 1, hits: [] } };

  const assembled = await assemblePrompt({ runContext, u4, gate: GATE_OK });
  const docParts = assembled.contextParts.filter((p) => p.type === 'doc');
  const memoryParts = assembled.contextParts.filter((p) => p.type === 'memory');

  assert(docParts.length === 1, 'explicit memory+docs recall must keep doc context');
  assert(memoryParts.length >= 1, 'explicit memory+docs recall must keep memory context');
  assert((assembled.meta?.sources?.docCount ?? 0) === 1, 'docCount must reflect included doc evidence');
  assert((assembled.meta?.sources?.memoryCount ?? 0) >= 1, 'memoryCount must reflect included memory evidence');
  console.log('[OK] test memory mode: explicit docs query keeps both docs and memory evidence');
}

async function testU9RunLookupGracefullyDegradesOnTransientDbReadFailure(): Promise<void> {
  const original = RunRepository.prototype.findByRunId;
  try {
    RunRepository.prototype.findByRunId = async function mockedFindByRunId() {
      throw new StorageError('DB_READ_FAIL', 'TypeError: fetch failed');
    };
    const run = await loadRunRecordForU9({ runId: 'u9-run-lookup-test', traceId: 'trace-u9-run-lookup-test' });
    assert(run === null, 'transient run lookup failure must degrade to null instead of throwing');
    console.log('[OK] test U9 consumer: transient run lookup degrades to null');
  } finally {
    RunRepository.prototype.findByRunId = original;
  }
}

async function testTransientMmDocsContextClassifier(): Promise<void> {
  assert(
    isTransientMmDocsContextError(new Error('mm_doc_records scope query failed: TypeError: fetch failed')),
    'MM Docs store fetch failure should be treated as transient'
  );
  assert(
    isTransientMmDocsContextError(new Error('MM Docs Qdrant search failed: 503 temporary unavailable')),
    'MM Docs Qdrant 503 should be treated as transient'
  );
  assert(
    !isTransientMmDocsContextError(new Error('row level security violation')),
    'deterministic MM Docs authorization failure must not be treated as transient'
  );
  console.log('[OK] test U9 MM Docs context: transient classifier');
}

async function testTransientMmDocsContextRetry(): Promise<void> {
  let attempts = 0;
  const result = await withTransientMmDocsContextRetry(async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error('mm_doc_records scope query failed: TypeError: fetch failed');
    }
    return 'ok';
  }, 2, 1);
  assert(result === 'ok', 'MM Docs context retry should return eventual success');
  assert(attempts === 2, `MM Docs context retry should use two attempts (got ${attempts})`);
  console.log('[OK] test U9 MM Docs context: retry succeeds on transient failure');
}

async function testNonTransientMmDocsContextErrorDoesNotRetry(): Promise<void> {
  let attempts = 0;
  try {
    await withTransientMmDocsContextRetry(async () => {
      attempts += 1;
      throw new Error('mm_doc_records scope query failed: permission denied');
    }, 2, 1);
    throw new Error('expected non-transient MM Docs context error to throw');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    assert(message.includes('permission denied'), 'original MM Docs non-transient error should be preserved');
    assert(attempts === 1, `non-transient MM Docs context error must not retry (attempts=${attempts})`);
  }
  console.log('[OK] test U9 MM Docs context: non-transient error does not retry');
}

function testShouldRetrieveMmDocsContextGating(): void {
  assert(
    shouldRetrieveMmDocsContext({
      hasDocCandidates: true,
      requestedScope: null,
      explicitDocQuery: false,
      availability: { conversation: false, project: false, user_global: false },
      planUsesLegalSources: true,
    }) === true,
    'attachments should always enable MM Docs retrieval'
  );
  assert(
    shouldRetrieveMmDocsContext({
      hasDocCandidates: false,
      requestedScope: 'project',
      explicitDocQuery: false,
      availability: { conversation: true, project: true, user_global: true },
      planUsesLegalSources: true,
    }) === true,
    'requested scope should force MM Docs retrieval'
  );
  assert(
    shouldRetrieveMmDocsContext({
      hasDocCandidates: false,
      requestedScope: null,
      explicitDocQuery: true,
      availability: { conversation: true, project: true, user_global: true },
      planUsesLegalSources: true,
    }) === true,
    'explicit docs query should force MM Docs retrieval'
  );
  assert(
    shouldRetrieveMmDocsContext({
      hasDocCandidates: false,
      requestedScope: null,
      explicitDocQuery: false,
      availability: { conversation: true, project: true, user_global: true },
      planUsesLegalSources: true,
    }) === false,
    'generic legal path should not opportunistically retrieve MM Docs just because docs exist'
  );
  assert(
    shouldRetrieveMmDocsContext({
      hasDocCandidates: false,
      requestedScope: null,
      explicitDocQuery: false,
      availability: { conversation: false, project: false, user_global: true },
      planUsesLegalSources: false,
    }) === false,
    'non-explicit query must not opportunistically retrieve MM Docs even on non-legal path'
  );
  console.log('[OK] test U9 MM Docs context: retrieval gating avoids opportunistic doc mixing on legal path');
}

// ---- Test: law mode respects upstream snippet ceiling (<= mixedModeLawMaxSnippets) ----
async function testLawModeRespectsSnippetCeiling(): Promise<void> {
  _setR2ClientForTest(makeMockR2Client());
  const runContext: RunContext = {
    run_id: 'test-law-ceiling',
    tenant_id: null,
    user_id: 'user-1',
    user_input: 'Склад злочину ст. 185 ККУ',
    history: [],
  };
  const rawHits = Array.from({ length: 14 }, (_, i) => ({
    r2_key: `acts/law_${i}.json`,
    json_path: '$.content.chunks[0].text',
    score: 0.9 - i * 0.02,
  }));
  const u4: U4Result = { rawHits, retrievalTrace: { version: 1, hits: [] } };

  const assembled = await assemblePrompt({ runContext, u4, gate: GATE_OK });

  const lawParts = assembled.contextParts.filter((p) => p.type === 'law');
  const ceiling = 8;
  assert(lawParts.length <= ceiling, `law mode must cap at ${ceiling} snippets (got ${lawParts.length})`);
  assert((assembled.meta?.sources?.lawCount ?? 0) <= ceiling, 'meta.sources.lawCount <= ceiling');
  console.log('[OK] test law mode: assembly respects upstream snippet ceiling (<= 8)');
}

// ---- Test: law mode use_memory=false => memoryCount=0 ----
async function testLawModeExcludesMemory(): Promise<void> {
  _setR2ClientForTest(makeMockR2Client());
  const runContext: RunContext = {
    run_id: 'test-law-no-memory',
    tenant_id: null,
    user_id: 'user-1',
    user_input: 'Склад злочину ст. 185 ККУ',
    search_plan: { sources: { use_memory: false, use_lldbi: true } },
    history: [{ role: 'user', content: 'Попереднє' }],
    memory_items: [{ id: 'mem-1', content_preview: 'Should not appear' }],
    memory_summaries: [{ scope: 'case', summary_text: 'Should not appear' }],
  };
  const u4: U4Result = {
    rawHits: [{ r2_key: 'acts/185.json', json_path: '$.content.chunks[0].text', score: 0.9 }],
    retrievalTrace: { version: 1, hits: [] },
  };
  const assembled = await assemblePrompt({ runContext, u4, gate: GATE_OK });
  const memoryParts = assembled.contextParts.filter((p) => p.type === 'memory');
  assert(memoryParts.length === 0, `law mode with use_memory=false must have memoryCount=0 (got ${memoryParts.length})`);
  assert((assembled.meta?.sources?.memoryCount ?? 0) === 0, 'meta.sources.memoryCount=0');
  console.log('[OK] test law mode: use_memory=false => memoryCount=0');
}

// ---- Test 2: missing R2 → graceful placeholder, no crash ----

async function testMissingR2GracefulFallback(): Promise<void> {
  _setR2ClientForTest(null); // no R2 → will fail to load
  const runContext: RunContext = {
    run_id: 'test-2',
    tenant_id: null,
    user_id: 'user-1',
    user_input: 'Query',
    history: [],
  };
  const u4: U4Result = {
    rawHits: [{ r2_key: 'some/key.json', json_path: '$.content.chunks[0].text', score: 0.5 }],
    retrievalTrace: { version: 1, hits: [] },
  };

  const assembled = await assemblePrompt({ runContext, u4, gate: GATE_OK });

  const lawParts = assembled.contextParts.filter((p) => p.type === 'law');
  assert(lawParts.length === 1, 'expected 1 law part (missing marker)');
  assert(lawParts[0].text.includes('[Норма недоступна') || lawParts[0].text.includes('[R2'), 'law part is missing marker');
  assert((assembled.meta?.loadErrorsCount ?? 0) > 0, 'loadErrorsCount > 0');
  assert(assembled.meta?.degraded === true, 'degraded=true when missing');
  console.log('[OK] test 2: missing R2 → graceful placeholder, loadErrorsCount>0, degraded=true');
}

// ---- Test 3: dedup identical r2_key+json_path → 1 snippet ----

async function testDedupIdenticalHits(): Promise<void> {
  _setR2ClientForTest(makeMockR2Client());
  const runContext: RunContext = {
    run_id: 'test-3',
    tenant_id: null,
    user_id: 'user-1',
    user_input: 'Query dedup',
    history: [],
  };
  // Two hits with same key+path but different scores
  const u4: U4Result = {
    rawHits: [
      { r2_key: 'acts/185.json', json_path: '$.content.chunks[0].text', score: 0.9 },
      { r2_key: 'acts/185.json', json_path: '$.content.chunks[0].text', score: 0.7 },
      { r2_key: 'acts/115.json', json_path: '$.content.chunks[0].text', score: 0.6 },
    ],
    retrievalTrace: { version: 1, hits: [] },
  };

  const assembled = await assemblePrompt({ runContext, u4, gate: GATE_OK });

  const lawParts = assembled.contextParts.filter((p) => p.type === 'law');
  assert(lawParts.length === 2, `dedup: expected 2 law parts (got ${lawParts.length})`);
  const keys = lawParts.map((p) => (p.sourceRef as LawSourceRef)?.r2_key);
  assert(keys.includes('acts/185.json'), 'acts/185.json present');
  assert(keys.includes('acts/115.json'), 'acts/115.json present');
  console.log('[OK] test 3: dedup identical r2_key+json_path → 2 unique snippets');
}

async function testSharedR2KeyUsesSingleObjectFetch(): Promise<void> {
  let callCount = 0;
  const fakeBody = {
    transformToString: async (_enc: string) =>
      JSON.stringify({
        content: {
          chunks: [
            { text: 'Стаття 1. Перша норма.' },
            { text: 'Стаття 2. Друга норма.' },
          ],
        },
      }),
  };
  const client = {
    send: async () => {
      callCount += 1;
      return { Body: fakeBody };
    },
  } as unknown as S3Client;
  _setR2ClientForTest(client);

  const runContext: RunContext = {
    run_id: 'test-shared-r2-key',
    tenant_id: null,
    user_id: 'user-1',
    user_input: 'Поясни дві суміжні норми',
    history: [],
  };
  const u4: U4Result = {
    rawHits: [
      { r2_key: 'acts/shared.json', json_path: '$.content.chunks[0].text', score: 0.95 },
      { r2_key: 'acts/shared.json', json_path: '$.content.chunks[1].text', score: 0.9 },
    ],
    retrievalTrace: { version: 1, hits: [] },
  };

  const assembled = await assemblePrompt({ runContext, u4, gate: GATE_OK });
  const lawParts = assembled.contextParts.filter((p) => p.type === 'law');
  assert(lawParts.length === 2, `expected 2 law parts from shared document (got ${lawParts.length})`);
  assert(callCount === 1, `shared r2_key should be fetched once (got ${callCount})`);
  _setR2ClientForTest(null);
  console.log('[OK] test shared R2 key: one object fetch serves multiple snippets');
}

// ---- Test 4: budgeting — deterministic (same input → same output) ----

async function testBudgetingDeterministic(): Promise<void> {
  _setR2ClientForTest(makeMockR2Client('A'.repeat(100)));
  const runContext: RunContext = {
    run_id: 'test-4',
    tenant_id: null,
    user_id: 'user-1',
    user_input: 'Budget test',
    history: [
      { role: 'user', content: 'msg1' },
      { role: 'assistant', content: 'msg2' },
    ],
    memory_items: [{ id: 'mem-1', content_preview: 'mem preview' }],
    memory_summaries: [{ scope: 'case', summary_text: 'summary' }],
  };
  const u4: U4Result = {
    rawHits: [
      { r2_key: 'acts/a.json', json_path: '$.content.chunks[0].text', score: 0.8 },
      { r2_key: 'acts/b.json', json_path: '$.content.chunks[0].text', score: 0.7 },
    ],
    retrievalTrace: { version: 1, hits: [] },
  };

  const run1 = await assemblePrompt({ runContext, u4, gate: GATE_OK });
  const run2 = await assemblePrompt({ runContext, u4, gate: GATE_OK });

  assert(run1.contextParts.length === run2.contextParts.length, 'deterministic: same parts count');
  assert(
    JSON.stringify(run1.contextParts.map((p) => p.sourceIds)) ===
      JSON.stringify(run2.contextParts.map((p) => p.sourceIds)),
    'deterministic: same sourceIds order'
  );
  assert(run1.meta?.budget?.tokenEstimateTotal === run2.meta?.budget?.tokenEstimateTotal, 'deterministic: same token estimate');
  console.log('[OK] test 4: budgeting is deterministic (same input → same output)');
}

// ---- Test 5: provenance — sourceRef present per contextPart ----

async function testProvenanceSourceRef(): Promise<void> {
  _setR2ClientForTest(makeMockR2Client());
  const runContext: RunContext = {
    run_id: 'test-5',
    tenant_id: null,
    user_id: 'user-1',
    user_input: 'Provenance test',
    history: [{ role: 'user', content: 'hello' }],
    memory_items: [{ id: 'mem-x', content_preview: 'memory preview' }],
    memory_summaries: [{ scope: 'global', summary_text: 'global summary' }],
  };
  const u4: U4Result = {
    rawHits: [
      { r2_key: 'acts/prov.json', json_path: '$.content.chunks[0].text', score: 0.85, rada_nreg: 'NREG-001' },
    ],
    retrievalTrace: { version: 1, hits: [] },
  };

  const assembled = await assemblePrompt({ runContext, u4, gate: GATE_OK });

  for (const part of assembled.contextParts) {
    assert(part.sourceRef !== undefined, `${part.type} part has sourceRef`);
  }

  const lawPart = assembled.contextParts.find((p) => p.type === 'law');
  assert(lawPart !== undefined, 'law part exists');
  const lawRef = lawPart!.sourceRef as LawSourceRef;
  assert(lawRef.r2_key === 'acts/prov.json', 'law sourceRef has r2_key');
  assert(lawRef.rada_nreg === 'NREG-001', 'law sourceRef has rada_nreg');
  assert(typeof lawRef.score === 'number', 'law sourceRef has score');
  assert(lawRef.loaded === true, 'law sourceRef loaded=true on success');

  assert(assembled.meta?.lawSourceRefs !== undefined, 'meta.lawSourceRefs present');
  assert((assembled.meta?.lawSourceRefs ?? []).length === 1, 'meta.lawSourceRefs has 1 entry');
  console.log('[OK] test 5: provenance sourceRef present per contextPart, lawSourceRefs in meta');
}

// ---- Test 7: normRef extraction (DEV RUN v14) ----

async function testNormRefExtraction(): Promise<void> {
  const snippet115 = 'Стаття 115. Умисне вбивство\n\n1. Умисне вбивство — вчинення з умислом заподіяння смерті іншій особі.';
  _setR2ClientForTest(makeMockR2Client(snippet115));
  const runContext: RunContext = {
    run_id: 'test-7',
    tenant_id: null,
    user_id: 'user-1',
    user_input: 'Склад злочину ст. 115 ККУ',
  };
  const u4: U4Result = {
    rawHits: [
      { r2_key: 'acts/kku_115.json', json_path: '$.content.chunks[0].text', score: 0.9 },
    ],
    retrievalTrace: { version: 1, hits: [] },
  };

  const assembled = await assemblePrompt({ runContext, u4, gate: GATE_OK });

  const lawPart = assembled.contextParts.find((p) => p.type === 'law');
  assert(lawPart !== undefined, 'law part exists');
  const lawRef = lawPart!.sourceRef as LawSourceRef;
  assert(lawRef.normRef != null, 'normRef extracted');
  assert(lawRef.normRef!.articleNumber === 115, `articleNumber=115 (got ${lawRef.normRef!.articleNumber})`);
  assert(
    (lawRef.normRef!.heading ?? '').includes('Умисне вбивство'),
    `heading contains "Умисне вбивство" (got ${lawRef.normRef!.heading})`
  );

  assert(assembled.meta?.lawIndex != null, 'meta.lawIndex present');
  const sid = 'acts/kku_115.json::$.content.chunks[0].text';
  assert(assembled.meta!.lawIndex![sid] != null, 'lawIndex has entry for snippet');
  assert(assembled.meta!.lawIndex![sid].articleNumber === 115, 'lawIndex.articleNumber=115');
  console.log('[OK] test 7: normRef extraction (article 115, heading Умисне вбивство), lawIndex in meta');
}

// ---- Test 6: extractTextByJsonPath + truncation utilities ----

function testUtilities(): void {
  // extractTextByJsonPath
  const doc = { content: { chunks: [{ text: 'Chunk zero text' }, { text: 'Chunk one text' }] } };
  assert(extractTextByJsonPath(doc, '$.content.chunks[0].text') === 'Chunk zero text', 'extract chunk 0');
  assert(extractTextByJsonPath(doc, '$.content.chunks[1].text') === 'Chunk one text', 'extract chunk 1');
  assert(extractTextByJsonPath(doc, '$.content.chunks[99].text') === null, 'out of bounds → null');
  assert(extractTextByJsonPath(doc, '$.unsupported.path') === null, 'unsupported path → null');

  // truncateSnippetText
  const long = 'word '.repeat(100); // 500 chars
  const cut = truncateSnippetText(long, 20);
  assert(cut.length <= 25, 'truncated to ~maxChars');
  assert(cut.endsWith('…'), 'ends with ellipsis');
  const short = 'short text';
  assert(truncateSnippetText(short, 100) === short, 'short text not modified');

  // DEV RUN v18: quote-critical — preserve "Стаття …" header when truncating
  const stattya256 = 'Стаття 256. Позовна давність. Загальні положення. ' + 'x'.repeat(500);
  const truncated256 = truncateSnippetText(stattya256, 400);
  assert(truncated256.startsWith('Стаття 256'), 'truncation preserves Стаття line');
  assert(truncated256.length <= 401, 'truncated length within max');
  console.log('[OK] test 6: utilities (extractTextByJsonPath, truncateSnippetText, quote-critical)');
}

// ---- Test: U9 meta-triage JSON parsing and fallback (DEV RUN v17) ----

function testMetaTriageParseAndFallback(): void {
  const maxIndex = 99;
  const maxSelect = 10;

  // Valid array
  assert(
    JSON.stringify(parseMetaTriageIndices('[1, 2, 3]', maxIndex, maxSelect)) === '[1,2,3]',
    'parse: direct array [1,2,3]'
  );
  assert(
    JSON.stringify(parseMetaTriageIndices('Here is the result: [0, 5, 12, 87]', maxIndex, maxSelect)) === '[0,5,12,87]',
    'parse: array inside text'
  );
  // Object with selected_indices
  assert(
    JSON.stringify(parseMetaTriageIndices('{"selected_indices": [2, 4, 6]}', maxIndex, maxSelect)) === '[2,4,6]',
    'parse: object selected_indices'
  );
  // Structured output: indices (json_schema response)
  assert(
    JSON.stringify(parseMetaTriageIndices('{"indices": [0, 5, 12]}', maxIndex, maxSelect)) === '[0,5,12]',
    'parse: object indices (structured output)'
  );
  // Invalid / empty → []
  assert(parseMetaTriageIndices('garbage', maxIndex, maxSelect).length === 0, 'parse: garbage → []');
  assert(parseMetaTriageIndices('[]', maxIndex, maxSelect).length === 0, 'parse: [] → []');
  // Out-of-range clipped
  assert(
    JSON.stringify(parseMetaTriageIndices('[0, 1, 999]', 5, maxSelect)) === '[0,1,5]',
    'parse: 999 clamped when maxIndex=5'
  );

  // Fallback: top N by score
  assert(
    JSON.stringify(fallbackTopNByScore(10, 5)) === '[0,1,2,3,4]',
    'fallback: (10,5) → [0,1,2,3,4]'
  );
  assert(
    JSON.stringify(fallbackTopNByScore(3, 10)) === '[0,1,2]',
    'fallback: (3,10) → [0,1,2]'
  );

  // Coverage-preserving fallback: includes deep ranks and article-number match
  const hits100 = Array.from({ length: 100 }, (_, i) => ({
    r2_key: `law_${i}.json`,
    json_path: '$.content.chunks[0].text',
    score: 0.95 - i * 0.005,
    article_number: i === 75 ? '185' : i === 89 ? '190' : null,
  })) as import('../../retrieval/types.js').RawHit[];
  const coverageIndices = coveragePreservingFallback(hits100, 'крадіжка ст.185 та ст.190 шахрайство', 25);
  assert(coverageIndices.length <= 25, 'coverage fallback cap 25');
  assert(coverageIndices.includes(0) && coverageIndices.includes(9), 'anchor top-10 included');
  const hasDeepRank = coverageIndices.some((i) => i >= 50);
  assert(hasDeepRank, 'coverage includes at least one deep rank (≥50)');
  const hasArticleMatch = coverageIndices.includes(75) || coverageIndices.includes(89);
  assert(hasArticleMatch, 'coverage includes article-number match (185 or 190 at rank 75/89)');
  console.log('[OK] test meta-triage: parseMetaTriageIndices + fallbackTopNByScore + coveragePreservingFallback');
}

function testExtractArticleNumbersFromQuery(): void {
  // Phase C: no false positive for bare numbers (e.g. "28 років")
  const q0 = extractArticleNumbersFromQuery('Чи може чоловік 28 років виїхати за кордон?');
  assert(q0.size === 0, '28 років → no article ref (strong-only)');
  const q1 = extractArticleNumbersFromQuery('ст.185 та ст.190');
  assert(q1.has('185') && q1.has('190'), 'extract 185 and 190');
  const q2 = extractArticleNumbersFromQuery('no numbers');
  assert(q2.size === 0, 'no numbers → empty set');
  // Phase 2: 1–5 digits, dash-suffix forms
  const q3 = extractArticleNumbersFromQuery('стаття 3322 ККУ');
  assert(q3.has('3322'), 'extract 3322 (4 digits)');
  // Phase 3: dash forms only — no false positives 185, 1, 332, 2 from "185-1" and "332-2"
  const q4 = extractArticleNumbersFromQuery('ст. 185-1 та 332-2');
  assert(q4.has('185-1') && q4.has('332-2'), 'extract 185-1 and 332-2');
  assert(!q4.has('185') && !q4.has('1') && !q4.has('332') && !q4.has('2'), 'no sub-tokens from dash forms');
  assert(q4.size === 2, 'exactly two: 185-1, 332-2');
  const q5 = extractArticleNumbersFromQuery('статті 115, 185-1, 332-2 та 99999');
  assert(q5.has('115') && q5.has('185-1') && q5.has('332-2') && q5.has('99999'), 'mixed: 115, 185-1, 332-2, 99999');
  assert(!q5.has('185') && !q5.has('1') && !q5.has('332') && !q5.has('2'), 'mixed: no false positives from dash parts');
  // Phase C: 332-2 normalized to 3322 for matching
  const norm332 = getStrongArticleRefsNormalized('ст. 332-2 ККУ');
  assert(norm332.has('332-2') && norm332.has('3322'), 'ст. 332-2 ККУ → normalized 3322');
  assert(extractArticleNumbersFromQuery('332-2 ККУ').has('332-2'), '332-2 ККУ → strong ref');
  // Phase C: bounded grammar — "28 років" / "2026 рік" / "3 дні" not strong; №57-95-п not article refs
  const qMixed = extractArticleNumbersFromQuery('ст. 332-2 ККУ, а мені 28 років');
  assert(qMixed.has('332-2') && qMixed.size === 1, 'ст. 332-2 ККУ, а мені 28 років → strong only 332-2');
  const qYear = extractArticleNumbersFromQuery('ст. 130 ... 2026 рік і 3 дні');
  assert(qYear.has('130') && qYear.size === 1, 'ст. 130 ... 2026 рік і 3 дні → strong only 130');
  // Unicode-safe: comma/semicolon before year/day
  const qYearComma = extractArticleNumbersFromQuery('ст.130, 2026 рік і 3 дні');
  assert(qYearComma.has('130') && qYearComma.size === 1, 'ст.130, 2026 рік і 3 дні → strong only 130');
  const qYearSemicolon = extractArticleNumbersFromQuery('ст. 130; 2026 рік');
  assert(qYearSemicolon.has('130') && qYearSemicolon.size === 1, 'ст. 130; 2026 рік → strong only 130');
  const qOrder = extractArticleNumbersFromQuery('Наказ №57-95-п і ст. 185 ККУ');
  assert(qOrder.has('185') && qOrder.size === 1, 'Наказ №57-95-п і ст. 185 ККУ → strong only 185');
  // PHASE A: "ст 185" without dot -> strong ref 185
  const qStNoDot = extractArticleNumbersFromQuery('ст 185');
  assert(qStNoDot.has('185') && qStNoDot.size === 1, 'ст 185 (no dot) → strong ref 185');
  const strongSt185 = getStrongArticleRefsNormalized('ст 185');
  assert(strongSt185.has('185'), 'getStrongArticleRefsNormalized(ст 185) includes 185');
  const qSt185_186 = extractArticleNumbersFromQuery('ст 185 та 186');
  assert(qSt185_186.has('185') && qSt185_186.has('186') && qSt185_186.size === 2, 'ст 185 та 186 → strong refs 185, 186');
  const qSt185_1_332_2 = extractArticleNumbersFromQuery('ст 185-1 та 332-2');
  assert(qSt185_1_332_2.has('185-1') && qSt185_1_332_2.has('332-2') && qSt185_1_332_2.size === 2, 'ст 185-1 та 332-2 → both strong, no sub-tokens');
  assert(!qSt185_1_332_2.has('185') && !qSt185_1_332_2.has('332'), 'no sub-tokens from 185-1 or 332-2');
  const qRegress28 = extractArticleNumbersFromQuery('мені 28 років');
  assert(qRegress28.size === 0, 'мені 28 років → empty strong (regression)');
  console.log('[OK] test extractArticleNumbersFromQuery');
}

/** Documents U9 law-context root cause: without explicit article numbers in query, coverage fallback gap skips ranks 11, 53, 92. */
function testCoverageFallbackGapWithoutQueryNumbers(): void {
  const hits100 = Array.from({ length: 100 }, (_, i) => ({
    r2_key: `law_${i}.json`,
    json_path: '$.content.chunks[0].text',
    score: 0.95 - i * 0.004,
    article_number: i === 11 ? '186' : i === 53 ? '185' : i === 92 ? '187' : null,
  })) as import('../../retrieval/types.js').RawHit[];
  const queryNoNumbers = 'яка різниця між крадіжкою та розбоєм?';
  const indicesNoNumbers = coveragePreservingFallback(hits100, queryNoNumbers, 20);
  assert(!indicesNoNumbers.includes(11), 'rank 11 (ст.186) not in fallback when query has no digits');
  assert(!indicesNoNumbers.includes(53), 'rank 53 (ст.185) not in fallback when query has no digits');
  assert(!indicesNoNumbers.includes(92), 'rank 92 (ст.187) not in fallback when query has no digits');
  const indicesWith185 = coveragePreservingFallback(hits100, 'ст. 185 процитуй', 20);
  assert(indicesWith185.includes(53), 'rank 53 (ст.185) included when query has "185"');
  // rank 92 would be in merged set but slice(0,20) keeps first 20 by rank order, so 92 may be cut; 53 is enough to document article-number merge
  console.log('[OK] test coverage fallback gap (no heuristics: explicit article numbers in query required for 185/186/187)');
}

/** Gap-free deterministic fallback: cap respected, at least one query-number included, diversity cap. */
function testGapFreeDeterministicFallback(): void {
  const hits100 = Array.from({ length: 100 }, (_, i) => ({
    r2_key: `law_${Math.floor(i / 20)}.json`,
    json_path: '$.content.chunks[0].text',
    score: 0.95 - i * 0.004,
    article_number: i === 53 ? '185' : i === 92 ? '187' : null,
  })) as import('../../retrieval/types.js').RawHit[];
  const indices = gapFreeDeterministicFallback(hits100, 'ст. 185 та ст. 187', 20);
  assert(indices.length <= 20, 'cap 20');
  const hasQueryNumber = indices.some((i) => hits100[i]?.article_number === '185' || hits100[i]?.article_number === '187');
  assert(hasQueryNumber, 'at least one query-number match (185 or 187) included');
  const sources = new Map<string, number>();
  for (const i of indices) {
    const key = hits100[i]?.r2_key ?? '';
    sources.set(key, (sources.get(key) ?? 0) + 1);
  }
  const maxPerSource = Math.max(...sources.values());
  assert(maxPerSource <= 6, 'diversity cap 6 per source');
  console.log('[OK] test gapFreeDeterministicFallback (query-number + diversity)');
}

function testMetaTriageDirectRefShortcutAndStructuredMode(): void {
  assert(
    shouldUseDirectRefDeterministicTriage('ст. 185 та ст. 187 ККУ') === true,
    'direct article refs trigger deterministic triage shortcut'
  );
  assert(
    shouldUseDirectRefDeterministicTriage('яка різниця між крадіжкою та розбоєм') === false,
    'non-direct-ref query does not trigger deterministic shortcut'
  );
  assert(
    shouldUseStructuredMetaTriageOutput('openai/gpt-5-nano') === false,
    'gpt-5-nano skips strict structured output in meta-triage'
  );
  assert(
    shouldUseStructuredMetaTriageOutput('openai/gpt-5-nano-2025-08-07') === false,
    'versioned gpt-5-nano also skips strict structured output'
  );
  assert(
    shouldUseStructuredMetaTriageOutput('openai/gpt-4o-mini') === true,
    'gpt-4o-mini keeps strict structured output'
  );
  assert(
    shouldFallbackImmediatelyOnEmptyMetaTriageOutput('openai/gpt-5-nano', 'openai/gpt-4o-mini') === true,
    'nano empty output goes straight to fallback model'
  );
  assert(
    shouldFallbackImmediatelyOnEmptyMetaTriageOutput('openai/gpt-4o-mini', 'openai/gpt-4o-mini') === false,
    'non-nano model does not special-case empty output fallback'
  );
  console.log('[OK] test meta-triage direct-ref shortcut + structured-mode selection');
}

// ---- Test B3: Semaphore limits concurrent R2 loads ----
// Verifies that even with 12 raw hits, the Semaphore (r2Concurrency=6) limits peak parallelism.

async function testSemaphoreConcurrencyLimit(): Promise<void> {
  let activeConcurrent = 0;
  let maxObservedConcurrent = 0;
  let callCount = 0;

  // Mock R2 client that tracks concurrent in-flight requests
  const trackingClient = {
    send: async () => {
      activeConcurrent++;
      callCount++;
      if (activeConcurrent > maxObservedConcurrent) {
        maxObservedConcurrent = activeConcurrent;
      }
      await new Promise((r) => setTimeout(r, 20)); // hold slot to expose concurrency
      activeConcurrent--;
      return {
        Body: {
          transformToString: async () =>
            JSON.stringify({ content: { chunks: [{ text: 'Mock legal text.' }] } }),
        },
      };
    },
  } as unknown as S3Client;

  _setR2ClientForTest(trackingClient);

  const N_HITS = 12;
  const runContext: RunContext = {
    run_id: 'test-b3',
    tenant_id: null,
    user_id: 'user-b3',
    user_input: 'Concurrency test',
  };
  const u4: U4Result = {
    rawHits: Array.from({ length: N_HITS }, (_, i) => ({
      r2_key: `acts/law_${i}.json`,
      json_path: '$.content.chunks[0].text',
      score: 0.9 - i * 0.05,
    })),
    retrievalTrace: { version: 1, hits: [] },
  };

  const assembled = await assemblePrompt({ runContext, u4, gate: GATE_OK });

  _setR2ClientForTest(null);

  const expectedCalls = assembled.meta?.lawSourceRefs?.length ?? 0;
  assert(callCount === expectedCalls, `all selected R2 loads called (expected ${expectedCalls}, got ${callCount})`);
  // config.u9R2Concurrency defaults to 6; max concurrent must not exceed it
  const expectedMax = 6;
  assert(
    maxObservedConcurrent <= expectedMax,
    `Semaphore limited concurrency to ≤${expectedMax} (observed ${maxObservedConcurrent})`
  );
  assert(maxObservedConcurrent > 1, `Semaphore allowed concurrent loads (observed ${maxObservedConcurrent} > 1)`);
  console.log(`[OK] test B3: Semaphore limits R2 concurrency (max observed: ${maxObservedConcurrent} ≤ ${expectedMax})`);
}

/** Phase 2.1: U9 selection explainability (candidate_count, selected_indices, score_breakdown). Deterministic: same input → same output. */
async function testU9SelectionExplainabilityAndDeterminism(): Promise<void> {
  _setR2ClientForTest(makeMockR2Client());
  const runContext: RunContext = {
    run_id: 'test-expl',
    tenant_id: null,
    user_id: 'u1',
    user_input: 'ст. 185 та 332-2',
  };
  const u4: U4Result = {
    rawHits: [
      { r2_key: 'a.json', json_path: '$.c[0].text', score: 0.9, article_number: '100' },
      { r2_key: 'b.json', json_path: '$.c[0].text', score: 0.85, article_number: '185' },
      { r2_key: 'c.json', json_path: '$.c[0].text', score: 0.8, article_number: '332-2' },
    ],
    retrievalTrace: { version: 1, hits: [] },
  };
  const assembled1 = await assemblePrompt({ runContext, u4, gate: GATE_OK });
  const assembled2 = await assemblePrompt({ runContext, u4, gate: GATE_OK });
  const triage = assembled1.meta?.u9MetaTriage;
  assert(triage != null, 'u9MetaTriage present');
  assert(typeof triage.candidate_count === 'number' && triage.candidate_count >= 1, 'candidate_count >= 1');
  assert(Array.isArray(triage.selected_indices) && triage.selected_indices!.length >= 1, 'selected_indices array');
  assert(Array.isArray(triage.score_breakdown) && triage.score_breakdown!.length >= 1, 'score_breakdown array');
  assert(
    JSON.stringify(assembled1.meta?.u9MetaTriage?.selected_indices) ===
      JSON.stringify(assembled2.meta?.u9MetaTriage?.selected_indices),
    'deterministic: same input → same selected_indices'
  );
  _setR2ClientForTest(null);
  console.log('[OK] test U9 selection explainability + deterministic same input → same output');
}

// ---- Main ----

async function main(): Promise<void> {
  console.log('U9 Assemble unit tests\n');
  testUtilities();
  await testBasicChannels();
  await testDocsChannelIncludedAheadOfMemory();
  await testExplicitDocQuerySkipsLawAssembly();
  await testLongDocSnippetTruncatesSafely();
  await testMemoryModeExcludesLawContext();
  await testMemoryModeUsesUserHistoryOnly();
  await testMemoryModePromotesDocBackedRecallWhenNoMemoryArtifacts();
  await testMemoryModeKeepsDocsWhenExplicitDocQueryAlsoNeedsMemory();
  await testU9RunLookupGracefullyDegradesOnTransientDbReadFailure();
  await testTransientMmDocsContextClassifier();
  await testTransientMmDocsContextRetry();
  await testNonTransientMmDocsContextErrorDoesNotRetry();
  testShouldRetrieveMmDocsContextGating();
  await testLawModeRespectsSnippetCeiling();
  await testLawModeExcludesMemory();
  await testMissingR2GracefulFallback();
  await testDedupIdenticalHits();
  await testSharedR2KeyUsesSingleObjectFetch();
  await testBudgetingDeterministic();
  await testProvenanceSourceRef();
  await testNormRefExtraction();
  await testSemaphoreConcurrencyLimit();
  _setR2ClientForTest(null); // restore
  testMetaTriageParseAndFallback();
  testExtractArticleNumbersFromQuery();
  testCoverageFallbackGapWithoutQueryNumbers();
  testGapFreeDeterministicFallback();
  testMetaTriageDirectRefShortcutAndStructuredMode();
  await testU9SelectionExplainabilityAndDeterminism();
  console.log('\nAll U9 assemble unit tests passed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
