# U5 in the pipeline

U5 Gate sits between U4 (Legislation RAG + MM Search/Load) and U9 (Assemble). It does not call external services; it only evaluates in-memory data.

## Flow

1. **U4** finishes: RunContext has `retrieval_trace`, `raw_hits`; MM Search/Load has optionally filled `memory_items` / `memory_summaries` inside U4.
2. **U5** runs (e.g. `handleU5Event`): reads RunContext / run record, builds `EvaluateGateInput` (retrievalTrace, rawHits, queryProfile, searchPlan), calls `evaluateGate()`, persists `gate_decision` to DB and RunContext.
3. **Branch:**
   - `expand === false` (status "ok") → enqueue **U9** (Assemble).
   - `expand === true` (status "rag_missing") → enqueue **U6** (DocList/Expand) or, if disabled, stub then U9. Currently U6 is stub (log + enqueue U9).

## Diagram (text)

```
U1/U2 → U3 → U4 (RAG + MM Search/Load) → U5 Gate → [expand? U6 stub →] U9 Assemble → U10 Write → …
```

Contracts: `lib/pipeline/contracts.ts` (RunContext, U4Result, GateInput, GateDecision, gateStatus).
