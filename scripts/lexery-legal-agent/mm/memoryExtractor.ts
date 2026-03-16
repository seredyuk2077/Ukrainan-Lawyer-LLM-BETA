/**
 * MM Memory Extractor — extract stable facts from a legal answer summary using Haiku LLM.
 * Used by MM Outbox Worker to populate mm_memory_items.
 *
 * Design:
 *   - Cheap LLM (Haiku): extract up to K short facts
 *   - Structured output: MemoryFact[] (type, text, importance) for storage policy
 *   - Max text length enforced (mmMaxFactTextChars) to avoid huge content
 *   - Non-fatal: any failure returns empty array (worker logs and continues)
 */
import { config } from '../lib/config.js';
import { openRouterChat } from '../lib/openrouter.js';
import { logger } from '../lib/logger.js';

const CALLER = 'mm-extractor';

/** Structured fact for memory storage (DEV RUN v11). */
export interface MemoryFact {
  type: 'person_detail' | 'preference' | 'case_fact' | 'jurisdiction' | 'other';
  text: string;
  importance?: number;
}

const EXTRACTION_SYSTEM_PROMPT =
  'You are a memory extraction assistant for a legal AI agent. ' +
  'Extract up to 5 stable memory facts from the provided conversation answer summary. ' +
  'Facts should be about the user, their matter, their documents, timeline, budget, constraints, or preferences — NOT legal doctrine. ' +
  'Each fact must be a single short sentence (max 80 chars). ' +
  'Do not output legal definitions, statutory citations, code names, article numbers, or generic legal explanations. ' +
  'Avoid sensitive legal advice, verdicts, or confidential data. ' +
  'Prefer concrete conversation facts over abstract legal framing. ' +
  'Output ONLY a JSON array of objects: [{"type":"person_detail|preference|case_fact|jurisdiction|other","text":"...","importance":0.0-1.0},...]. ' +
  'Example: [{"type":"person_detail","text":"User name is Andrii","importance":0.9},{"type":"preference","text":"User prefers short answers","importance":0.8}]';

const USER_MESSAGE_MIXED_SYSTEM_PROMPT =
  'You extract durable conversational memory from a USER message in a legal chat. ' +
  'Return ONLY facts explicitly stated by the user about their identity, matter facts, documents, dates, amounts, constraints, preferences, or goals. ' +
  'If a message mixes legal context with explicit user/case facts, KEEP those explicit facts. ' +
  'User-defined labels or codewords for a matter may be retained when they help identify the same conversation or case. ' +
  'If the user message is mainly a legal question, legal comparison, request for explanation, or reference to laws/articles/codes and does not explicitly state durable user or case facts, return an empty JSON array []. ' +
  'Do NOT transform a legal topic into memory. ' +
  'Do NOT output legal comparisons, legal doctrines, code names, article references, or the mere fact that the user asked for a comparison. ' +
  'Each fact must be a single short sentence (max 80 chars). ' +
  'Output ONLY a JSON array of objects: [{"type":"person_detail|preference|case_fact|jurisdiction|other","text":"...","importance":0.0-1.0},...].';

export interface ExtractedFacts {
  /** Plain text list (for backward compat and embedding). */
  facts: string[];
  /** Structured facts (type, text, importance). */
  structured: MemoryFact[];
  modelUsed: string;
  latencyMs: number;
}

export type MemoryExtractionMode = 'answer_summary' | 'user_message_mixed';

