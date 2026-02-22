/**
 * U3a Plan Builder — SearchPlan → concrete SearchSteps (LEX-113)
 * Params: top_k, min_score, timeout_ms, memory_enabled, doclist_enabled, import_fast_count.
 */
import type { SearchPlan, SearchStep } from './types.js';

const DEFAULT_TOP_K = 20;
const DEFAULT_MIN_SCORE = 0.5;
const DEFAULT_TIMEOUT_MS = 5000;
const IMPORT_FAST_COUNT = 3;
const IMPORT_TIMEOUT_MS = 10000;

/** Build ordered SearchSteps from SearchPlan. Gate is implicit after U4; expand/doclist/import conditional. */
export function buildSearchSteps(plan: SearchPlan): SearchStep[] {
  const topK = plan.thresholds?.top_k_chunks ?? DEFAULT_TOP_K;
  const minScore = plan.thresholds?.min_score ?? DEFAULT_MIN_SCORE;
  const steps: SearchStep[] = [];
  let order = 0;

  if (plan.sources.use_lldbi) {
    steps.push({
      kind: 'lldbi_chunks',
      params: { top_k: topK, min_score: minScore, timeout_ms: DEFAULT_TIMEOUT_MS },
      order: order++,
    });
    steps.push({
      kind: 'lldbi_acts',
      params: {
        top_k: plan.thresholds?.top_k_acts ?? 10,
        min_score: minScore,
        timeout_ms: DEFAULT_TIMEOUT_MS,
      },
      order: order++,
    });
  }

  if (plan.sources.use_memory) {
    steps.push({
      kind: 'memory',
      params: { top_k: 10, timeout_ms: 3000 },
      order: order++,
    });
  }

  // Gate runs after U4 (not a step kind here; U5 handles it)
  // Expand + DocList + Import fast-mode when use_doclist
  if (plan.sources.use_doclist) {
    steps.push({
      kind: 'doclist',
      params: { top_k: 15, timeout_ms: 7000 },
      order: order++,
    });
    steps.push({
      kind: 'import_fast',
      params: {
        top_k: IMPORT_FAST_COUNT,
        timeout_ms: IMPORT_TIMEOUT_MS,
      },
      order: order++,
    });
  }

  if (plan.sources.use_web) {
    steps.push({ kind: 'web', params: { timeout_ms: 15000 }, order: order++ });
  }

  return steps;
}
