/**
 * Compact retrieval_trace for DB persistence: keep dashboard/debug fields, cap heavy arrays.
 * Preserves: reason_codes, selected_acts, goals_summary (truncated), memory meta, degraded markers, counts.
 * Caps: hits (max 8), sample_hits (max 3), query_rewrite.variants (max 2), goals subquery_preview (80 chars).
 */
import type { RetrievalTrace } from './types.js';

export const MAX_HITS_IN_DB = 8;
const MAX_SAMPLE_HITS = 3;
const MAX_GOAL_SUBQUERY_PREVIEW = 80;
const MAX_QUERY_VARIANTS = 2;

/**
 * Returns a copy of the trace suitable for DB: smaller payload, forensics still usable.
 */
export function compactRetrievalTraceForDb(trace: RetrievalTrace): RetrievalTrace {
  const hits = Array.isArray(trace.hits)
    ? trace.hits.slice(0, MAX_HITS_IN_DB)
    : [];
  const meta = trace.meta ? { ...trace.meta } : undefined;
  if (meta) {
    if (Array.isArray(meta.sample_hits)) {
      meta.sample_hits = meta.sample_hits.slice(0, MAX_SAMPLE_HITS);
    }
    if (meta.goals_summary && Array.isArray(meta.goals_summary)) {
      meta.goals_summary = meta.goals_summary.map((g) => ({
        ...g,
        subquery_preview:
          typeof g.subquery_preview === 'string' && g.subquery_preview.length > MAX_GOAL_SUBQUERY_PREVIEW
            ? g.subquery_preview.slice(0, MAX_GOAL_SUBQUERY_PREVIEW) + '…'
            : g.subquery_preview,
      }));
    }
    if (meta.query_rewrite && typeof meta.query_rewrite === 'object') {
      const qr = { ...meta.query_rewrite };
      if (Array.isArray(qr.variants)) {
        qr.variants = qr.variants.slice(0, MAX_QUERY_VARIANTS);
      }
      meta.query_rewrite = qr;
    }
  }
  return {
    ...trace,
    hits,
    meta,
  };
}
