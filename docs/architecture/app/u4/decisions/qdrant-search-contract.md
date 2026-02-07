# ADR: Qdrant search → RawHit mapping

## Context

U4 CacheRAG отримує hits з Qdrant (lexery_legislation_chunks, lexery_legislation_acts) і мапить їх на контракт RawHit без витягування повних текстів з R2.

## Payload → RawHit

Джерело: `scripts/legislation/Lexery Legislation DB Infra/src/lib/qdrantRagClient.ts` (ChunkPayload, ActPayload), `src/commands/search.ts`.

| Qdrant payload field | RawHit field | Примітка |
|----------------------|--------------|----------|
| r2_key | r2_key | обов'язково |
| json_path | json_path | обов'язково |
| (result).score | score | від Qdrant search result |
| rada_nreg | rada_nreg | optional |
| article_number | article_number | optional |
| title | title | optional |
| — | source | "lldbi_chunks" \| "lldbi_acts" — визначається колекцією |

Інші поля payload (content_hash, chunk_index, category, document_type, validity_status, тощо) можуть потрапляти в metadata за потреби. U4 не копіює тексти в runs — тільки refs.

## Collections

- **lexery_legislation_chunks** — dim 1536, payload з r2_key, json_path, rada_nreg, article_number, title (див. ChunkPayload).
- **lexery_legislation_acts** — dim 1536, payload з r2_key, rada_nreg, title (ActPayload; json_path для acts може бути фіксований або з payload).

Env: LLDBI_COLLECTION_CHUNKS, LLDBI_COLLECTION_ACTS (default: lexery_legislation_chunks, lexery_legislation_acts).

## Decision

Мапінг реалізовано в `retrieval/cache-rag.ts` (payloadToRawHit). Контракт RawHit у `retrieval/types.ts`.
