/**
 * U10 Legal Agent — runLegalAgent: AssembledPrompt → configured OpenRouter model → LegalAgentResult (LEX-133)
 *
 * Features (DEV RUN v8):
 *   - buildPromptStack: multi-level system prompt (global → project → chat → user)
 *   - buildMessagesFromAssembled: structured evidence sections (LAW / USER DOCUMENTS / MEMORY / HISTORY)
 *   - evidenceInsufficientMode: when law evidence missing/degraded → special system prefix
 *   - Stateless; no shared mutable state; safe for concurrent runs.
 */
import type {
  RunContext,
  AssembledPrompt,
  AssembledPromptBudget,
  LegalAgentResult,
  PromptStack,
} from '../lib/pipeline/contracts.js';
import { config } from '../lib/config.js';
import { openRouterChat, OpenRouterError } from '../lib/openrouter.js';

const U10_CALLER = 'u10-legal-agent';

/** Internal RAG awareness (DEV RUN v14): user did not provide the documents. */
const RAG_AWARENESS =
  'You are operating inside Lexery Legal Agent. The context below was retrieved by the system from an internal legislation database (RAG). The user did not provide these documents. ' +
  'Do NOT say "надані матеріали", "матеріали користувача" or similar. Prefer: "витяги з норм законодавства з внутрішньої бази Lexery".';

/**
 * Common groundedness: shared by both legal and memory modes (architecture decision).
 * Answer only from provided context; do not invent facts; same language; concise/factual.
 */
export const COMMON_GROUNDEDNESS_PROMPT =
  'Answer ONLY based on the evidence in the context provided. Do not invent facts or sources. ' +
  'Respond in the same language as the user (default: Ukrainian). Keep answers concise and factual.';

/** Service-level global safety prompt for Legal Agent (COMMON_GROUNDEDNESS + LEGAL/RAG overlay). */
const GLOBAL_SAFETY_PROMPT =
  'You are Lexery Legal Agent — a professional Ukrainian legal assistant. ' +
  RAG_AWARENESS + ' ' +
  COMMON_GROUNDEDNESS_PROMPT + ' ' +
  'Do not invent legal norms, articles, or facts not present in the evidence. ' +
  'If a norm is cited, verify it against the law snippets in context. ' +
  'If evidence is insufficient, clearly state this and explain what information is missing.';

/** Memory recall: COMMON_GROUNDEDNESS + MEMORY_RECALL overlay (no legal/RAG framing). */
const MEMORY_RECALL_SYSTEM_PROMPT =
  COMMON_GROUNDEDNESS_PROMPT + ' ' +
  'The user is asking about what you remember from this conversation. ' +
  'Use ONLY the MEMORY CONTEXT and CHAT HISTORY sections below. ' +
  'Do NOT cite laws, articles (ст.), or legal norms unless the user explicitly asks for legal text or qualification. ' +
  'Do NOT say you cannot access previous chats — use the context provided.';

const DOC_ONLY_SYSTEM_PROMPT =
  COMMON_GROUNDEDNESS_PROMPT + ' ' +
  'The user is asking about their own uploaded documents. ' +
  'Use ONLY the USER DOCUMENTS and CHAT HISTORY sections below. ' +
  'Do NOT describe the evidence as legislation retrieval, internal law database, or legal RAG. ' +
  'Do NOT cite laws, statutes, codes, or legal norms unless they are explicitly present in the retrieved USER DOCUMENTS text. ' +
  'If the requested fact is not present in the retrieved USER DOCUMENTS, say so plainly.';

/** Memory recall mode: reinforce no legal citation (appended after context). */
const MEMORY_ANSWER_MODE_PROMPT =
  '--- MEMORY ANSWER MODE ---\n' +
  'Answer from MEMORY CONTEXT and CHAT HISTORY only. Do NOT cite legislation or legal norms unless the user explicitly asked for legal qualification. ' +
  'Summarize prior requests or facts clearly. No "Закон України", "ст. N", or legal framing unless the user asked for it.';

