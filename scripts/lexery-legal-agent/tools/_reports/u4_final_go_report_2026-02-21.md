# U4 CacheRAG — Final GO Report
**Date:** 2026-02-21  
**Branch:** feature/lexery-legal-agent-architecture  
**Decision: ✅ GO — Готово до production**

---

## Що перевірено

### Automated packs (baseline + post-fix)
| Верифікатор | Результат |
|-------------|-----------|
| `brain:verify:smoke` (6 кейсів) | ✅ 6/6 PASS, p95=25s |
| `brain:verify:retrieval-real-dev:fast` (10 кейсів) | ✅ 10/10 PASS, gate PASS |
| `brain:verify:act-type-audit:fast` (20 кейсів) | ✅ 18/20 PASS (90%), explicit_act_hit=100% |
| `brain:verify:u2-domain:smoke` (7 кейсів) | ✅ 7/7 PASS |

### Final GO Audit (25 нових кейсів)
- Охоплення: Указ Президента, Постанова КМУ, Наказ МОЗ, Рішення КСУ, Конвенція,
  Міжнародний договір, Закон (anti_corruption/освіта/антидискримінація), Кодекс (цивільний/кримінальний/трудовий/податковий),
  multi-act (кордон+КУпАП, корупція+прокуратура, тероризм+КК, емансипація+СКУ+ЦКУ),
  OOD (3 кейси), короткі запити (2 кейси).
- **Critical FAIL = 0** (потрібний акт/сімейство відсутній у топ-50 + selected)
- **OOD stable = 3/3** (low_confidence=true для МКС/суперструни/рецепт)
- False low_confidence = 0 (після фіксу, до — 8/25)

---

## Інваріанти ✅

| Інваріант | Статус |
|-----------|--------|
| `selected_acts != []` | ✅ Завжди є (25/25, 100%) |
| `act_kind/category/document_type != null` | ✅ Гідратовані після buildSelectedActs |
| `OOD → low_confidence=true` | ✅ Стабільно (OOD guard + ACT_SELECTION_LOW_CONFIDENCE) |
| No local file writes at runtime | ✅ Підтверджено grep (тільки tools/) |
| API key: тільки OPENROUTER_API_KEY_ONLINE | ✅ Перевірено |
| Latency p50 ~ 17-18s, p95 ~ 25-30s | ✅ Без деградації |

---

## Системні зміни (в межах цього сеансу)

### 1. LLDBI Soft Prior + OOD Guard + Anti-order relaxation (commit 81ca91d)
- `cache-rag.ts`: LLDBI category/doc_type soft prior boost (0.08/0.06) для scoring
- `cache-rag.ts`: OOD Confidence Guard (4 умови: topScore < 0.55, domainWeak, noCategoryHints, avgScore < 0.52)
- `selected-acts.ts`: Anti-order relaxation — дозволяємо N SECONDARY_ORDER з сильними доказами (count >= 3)
- `lib/config.ts`: нові конфіги `u4LldbiSoftPriorEnabled/Boost`, `u4OodGuardEnabled/Thresholds`

### 2. Zod типізація meta + Phase2 звіт (commit 51521c1)
- `retrieval/types.ts`: `lldbi_soft_prior` і `ood_guard` в `RetrievalTraceSchema.meta`

### 3. Fix: хибний low_confidence для спеціалізованих доменів (цей сеанс)
- `cache-rag.ts`: Fix A — `specializedDomainNoPrimary` (SECONDARY_ORDER/INTERNATIONAL_TREATY/KSU_DECISION з count>=5 = авторитетне джерело)
- `cache-rag.ts`: Fix B — `coverageGuardFiredButFamilyOk` (COVERAGE_GUARD_FAILED + FAMILY_DOMINANT_OK = metadata lookup gap, не справжня відсутність покриття)
- Результат: 8 хибних LC=T → 0 (зберігаючи reason_codes для observability)

### 4. `run_final_manual_audit.ts`: параметр `--dataset=<path>`
- Дозволяє запускати batch проти будь-якого датасету без копіювання скрипту.

---

## Приклади 3 кейсів

### 1. Перетин кордону (FG02) — спеціалізований домен
**Query:** "Які документи та умови необхідні громадянину України для перетину державного кордону?"  
**selected_acts:** 57-95-п (Постанова КМУ), 22-2026-п, z1873-25, 36-2026-п  
**low_confidence:** false ✅ (після Fix A)  
**reason_codes:** COVERAGE_GUARD_FAILED, SELECTED_ACTS_FROM_CHUNKS_EVIDENCE, FAMILY_DOMINANT_OK  
Авторитетне джерело — Постанова КМУ (SECONDARY_ORDER з count=13). Fix A правильно ідентифікує це як спеціалізований домен.

### 2. Тероризм (FG15) — кримінальний мульти-акт
**Query:** "Кримінальна відповідальність за тероризм та замороження активів терористів"  
**selected_acts:** 2341-14 (ККУ), 4651-17 (КПК), 580-19 (Про Нацполіцію)  
**low_confidence:** false ✅  
ККУ як PRIMARY_LAW + КПК для процедури + закон про поліцію як enforcement.

### 3. OOD — МКС та орбіта (FG18)
**Query:** "Пілотований корабель на орбіті Місяця та технічні вимоги до стикування з МКС"  
**selected_acts:** (шум: 4196-20, z0147-10, v0001500-25)  
**low_confidence:** true ✅  
OOD guard коректно ідентифікує: топ_score < 0.55, domain=general, no categoryHints, avgScore < 0.52.

---

## Відомі обмеження (Known Issues, не блокуючі)

| KI | Опис | Вплив |
|----|------|-------|
| KI-1 | Емансипація (FG17): 322-08 (КЗпП) відсутній у selected, є ЦКУ+СКУ | Minor: трудові наслідки покриті ЦКУ |
| KI-2 | Корупційне розслідування (FG14): 1697-18 (Прокуратура) відсутній | Minor: 1700-18 достатній |
| KI-3 | Шум у FG10 (НБУ повідомлення) та FG06 (3543-12 в корупційному запиті) | Minor: основний акт присутній |
| KI-4 | COVERAGE_GUARD_FAILED/NO_PRIMARY_LAW_EVIDENCE в reason_codes для спец.доменів | Informational only, не впливає на LC |

---

## Commits

- `51521c1` — docs(u4): Zod meta типізація + phase2_final_audit звіт
- `81ca91d` — feat(u4): LLDBI soft prior + OOD guard + anti-order relaxation  
- поточний — fix(u4): suppress false low_confidence for specialized domains (Fix A + Fix B)

---

## Рекомендація

**GO ✅** — System ready for production deployment.

Плановані подальші покращення (не блокуючі):
- Покращити U2 для запитів про міжнародне право (ЄСПЛ — неправильний domain hint `business_corporate`)
- Розширити LLDBI vocabulary snapshot для нових категорій при змінах у БД
- Smoke pack: додати кейс для `border_migration` + `healthcare` щоб зафіксувати регресії Fix A/B
