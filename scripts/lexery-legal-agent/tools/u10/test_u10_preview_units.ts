/**
 * U10 Preview Mode unit tests (DEV RUN v9) — LEX-133
 * Run: pnpm brain:test:u10-preview-units
 *
 * Tests:
 *   P1) preview object includes prompt_stack_keys in correct order
 *   P2) preview evidence_insufficient flag correctly set
 *   P3) composer_skipped=true when evidence_insufficient
 *   P4) channel separation markers present in messages (verified via user_prefix)
 *   P5) prompt_stack_lengths reported for each level
 *   P6) system_hash and user_hash are non-empty sha256 hex strings
 *   P7) counts match contextParts channels
 *   P8) evidence_insufficient prefix changes system_hash
 */
import { createHash } from 'crypto';
import { config } from '../../lib/config.js';
import {
  buildMessagesFromAssembled,
  buildPromptStack,
  isEvidenceInsufficient,
} from '../../write/legalAgent.js';
import type { AssembledPrompt, RunContext, PromptStack } from '../../lib/pipeline/contracts.js';

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`ASSERT FAIL: ${msg}`);
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Simulate the preview object computation (mirrors what consumer.ts does). */
function buildPreview(
  assembled: AssembledPrompt,
  runContext: RunContext,
  ps?: PromptStack
): {
  model: string;
  prompt_stack_keys: string[];
  evidence_insufficient: boolean;
  context_truncated: boolean;
  counts: { law: number; memory: number; history: number };
  prompt_stack_lengths: { global?: number; project?: number; chat?: number; user?: number };
  system_hash: string;
  user_hash: string;
  system_prefix: string;
  user_prefix: string;
  composer_skipped: boolean;
} {
  const evidenceInsufficient = isEvidenceInsufficient(assembled, runContext);
  const messages = buildMessagesFromAssembled(assembled, {
    promptStack: ps,
    evidenceInsufficient,
    contextTruncated: assembled.meta?.budget?.truncated === true,
  });
  const systemMsg = messages.find((m) => m.role === 'system')?.content ?? '';
  const userMsg = messages.find((m) => m.role === 'user')?.content ?? '';
  return {
    model: config.legalAgentModelId,
    prompt_stack_keys: Object.entries(ps ?? {}).filter(([, v]) => v).map(([k]) => k),
    evidence_insufficient: evidenceInsufficient,
    context_truncated: assembled.meta?.budget?.truncated === true,
    counts: {
      law: assembled.meta?.sources?.lawCount ?? assembled.contextParts.filter((p) => p.type === 'law').length,
      memory: assembled.meta?.sources?.memoryCount ?? assembled.contextParts.filter((p) => p.type === 'memory').length,
      history: assembled.meta?.sources?.historyCount ?? assembled.contextParts.filter((p) => p.type === 'history').length,
    },
    prompt_stack_lengths: {
      global: ps?.global?.length,
      project: ps?.project?.length,
      chat: ps?.chat?.length,
      user: ps?.user?.length,
    },
    system_hash: sha256(systemMsg),
    user_hash: sha256(userMsg),
    system_prefix: systemMsg.slice(0, 200),
    user_prefix: userMsg.slice(0, 200),
    composer_skipped: evidenceInsufficient,
  };
}

function makeAssembled(opts: {
  lawCount?: number;
  memoryCount?: number;
  historyCount?: number;
  degraded?: boolean;
  truncated?: boolean;
  gateExpand?: boolean;
}): AssembledPrompt {
  const lawParts = Array.from({ length: opts.lawCount ?? 0 }, (_, i) => ({
    type: 'law' as const,
    text: `Стаття ${i + 1}. Текст норми.`,
    sourceIds: [`law-${i}`],
  }));
  const memParts = Array.from({ length: opts.memoryCount ?? 0 }, (_, i) => ({
    type: 'memory' as const,
    text: `Memory summary ${i}`,
    sourceIds: [`mem-${i}`],
  }));
  const histParts = Array.from({ length: opts.historyCount ?? 0 }, (_, i) => ({
    type: 'history' as const,
    text: `user: History message ${i}`,
    sourceIds: [],
  }));
  return {
    systemPrompt: 'You are a legal assistant. Answer only using the provided evidence (laws, memory, dialogue). Do not invent sources. Cite the law article when available. If there is no sufficient data in the context, say so clearly.',
    userPrompt: 'Яка відповідальність за ст. 115 ККУ?',
    contextParts: [...lawParts, ...memParts, ...histParts],
    meta: {
      budget: { tokenEstimateTotal: 100, tokenEstimateByChannel: { law: 60, memory: 20, history: 20 }, truncated: opts.truncated ?? false, droppedChannels: [] },
      degraded: opts.degraded ?? false,
      loadErrorsCount: opts.degraded ? 1 : 0,
      sources: { lawCount: opts.lawCount ?? 0, memoryCount: opts.memoryCount ?? 0, historyCount: opts.historyCount ?? 0 },
      lawSourceRefs: [],
    },
  };
}