const DOC_ONLY_ANSWER_MODE_PROMPT =
  '--- USER DOCUMENT ANSWER MODE ---\n' +
  'Answer from USER DOCUMENTS (and CHAT HISTORY when present) only. ' +
  'Do NOT cite legislation, articles (ст.), codes, or external legal norms unless they are explicitly present in the retrieved USER DOCUMENTS text. ' +
  'If the user asks for legal qualification but no law snippets are present, say that you can only confirm what is stated in the user documents. ' +
  'Do NOT add phrases about absent legislation, missing legal norms, or legal databases unless the user explicitly asked about that absence.';

/** DEV RUN v18: universal citation format — every answer that cites norms MUST use this structure. */
const UNIVERSAL_CITATION_RULES =
  '\n\n--- Output format (mandatory when citing norms) ---\n' +
  'In every answer that refers to legal norms, use this structure (adapt to the question):\n' +
  '• Норма (цитування): [НПА name]; if date/number is in evidence use e.g. "Закон України від DD.MM.YYYY № N"; then "ст. X", "ч. Y" (or пункт/підпункт/абзац as in the act). Example: Цивільний кодекс України (Закон України від 16.01.2003 № 435-IV, зі змінами): ст. 256, ч. 1. If date/number is not in evidence: Цивільний кодекс України: ст. 256, ч. 1.\n' +
  '• Цитата: 1–3 sentences from the evidence (exact or close quote); do not invent.\n' +
  '• Пояснення: short explanation in your own words.\n' +
  '• Як застосовується (умови/винятки): only if present in evidence; otherwise say "у наданих витягах відсутні відповідні положення".\n' +
  'Do NOT use vague references like "ЦК України: «Поняття…», ч.1" without "ст. X". Always include article number (ст. X) when citing.';

/** System prefix injected when evidence is degraded/missing. */
const EVIDENCE_INSUFFICIENT_PREFIX =
  '⚠️ EVIDENCE INSUFFICIENT: The legal retrieval returned zero or degraded law snippets for this query. ' +
  'Do NOT attempt to answer from general knowledge. ' +
  'Inform the user that insufficient legal norms were found, describe what is missing, ' +
  'and suggest they clarify or rephrase the question. Do not fabricate any legal articles.';

/**
 * Build a stacked system prompt from PromptStack.
 * Order: global_safety → project → chat → user_additional_constraints.
 * User prompt is appended as "Additional user instructions" — never overrides safety.
 */
export function buildPromptStack(stack?: PromptStack): string {
  const parts: string[] = [];
  parts.push(stack?.global?.trim() || GLOBAL_SAFETY_PROMPT);
  if (stack?.project?.trim()) {
    parts.push('--- Project context ---\n' + stack.project.trim());
  }
  if (stack?.chat?.trim()) {
    parts.push('--- Chat context ---\n' + stack.chat.trim());
  }
  if (stack?.user?.trim()) {
    parts.push('--- Additional user instructions (no safety override) ---\n' + stack.user.trim());
  }
  return parts.join('\n\n');
}

/**
 * Detect whether evidence is insufficient for a real answer (DEV RUN v16).
 * True only when: law channel is empty, or degraded with significant load errors.
 * gate.expand no longer forces insufficient — it triggers triage + ambiguous_query warning.
 */
export function isEvidenceInsufficient(assembled: AssembledPrompt, _runContext: RunContext): boolean {
  const lawCount = assembled.meta?.sources?.lawCount ?? assembled.contextParts.filter((p) => p.type === 'law').length;
  const docCount = assembled.meta?.sources?.docCount ?? assembled.contextParts.filter((p) => p.type === 'doc').length;
  const degraded = assembled.meta?.degraded === true;
  const loadErrors = assembled.meta?.loadErrorsCount ?? 0;
  return (lawCount === 0 && docCount === 0) || (degraded && loadErrors > 0 && docCount === 0);
}

