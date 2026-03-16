/**
 * U11 Verify unit tests — verdict logic (complete vs failed)
 * Run: pnpm brain:test:u11-units
 */
import type { LegalAgentResult, VerifyResult } from '../../lib/pipeline/contracts.js';

function verdictFromLlmResult(llmResult: LegalAgentResult | undefined): VerifyResult['verdict'] {
  return llmResult?.answerText != null && String(llmResult.answerText).trim().length > 0
    ? 'complete'
    : 'failed';
}

function testCompleteWhenAnswerNonEmpty(): void {
  const llmResult: LegalAgentResult = {
    answerText: 'Article 115 defines murder.',
    model: 'test',
    latencyMs: 100,
  };
  const v = verdictFromLlmResult(llmResult);
  if (v !== 'complete') throw new Error(`Expected complete, got ${v}`);
  console.log('[OK] verdict complete when answerText non-empty');
}

function testFailedWhenAnswerEmpty(): void {
  const llmResult: LegalAgentResult = {
    answerText: '',
    model: 'test',
    latencyMs: 50,
  };
  const v = verdictFromLlmResult(llmResult);
  if (v !== 'failed') throw new Error(`Expected failed, got ${v}`);
  console.log('[OK] verdict failed when answerText empty');
}

function testFailedWhenUndefined(): void {
  const v = verdictFromLlmResult(undefined);
  if (v !== 'failed') throw new Error(`Expected failed, got ${v}`);
  console.log('[OK] verdict failed when llm_result undefined');
}

async function main(): Promise<void> {
  console.log('U11 Verify unit tests\n');
  testCompleteWhenAnswerNonEmpty();
  testFailedWhenAnswerEmpty();
  testFailedWhenUndefined();
  console.log('\nAll U11 verify unit tests passed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
