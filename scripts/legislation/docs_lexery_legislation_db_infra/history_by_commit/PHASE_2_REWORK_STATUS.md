# PHASE 2 REWORK — Status

**Дата:** 2026-01-24  
**Статус:** 🔄 В ПРОЦЕСІ

---

## Реалізовано

### 2.0 Переробка збору кандидатів

**Створено файл:**
- `commands/collect-diverse-candidates-v2.ts` — нова версія з keyword mining + 3 джерела

**3 джерела кандидатів:**

1. **SOURCE 1: Rada feed (r.txt)**
   - Базовий пул з feed
   - Відкидаємо існуючі nreg
   - Обмеження: 2000 рядків

2. **SOURCE 2: Keyword-driven mining**
   - Seed keywords для різних категорій:
     - international: конвенція, протокол, пакт, договір
     - ccu: конституційний суд, окрема думка
     - rnbo: рада національної безпеки, санкції
     - cec: центральна виборча, цвк
     - nbu: національний банк, облікова ставка
     - defense: служба безпеки, зсу, сзр, моу
     - vru: верховна рада, голова верховної ради
     - presidential_order: розпорядження президента, -рп
   - Перевірка по title + suffix-based matching (-РП, -РГ, V..., N..., X/2026)

3. **SOURCE 3: Known hard seeds**
   - Підбір по 2 кандидати для кожної категорії:
     - international: 2
     - ccu: 2
     - rnbo: 2
     - cec: 2
     - nbu: 2
     - vru_rg: 2
     - defense: 2

**Оптимізація:**
- TXT/snippet завантажується тільки для топ-60 кандидатів
- JSON завантажується тільки для кандидатів з keyword match або suffix match

### 2.1 Квоти для Real Diversity

**Квоти (мін 30 кандидатів):**
- presidential_decree: 2–4
- presidential_order: 1–2
- rnbo_decision: 2–4
- vr_speaker_order: 1–2
- vr_resolution: 2–4
- cec_resolution: 1–2
- ccu_opinion: 1–2
- ccu_decision: 1–2
- nbu_letter: 2–4
- nbu_resolution: 1–2
- international: 2–4
- cmu_total: max 6
- defense: min 4

### 2.2 Preview Evidence

**Створено команду:**
- `show-golden-set-preview` — виводить preview-evidence таблицю

**Формат таблиці:**
- nreg | title | predicted_slug | prefix_class | organ_signal | summary_prefix(80) | snippet15 | reason

**Distribution:**
- Predicted Slugs (top 10)
- Prefix Classes
- Organ Signals
- CMU % (ціль < 20%)

---

## Поточний стан

**Проблема:**
- Команда `collect-diverse-candidates --v2` виконується довго через API calls
- Потрібно дочекатися завершення або оптимізувати

**Наступні кроки:**
1. Дочекатися завершення збору кандидатів
2. Перевірити golden set на виконання квот
3. Показати preview-evidence таблицю
4. Якщо квоти не виконані — продовжити mining

---

## Команди

```bash
# Збір кандидатів (V2)
pnpm tsx scripts/legislation/admin-cli.ts collect-diverse-candidates --v2

# Preview golden set
pnpm tsx scripts/legislation/admin-cli.ts show-golden-set-preview
```
