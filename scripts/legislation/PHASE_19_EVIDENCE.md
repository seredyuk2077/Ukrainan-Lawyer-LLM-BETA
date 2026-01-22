# PHASE 19: Supabase UX Dashboard + Health Semantics — Evidence

**Дата:** 2026-01-21  
**Статус:** ✅ ЗАВЕРШЕНО

---

## PHASE 19.1-19.5: UX View та Health Semantics

### Створено VIEW `legislation_documents_ui`

**Колонки:**
- `health_badge` (перша колонка) — 🟢/🟡/🔴/⚪
- `health_label` — OK/WARN/ERROR/UNKNOWN
- `health_rank` — для сортування (1=red, 2=yellow, 3=unknown, 4=green)
- `law_number_ui` — 🔴 missing для required, — для not required
- `legal_status_ui` — 🟢 active / 🟡 inactive / ⚪ unknown
- `sync_issue_ui` — — для OK, 🔴 missing reason для error без reason
- `act_group_key_ui` / `act_part_label_ui` — — для single acts, 🔴 missing для multi-part без даних

### Оновлено verify --write-health

**Логіка:**
- GREEN: всі інваріанти PASS, sync_status=synced, qdrant_status=indexed, chunks match, acts=1
- RED: sync_status=error OR qdrant_status=error OR r2 missing OR chunks mismatch OR acts!=1 OR chunks=0 для indexable
- YELLOW: часткові проблеми (sync_status!=synced OR qdrant_status!=indexed OR chunks mismatch)
- UNKNOWN: недостатньо даних

---

## Evidence — Health Distribution

**Після write-health для 8 тестових документів:**

| sync_health | Count |
|-------------|-------|
| green | 8 |
| yellow | 0 |
| red | 0 |
| unknown | 0 |

**VIEW Health Badges:**

| health_badge | health_label | Count |
|--------------|--------------|-------|
| 🟢 | OK | 8 |
| 🟡 | WARN | 0 |
| 🔴 | ERROR | 0 |
| ⚪ | UNKNOWN | 0 |

---

## SQL Evidence (VIEW)

**Приклад записів з VIEW:**

| health_badge | rada_nreg | title | sync_health | law_number_ui | legal_status_ui |
|--------------|-----------|-------|-------------|----------------|-----------------|
| 🟢 | 2341-14 | Кримінальний кодекс України | green | 2341-III | ⚪ unknown |
| 🟢 | 254к/96-вр | Конституція України | green | — | ⚪ unknown |
| 🟢 | 3543-12 | ЗУ Про мобілізаційну підготовку... | green | 3543-XII | ⚪ unknown |
| 🟢 | 57-95-п | Постанова КМУ... | green | 57-95-п | ⚪ unknown |

---

**PHASE 19 завершено. VIEW створено, health semantics працює.** ✅