/**
 * Build OpenRouter messages from AssembledPrompt with:
 *   - Stacked system prompt (via PromptStack or GLOBAL_SAFETY_PROMPT)
 *   - Evidence insufficient prefix when applicable
 *   - Structured context sections: LAW EVIDENCE / USER DOCUMENTS / MEMORY CONTEXT / CHAT HISTORY
 *   - Context budget warning when truncated
 */
/** Mandatory output template for crime_composition (DEV RUN v14). */
const CRIME_COMPOSITION_TEMPLATE =
  'For questions about the composition of a crime (склад злочину), your answer MUST follow this structure:\n' +
  '1) Норма (цитування): e.g. Кримінальний кодекс України: Закон України від 05.04.2001 № 2341-III (зі змінами), ч. 1 ст. 115.\n' +
  '2) Цитата: 1–3 sentences from the norm (relevant fragment).\n' +
  '3) Склад злочину: Об\'єкт; Об\'єктивна сторона; Суб\'єкт; Суб\'єктивна сторона.\n' +
  '4) Санкція: punishment from the norm.\n' +
  'Do NOT list unrelated articles unless the user asked. Start with the primary norm and citation.';

export function isTransientLegalAgentError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (/fetch failed|ECONNRESET|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|network/i.test(msg)) return true;
  if (!(err instanceof OpenRouterError)) return false;
  if (err.code === 'TIMEOUT' || err.code === 'NETWORK') return true;
  if (err.statusCode === 429) return true;
  return err.statusCode != null && err.statusCode >= 500;
}

