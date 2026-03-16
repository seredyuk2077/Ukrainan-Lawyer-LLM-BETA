# Retrieval trace: compact (DB) + full (R2) storage policy

**Status:** Decision / target state. Current: compact-only in DB; full-trace R2 offload and pointer not yet implemented.

---

## Policy (target)

1. **DB (Supabase `runs.retrieval_trace`):** Store **compact** trace only.
   - `compactRetrievalTraceForDb()` caps: `hits` (max 8), `meta.sample_hits` (max 3), `meta.goals_summary.subquery_preview` (80 chars), `meta.query_rewrite.variants` (max 2).
   - Preserves: `reason_codes`, `selected_acts`, counts, `memory` meta, degraded markers.
   - Optional: add `full_trace_r2_key` (or `snapshot.retrieval_trace_full_key`) when full trace is offloaded.

2. **R2 (full trace artifact):** For heavy runs (e.g. hits > 8 or config threshold), write full `retrieval_trace` to R2.
   - Suggested key: `runs/{tenant_id}/{run_id}/retrieval_trace_full.json` or `tenant/{tenant_id}/runs/{run_id}/retrieval_trace.json`.
   - DB keeps compact + pointer so forensics can resolve full trace when needed.

3. **Forensics / tools:**
   - Prefer: read compact from DB; use `meta.hits_count`, `meta.sample_hits`, and compact `hits` for dashboard/audit.
   - When full hit list is required (e.g. U9/U10 chunk diagnostic): resolve from R2 using pointer if present; otherwise document that only compact is available and use `meta.hits_count` + sample.

---

## Current state

- **Compact:** Implemented in `retrieval/retrieval-trace-compact.ts`; used in `retrieval/consumer.ts` before `updateRetrievalTrace()`.
- **Full-trace R2 offload:** Not implemented. TODO: in retrieval consumer (or gateway storage), when `trace.hits.length > MAX_HITS_IN_DB`, write full trace to R2 and store key in run snapshot or in `retrieval_trace.meta.full_trace_r2_key`.
- **Forensics:** Tools that read `run.retrieval_trace.hits` from DB currently get at most 8 hits. They should either:
  - Use compact + `meta.hits_count` and accept truncated hit list for audits, or
  - Be updated to fetch full trace from R2 when `full_trace_r2_key` is set.

---

## Acceptance

- Median DB `retrieval_trace` size materially lower (achieved by compact).
- Forensics not broken: either they work with compact, or they use R2 when pointer present (after implementation).
