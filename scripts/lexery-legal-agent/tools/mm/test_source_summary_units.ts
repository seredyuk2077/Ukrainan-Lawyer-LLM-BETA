#!/usr/bin/env node
/**
 * Unit tests: buildRunSourceSummary respects top-level and nested assembled_prompt.sources,
 * and merges with existing snapshot.source_summary (no regression when fields missing).
 */
import { resolve } from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(process.cwd(), 'scripts/lexery-legal-agent/.env') });

import { buildRunSourceSummary } from '../../write/deliverConsumer.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

// Top-level sources (U9 persisted shape)
const runTopLevel = {
  assembled_prompt: {
    sources: { historyCount: 4, memoryCount: 2, lawCount: 0 },
  },
  query_profile: { routing_flags: { context_mode: 'memory' as const } },
  llm_result: { usage: { prompt_tokens: 100 } },
  retrieval_trace: { meta: { memory: { scope_primary: 'conversation' as const, scope_fallback_used: false } } },
  snapshot: { u10_selection: { triage_used: false } },
};
const outTop = buildRunSourceSummary(runTopLevel, null);
assert(outTop.history_count === 4, 'top-level sources: history_count');
assert(outTop.memory_count === 2, 'top-level sources: memory_count');
assert(outTop.law_count === 0, 'top-level sources: law_count');
assert(outTop.context_mode === 'memory', 'top-level sources: context_mode');
assert(outTop.triage_used === false, 'top-level sources: triage_used from snapshot.u10_selection');
assert(outTop.prompt_tokens === 100, 'top-level sources: prompt_tokens');
assert(outTop.memory_scope_mode === 'conversation', 'top-level sources: memory_scope_mode');
console.log('[OK] top-level assembled_prompt.sources → source_summary populated');

// Nested meta.sources
const runNested = {
  assembled_prompt: {
    meta: { sources: { historyCount: 1, memoryCount: 3, lawCount: 5 } },
  },
  query_profile: { routing_flags: { context_mode: 'mixed' as const } },
};
const outNested = buildRunSourceSummary(runNested, null);
assert(outNested.history_count === 1, 'nested meta.sources: history_count');
assert(outNested.memory_count === 3, 'nested meta.sources: memory_count');
assert(outNested.law_count === 5, 'nested meta.sources: law_count');
assert(outNested.context_mode === 'mixed', 'nested meta.sources: context_mode');
console.log('[OK] nested assembled_prompt.meta.sources → source_summary populated');

// Missing fields: no regression (nulls, existing preserved)
const runMissing = {
  assembled_prompt: {},
  query_profile: {},
};
const existing = {
  history_count: 10,
  memory_count: 1,
  law_count: 0,
  context_mode: 'memory' as const,
};
const outMissing = buildRunSourceSummary(runMissing, existing);
assert(outMissing.history_count === 10, 'missing assembled: preserve existing history_count');
assert(outMissing.memory_count === 1, 'missing assembled: preserve existing memory_count');
assert(outMissing.law_count === 0, 'missing assembled: preserve existing law_count');
assert(outMissing.context_mode === 'memory', 'missing assembled: preserve existing context_mode');
console.log('[OK] missing assembled fields → existing source_summary preserved');

// No existing: nulls
const outNoExisting = buildRunSourceSummary(runMissing, null);
assert(outNoExisting.history_count === null, 'no existing: history_count null');
assert(outNoExisting.memory_count === null, 'no existing: memory_count null');
assert(outNoExisting.law_count === null, 'no existing: law_count null');
console.log('[OK] no existing summary → counts remain null (no fake zeros)');

// Backward compatibility: llm_result fallback still works when snapshot.u10_selection absent
const runLegacyTriage = {
  assembled_prompt: {
    sources: { historyCount: 0, memoryCount: 1, lawCount: 2 },
  },
  llm_result: { triage_used: true },
};
const outLegacyTriage = buildRunSourceSummary(runLegacyTriage, null);
assert(outLegacyTriage.triage_used === true, 'legacy llm_result.triage_used fallback preserved');
console.log('[OK] triage_used falls back to llm_result for legacy rows');

console.log('All source summary unit tests passed.');