export async function withTransientLegalAgentRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 2
): Promise<T> {
  let lastErr: unknown;
  const attempts = Math.max(1, maxAttempts);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientLegalAgentError(err) || attempt === attempts) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 700 * attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export function buildMessagesFromAssembled(
  assembled: AssembledPrompt,
  options?: {
    promptStack?: PromptStack;
    evidenceInsufficient?: boolean;
    contextTruncated?: boolean;
    /** When crime_composition, add mandatory template (DEV RUN v14). When memory_recall, add MEMORY ANSWER MODE. */
    taskType?: 'crime_composition' | 'citation_only' | 'general' | 'memory_recall';
  }
): Array<{ role: 'system' | 'user'; content: string }> {
  const { promptStack, evidenceInsufficient, contextTruncated, taskType } = options ?? {};
  const lawParts = assembled.contextParts.filter((p) => p.type === 'law');
  const docParts = assembled.contextParts.filter((p) => p.type === 'doc');
  const memoryParts = assembled.contextParts.filter((p) => p.type === 'memory');
  const historyParts = assembled.contextParts.filter((p) => p.type === 'history');
  const hasLawEvidence = lawParts.length > 0;
  const hasDocOnlyEvidence = !hasLawEvidence && docParts.length > 0;

  let systemPrompt: string;

  if (taskType === 'memory_recall') {
    // Pure memory: do not use legal-assistant prompt; use memory-only identity so model does not cite laws
    systemPrompt = MEMORY_RECALL_SYSTEM_PROMPT;
    if (promptStack?.chat?.trim()) systemPrompt += '\n\n--- Chat context ---\n' + promptStack.chat.trim();
    if (promptStack?.user?.trim()) systemPrompt += '\n\n--- User instructions ---\n' + promptStack.user.trim();
    systemPrompt += '\n\n' + MEMORY_ANSWER_MODE_PROMPT;
  } else if (hasDocOnlyEvidence) {
    systemPrompt = DOC_ONLY_SYSTEM_PROMPT;
    if (promptStack?.chat?.trim()) systemPrompt += '\n\n--- Chat context ---\n' + promptStack.chat.trim();
    if (promptStack?.user?.trim()) systemPrompt += '\n\n--- User instructions ---\n' + promptStack.user.trim();
    systemPrompt += '\n\n' + DOC_ONLY_ANSWER_MODE_PROMPT;
  } else {
    systemPrompt = assembled.systemPrompt ?? '';
    if (!systemPrompt || systemPrompt === 'You are a legal assistant. Answer only using the provided evidence (laws, memory, dialogue). Do not invent sources. Cite the law article when available. If there is no sufficient data in the context, say so clearly.') {
      systemPrompt = buildPromptStack(promptStack);
    }
    if (evidenceInsufficient) {
      systemPrompt = EVIDENCE_INSUFFICIENT_PREFIX + '\n\n' + systemPrompt;
    }
    if (contextTruncated) {
      systemPrompt += '\n\n⚠️ NOTE: The legal context was truncated due to token budget limits. Some law snippets may be missing.';
    }
    if (hasLawEvidence) {
      systemPrompt += UNIVERSAL_CITATION_RULES;
    }
    if (taskType === 'crime_composition') {
      systemPrompt += '\n\n' + CRIME_COMPOSITION_TEMPLATE;
    }
  }

  let userContent = assembled.userPrompt;

  const sections: string[] = [];

  if (lawParts.length > 0) {
    const lawBlocks = lawParts.map((p, i) => {
      const ref = p.sourceRef as { act_title?: string; article_number?: string; r2_key?: string; normRef?: { heading?: string } } | undefined;
      const actTitle = ref?.act_title ?? '';
      const art = ref?.article_number ? ` ст. ${ref.article_number}` : '';
      const normRef = ref?.normRef?.heading ? ` ${ref.normRef.heading}` : '';
      const sourceId = ref?.r2_key ?? (p.sourceIds?.[0] as string) ?? '';
      return `### [LAW #${i + 1}] ${actTitle}${art}${normRef}\nSOURCE_ID: ${sourceId}\nTEXT:\n${p.text}`;
    });
    sections.push('=== LAW EVIDENCE ===\n' + lawBlocks.join('\n\n'));
  }

  if (docParts.length > 0) {
    const docBlocks = docParts.map((p, i) => {
      const ref = p.sourceRef as {
        filename?: string;
        title?: string;
        scope_type?: string;
        doc_id?: string;
        json_path?: string;
      } | undefined;
      const title = ref?.title || ref?.filename || `Document ${i + 1}`;
      const scope = ref?.scope_type ? ` (${ref.scope_type})` : '';
      const docId = ref?.doc_id ?? (p.sourceIds?.[0] as string) ?? '';
      const location = ref?.json_path ? `\nLOCATION: ${ref.json_path}` : '';
      return `### [DOC #${i + 1}] ${title}${scope}\nDOC_ID: ${docId}${location}\nTEXT:\n${p.text}`;
    });
    sections.push('=== USER DOCUMENTS ===\n' + docBlocks.join('\n\n'));
  }

  if (memoryParts.length > 0) {
    const memBlock = memoryParts.map((p) => p.text).join('\n\n');
    sections.push('=== MEMORY CONTEXT ===\n' + memBlock);
  }

  if (historyParts.length > 0) {
    const histBlock = historyParts.map((p) => p.text).join('\n\n');
    sections.push('=== CHAT HISTORY ===\n' + histBlock);
  }

  if (sections.length > 0) {
    userContent = userContent + '\n\n---\n' + sections.join('\n\n---\n');
  }

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];
}

/** DEV RUN v18: forensics — what U10 actually sent to the model (hashes, lengths, counts). */
export interface U10PromptDebug {
  system_len: number;
  user_len: number;
  evidence_block_len: number;
  law_parts_count: number;
  total_evidence_chars: number;
  max_single_snippet_chars: number;
  sample_source_ref_ids: string[];
  model_id: string;
  budget?: AssembledPromptBudget;
  created_at: string;
}

