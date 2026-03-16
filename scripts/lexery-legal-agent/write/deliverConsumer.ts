/**
 * U12 Deliver — claim + idempotent messages/outbox + completeRun (Azure multi-instance).
 * When outbox is enqueued and worker is enabled, schedules a non-blocking wake-up for that conversation.
 */
import type { RunEvent } from '../gateway/types.js';
import type { LegalAgentResult } from '../lib/pipeline/contracts.js';
import { RunRepository, type RunSourceSummary } from '../gateway/storage.js';
import { incrementU12Success, incrementU12Fail } from '../gateway/observability.js';
import { logger } from '../lib/logger.js';
import { config } from '../lib/config.js';
import { runOutboxWorkerBatch } from '../mm/outboxWorker.js';
import { normalizeMemorySummary } from './memorySummary.js';

/** Bounded memory summary for outbox/extraction: plain, no markdown/legal structure. */
function buildAnswerSummaryForMemory(answerText: string): string {
  return normalizeMemorySummary(answerText, 500);
}

export interface MmOutboxPayloadForMemory {
  conversation_id: string | null;
  tenant_id: string | null;
  user_id: string;
  user_query: string;
  answer_summary: string;
  source_summary: RunSourceSummary;
}

export function buildMmOutboxPayloadForMemory(params: {
  conversationId: string | null;
  tenantId: string | null;
  userId: string;
  userQuery: string;
  answerText: string;
  sourceSummary: RunSourceSummary;
}): MmOutboxPayloadForMemory {
  return {
    conversation_id: params.conversationId,
    tenant_id: params.tenantId,
    user_id: params.userId,
    user_query: params.userQuery.slice(0, 2000),
    answer_summary: buildAnswerSummaryForMemory(params.answerText),
    source_summary: params.sourceSummary,
  };
}

/** Build authoritative RunSourceSummary from run row (supports top-level and nested assembled_prompt.sources). Used by U12 and tests. */
export function buildRunSourceSummary(
  run: {
    assembled_prompt?: unknown;
    query_profile?: unknown;
    llm_result?: unknown;
    retrieval_trace?: unknown;
    snapshot?: unknown;
  },
  existing?: RunSourceSummary | null
): RunSourceSummary {
  const assembled = run?.assembled_prompt as {
    sources?: { lawCount?: number; docCount?: number; memoryCount?: number; historyCount?: number };
    meta?: { sources?: { lawCount?: number; docCount?: number; memoryCount?: number; historyCount?: number } };
  } | undefined;
  const assembledSources = assembled?.sources ?? assembled?.meta?.sources;
  const memTrace = run?.retrieval_trace as { meta?: { memory?: { scope_primary?: string; scope_fallback_used?: boolean } } } | undefined;
  const snapshot = run?.snapshot as { u10_selection?: { triage_used?: boolean | null } } | undefined;
  const snapshotTriageUsed = snapshot?.u10_selection?.triage_used;
  return {
    context_mode: (run?.query_profile as { routing_flags?: { context_mode?: string } } | undefined)?.routing_flags?.context_mode ?? existing?.context_mode ?? null,
    history_count: assembledSources?.historyCount ?? existing?.history_count ?? null,
    memory_count: assembledSources?.memoryCount ?? existing?.memory_count ?? null,
    law_count: assembledSources?.lawCount ?? existing?.law_count ?? null,
    document_count: assembledSources?.docCount ?? existing?.document_count ?? 0,
    triage_used:
      (typeof snapshotTriageUsed === 'boolean' || snapshotTriageUsed === null
        ? snapshotTriageUsed
        : undefined) ??
      (run?.llm_result as { triage_used?: boolean } | undefined)?.triage_used ??
      existing?.triage_used ??
      null,
    prompt_tokens: (run?.llm_result as { usage?: { prompt_tokens?: number } } | undefined)?.usage?.prompt_tokens ?? existing?.prompt_tokens ?? null,
    memory_scope_mode: (memTrace?.meta?.memory?.scope_primary as 'conversation' | 'user_global' | undefined) ?? existing?.memory_scope_mode ?? null,
    memory_fallback_used: memTrace?.meta?.memory?.scope_fallback_used ?? existing?.memory_fallback_used ?? null,
  };
}

const runRepo = new RunRepository();

export async function handleU12Event(event: RunEvent): Promise<void> {
  if (event.step !== 'U12') return;

  const { run_id, trace_id } = event;
  const ctx = { run_id, step: 'U12', trace_id, module: 'write/deliverConsumer' };

  let delivered = false;
  let messageInserted = false;
  let outboxEnqueued = false;
  let completed_at_set = false;

  try {
    const run = await runRepo.findByRunId(run_id);
    if (run?.completed_at != null) {
      logger.info('U12 idempotent skip (completed_at already set)', ctx);
      return;
    }

    const claimed = await runRepo.claimU12Run(run_id);
    if (!claimed) {
      const runAgain = await runRepo.findByRunId(run_id);
      if (runAgain?.completed_at != null) {
        logger.info('U12 claim lost, another instance completed', ctx);
        return;
      }
    }

    const llmResult = run?.llm_result as LegalAgentResult | undefined;
    const answerText = llmResult?.answerText ?? '';
    const conversationId = run?.conversation_id ?? null;
    const tenantId = (run?.tenant_id ?? null) as string | null;
    const userId = run?.user_id ?? '';
    const userQuery = (run?.query ?? (run?.snapshot as { request?: { query?: string } } | undefined)?.request?.query) ?? '';

    if (conversationId && answerText) {
      messageInserted = await runRepo.insertAssistantMessageIfNotExists(
        run_id,
        conversationId,
        answerText
      );
    }

    const existing = (run?.snapshot as { source_summary?: RunSourceSummary } | undefined)?.source_summary;
    const summary = buildRunSourceSummary(run, existing);

    outboxEnqueued = await runRepo.insertMmOutboxIfNotExists(
      run_id,
      conversationId,
      tenantId,
      'index_memory',
      buildMmOutboxPayloadForMemory({
        conversationId,
        tenantId,
        userId,
        userQuery,
        answerText,
        sourceSummary: summary,
      })
    );

    if (outboxEnqueued && conversationId && config.mmOutboxWorkerEnabled) {
      setImmediate(() => {
        runOutboxWorkerBatch({ conversationId, batchSize: 5, runId: `wake-${run_id}` }).catch((err) => {
          logger.warn('U12 outbox wake-up batch failed (non-blocking)', {
            run_id,
            conversation_id: conversationId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      });
    }

    await runRepo.patchRunSourceSummary(run_id, summary);

    await runRepo.completeRun(run_id);
    delivered = true;
    completed_at_set = true;

    logger.info('U12 deliver', {
      ...ctx,
      delivered,
      messageInserted,
      outboxEnqueued,
      completed_at_set,
    });
    incrementU12Success();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('U12 failed', { ...ctx, error: msg, delivered });
    if (!completed_at_set) {
      try {
        await runRepo.markFailed(run_id, 'U12_DELIVER_ERROR');
      } catch (markErr) {
        logger.warn('U12 markFailed failed (non-fatal)', {
          ...ctx,
          error: markErr instanceof Error ? markErr.message : String(markErr),
        });
      }
    }
    incrementU12Fail();
    throw err;
  }
}
