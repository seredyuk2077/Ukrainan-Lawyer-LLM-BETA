# Future document memory — recommended structure

**Status:** Foundation started on 2026-03-14. Core `mm/doc/` storage/parsing/indexing modules now exist and the MM Docs evidence channel is now live-verified end-to-end on the shared Lexery-LA Qdrant cluster. Remaining work is tuning/observability, not basic pipeline integration.

---

## Scope

- **Current `mm/`** = chat/session memory (conversation facts, summaries, semantic search, outbox).
- **Future document memory** = ingest/retrieve/index of user-uploaded or referenced documents (e.g. case files, contracts). Not to be mixed with chat memory or scattered across the repo.

---

## Recommended layout

Place all document-memory code under a single subdomain under `scripts/lexery-legal-agent/mm/`:

```
scripts/lexery-legal-agent/mm/
  (existing: semanticSearch.ts, offload.ts, outboxWorker.ts, memoryExtractor.ts, …)
  doc/                    # or doc-memory/
    ingest/               # parse, chunk, embed, write to store
    retrieve/             # search by query / doc id
    qdrant/               # Qdrant collection for doc vectors (separate from lexery_memory_semantic_v1)
    r2/                   # doc blobs / artifacts if needed
    jobs/                 # background jobs (e.g. ingest queue consumer)
    types/                # shared types
    tools/                # CLI / one-off scripts
    tests/                # unit tests
```

- **Memory vectors** stay in **LEXERY-LA** Qdrant cluster only. Do not use the legislation cluster for document memory.
- Legislation cluster = LLDBI chunks/acts + catalog. LEXERY-LA = chat memory (`lexery_memory_semantic_v1`) + future doc memory collection(s).

---

## When to implement

Current implemented foundation:

- `mm/doc/formats.ts` — format detection and scope resolution
- `mm/doc/parse.ts` — text/markdown/json/csv/doc/docx/rtf/xls/xlsx/pdf parsing with local spreadsheet support for legacy `.xls`, cross-platform office fallback for legacy word/rtf, and image-aware parser warnings
- `mm/doc/vision.ts` — direct image upload extraction using a cheap multimodal model (`gpt-4o-mini`)
- `mm/doc/chunking.ts` — chunking for semantic retrieval
- `mm/doc/r2.ts` — raw/canonical artifact storage in R2
- `mm/doc/store.ts` — Supabase metadata + ingest log tables
- `mm/doc/qdrant.ts` — MM Docs indexing/search client using the shared Lexery-LA cluster and the separate `lexery_mm_docs_chunks_v1` collection
- `mm/doc/ingest.ts` / `mm/doc/retrieve.ts` — orchestration helpers
- explicit docs-only queries can now bypass LLDBI earlier in U3 when MM Docs scope is already clear, instead of relying only on late U10 suppression
- live smoke now also covers project-scoped spreadsheet retrieval (`.xlsx` and legacy `.xls`) and real PDF retrieval, not only DOCX/CSV/TXT paths
- current-run attachment path is live-proven for `docx`, `csv`, `xlsx`, `txt`, and `pdf`; direct live ingest/retrieval is also proven for image uploads

Still required before the feature is fully closed at scale:

- stronger production observability and capacity tracking for the MM Docs collection as usage grows
- broader parser coverage for OCR/scanned PDFs and richer visual-document extraction
- further latency/cost tuning for heavy mixed law+docs runs