export function buildU10PromptDebug(
  assembled: AssembledPrompt,
  messages: Array<{ role: 'system' | 'user'; content: string }>
): U10PromptDebug {
  const systemMsg = messages.find((m) => m.role === 'system')?.content ?? '';
  const userMsg = messages.find((m) => m.role === 'user')?.content ?? '';
  const lawParts = assembled.contextParts.filter((p) => p.type === 'law');
  const docParts = assembled.contextParts.filter((p) => p.type === 'doc');
  const totalLawChars = lawParts.reduce((s, p) => s + p.text.length, 0);
  const totalDocChars = docParts.reduce((s, p) => s + p.text.length, 0);
  const maxSnippet = lawParts.length ? Math.max(...lawParts.map((p) => p.text.length)) : 0;
  const evidenceBlock =
    lawParts.length > 0
      ? '=== LAW EVIDENCE ===\n' + lawParts.map((p) => p.text).join('\n\n')
      : '' +
        (docParts.length
          ? '\n\n=== USER DOCUMENTS ===\n' + docParts.map((p) => p.text).join('\n\n')
          : '') +
        (assembled.contextParts.filter((p) => p.type === 'memory').length
          ? '\n\n=== MEMORY CONTEXT ===\n' +
            assembled.contextParts
              .filter((p) => p.type === 'memory')
              .map((p) => p.text)
              .join('\n\n')
          : '') +
        (assembled.contextParts.filter((p) => p.type === 'history').length
          ? '\n\n=== CHAT HISTORY ===\n' +
            assembled.contextParts
              .filter((p) => p.type === 'history')
              .map((p) => p.text)
              .join('\n\n')
          : '');
  const sampleIds = lawParts
    .slice(0, 5)
    .map((p) => (p.sourceRef as { r2_key?: string } | undefined)?.r2_key ?? p.sourceIds?.[0] ?? '')
    .filter(Boolean);
  return {
    system_len: systemMsg.length,
    user_len: userMsg.length,
    evidence_block_len: evidenceBlock.length,
    law_parts_count: lawParts.length,
    total_evidence_chars: totalLawChars + totalDocChars,
    max_single_snippet_chars: maxSnippet,
    sample_source_ref_ids: sampleIds,
    model_id: config.legalAgentModelId,
    budget: assembled.meta?.budget ?? undefined,
    created_at: new Date().toISOString(),
  };
}

/**
 * Call LLM and return LegalAgentResult.
 * openRouterChat already retries one provider-side 5xx once; U10 adds one outer retry for transient
 * TIMEOUT/NETWORK/429/5xx so a single flaky writer call does not fail the whole long conversation.
 */
export async function runLegalAgent(args: {
  runId: string;
  runContext: RunContext;
  assembled: AssembledPrompt;
  /** Optional focus spec for template + taskType (DEV RUN v14). */
  focusSpec?: { taskType: 'crime_composition' | 'citation_only' | 'general' | 'memory_recall' };
  /** DEV RUN v18: optional pre-built messages (consumer saves u10_prompt_debug). */
  preBuiltMessages?: Array<{ role: 'system' | 'user'; content: string }>;
}): Promise<LegalAgentResult> {
  const { runContext, assembled, focusSpec, preBuiltMessages } = args;
  const apiKey = config.openRouterApiKey;
  if (!apiKey) {
    throw new Error('U10: OPENROUTER_API_KEY_BRAIN or OPENROUTER_API_KEY_ONLINE required');
  }

  const evidenceInsufficient = isEvidenceInsufficient(assembled, runContext);
  const contextTruncated = assembled.meta?.budget?.truncated === true;
  const promptStack = runContext.prompt_stack;

  const messages =
    preBuiltMessages ??
    buildMessagesFromAssembled(assembled, {
      promptStack,
      evidenceInsufficient,
      contextTruncated,
      taskType: focusSpec?.taskType,
    });

  const timeoutSec = config.legalAgentTimeoutSec;
  const maxTokens = config.legalAgentMaxTokens;
  const model = config.legalAgentModelId;

  return withTransientLegalAgentRetry(async () => {
      const result = await openRouterChat(
        apiKey,
        {
          model,
          messages,
          temperature: 0.2,
          max_tokens: maxTokens,
          caller: U10_CALLER,
        },
        timeoutSec
      );

      const usage = result.usage
        ? {
            prompt_tokens: result.usage.prompt_tokens,
            completion_tokens: result.usage.completion_tokens,
            total_tokens:
              result.usage.total_tokens ??
              (result.usage.prompt_tokens ?? 0) + (result.usage.completion_tokens ?? 0),
          }
        : undefined;

      return {
        answerText: result.content,
        model: result.model_id,
        latencyMs: result.latency_ms,
        finishReason: result.finish_reason,
        usage,
        warnings: evidenceInsufficient ? ['evidence_insufficient'] : undefined,
      };
    }, 2);
}

