/**
 * Prompt Composer — LLM-assisted structuring of instructions for the main Legal Agent (pre-U10).
 * Does NOT add facts; only reorganizes requirements. Model: Sonnet non-thinking (complex) or Haiku (simple) by complexity score.
 */
import type { RunContext, AssembledPrompt } from '../lib/pipeline/contracts.js';
import { config } from '../lib/config.js';
import { openRouterChat } from '../lib/openrouter.js';

const COMPOSER_CALLER = 'u10-prompt-composer';

/**
 * Deterministic complexity score 0..10 from assembled + context. Used to choose model or skip.
 */
export function computeComplexityScore(assembled: AssembledPrompt, _runContext: RunContext): number {
  let score = 0;
  const userLen = assembled.userPrompt?.length ?? 0;
  if (userLen > 500) score += 3;
  else if (userLen > 200) score += 2;
  else if (userLen > 80) score += 1;

  const contextCount = assembled.contextParts?.length ?? 0;
  if (contextCount > 8) score += 3;
  else if (contextCount > 4) score += 2;
  else if (contextCount > 1) score += 1;

  const hasMultiAspect = (assembled.meta?.sourcesSummary ?? '').length > 100;
  if (hasMultiAspect) score += 2;

  return Math.min(10, score);
}

/**
 * Call Composer LLM and return appendix string + model used + latencyMs, or null when skipped/disabled.
 */
export async function composeInstructions(args: {
  assembled: AssembledPrompt;
  runContext: RunContext;
}): Promise<{ appendix: string; modelUsed: string; latencyMs: number } | null> {
  if (!config.promptComposerEnabled) return null;

  const score = computeComplexityScore(args.assembled, args.runContext);
  if (score <= config.promptComposerSkipThreshold) return null;

  const model =
    score >= config.promptComposerUseComplexThreshold
      ? config.promptComposerModelComplexId
      : config.promptComposerModelSimpleId;

  const apiKey = config.openRouterApiKey;
  if (!apiKey) return null;

  const evidenceChannels = args.assembled.contextParts
    ? [...new Set(args.assembled.contextParts.map((p) => p.type))].join(', ')
    : 'none';
  const lawCount = args.assembled.meta?.sources?.lawCount ?? 0;
  const userContent =
    `User query (do not add facts; only structure instructions):\n${args.assembled.userPrompt.slice(0, 2000)}\n\n` +
    `Available evidence channels: ${evidenceChannels}. Context parts: ${args.assembled.contextParts?.length ?? 0}. Law snippets: ${lawCount}. ` +
    `Return a short structured instruction block: task_summary, answer_requirements (bullets), output_format. ` +
    `Use only the evidence provided; do not invent legal norms.`;

  const composerStart = Date.now();
  try {
    const result = await openRouterChat(
      apiKey,
      {
        model,
        messages: [
          {
            role: 'system',
            content:
              'You are a prompt composer for a legal AI agent. Do NOT add facts. ' +
              'Only reorganize and clarify requirements for the answer. ' +
              'Output concise structured text: task summary, answer requirements (bullets), output format. ' +
              'No legal facts. Max 3 sentences per section.',
          },
          { role: 'user', content: userContent },
        ],
        temperature: 0.2,
        max_tokens: config.promptComposerMaxTokens,
        caller: COMPOSER_CALLER,
      },
      config.promptComposerTimeoutSec
    );

    const appendix = result.content.trim();
    if (!appendix) return null;
    return {
      appendix: '\n\n--- Composed instructions (do not add facts; use only evidence in context) ---\n' + appendix,
      modelUsed: result.model_id,
      latencyMs: Date.now() - composerStart,
    };
  } catch {
    return null;
  }
}