function makeContext(opts?: { gateExpand?: boolean }): RunContext {
  return {
    run_id: 'preview-test',
    tenant_id: 'tenant-1',
    user_id: 'user-1',
    gate_decision: {
      expand: opts?.gateExpand ?? false,
      reason_codes: ['OK'],
      thresholds: { min_hits: 3, min_avg_score: 0.18 },
      signals: { hits_count: 0, top_score: null, avg_score: null },
      meta: {},
    },
  };
}

// ---- P1: prompt_stack_keys in correct order ----
function testP1(): void {
  const ps: PromptStack = { global: 'Global', project: 'Proj', chat: 'Chat', user: 'User' };
  const assembled = makeAssembled({ lawCount: 3 });
  const preview = buildPreview(assembled, makeContext(), ps);
  assert(preview.prompt_stack_keys.includes('global'), 'global in keys');
  assert(preview.prompt_stack_keys.includes('project'), 'project in keys');
  assert(preview.prompt_stack_keys.includes('chat'), 'chat in keys');
  assert(preview.prompt_stack_keys.includes('user'), 'user in keys');
  // Verify the built system prompt contains the stack levels in order
  const systemText = buildPromptStack(ps);
  assert(systemText.indexOf('Global') < systemText.indexOf('Proj'), 'global before project');
  assert(systemText.indexOf('Proj') < systemText.indexOf('Chat'), 'project before chat');
  assert(systemText.indexOf('Chat') < systemText.indexOf('User'), 'chat before user');
  console.log('[OK] P1: prompt_stack_keys in correct order');
}

// ---- P2: evidence_insufficient flag ----
function testP2(): void {
  const noLaw = makeAssembled({ lawCount: 0 });
  const withLaw = makeAssembled({ lawCount: 5 });
  const ctx = makeContext();

  const previewNoLaw = buildPreview(noLaw, ctx);
  const previewWithLaw = buildPreview(withLaw, ctx);

  assert(previewNoLaw.evidence_insufficient === true, 'no law → evidence_insufficient=true');
  assert(previewWithLaw.evidence_insufficient === false, 'law present → evidence_insufficient=false');
  console.log('[OK] P2: evidence_insufficient flag correctly set');
}

// ---- P3: composer_skipped=true when evidence_insufficient ----
function testP3(): void {
  const noLaw = makeAssembled({ lawCount: 0 });
  const withLaw = makeAssembled({ lawCount: 5 });
  const ctx = makeContext();

  const previewNoLaw = buildPreview(noLaw, ctx);
  const previewWithLaw = buildPreview(withLaw, ctx);

  assert(previewNoLaw.composer_skipped === true, 'no law → composer_skipped=true');
  assert(previewWithLaw.composer_skipped === false, 'law present → composer_skipped=false');
  console.log('[OK] P3: composer_skipped=true when evidence_insufficient');
}

