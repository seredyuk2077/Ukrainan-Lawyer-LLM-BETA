# ADR: U5 minimal gate (happy-path only, no DocList/Import)

**Date:** 2026-02-22  
**Status:** Accepted  
**Related:** LEX-131, LEX-130

## Context

U5 Gate decides whether retrieval evidence is sufficient to proceed to U9 Assemble or whether to "expand" (U6 DocList/Import). Full design may include retries, web-docs, and multi-step DocList. This run implements only the minimal gate.

## Decision

1. **Implement only happy-path gate logic**
   - **status "ok"** (expand=false): rawHits.length >= MIN_HITS_THRESHOLD (config, default 3), no critical degraded_sources (e.g. lldbi), no LOW_SCORE / DIRECT_REF_MISSING / AMBIGUOUS_QUERY / NEED_DEEP_RETRIEVAL. Proceed to U9.
   - **status "rag_missing"** (expand=true): any of FEW_HITS, LOW_SCORE, DEGRADED_LLDBI, DIRECT_REF_MISSING, AMBIGUOUS_QUERY, NEED_DEEP_RETRIEVAL. Reason codes stored in GateDecision; RunRecord.gate_decision persisted.

2. **Stub for rag_missing**
   - When expand=true we do **not** run real U6 DocList/Import or web-docs. Either: complete run with a special status, or pass GateDecision to U9/U10 so they can produce a "no legislation" style response. Current code: U6 is a stub (log + enqueue U9).

3. **Contracts**
   - Shared types in `lib/pipeline/contracts.ts`: RunContext, U4Result, GateInput, GateDecision (re-export), gateStatus(decision) → "ok" | "rag_missing". No new top-level `online/` directory.

4. **Not in scope**
   - DocList/Import cycles, retries, web-docs, complex expand flows. Those are follow-up work.

## Consequences

- U4 → U5 → U9 chain is well-defined and testable (unit tests + E2E verify_u5).
- When we add real U6, we only extend the branch after expand=true; Gate contract stays the same.
