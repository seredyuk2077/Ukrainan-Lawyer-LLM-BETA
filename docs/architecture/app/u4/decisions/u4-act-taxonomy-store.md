# ADR: U4 ActTaxonomyStore — Runtime Data-Driven Act Candidates

## Context

U4 CacheRAG must work universally across domains (criminal, civil, labor, tax, admin, etc.) and must not hardcode act names or categories (e.g. "if criminal → KKU"). Anchors and act candidates must come from data: Supabase legislation metadata (aliases, keywords, topics, category) and Qdrant payload. Content can change (new categories/topics/aliases); the system must tolerate schema and content updates without redeploy.

## Decision

### 1. ActTaxonomyStore module

- **Location**: `retrieval/act-taxonomy-store.ts`.
- **Source**: Supabase legislation project table `legislation_documents`. Required env (optional for Brain): `SUPABASE_LEGISLATION_URL` (or `SUPABASE_LEGISLATION_RAG_URL`) and `SUPABASE_LEGISLATION_SERVICE_ROLE_KEY` (or `SUPABASE_LEGISLATION_RAG_SERVICE_ROLE_KEY`). If missing, store returns empty candidates and no anchors; U4 continues without taxonomy (graceful degradation).
- **Load**: Select `rada_nreg`, `title`, `category`, `aliases`, `keywords`, `topics` where `qdrant_status = 'indexed'`. Normalize jsonb: aliases/keywords/topics as string arrays (support array or single string from DB).
- **Index**: In-memory maps: alias (lower) → ActEntry[], keyword → ActEntry[], topic → ActEntry[], category → ActEntry[].
- **TTL**: Configurable `ACT_TAXONOMY_TTL_SEC` (default 3600). Refresh in background; on fetch error keep last snapshot and increment `taxonomy_refresh_failed_total`.

### 2. getTaxonomyCandidates API

- **Input**: `query`, `domainHint` (from query_profile.domain — hint only, no hardcoded mapping), `entities` (U2: act_abbrev, article_ref).
- **Output**: `rada_nreg_candidates`, `category_hints`, `alias_hits`, `anchor_tokens`, `debug` (taxonomy_snapshot_version, taxonomy_snapshot_age_seconds, source: 'supabase' | 'none').
- **Logic**: Tokenize query; match tokens against alias/keyword/topic maps from DB; add entities.act_abbrev to alias lookup; domainHint added to category_hints as string. Anchor tokens: short strings from top alias_hits/titles (max 3) for query shaping.

### 3. No hardcoded categories or acts

- Candidates and anchors are built only from DB (aliases, keywords, topics, category) and from query/entities/domain as generic strings.
- New categories or topics in DB are used automatically after next TTL refresh.

### 4. Schema/content tolerance

- New columns or values in `legislation_documents` do not break the store: we select only needed fields; unknown fields ignored.
- If aliases/keywords/topics are in a different format (e.g. string vs array), normalizer converts to string[].

### 5. Metrics

- `taxonomy_refresh_success_total`, `taxonomy_refresh_failed_total`, `taxonomy_snapshot_age_seconds` (observability). Critical for production monitoring.

## Consequences

- Query shaping uses only `anchor_tokens` from ActTaxonomyStore; no "if criminal → KKU" in code.
- Two-stage retrieval merges `rada_nreg_candidates` from taxonomy with top acts from Qdrant acts search; filtered chunks use merged list.
- When legislation Supabase is unavailable, U4 still runs with chunks + acts search only.
