# ADR: Prompt Composer (pre-U10, LLM-assisted instructions) (2026-02-22)

## Context

Legal Agent (U10) should receive not only rule-based assembled prompt but optionally a **structured instruction pack** from a cheaper/faster LLM step that reorganizes requirements without adding facts.

## Decision

- **Prompt Composer** runs before the main U10 LLM call (inside U10 consumer). Input: AssembledPrompt + RunContext. Output: appendix string appended to systemPrompt, or skip.
- **No new facts:** Composer system prompt: "Do NOT add facts. Only reorganize and clarify requirements." Context sent to composer is metadata + short excerpts, not full law text.
- **Model by complexity:** Deterministic score 0..10 from userPrompt length, contextParts count, multi-aspect signals. Score ≥ threshold (6) → Claude Sonnet 3.7 non-thinking (`anthropic/claude-3.7-sonnet`). Score < 6 → Claude 3.5 Haiku. Score ≤ skip threshold (2) → skip composer, use assembled as-is.
- **Config:** PROMPT_COMPOSER_MODEL_COMPLEX_ID, PROMPT_COMPOSER_MODEL_SIMPLE_ID, PROMPT_COMPOSER_SKIP_THRESHOLD (2), PROMPT_COMPOSER_USE_COMPLEX_THRESHOLD (6), PROMPT_COMPOSER_ENABLED.

## Status

Accepted. Implemented in `write/promptComposer.ts`; invoked from U10 consumer when not dry_run.
