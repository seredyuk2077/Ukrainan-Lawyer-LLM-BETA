# ADR: U10 noise control and citation template

**Date:** 2026-02-28  
**Status:** Accepted  
**Context:** DEV RUN v14 — first real LLM run showed model "drifting into overview" (many unrelated articles, "надані матеріали" framing) instead of focused answer with citation.

## Decision

1. **U9 metadata (normRef + lawIndex)**  
   Extract from each law snippet: article number, part, heading. Persist in `LawSourceRef.normRef` and `assembled_prompt.meta.lawIndex` for U10 focus/triage.

2. **FocusSpec (deterministic)**  
   Before generation, build `FocusSpec`: task type (e.g. crime_composition), primary norm source id (from lawIndex match to query), `maxLawSnippets` (e.g. 3), required sections, banned phrases, citation style.

3. **Enforce focus on context**  
   After triage (or when skipped): ensure primary norm snippet is included and first; slice law parts to `maxLawSnippets`. No trust in model to "pick" the right norm without signal.

4. **System prompt**  
   Add RAG-awareness: "Context from internal Lexery legislation database; user did not provide these documents." Forbid "надані матеріали"; prefer "витяги з норм законодавства з внутрішньої бази Lexery". For crime_composition, require output template: Норма (цитування) → Цитата → Склад злочину → Санкція.

5. **Output validator**  
   Post-LLM: check banned phrases, citation presence, "Склад злочину" / 4 elements for crime_composition, article sprawl (>5 "ст." refs). Record failures in `llm_result.warnings`; do not block pipeline. Optional: single repair attempt (out of scope for v14).

## Consequences

- Focused answers for "склад злочину" queries; fewer irrelevant articles.
- Observability via focusSpec logs and validator warnings.
- Backward compatible: normRef/lawIndex optional; validator non-blocking.