function dedupeKey(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function pushFact(
  target: MemoryFact[],
  seen: Set<string>,
  type: MemoryFact['type'],
  text: string,
  importance: number
): void {
  const normalized = text.trim().replace(/\s+/g, ' ');
  if (!normalized) return;
  const key = dedupeKey(normalized);
  if (!key || seen.has(key)) return;
  seen.add(key);
  target.push({ type, text: normalized, importance });
}

export function mergeParsedMemoryFacts(params: {
  raw: string;
  deterministicFacts?: MemoryFact[];
  maxFacts?: number;
  maxTextChars?: number;
}): { facts: string[]; structured: MemoryFact[] } {
  const deterministicFacts = params.deterministicFacts ?? [];
  const maxFacts = params.maxFacts ?? config.mmMaxFactsPerEvent;
  const maxTextChars = params.maxTextChars ?? config.mmMaxFactTextChars;
  const structured: MemoryFact[] = [...deterministicFacts];
  const facts: string[] = deterministicFacts.map((fact) => fact.text);
  const seenFacts = new Set<string>(deterministicFacts.map((fact) => dedupeKey(fact.text)));

  const jsonMatch = params.raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return { facts, structured };

  const parsed = JSON.parse(jsonMatch[0]) as unknown;
  if (!Array.isArray(parsed)) return { facts, structured };

  for (const item of parsed.slice(0, maxFacts)) {
    if (typeof item === 'string') {
      const text = item.trim().slice(0, maxTextChars);
      const normalizedKey = dedupeKey(text);
      if (text && !seenFacts.has(normalizedKey)) {
        seenFacts.add(normalizedKey);
        structured.push({ type: 'case_fact', text, importance: 0.5 });
        facts.push(text);
      }
    } else if (item && typeof item === 'object' && 'text' in item && typeof (item as { text: unknown }).text === 'string') {
      const o = item as { type?: string; text: string; importance?: number };
      const text = o.text.trim().slice(0, maxTextChars);
      const normalizedKey = dedupeKey(text);
      if (text && !seenFacts.has(normalizedKey)) {
        seenFacts.add(normalizedKey);
        const type = ['person_detail', 'preference', 'case_fact', 'jurisdiction', 'other'].includes(o.type as string)
          ? (o.type as MemoryFact['type'])
          : 'case_fact';
        structured.push({ type, text, importance: Math.min(1, Math.max(0, o.importance ?? 0.5)) });
        facts.push(text);
      }
    }
  }

  return { facts, structured };
}

export function extractDeterministicMixedFacts(input: string): MemoryFact[] {
  const facts: MemoryFact[] = [];
  const seen = new Set<string>();
  const text = input.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!text) return facts;

  const capture = (
    re: RegExp,
    build: (match: RegExpExecArray) => { type: MemoryFact['type']; text: string; importance: number } | null
  ): void => {
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) != null) {
      const built = build(match);
      if (built) pushFact(facts, seen, built.type, built.text, built.importance);
    }
  };

  capture(/кодов(?:е|им)\s+слов(?:о|ом)\s*[—:-]?\s*([A-ZА-ЯІЇЄҐ0-9][A-ZА-ЯІЇЄҐ0-9-]{2,40})/giu, (match) => ({
    type: 'case_fact',
    text: `Case codeword: ${match[1]}`,
    importance: 0.98,
  }));
  capture(/(?:улюблений|любимий)\s+колір\s*[—:-]?\s*([A-Za-zА-Яа-яІіЇїЄєҐґ'-]{2,40})/giu, (match) => ({
    type: 'preference',
    text: `Favorite color is ${match[1]}`,
    importance: 0.9,
  }));
  capture(/(?:(?:мою|мого|мій|моя)\s+)?(?:собаку|собака|пса|пес)\s+(?:звуть|звати|зовуть)\s+([A-Za-zА-Яа-яІіЇїЄєҐґ'-]{2,40})/giu, (match) => ({
    type: 'person_detail',
    text: `Dog is named ${match[1]}`,
    importance: 0.92,
  }));
  capture(/(?:живу|мешкаю)\s+(?:у|в)\s+міст[іе]\s+([A-Za-zА-Яа-яІіЇїЄєҐґ'-]{2,40})/giu, (match) => ({
    type: 'person_detail',
    text: `Lives in ${match[1]}`,
    importance: 0.88,
  }));
  capture(/(?:мій|моя)\s+бюджет\s*(?:становить|складає)?\s*[—:-]?\s*([\d\s.,]+(?:грн|₴))/giu, (match) => ({
    type: 'case_fact',
    text: `Budget is ${match[1].replace(/\s+/g, ' ').trim()}`,
    importance: 0.86,
  }));
  capture(/резервн(?:ий|ого)\s+фонд\s*[—:-]?\s*([\d\s.,]+(?:грн|₴))/giu, (match) => ({
    type: 'case_fact',
    text: `Reserve fund is ${match[1].replace(/\s+/g, ' ').trim()}`,
    importance: 0.76,
  }));

  return facts.slice(0, config.mmMaxFactsPerEvent);
}