/**
 * DEV RUN v18: single repair call (nano) to add explicit citations when missing_citation.
 * Max one call per run; no loops.
 */
export async function repairCitationAnswer(answerText: string): Promise<string> {
  const apiKey = config.openRouterApiKey;
  if (!apiKey) return answerText;
  try {
    const result = await openRouterChat(
      apiKey,
      {
        model: config.evidenceTriageModelId,
        messages: [
          {
            role: 'system',
            content:
              'Rewrite the legal answer to include explicit citations: НПА (act name), ст. X, ч. Y (or пункт/підпункт). Keep the same language (Ukrainian) and content; only add or clarify norm references. Output only the rewritten answer, no preamble.',
          },
          { role: 'user', content: answerText.slice(0, 4000) },
        ],
        temperature: 0.2,
        max_tokens: 2048,
        caller: 'u10-citation-repair',
      },
      15
    );
    return result.content?.trim() || answerText;
  } catch {
    return answerText;
  }
}

export type MemoryRecallVerdict = 'grounded_memory_recall' | 'substantive_answer_not_recall' | 'unsupported_or_fabricated';

/**
 * Grounded judge for memory_recall: sees user query, memory context, history, and proposed answer.
 * Returns strict JSON verdict. No phrase heuristics; no legal wordlists.
 */
export async function judgeMemoryRecallGrounded(params: {
  userQuery: string;
  memoryText: string;
  historyText: string;
  answerText: string;
}): Promise<{ verdict: MemoryRecallVerdict }> {
  const apiKey = config.openRouterApiKey;
  const fallback: { verdict: MemoryRecallVerdict } = { verdict: 'unsupported_or_fabricated' };
  if (!apiKey) return fallback;
  try {
    const body = `User query: ${params.userQuery.slice(0, 500)}

MEMORY CONTEXT:
${params.memoryText.slice(0, 2000)}

CHAT HISTORY:
${params.historyText.slice(0, 1500)}

PROPOSED ANSWER:
${params.answerText.slice(0, 2000)}

Return exactly one JSON object with a single key "verdict" and value one of: grounded_memory_recall, substantive_answer_not_recall, unsupported_or_fabricated.
grounded_memory_recall = answer summarizes or recalls what was discussed, based on the context above.
substantive_answer_not_recall = answer gives standalone definitions or legal explanation not framed as conversation recall.
unsupported_or_fabricated = answer invents facts or is not supported by the context.`;

    const result = await openRouterChat(
      apiKey,
      {
        model: config.evidenceTriageModelId,
        messages: [
          {
            role: 'system',
            content:
              'You are a judge. Output ONLY valid JSON. No markdown, no preamble. Key: verdict. Values: grounded_memory_recall | substantive_answer_not_recall | unsupported_or_fabricated.',
          },
          { role: 'user', content: body },
        ],
        temperature: 0,
        max_tokens: 64,
        caller: 'u10-memory-recall-judge',
      },
      12
    );
    const raw = result.content?.trim() ?? '';
    const parsed = JSON.parse(raw) as { verdict?: string };
    const v = parsed.verdict;
    if (v === 'grounded_memory_recall' || v === 'substantive_answer_not_recall' || v === 'unsupported_or_fabricated') {
      return { verdict: v };
    }
    return fallback;
  } catch {
    return fallback;
  }
}

/**
 * One bounded grounded regenerate: rewrites answer using the same memory + history context (no answer-only rewrite).
 */
