# U4 CacheRAG — Результати перевірки

## One-command verification

```bash
pnpm brain:verify:u4
```

- Вибирає вільний порт, стартує server з BRAIN_PORT і DEV_API_KEY.
- Чекає /health (poll 250ms, timeout 20s).
- POST /v1/runs з query "ККУ ст. 115 умисне вбивство".
- Polling GET /v1/runs/:id до появи `retrieval_trace` (timeout 60s).
- PASS якщо retrieval_trace != null (з hits або з degraded_sources.lldbi=true при недоступному Qdrant).
- SIGTERM серверу → 5s → SIGKILL.
- Summary: Port, Health, Smoke, Exit 0/1.

Ручних кроків не потрібно.

## LLDBI Semantic Evidence: ККУ ст.115

Доказова перевірка, що LLDBI (Qdrant + R2 refs) повертає правильний фрагмент закону для запитів про умисне вбивство.

**Команда:**

```bash
pnpm brain:verify:lldbi-kku115
```

- Стартує brain server на random port, health wait.
- POST /v1/runs з 3 запитами: «умисне вбивство», «умисне вбиство» (типова помилка), «ККУ ст. 115 умисне вбивство».
- Polling GET /v1/runs/:id до появи `retrieval_trace` (і `meta.sample_hits`).
- Для кожного кейсу бере top sample hits, завантажує фрагмент з R2 за `r2_key` + `json_path`, перевіряє:
  - текст містить «Стаття 115» / «115» у контексті статті;
  - текст містить «умисне вбивство»;
  - act — ККУ/Кримінальний кодекс України.
- Якщо хоча б один hit з top-3 проходить — кейс PASS. Exit 0 тільки якщо всі 3 кейси PASS.

**Режим REAL_LLDBI_REQUIRED:** якщо `REAL_LLDBI_REQUIRED=true` і немає доступу до Qdrant/R2 або retrieval degraded — verify FAIL з чіткою причиною (не PASS).

**Останній прогін: 3/3 PASS**

- **Кейс 1** («умисне вбивство»): PASS — query shaping (anchors ККУ, Кримінальний кодекс України) + один embedding; top hit act_title=Кримінальний кодекс України, article_ref=115, score ≈ 0.70; фрагмент з R2 містить «Умисне вбивство» та текст статті.
- **Кейс 2** («умисне вбиство» — typo): PASS — typo-fix (вбиство→вбивство) + anchors; при потребі two-stage (acts → filtered chunks); top hit ККУ ст.115, score ≈ 0.29; фрагмент підтверджує «Умисне вбивство».
- **Кейс 3** («ККУ ст. 115 умисне вбивство»): PASS — direct_citation, top hit ККУ ст.115, score ≈ 0.77; фрагмент містить «Умисне вбивство» та текст статті.

## Universal retrieval verify suite (20 cases)

**Команда:**

```bash
pnpm brain:verify:retrieval
```

- Стартує brain server на random port, health wait.
- 20 кейсів: короткі людські (умисне вбивство, звільнення з роботи, оскарження податкової, поліція перевищення повноважень, спадщина квартира, ККУ ст. 115, ЦПК ст. 121, трудовий договір, податкове право, адмін провадження, конституційні права, земельна ділянка, банкрутство, договір купівлі-продажу, захист споживача), довгий контрактний абзац, абсурдний запит, змішана мова, КЗпП, умисне вбиство ККУ.
- Очікувані сигнали: expected_non_empty_hits (або low_confidence при 0 hits), optional expected_article_ref для коротких запитів з «ст. X», optional expected_domain (soft).
- Summary: median/p95 latency, % low_confidence, % used_filtered_chunks_search, top-1 act_title coverage.

**Останній прогін:** 20/20 PASS (median latency ~3.6s, p95 ~9.4s, low_confidence % 40, filtered_search % 5, top-1 act_title coverage 100%).

## Останній прогін

- Health: PASS
- Smoke (verify:u4): PASS (retrieval_trace присутній; при наявному Qdrant — hits, при відсутності — degraded)
- verify:lldbi-kku115: 3/3 PASS
- verify:retrieval: 20/20 PASS
- Exit: 0
