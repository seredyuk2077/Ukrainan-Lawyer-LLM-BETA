# MM Docs Foundation — 2026-03-14

## Problem

LLDBI covers legislation. MM memory covers conversational facts and summaries. We still need a separate document-RAG subsystem for user-uploaded documents such as contracts, claims, annexes, spreadsheets, and case materials.

This subsystem must:

- isolate data by tenant + user + scope
- support chat-scoped, project-scoped, and user-global documents
- keep heavy content out of Supabase row storage
- stay cheap enough for legal-agent production usage
- become a first-class evidence channel instead of being mixed into chat memory

## Scope Model

MM Docs foundation uses three explicit scopes:

- `conversation`
- `project`
- `user_global`

Resolution rule in the new helper:

1. explicit requested scope if valid and fully specified
2. current conversation if present
3. current project if present
4. user-global fallback

## Storage Model

### Supabase

Two new tables:

- `mm_doc_records`
  - durable metadata per ingested document
  - tenant/user/project/conversation isolation fields
  - source kind, status, parser metadata, chunk count, R2 pointers
- `mm_doc_ingest_log`
  - cheap stage/event log
  - keeps operational traceability without storing large content
  - now bounded by app-level retention + row-cap pruning so Supabase log volume does not grow without limit

### Cloudflare R2

Legal-agent bucket namespace:

- raw upload:
  - `tenant/{tenant}/mm/docs/user/{user}/raw/{doc_id}/{filename}`
- canonical parsed artifact:
  - `tenant/{tenant}/mm/docs/user/{user}/scope/{scope_type}/{scope_id}/{doc_id}/canonical.v1.json`

Important nuance:

- if the source document already entered the pipeline as a chat attachment stored under `tenant/{tenant}/runs/{run_id}/attachments/...`, MM Docs may retain that existing attachment key as `raw_r2_key`
- `canonical_r2_key` is the stable MM Docs artifact and always lives under the `mm/docs/...` namespace
- internal attachment references are now accepted only from:
  - same-tenant `runs/.../attachments/...` keys
  - same-tenant + same-user `mm/docs/user/.../raw/...` keys
- internal references to MM Docs canonical artifacts are rejected at the gateway surface; retrieval must go through the MM Docs toolchain, not raw attachment reuse

Canonical artifact stores:

- parsed blocks
- semantic chunks
- parser warnings
- scope/source metadata

### Qdrant

Separate MM Docs collection:

- default collection id: `lexery_mm_docs_chunks_v1`
- default production topology: shared Lexery-LA Qdrant cluster, separate MM Docs collection
- optional future isolation: docs-specific endpoint may be configured later without changing app logic

Payload isolation keys:

- `tenant_id`
- `user_id`
- `project_id`
- `conversation_id`
- `scope_type`
- `scope_id`

## Parsing Support Implemented

Foundation parser currently supports:

- `.txt`
- `.md`
- `.json`
- `.csv`
- `.pdf` via `pdftotext`
- legacy `.doc` via `soffice/libreoffice` fallback or `textutil`
- `.docx`
- `.rtf` via `soffice/libreoffice` fallback or `textutil`
- legacy binary `.xls` via local SheetJS parsing
- `.xlsx` / `.xlsm`
- direct image uploads (`.png`, `.jpg`, `.jpeg`, `.webp`) via cheap vision extraction on `gpt-4o-mini`

Not yet supported in this foundation pass:

- scanned/OCR-only PDFs beyond the bounded image/OCR fallback path

Important nuance:

- image uploads now have a first-class parse path
- legacy `.xls` no longer depends on host office-converter binaries
- PDFs with zero extracted text and embedded images are marked with OCR-needed warnings instead of silently indexing empty content
- DOCX files with embedded images are marked in parser warnings so operators can distinguish text-rich docs from visually heavy docs

That is an honest current boundary, not a hidden gap.

## Pipeline Prerequisites Already Added

To avoid downstream blind spots:

- attachment manifest now preserves `content_type`
- attachment manifest now flags `mm_doc_candidate`
- doc-like attachments are forced into R2 even when small, so downstream ingest can recover bytes
- gateway attachment payload now requires exactly one source:
  - inline `contentBase64`
  - or internal `presignedUrl`
  - never both, never neither
- malformed inline `contentBase64` is now rejected at the API contract boundary before decode/ingest
- `client_context.project_id` is now propagated into run snapshot / run context
- a bridge helper now converts `runs.attachments_manifest` + `snapshot.project_context.mm_doc_scope` into MM Docs ingest calls, so future worker/U-block integration can reuse the gateway manifest directly

## What Is Still Pending

The feature is now wired into the live agent path, but a few production tasks still remain.

Still pending:

1. stricter collection-level observability and capacity monitoring as MM Docs volume grows
2. broader parser coverage for OCR/scanned PDFs and richer visual-document extraction
3. additional latency/cost tuning for heavy mixed law+docs runs
4. final product/backend surface decisions for chat upload vs project upload UX

