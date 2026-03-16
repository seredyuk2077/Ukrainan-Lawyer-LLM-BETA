# U9 in the pipeline

U9 Assemble runs after U5 Gate. It does not call MM Search directly — it uses memory and history already in RunContext (filled by U4 / upstream).

## Flow

1. **U5** enqueues U9 (when expand=false) or U6 stub → U9.
2. **U9** handleU9Event: load RunContext (retrieval_trace, raw_hits, gate_decision, history, memory_*), build U4Result + RunContext shape, call assemblePrompt().
3. **assemblePrompt**:
   - Dedup + sort rawHits (score desc, deterministic).
   - Concurrently load canonical snippets from R2 (`loadCanonicalSnippet`, Semaphore).
   - Apply law budget (U9_MAX_LAW_SNIPPETS, U9_MAX_SNIPPET_CHARS, U9_MAX_TOTAL_LAW_CHARS).
   - Add memory channel (summaries + items, U9_MAX_TOTAL_MEMORY_CHARS).
   - Add history channel (last U9_MAX_HISTORY_MESSAGES messages).
   - Build ContextPart[] with rich sourceRef (LawSourceRef / MemorySourceRef / HistorySourceRef).
   - Return AssembledPrompt with meta (budget, provenance, loadErrorsCount).
4. Persist compact assembled_prompt meta to **Supabase `runs.assembled_prompt`** (durable).
5. Store full assembled_prompt in **RunContext** (in-memory, for U10 direct access).
6. Enqueue **U10**.

## Diagram

```
U4 (RAG + MM) → U5 Gate → U9 Assemble
                              ├─ dedup + sort rawHits
                              ├─ concurrent R2 load (6 parallel)
                              ├─ budget: law ≤ 30000 chars, memory ≤ 6000 chars
                              ├─ provenance: sourceRef per ContextPart
                              ├─ persist meta → runs.assembled_prompt (Supabase)
                              └─ enqueue → U10 Write (thinking agent)
```

Contracts: `lib/pipeline/contracts.ts` (AssembledPrompt, ContextPart, LawSourceRef, RunContext, U4Result, GateDecision).

## DB schema

```
runs.assembled_prompt  jsonb  -- U9 compact meta (no full text), durable
  .assembledAt         string
  .sourcesSummary      string (e.g. "law=20 memory=0 history=0")
  .tokenEstimateTotal  number
  .tokenEstimateByChannel  {law, memory, history}
  .truncated           boolean
  .droppedChannels     string[]
  .loadErrorsCount     number
  .degraded            boolean
  .sources             {lawCount, memoryCount, historyCount}
  .lawSourceRefs       LawSourceRef[]  -- r2_key+json_path+score+loaded
```
