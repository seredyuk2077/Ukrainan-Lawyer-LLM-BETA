/**
 * U11 Verify — minimal scaffold: verdict complete | retry | failed. Claim + durable verify_result (Azure).
 */
import type { RunEvent } from '../gateway/types.js';
import type { LegalAgentResult, VerifyResult } from '../lib/pipeline/contracts.js';
import { getTaskQueue } from '../gateway/handler.js';
import { RunRepository } from '../gateway/storage.js';
import { logger } from '../lib/logger.js';
import { runContextGet, runContextSet } from '../lib/run-context.js';

const RUN_CONTEXT_TTL_SEC = 3600;
const runRepo = new RunRepository();

export async function handleU11Event(event: RunEvent): Promise<void> {
  if (event.step !== 'U11') return;

  const { run_id, trace_id } = event;
  const ctx = { run_id, step: 'U11', trace_id, module: 'write/verifyConsumer' };
  let verifyPersisted = false;

  try {
    const runFromDb = await runRepo.findByRunId(run_id);
    const existingVerify = runFromDb?.verify_result as VerifyResult | undefined;
    if (existingVerify != null) {
      logger.info('U11 idempotent skip (verify_result in DB)', { ...ctx, verdict: existingVerify.verdict });
      const now = new Date().toISOString();
      await getTaskQueue().enqueue({ run_id, step: 'U12', created_at: now, trace_id });
      return;
    }

    const claimed = await runRepo.claimU11Run(run_id);
    if (!claimed) {
      const runAgain = await runRepo.findByRunId(run_id);
      const otherVerify = runAgain?.verify_result as VerifyResult | undefined;
      if (otherVerify != null) {
        logger.info('U11 claim lost, another instance wrote result', { ...ctx });
        const now = new Date().toISOString();
        await getTaskQueue().enqueue({ run_id, step: 'U12', created_at: now, trace_id });
        return;
      }
    }

    let llmResult: LegalAgentResult | undefined = runFromDb?.llm_result as LegalAgentResult | undefined;
    if (llmResult == null) {
      const stored = await runContextGet<Record<string, unknown>>(run_id);
      llmResult = stored?.llm_result as LegalAgentResult | undefined;
    }

    const verdict: VerifyResult['verdict'] =
      llmResult?.answerText != null && String(llmResult.answerText).trim().length > 0
        ? 'complete'
        : 'failed';
    const reasons: string[] =
      verdict === 'complete' ? [] : [llmResult ? 'Empty answer' : 'Missing llm_result'];

    const verifyResult: VerifyResult = {
      verdict,
      reasons: reasons.length > 0 ? reasons : undefined,
    };

    try {
      await runRepo.persistVerifyResult(run_id, verifyResult);
      verifyPersisted = true;
    } catch {
      // Column may be missing; persist to context only
    }

    const stored = (await runContextGet<Record<string, unknown>>(run_id)) ?? {};
    await runContextSet(
      run_id,
      { ...stored, verify_result: verifyResult } as Record<string, unknown>,
      RUN_CONTEXT_TTL_SEC
    );

    logger.info('U11 verdict', {
      ...ctx,
      verdict,
      reasonsCount: verifyResult.reasons?.length ?? 0,
    });

    const now = new Date().toISOString();
    await getTaskQueue().enqueue({
      run_id,
      step: 'U12',
      created_at: now,
      trace_id,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('U11 failed', { ...ctx, error: msg });
    if (!verifyPersisted) {
      try {
        await runRepo.markFailed(run_id, 'U11_VERIFY_ERROR');
      } catch (markErr) {
        logger.warn('U11 markFailed failed (non-fatal)', {
          ...ctx,
          error: markErr instanceof Error ? markErr.message : String(markErr),
        });
      }
    }
    throw err;
  }
}
