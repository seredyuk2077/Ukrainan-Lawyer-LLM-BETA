# Політика використання R2 для input (U1 / U2)

## Контекст

Великий текст запиту або вкладення можуть перевищувати ліміти БД/запиту. Збереження повного input у R2 і лише посилання в БД дозволяє U2 і наступним крокам працювати лише з preview (U2 не завантажує повний query з R2 для класифікації).

## Політика (реалізовано)

- **Коли:** якщо `Buffer.byteLength(query, 'utf8') > QUERY_R2_THRESHOLD_BYTES` (default 32KB, env override), U1 зберігає повний query в R2 і записує preview + ref у RunRecord.
- **Bucket:** `R2_RUNS_BUCKET` / `lexery-legal-agent`. Key: `runs/{tenant_id}/{run_id}/input/query.txt`.
- **DB:** `runs.query` = preview string (head + `...[overflow]...` + tail; довжини head/tail з `QUERY_PREVIEW_HEAD_CHARS` / `QUERY_PREVIEW_TAIL_CHARS`).
- **Snapshot:** `snapshot.input.query_overflow: true`, `snapshot.input.query_ref: { storage, r2_bucket, r2_key, content_type, original_length }`, `snapshot.input.query_preview: { head, tail, original_length, effective_length_hint }`. Якщо R2 put не вдався: `query_ref` відсутній, `input_overflow_store_failed: true`, warning у відповіді; run все одно створюється з preview.
- **U2:** Consumer будує `query` з `snapshot.input.query_preview.head + "\n...\n" + tail` коли є; інакше `run.query`. U2 **не** пише input у R2; лише читає preview з snapshot (або `run.query`). Не завантажує повний текст з R2. Meta `input_source: "snapshot_preview" | "db_query"`.
- **Зворотна сумісність:** runs без `snapshot.input` використовують `run.query` як раніше.

## Статус

Реалізовано: U1 `gateway/query-overflow.ts`, гілка overflow у handler, U2 consumer resolution preview. Помилка R2 put не ламає створення run.
