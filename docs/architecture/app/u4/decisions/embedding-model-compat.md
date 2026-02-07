# ADR: Embedding model compatibility (LLDBI 1536d)

## Context

U4 потребує embedding запиту для пошуку в Qdrant. Розмірність має збігатися з колекціями LLDBI (1536).

## Джерело

- `scripts/legislation/Lexery Legislation DB Infra/src/canonical/embeddings.ts`: модель **openai/text-embedding-3-small**, EXPECTED_DIMENSIONS = 1536.
- OpenRouter endpoint: `https://openrouter.ai/api/v1/embeddings`.
- Документ EVIDENCE_SEARCH_WHATS_REAL: колекції lexery_legislation_chunks, lexery_legislation_acts — dim 1536.

## Decision

- **Модель**: openai/text-embedding-3-small (env LLDBI_EMBED_MODEL_ID, default як вище).
- **Розмірність**: 1536; валідація після відповіді API.
- **API key**: OPEN_ROUTER_API_RAG або OPENROUTER_API_KEY_ONLINE / OPENROUTER_API_KEY.
- **Timeout**: LLDBI_EMBED_TIMEOUT_SEC (default 5s); 1 retry при 5xx.

Якщо в майбутньому індекс змінить dim — це breaking change; потрібно оновити default і ADR.