export async function regenerateMemoryRecallGrounded(params: {
  userQuery: string;
  memoryText: string;
  historyText: string;
}): Promise<string> {
  const apiKey = config.openRouterApiKey;
  if (!apiKey) return '';
  try {
    const body = `User query: ${params.userQuery.slice(0, 500)}

MEMORY CONTEXT:
${params.memoryText.slice(0, 2500)}

CHAT HISTORY:
${params.historyText.slice(0, 1500)}

Using ONLY the memory context and chat history above, write a short answer that recalls or summarizes what was discussed. Same language as the user. Do not invent facts. Output only the answer, no preamble.`;

    const result = await openRouterChat(
      apiKey,
      {
        model: config.evidenceTriageModelId,
        messages: [
          {
            role: 'system',
            content:
              'Answer only from the provided MEMORY CONTEXT and CHAT HISTORY. Do not cite laws or give standalone legal definitions. Summarize what was discussed. Output only the answer.',
          },
          { role: 'user', content: body },
        ],
        temperature: 0.2,
        max_tokens: 1024,
        caller: 'u10-memory-recall-regenerate',
      },
      15
    );
    return result.content?.trim() ?? '';
  } catch {
    return '';
  }
}

/**
 * One bounded grounded regenerate for USER DOCUMENTS-only answers.
 * Uses only retrieved document snippets (+ optional chat history), never external legal knowledge.
 */
export async function regenerateDocOnlyGrounded(params: {
  userQuery: string;
  docText: string;
  historyText: string;
}): Promise<string> {
  const apiKey = config.openRouterApiKey;
  if (!apiKey) return '';
  try {
    const body = `User query: ${params.userQuery.slice(0, 500)}

USER DOCUMENTS:
${params.docText.slice(0, 3000)}

CHAT HISTORY:
${params.historyText.slice(0, 1200)}

Write a short answer using ONLY the USER DOCUMENTS and CHAT HISTORY above. Do not invent legal norms, articles, codes, or external sources. If the retrieved document text does not contain the requested legal qualification, say so plainly. Output only the answer.`;

    const result = await openRouterChat(
      apiKey,
      {
        model: config.evidenceTriageModelId,
        messages: [
          {
            role: 'system',
            content:
              'Answer only from the provided USER DOCUMENTS and CHAT HISTORY. ' +
              'Do not cite statutes, articles, codes, or external legal norms unless they are explicitly present in the retrieved document text. ' +
              'When the user asks to repeat a term, date, amount, deadline, or table value, return the shortest exact value from the most directly matching document line or table row. ' +
              'Do not mention missing legislation or absent legal norms unless the user explicitly asked about that. ' +
              'Prefer direct extraction over summary. Output only the answer.',
          },
          { role: 'user', content: body },
        ],
        temperature: 0.1,
        max_tokens: 1024,
        caller: 'u10-doc-grounded-regenerate',
      },
      15
    );
    return result.content?.trim() ?? '';
  } catch {
    return '';
  }
}

const COMPACT_REPAIR_SYSTEM =
  'Rewrite the legal answer to be more compact: keep ONLY the core norms needed to answer; maximum 3–4 normative references (ст. X, ч. Y). Do not invent new norms. Preserve the legal substance and key conclusions. Output only the rewritten answer, no preamble.';

const COMPACT_REPAIR_STRICT_SYSTEM =
  'Rewrite the legal answer to be very compact: keep ONLY 2–3 most essential normative references (ст. X, ч. Y). Remove all redundant article mentions. Do not invent norms. Preserve the legal conclusion. Output only the rewritten answer, no preamble.';

/** PHASE 2: single compact-repair call (same U10 model). */
export async function repairCompactAnswer(answerText: string, strict = false): Promise<string> {
  const apiKey = config.openRouterApiKey;
  if (!apiKey) return answerText;
  try {
    const result = await openRouterChat(
      apiKey,
      {
        model: config.legalAgentModelId,
        messages: [
          {
            role: 'system',
            content: strict ? COMPACT_REPAIR_STRICT_SYSTEM : COMPACT_REPAIR_SYSTEM,
          },
          { role: 'user', content: answerText.slice(0, 6000) },
        ],
        temperature: 0.2,
        max_tokens: 2048,
        caller: strict ? 'u10-compact-repair-strict' : 'u10-compact-repair',
      },
      20
    );
    return result.content?.trim() || answerText;
  } catch {
    return answerText;
  }
}