// ---- P4: channel separation markers in user_prefix ----
function testP4(): void {
  const assembled = makeAssembled({ lawCount: 2, memoryCount: 1, historyCount: 1 });
  const preview = buildPreview(assembled, makeContext());

  // The user message should contain section markers
  const messages = buildMessagesFromAssembled(assembled);
  const userContent = messages.find((m) => m.role === 'user')?.content ?? '';
  assert(userContent.includes('=== LAW EVIDENCE ==='), 'LAW EVIDENCE section present');
  assert(userContent.includes('=== MEMORY CONTEXT ==='), 'MEMORY CONTEXT section present');
  assert(userContent.includes('=== CHAT HISTORY ==='), 'CHAT HISTORY section present');
  // Channel order: LAW before MEMORY before HISTORY
  assert(
    userContent.indexOf('=== LAW EVIDENCE ===') < userContent.indexOf('=== MEMORY CONTEXT ==='),
    'LAW before MEMORY'
  );
  assert(
    userContent.indexOf('=== MEMORY CONTEXT ===') < userContent.indexOf('=== CHAT HISTORY ==='),
    'MEMORY before HISTORY'
  );
  // preview should contain user_prefix with the start of the user content
  assert(preview.user_prefix.length > 0, 'user_prefix non-empty');
  assert(preview.counts.law === 2, 'counts.law=2');
  assert(preview.counts.memory === 1, 'counts.memory=1');
  assert(preview.counts.history === 1, 'counts.history=1');
  console.log('[OK] P4: channel separation markers in correct order (LAW→MEMORY→HISTORY)');
}

// ---- P5: prompt_stack_lengths reported ----
function testP5(): void {
  const ps: PromptStack = { global: 'A'.repeat(50), project: 'B'.repeat(30), chat: undefined, user: 'C'.repeat(10) };
  const assembled = makeAssembled({ lawCount: 2 });
  const preview = buildPreview(assembled, makeContext(), ps);

  assert(preview.prompt_stack_lengths.global === 50, `global length=50 (got ${preview.prompt_stack_lengths.global})`);
  assert(preview.prompt_stack_lengths.project === 30, `project length=30 (got ${preview.prompt_stack_lengths.project})`);
  assert(preview.prompt_stack_lengths.chat === undefined, 'chat length=undefined');
  assert(preview.prompt_stack_lengths.user === 10, `user length=10 (got ${preview.prompt_stack_lengths.user})`);
  console.log('[OK] P5: prompt_stack_lengths reported per level');
}

// ---- P6: system_hash and user_hash are sha256 hex strings ----
function testP6(): void {
  const assembled = makeAssembled({ lawCount: 3 });
  const preview = buildPreview(assembled, makeContext());

  assert(typeof preview.system_hash === 'string' && preview.system_hash.length === 64, 'system_hash is 64-char hex');
  assert(typeof preview.user_hash === 'string' && preview.user_hash.length === 64, 'user_hash is 64-char hex');
  assert(/^[0-9a-f]{64}$/.test(preview.system_hash), 'system_hash is hex');
  assert(/^[0-9a-f]{64}$/.test(preview.user_hash), 'user_hash is hex');
  console.log('[OK] P6: system_hash and user_hash are valid sha256 hex strings');
}

// ---- P7: counts match contextParts channels ----
function testP7(): void {
  const assembled = makeAssembled({ lawCount: 5, memoryCount: 2, historyCount: 3 });
  const preview = buildPreview(assembled, makeContext());

  assert(preview.counts.law === 5, `counts.law=5 (got ${preview.counts.law})`);
  assert(preview.counts.memory === 2, `counts.memory=2 (got ${preview.counts.memory})`);
  assert(preview.counts.history === 3, `counts.history=3 (got ${preview.counts.history})`);
  console.log('[OK] P7: counts match contextParts channels');
}

// ---- P8: evidence_insufficient prefix changes system_hash ----
function testP8(): void {
  const assembled = makeAssembled({ lawCount: 0 }); // insufficient
  const assembledOk = makeAssembled({ lawCount: 5 }); // sufficient
  const ctx = makeContext();

  const previewInsuff = buildPreview(assembled, ctx);
  const previewOk = buildPreview(assembledOk, ctx);

  assert(previewInsuff.system_hash !== previewOk.system_hash, 'evidence_insufficient changes system_hash');
  assert(previewInsuff.evidence_insufficient === true, 'insufficient flagged correctly');
  assert(previewOk.evidence_insufficient === false, 'sufficient not flagged');
  console.log('[OK] P8: evidence_insufficient prefix changes system_hash (different prompt = different hash)');
}

// ---- Main ----
function main(): void {
  console.log('U10 Preview Mode unit tests\n');
  testP1();
  testP2();
  testP3();
  testP4();
  testP5();
  testP6();
  testP7();
  testP8();
  console.log('\nAll U10 preview unit tests passed.');
}

main();
