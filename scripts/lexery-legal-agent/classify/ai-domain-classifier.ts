/**
 * U2 AI Domain Classifier (Phase 6) — budgeted, only when heuristic low/unknown.
 * Returns taxonomy family keys only; max 1 call/run; cache by run_id; strict JSON + Zod.
 */
import { z } from 'zod';
import { openRouterChat, OpenRouterError } from '../lib/openrouter.js';
import { runContextGet, runContextSet } from '../lib/run-context.js';

export interface AiDomainConfig {
  openRouterApiKey: string;
  u2AiDomainModel: string;
  u2AiDomainMaxTokens: number;
  u2AiDomainTimeoutMs: number;
  u2AiDomainMaxCallsPerRun: number;
  u2AiDomainMinConfidence: number;
}

/** Allowed family keys from taxonomy (legislation_documents.category); no act names. */
export const ALLOWED_TAXONOMY_FAMILY_KEYS = new Set([
  'criminal',
  'civil',
  'tax_customs',
  'labor_social',
  'administrative',
  'judiciary_justice',
  'administrative_offenses',
  'criminal_procedure',
  'civil_procedure',
  'corporate',
  'general',
  'unknown',
]);

const DomainOutputSchema = z.object({
  domain_primary: z.string().trim(),
  domain_secondary: z.string().trim().optional(),
  confidence: z.number().min(0).max(1),
  rationale_short: z.string().max(300).optional(),
  missing_info_flags: z.array(z.string()).optional(),
});

export type AiDomainOutput = z.infer<typeof DomainOutputSchema>;

export interface AiDomainClassifierInput {
  query: string;
  heuristic_domain: string;
  heuristic_confidence: number;
  run_id?: string;
}

export interface AiDomainClassifierResult {
  domain_primary: string;
  domain_secondary?: string;
  confidence: number;
  rationale_short?: string;
  missing_info_flags?: string[];
  meta: {
    called: boolean;
    used: boolean;
    not_used_reason?: string;
    attempts: number;
    parse_mode: 'zod' | 'best_effort' | 'failed';
    failure_reason?: string;
  };
}

const TAXONOMY_SUMMARY =
  'Дозволені галузі (тільки ці ключі): criminal, civil, tax_customs, labor_social, administrative, judiciary_justice, administrative_offenses, criminal_procedure, civil_procedure, corporate, general, unknown. Не повертай назви актів.';

function buildPrompt(input: AiDomainClassifierInput): string {
  const { query, heuristic_domain, heuristic_confidence } = input;
  return `Ти класифікатор правової галузі запиту. Вхід: запит користувача.
Евристика дала: domain=${heuristic_domain}, confidence=${heuristic_confidence.toFixed(2)}.

${TAXONOMY_SUMMARY}

Запит: "${query.slice(0, 2000)}"

Поверни ТІЛЬКИ один JSON-об'єкт без markdown:
{"domain_primary": "<один з дозволених ключів>", "domain_secondary": "<або unknown>", "confidence": 0.0-1.0, "rationale_short": "1-2 речення", "missing_info_flags": []}
Якщо запит поза правом — domain_primary: "unknown", confidence < 0.55.`;
}

function normalizeToAllowed(key: string): string {
  const k = key.trim().toLowerCase().replace(/\s+/g, '_');
  return ALLOWED_TAXONOMY_FAMILY_KEYS.has(k) ? k : 'unknown';
}

