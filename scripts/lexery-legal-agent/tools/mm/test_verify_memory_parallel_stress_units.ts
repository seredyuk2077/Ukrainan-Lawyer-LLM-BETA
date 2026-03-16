import {
  evaluatePromptGrowth,
  recomputeConversationFlags,
  type ConversationResult,
} from './verify_memory_parallel_stress.js';

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`ASSERT FAIL: ${msg}`);
}

function testMissingPromptTokensFailClosed(): void {
  assert(
    evaluatePromptGrowth({ firstTurnTokens: null, lastTurnTokens: 2000 }) === false,
    'missing firstTurnTokens must fail closed'
  );
  assert(
    evaluatePromptGrowth({ firstTurnTokens: 1000, lastTurnTokens: null }) === false,
    'missing lastTurnTokens must fail closed'
  );
  console.log('[OK] missing prompt tokens fail closed');
}

function testPromptGrowthThreshold(): void {
  assert(
    evaluatePromptGrowth({ firstTurnTokens: 1000, lastTurnTokens: 2000, maxRatio: 2.5 }) === true,
    'growth within threshold passes'
  );
  assert(
    evaluatePromptGrowth({ firstTurnTokens: 1000, lastTurnTokens: 3000, maxRatio: 2.5 }) === false,
    'growth above threshold fails'
  );
  console.log('[OK] prompt growth threshold enforced');
}

function testRecomputeClearsResolvedTimeouts(): void {
  const result: ConversationResult = {
    conv_id: 'conv-test',
    conv_index: 1,
    turns: [
      { turn: 1, run_id: 'r1', status: 'completed', memory_count: 0, law_count: 7, prompt_tokens: 2000, context_mode: 'law', use_memory: false },
      { turn: 2, run_id: 'r2', status: 'completed', memory_count: 0, law_count: 7, prompt_tokens: 2100, context_mode: 'law', use_memory: false },
      { turn: 3, run_id: 'r3', status: 'completed', memory_count: 0, law_count: 7, prompt_tokens: 2200, context_mode: 'law', use_memory: false },
      { turn: 4, run_id: 'r4', status: 'completed', memory_count: 0, law_count: 7, prompt_tokens: 2300, context_mode: 'law', use_memory: false },
      { turn: 5, run_id: 'r5', status: 'completed', memory_count: 0, law_count: 0, prompt_tokens: 2400, context_mode: 'memory', use_memory: true },
      { turn: 6, run_id: 'r6', status: 'completed', memory_count: 6, law_count: 7, prompt_tokens: 2450, context_mode: 'mixed', use_memory: true },
      { turn: 7, run_id: 'r7', status: 'completed', memory_count: 0, law_count: 7, prompt_tokens: 2500, context_mode: 'law', use_memory: false },
      { turn: 8, run_id: 'r8', status: 'completed', memory_count: 6, law_count: 0, prompt_tokens: 1800, context_mode: 'memory', use_memory: true },
      { turn: 9, run_id: 'r9', status: 'completed', memory_count: 0, law_count: 7, prompt_tokens: 2100, context_mode: 'law', use_memory: false },
      { turn: 10, run_id: 'r10', status: 'completed', memory_count: 6, law_count: 0, prompt_tokens: 1700, context_mode: 'memory', use_memory: true },
    ],
    outbox_done: 10,
    outbox_failed: 0,
    outbox_stale: 0,
    memory_recall_ok: false,
    prompt_growth_ok: false,
    intermediate_prompt_growth_ok: false,
    law_only_memory_clean: false,
    all_runs_terminal: false,
    errors: ['conv1t1 timeout', 'conv1t3 timeout'],
  };
  recomputeConversationFlags(result);
  assert(result.all_runs_terminal === true, 'resolved terminal turns should recompute all_runs_terminal=true');
  assert(result.errors.some((e) => e.includes('timeout')) === false, 'resolved timeout errors should be removed');
  assert(result.memory_recall_ok === true, 'recompute should preserve durable recall pass');
  assert(result.prompt_growth_ok === true, 'recompute should preserve final prompt growth pass');
  assert(result.intermediate_prompt_growth_ok === true, 'recompute should preserve intermediate growth pass');
  assert(result.law_only_memory_clean === true, 'recompute should preserve law-only cleanliness');
  console.log('[OK] recompute clears resolved timeout failures');
}

function main(): void {
  testMissingPromptTokensFailClosed();
  testPromptGrowthThreshold();
  testRecomputeClearsResolvedTimeouts();
  console.log('All verify_memory_parallel_stress unit tests passed.');
}

main();
