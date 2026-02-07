# ADR: U4 degraded policy (Qdrant / embedding failure)

## Context

U4 CacheRAG залежить від OpenRouter (embeddings) і Qdrant. При недоступності сервіс не повинен падати; pipeline має продовжуватися з явною деградацією.

## Decision

1. **Embedding failure** (OPEN_ROUTER_API_RAG відсутній, 5xx, timeout):
   - У runCacheRag: catch, встановити degraded_sources.lldbi = true, повернути retrieval_trace з hits=[], latency_ms та meta (error hint).
   - U4 consumer: persist trace, RunContext, enqueue U5 як завжди. Gate (U5) зможе вирішити подальшу поведінку.

2. **Qdrant unreachable** (QDRANT_URL відсутній, 502, timeout):
   - У runCacheRag: при виклику qdrantSearch getClient() або search кидає — catch у циклі по steps, degraded_sources.lldbi = true, steps_latency_ms фіксується, hits залишаються порожніми.
   - U4 consumer: persist trace з degraded_sources, enqueue U5.

3. **Verify_u4**:
   - PASS якщо retrieval_trace != null (незалежно від наявності hits чи degraded). Тобто при dev без Qdrant тест зелений за умови коректної деградації та U5 enqueue.

4. **Логи**: не дампувати секрети; structured logs з run_id, step=U4, hits_count, top_score, degraded_sources.

5. **Метрики**: u4_degraded_lldbi_total інкрементується при degraded_sources.lldbi=true.
