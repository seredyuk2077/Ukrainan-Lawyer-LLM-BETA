# U4 Root-Cause: Act Found, Article Miss (e.g. ст.130 КУПАП)

## Evidence (Phase 0)

### 0.1 Qdrant payload inspection

- **Script:** `tools/inspect_lldbi_payload.ts` (read-only).
- **КУПАП rada_nreg:** 80731-10 (статті 1–212-24).
- **Result:** 795 chunks with required payload (rada_nreg, article_number, r2_key, json_path); **4 chunks with article_number=130**. Дані дозволяють знайти статтю 130 — проблема не в ingestion.

### 0.2 Taxonomy

- ActTaxonomyStore читає `legislation_documents` (read-only). Додано tolerant-normalizer для aliases/keywords/topics (NFC, trim, lower, dedup) у рантаймі; у БД нічого не змінюємо.

### 0.3 Чому виграє ст.121, а не ст.130?

1. **Score distribution:** При запиті «Водіння машиною в нетверезому стані, яка відповідальність?» топ hits — КУПАП ст.122, 1521, 143, 141, 1273, 48, 121, … У повному масиві `retrieval_trace.hits` ст.130 **немає** — тобто вона не потрапляє навіть у об’єднаний список кандидатів.
2. **Candidate set:** U4 робить (a) unfiltered chunks `top_k=50`, (b) за умови `needTwoStage` — acts search + **filtered chunks з limit=TWO_STAGE_CHUNKS_TOP=15**. Тобто з топ-актів (в т.ч. 80731-10) беремо лише **15 чанків** за векторним скором. Ці 15 — найрелевантніші за embedding у межах цих актів; ст.121, 122, 143 тощо мають вищий векторний скор для цього запиту, ніж чанки ст.130.
3. **Within-act competition:** Ст.130 є в індексі (4 чанки), але їхній embedding similarity до запиту нижча, ніж у ст.121/122/143. При обмеженні 15 чанків на filtered search ст.130 не потрапляє в топ-15 по акту 80731-10.
4. **min_score / top_k:** Не обрізаємо до 0 — є fallback при `aboveThreshold.length === 0`. Проблема саме в порядку (ranking) і в малому **within-act depth** (15).
5. **Diversity:** Топ повністю з КУПАП після таксономії — collapse не через «окремі думки», а через те, що ми беремо мало чанків з кожного акту.

## Висновок

- **Root-cause:** Мала глибина within-act retrieval (TWO_STAGE_CHUNKS_TOP=15) і відсутність окремого «act → більше чанків по статтях» призводять до того, що релевантна стаття (130) програє іншим статтям того ж акту (121, 122, …) за векторним скором і не потрапляє в фінальний список.
- **Універсальний фікс (без зміни даних):** Збільшити кількість чанків у within-act пошуку, додати act_candidates у trace, опційно — selective LLM rewrite/rerank при low_confidence; diversity cap за актами.
