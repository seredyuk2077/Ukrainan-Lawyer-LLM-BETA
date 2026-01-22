# PHASE 9-12: Post-PHASE 6-8 Hardening — COMPLETED

**Дата:** 2026-01-21  
**Статус:** ✅ ЗАВЕРШЕНО

---

## PHASE 9: Category Normalization ✅

### Evidence
- **Проблема:** category="інше" (UA) в БД для 57-95-п
- **Причина:** canonical.metadata.category міг бути UA, і importer використовував його як fallback

### Виправлення
1. **Покращена normalizeCategory():**
   - Підтримує legacy UA mappings ("інше" → "other", "кордон" → "border_migration")
   - Завжди повертає taxonomy slug EN (fallback='other')

2. **Importer гарантує EN slug:**
   - finalCategory завжди нормалізується через normalizeCategory()
   - Неможливо записати UA значення в Supabase

3. **storage_category column:**
   - Додано колонку для стабільного R2 folder path
   - Не змінюється при перекласифікації (backward compatibility)

4. **Repair command:**
   - `admin-cli repair categories --nreg "57-95-п" --force-ai`
   - Нормалізує invalid categories
   - AI reclassification для "other" у важливих документів
   - Оновлює Qdrant payloads

### Результат
- ✅ 57-95-п тепер має category="border_migration" (не "інше")
- ✅ Всі categories в БД = taxonomy slugs EN (constitutional, criminal, defense_mobilization, border_migration)

---

## PHASE 10: Act Group Semantics Fix ✅

### Семантика
- **Одиночні акти:** act_group_key = NULL, act_is_part = false
- **Multi-part акти:** act_group_key = stable hash, act_is_part = true

### Виправлення
1. **determineActGroup():**
   - act_group_key генерується ТІЛЬКИ якщо detectPartLabel повернув щось
   - Для одиночних актів → act_group_key = NULL

2. **detectPartLabel():**
   - Підтримує діапазони статей: "(статті 1 - 212-24)", "(статті 213 - 330)"
   - Розпізнає частини/томи/книги

3. **Repair command:**
   - `admin-cli repair act-groups --all`
   - Перераховує act_group поля за новими правилами
   - Оновлює Qdrant payloads

### Результат
- ✅ Всі існуючі одиночні акти мають act_group_key = NULL
- ✅ Готовий для тестування КУпАП

---

## PHASE 11: AI-Assisted Fallback Parsing ✅

### Реалізація
1. **AI Parsing Assist модуль:**
   - `canonical/aiParsingAssist.ts` — генерація parse plan через AI
   - Strict JSON schema (whitelist стратегій)
   - Кешування parse plan в R2: `legislation/_lexery/ai_cache/parse_plan/{content_hash}.json`

2. **Trigger conditions:**
   - strategy=fallback і units=0
   - Важливі документи з units=0
   - Багато unknown типів в stru (other/total > 0.5)

3. **Last resort fallback:**
   - Якщо AI не допоміг → paragraph-based splitting
   - Гарантує chunks > 0 для непустих документів

4. **parseContentUnits():**
   - Тепер async (підтримує AI assist)
   - Викликає AI assist якщо треба
   - Застосовує parse plan або fallback

---

## PHASE 12: Verify/Repair Toolkit ✅

### Команди
1. **verify:**
   ```bash
   admin-cli verify --nreg "2341-14"
   ```
   - Перевіряє консистентність Supabase ↔ Qdrant ↔ R2
   - Валідує category, chunks counts, payloads

2. **repair consistency:**
   ```bash
   admin-cli repair consistency --nreg "2341-14"
   ```
   - Виправляє невідповідності
   - Нормалізує category
   - Оновлює Qdrant payloads
   - Синхронізує expected_chunks з canonical

### Результат
- ✅ Verify працює (перевірено на 57-95-п)
- ✅ Repair commands готові

---

## Конституція Bug (254к/96-ВР)

**Проблема:** indexed_chunks=0 після corpus test

**Дослідження потрібно:**
- Перевірити чи canonical існує в R2
- Перевірити чи importer пропустив indexing
- Перевірити чи є mismatch в ключах/path

**TODO:** Додати `admin-cli test-constitution` або включити в corpus як must-pass

---

## Команди

```bash
# Category repair
pnpm tsx scripts/legislation/admin-cli.ts repair categories --nreg "57-95-п" --force-ai

# Act groups repair
pnpm tsx scripts/legislation/admin-cli.ts repair act-groups --all

# Verify
pnpm tsx scripts/legislation/admin-cli.ts verify --nreg "57-95-п"

# Repair consistency
pnpm tsx scripts/legislation/admin-cli.ts repair consistency --nreg "2341-14"

# КУпАП test
pnpm tsx scripts/legislation/admin-cli.ts test-kupap
```

---

## Наступні кроки

1. ⏳ Виправити проблему з Конституцією (254к/96-ВР)
2. ⏳ Запустити test-kupap для перевірки multi-part актів
3. ⏳ Тестувати AI parsing assist на реальних "weird docs"
