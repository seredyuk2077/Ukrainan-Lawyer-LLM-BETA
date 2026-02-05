# Online Processing — Sequence Diagram

Sequence diagram для онлайн-обробки: User/Frontend → Brain (/v1/runs) → Orchestrator → Retrieval → Assemble → OpenRouter → Critic → SSE Deliver. Показані stream events, verify loop, cancellation.

```mermaid
%%{init: {"theme":"base"} }%%
sequenceDiagram
  autonumber
  participant U as User
  participant FE as Frontend
  participant BE as Backend API
  participant GW as Brain Gateway
  participant ORC as Orchestrator
  participant MEM as Memory Manager
  participant RET as Retrieval Engine
  participant ASS as Assemble
  participant OR as OpenRouter
  participant VER as Verifier
  participant DEL as Deliver

  U->>FE: Send query
  FE->>BE: POST /v1/runs (user_id, tenant_id, query)
  BE->>GW: POST /v1/runs
  GW->>GW: Auth, limits, RunRecord
  GW-->>BE: 202 run_id
  BE-->>FE: run_id
  FE->>DEL: GET /v1/runs/{run_id}/events (SSE)

  GW->>ORC: enqueue run
  ORC->>ORC: [U2] Classify
  ORC->>OR: LLM classify (QueryProfile)
  OR-->>ORC: QueryProfile
  ORC->>ORC: [U3] Plan (SearchPlan)
  ORC->>MEM: context / memory recall
  MEM-->>ORC: MemoryRefs
  ORC->>RET: [U4] CacheRAG (SearchPlan, query)
  RET->>RET: Qdrant LLDBI chunks/acts
  RET-->>ORC: RawHits[]
  ORC->>ORC: [U5] Gate
  alt expand=true
    ORC->>OR: [U6] Expand (synonyms)
    OR-->>ORC: expanded query
    ORC->>RET: [U7] DocList resolve
    RET-->>ORC: ActCandidates[]
    ORC->>ORC: [U8] Import (optional)
    Note over ORC: may trigger T6 LLDBI ingestion
  end
  ORC->>ASS: [U9] Assemble (RawHits, Memory, query)
  ASS->>ASS: R2 CanonicalSnippetLoader
  ASS-->>ORC: Complete Prompt
  ORC->>DEL: stream event: state=reason
  ORC->>OR: [U10] Write (prompt, stream)
  loop stream tokens
    OR-->>ORC: token
    ORC->>DEL: SSE message (token)
    DEL->>FE: SSE message
  end
  OR-->>ORC: Draft Answer
  ORC->>VER: [U11] Verify (Draft, EvidencePack)
  VER->>OR: Critic (optional)
  OR-->>VER: coverage verdict
  alt retry_with_more_evidence
    VER-->>ORC: retry
    ORC->>RET: [U11c] QueryRefiner → [U4] again
    RET-->>ORC: RawHits
    ORC->>ASS: Assemble again
    ASS-->>ORC: Prompt
    ORC->>OR: Write again
    OR-->>ORC: Draft Answer
    ORC->>VER: Verify again
  end
  VER-->>ORC: complete / failed
  ORC->>DEL: [U12] final answer, RunRecord finalized
  DEL->>FE: SSE status final
  DEL->>DEL: messages DB, outbox, billing

  opt Cancellation
    U->>FE: Cancel
    FE->>BE: DELETE /runs/{run_id}
    BE->>GW: cancel
    GW->>ORC: cancel token
    ORC->>OR: abort stream
    DEL->>FE: SSE status cancelled
  end
```

## Події стріму (StreamEvent)

- **state** — classify | plan | memory | retrieve | doclist | import | reason | verify | write | deliver
- **message** — контент відповіді (токени/чанки)
- **status** — final | cancelled | timeout
- **progress** — step_i / step_n
- **cost_so_far_usd**, **citations_count**, **mode**, **degrade_reason**

Джерело: plan.md Appendix A9.1 StreamEvent, answer.md [U12] Deliver.
