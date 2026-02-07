# U3/U3a — Результати тестування

## One-command verification (автономно)

Одна команда піднімає сервер на випадковому порту, проганяє smoke (POST→U4 stub) і `brain:u3:test`, гасить сервер і повертає exit 0/1:

```bash
pnpm brain:verify:u3
```

- Вибирає вільний порт (не 3081), стартує server як child process з `BRAIN_PORT` і `DEV_API_KEY` (env або `dev-key-change-me`).
- Чекає health OK (poll 250ms, timeout 20s).
- Smoke: POST /v1/runs ("ККУ ст. 115") → polling GET /v1/runs/:id до появи query_profile, search_plan.plan, search_plan.steps, next_step=U4 (timeout 30s).
- Запускає `pnpm brain:u3:test` з `BRAIN_BASE_URL`/`BRAIN_URL` і тим самим `DEV_API_KEY` (timeout 5 хв).
- SIGTERM серверу → 5s → SIGKILL fallback.
- Summary: Port, Health, Smoke, u3:test, Exit. CI-ready (exit 1 при будь-якому fail).

Ручних кроків не потрібно: не потрібно звільняти порт, виставляти ключ або запускати сервер в іншому терміналі.

## Ручний запуск тестів

```bash
pnpm brain:u3:test
```

Передумова: Brain server запущений (`pnpm brain:dev`); для порту відмінного від 3081 задати `BRAIN_BASE_URL` або `BRAIN_URL`. `DEV_API_KEY` — з env або дефолт `dev-key-change-me`.

## Очікувана таблиця (summary)

| label         | pass | latency | plan | steps | next | lldbi | doclist | degraded |
|---------------|------|---------|------|-------|------|-------|---------|----------|
| direct_citation | ok   | …ms     | Y    | ≥2    | U4   | Y     | n       | n        |
| ambiguity_hard  | ok   | …ms     | Y    | ≥4    | U4   | Y     | Y       | n        |
| labor          | ok   | …ms     | Y    | ≥2    | U4   | Y     | n       | n        |
| long_contract   | ok   | …ms     | Y    | ≥2    | U4   | Y     | n       | n        |
| table_like     | ok   | …ms     | Y    | ≥2    | U4   | Y     | n       | n        |
| tax_procedure  | ok   | …ms     | Y    | ≥2    | U4   | Y     | n       | n        |
| mixed_lang     | ok   | …ms     | Y    | ≥2    | U4   | Y     | n       | n        |

Усі 7 кейсів мають проходити (pass = ok, plan = Y, steps ≥ 2, next_step = U4).

## Логи сервера (фрагмент одного run)

- U2 finished → U3 enqueued
- U3 finished (plan_version, reasons, sources) → U3a enqueued
- U3a finished (steps_count, step_kinds, next_step U4) → U4 enqueued
- U4 event received (CacheRAG Wave 3 stub)

## Оновлення

Після прогону вручну оновити цей файл: вставити фактичний вивід summary та, за потреби, latency/деградації.