function tryParse(content: string): AiDomainOutput | null {
  const trimmed = content.trim();
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  const jsonStr = jsonMatch ? jsonMatch[0] : trimmed;
  try {
    const raw = JSON.parse(jsonStr) as unknown;
    const parsed = DomainOutputSchema.safeParse(raw);
    if (parsed.success) {
      return {
        ...parsed.data,
        domain_primary: normalizeToAllowed(parsed.data.domain_primary),
        domain_secondary: parsed.data.domain_secondary
          ? normalizeToAllowed(parsed.data.domain_secondary)
          : undefined,
      };
    }
    const bestEffort = raw as Record<string, unknown>;
    const primary =
      typeof bestEffort.domain_primary === 'string'
        ? normalizeToAllowed(bestEffort.domain_primary)
        : 'unknown';
    const confidence =
      typeof bestEffort.confidence === 'number'
        ? Math.min(1, Math.max(0, bestEffort.confidence))
        : 0.5;
    return {
      domain_primary: primary,
      domain_secondary:
        typeof bestEffort.domain_secondary === 'string'
          ? normalizeToAllowed(bestEffort.domain_secondary)
          : undefined,
      confidence,
      rationale_short:
        typeof bestEffort.rationale_short === 'string'
          ? bestEffort.rationale_short.slice(0, 300)
          : undefined,
      missing_info_flags: Array.isArray(bestEffort.missing_info_flags)
        ? (bestEffort.missing_info_flags as string[]).slice(0, 5)
        : undefined,
    };
  } catch {
    return null;
  }
}

const CACHE_KEY_AI_DOMAIN = 'u2_ai_domain_result';
const CACHE_TTL_SEC = 3600;

export async function classifyDomainWithAi(
  config: AiDomainConfig,
  input: AiDomainClassifierInput
): Promise<AiDomainClassifierResult> {
  const { run_id } = input;
  if (config.u2AiDomainMaxCallsPerRun >= 1 && run_id) {
    const cached = (await runContextGet<Record<string, unknown>>(run_id)) ?? {};
    const stored = cached[CACHE_KEY_AI_DOMAIN] as AiDomainClassifierResult | undefined;
    if (stored && typeof stored === 'object' && 'domain_primary' in stored) {
      return {
        ...stored,
        meta: { ...stored.meta, called: false, used: stored.meta.used },
      };
    }
  }

  const timeoutSec = Math.ceil(config.u2AiDomainTimeoutMs / 1000);
  const messages = [
    { role: 'system' as const, content: 'Ти відповідаєш лише валідним JSON без markdown.' },
    { role: 'user' as const, content: buildPrompt(input) },
  ];

  let attempts = 0;
  let lastContent = '';
  let parseMode: 'zod' | 'best_effort' | 'failed' = 'failed';
  let failureReason: string | undefined;

  for (let i = 0; i < 2; i++) {
    attempts++;
    try {
      const result = await openRouterChat(
        config.openRouterApiKey,
        {
          model: config.u2AiDomainModel,
          messages,
          temperature: 0.1,
          max_tokens: config.u2AiDomainMaxTokens,
        },
        timeoutSec
      );
      lastContent = result.content ?? '';
      const parsed = tryParse(lastContent);
      if (parsed) {
        parseMode = DomainOutputSchema.safeParse(parsed).success ? 'zod' : 'best_effort';
        const used =
          parsed.confidence >= config.u2AiDomainMinConfidence && parsed.domain_primary !== 'unknown';
        const out: AiDomainClassifierResult = {
          ...parsed,
          meta: { called: true, used, attempts, parse_mode: parseMode },
        };
        if (config.u2AiDomainMaxCallsPerRun >= 1 && run_id) {
          const merged = (await runContextGet<Record<string, unknown>>(run_id)) ?? {};
          await runContextSet(
            run_id,
            { ...merged, [CACHE_KEY_AI_DOMAIN]: out } as Record<string, unknown>,
            CACHE_TTL_SEC
          );
        }
        return out;
      }
      failureReason = 'invalid_json';
    } catch (err) {
      failureReason = err instanceof Error ? err.message : String(err);
      if (err instanceof OpenRouterError && err.statusCode === 429) break;
    }
  }

  return {
    domain_primary: 'unknown',
    confidence: 0,
    meta: {
      called: true,
      used: false,
      not_used_reason: failureReason ?? 'parse_failed',
      attempts,
      parse_mode: 'failed',
      failure_reason: failureReason,
    },
  };
}