export function buildMemoryExtractionPromptParts(params: {
  answerSummary: string;
  userQuery?: string;
  mode?: MemoryExtractionMode;
}): { systemPrompt: string; userContent: string } {
  const mode = params.mode ?? 'answer_summary';
  const systemPrompt = mode === 'user_message_mixed'
    ? USER_MESSAGE_MIXED_SYSTEM_PROMPT
    : EXTRACTION_SYSTEM_PROMPT;
  const userContent = mode === 'user_message_mixed'
    ? `User message: ${params.answerSummary.slice(0, 1200)}`
    : params.userQuery
      ? `User question: ${params.userQuery.slice(0, 200)}\n\nAnswer summary: ${params.answerSummary.slice(0, 600)}`
      : `Answer summary: ${params.answerSummary.slice(0, 600)}`;
  return { systemPrompt, userContent };
}

/**
 * Extract memory facts from an answer summary using cheap LLM.
 * Returns empty facts array on any error (non-fatal).
 */
export async function extractMemoryFacts(params: {
  answerSummary: string;
  userQuery?: string;
  runId?: string;
  mode?: MemoryExtractionMode;
}): Promise<ExtractedFacts> {
  const { answerSummary, userQuery, runId, mode = 'answer_summary' } = params;
  const ctx = { run_id: runId, module: 'mm/memoryExtractor' };

  if (!config.openRouterApiKey && !config.openRouterApiKeyRag) {
    logger.warn('mm_extractor: no API key — skipping extraction', ctx);
    return { facts: [], structured: [], modelUsed: '', latencyMs: 0 };
  }

  const apiKey = config.openRouterApiKeyRag || config.openRouterApiKey;
  const deterministicMixedFacts =
    mode === 'user_message_mixed' ? extractDeterministicMixedFacts(answerSummary) : [];
  if (deterministicMixedFacts.length >= 2) {
    return {
      facts: deterministicMixedFacts.map((fact) => fact.text),
      structured: deterministicMixedFacts,
      modelUsed: 'deterministic_mixed',
      latencyMs: 0,
    };
  }

  const { systemPrompt, userContent } = buildMemoryExtractionPromptParts({
    answerSummary,
    userQuery,
    mode,
  });

  try {
    const result = await openRouterChat(
      apiKey,
      {
        model: config.mmExtractionModelId,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        temperature: 0.1,
        max_tokens: 256,
        caller: CALLER,
      },
      Math.ceil(config.mmExtractionTimeoutMs / 1000)
    );

    const raw = result.content.trim();
    const { facts, structured } = mergeParsedMemoryFacts({
      raw,
      deterministicFacts: deterministicMixedFacts,
    });

    logger.debug('mm_extractor: extracted facts', { ...ctx, count: facts.length, model: result.model_id });
    return { facts, structured, modelUsed: result.model_id, latencyMs: result.latency_ms };
  } catch (err) {
    logger.warn('mm_extractor: extraction failed (non-fatal)', {
      ...ctx,
      error: err instanceof Error ? err.message : String(err),
      deterministic_facts_salvaged: deterministicMixedFacts.length,
    });
    return {
      facts: deterministicMixedFacts.map((fact) => fact.text),
      structured: deterministicMixedFacts,
      modelUsed: config.mmExtractionModelId,
      latencyMs: 0,
    };
  }
}