## Live Verification Status

As of 2026-03-15 from this workspace:

- MM Docs unit tests: PASS
- R2 readiness probe: PASS
- Qdrant docs collection bootstrap: PASS
- Supabase MM Docs tables visible via REST: PASS
- live ingest/retrieve smoke: PASS
- live pipeline verifier: PASS
- live legacy `.xls` project-scope retrieval: PASS
- live `.xlsx` project-scope retrieval: PASS
- live `.pdf` current-run upload + project-scope retrieval: PASS
- cross-chat / cross-user / cross-tenant isolation: PASS
- user-global doc recall from a fresh chat without `project_id`: PASS
- docs-only answers with `lawCount=0` now stay docs-grounded and are verified against invented legal citation output
- docs-only answers with `lawCount=0` are also verified against stray legal framing such as `норм законодавства не було надано`
- explicit document queries now force `max_law_snippets=0` at U10 unless the user explicitly requests legislation, preventing law-overlay contamination in docs recall
- explicit docs-only queries with project scope / requested MM Docs scope / doc attachments now also short-circuit LLDBI at U3 via `mm_docs_only_scope`, so docs-dominant runs avoid unnecessary legal retrieval earlier in the pipeline
- MM Docs readiness verifier now proves `publicReadBlocked=true` for both `mm_doc_records` and `mm_doc_ingest_log`
- MM Docs readiness now also reports parser-engine capability on the real host:
  - office converter available via `soffice/libreoffice` or `textutil`
  - `pdftotext` / `pdfimages` / `pdftoppm` presence
  - vision flags for direct-image and PDF OCR fallback
- live row-shape audit confirms MM Docs is not storing large document payloads in Supabase rows:
  - `max_mm_doc_record_json_bytes ≈ 1174`
  - `max_mm_doc_ingest_log_json_bytes ≈ 579`
- MM Docs ingest logging is now bounded operationally:
  - default retention: `21` days
  - default soft cap: `5000` rows
  - oldest rows are pruned opportunistically in small batches after inserts
  - pruning runs on cooldown, so normal ingest writes do not pay repeated cleanup cost

Important live caveat:

- the current environment uses the shared Lexery-LA cluster intentionally
- strict readiness/live verifiers now accept this as the default production topology
- the separate MM Docs collection remains real (`lexery_mm_docs_chunks_v1`) and is isolated by collection + payload filters

Interpretation:

- code foundation is real
- live pipeline integration is real
- storage layers are live-ready and verified
- RLS/public-read hardening is present at runtime and verified from the anon path
- the remaining blockers are observability/capacity growth work and latency/cost tuning, not parser completeness or cluster topology

## Why This Split Is Correct

MM Docs should not be implemented as:

- extra chat memory rows
- attachment string stuffing in prompt history
- ad hoc per-run inline parsing without durable indexing

It should be:

- durable
- scope-aware
- RAG-native
- separately observable
- cheap enough to run repeatedly

This foundation puts the repo on that path without mixing the document subsystem into the existing MM chat-memory pipeline.

## Operational Hardening Added

- strict readiness/live verifiers now require only a valid MM Docs collection and credentials
- shared-cluster operation is accepted as production-safe as long as MM Docs remains isolated by collection + payload filters
- failed MM Docs rows can now be repaired in place without minting a second `doc_id`
- U10 now has an explicit USER DOCUMENTS-only answer mode: when law snippets are absent, docs answers must not emit `Норма (цитування)` or invented `ст.` references
- the same USER DOCUMENTS-only mode now also blocks stray “missing legislation / legal norms not provided” phrasing unless the user explicitly asked about absent law evidence
- explicit user-document phrasing is now detected with Unicode-aware matching, so Cyrillic queries such as `у моїх завантажених документах` correctly suppress law snippets in docs-only recall
- U3 now has an early docs-only optimization path:
  - if the query is explicitly about user documents
  - and there is a strong MM Docs scope signal (`project_id`, `mm_doc_scope`, or MM Docs attachment candidates)
  - then the plan disables LLDBI/doclist/web before U4 instead of paying legal-retrieval cost and discarding law snippets later
- MM Docs readiness now checks both security posture and storage shape:
  - anon path sees zero rows
  - ingest/error/log payloads stay small enough for Supabase row limits
- MM Docs ingest log now has bounded retention semantics in app runtime:
  - stage logs remain available for recent operational debugging
  - the logger is no longer an unbounded growth path in Supabase
- DB and runtime guards now also enforce MM Docs pointer namespaces:
  - `raw_r2_key` must stay inside `runs/.../attachments/...` or `mm/docs/user/.../raw/...`
  - `canonical_r2_key` must stay inside `mm/docs/user/.../scope/.../canonical.v1.json`
