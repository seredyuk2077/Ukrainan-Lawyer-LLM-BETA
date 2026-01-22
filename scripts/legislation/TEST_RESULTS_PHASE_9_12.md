# Test Results — PHASE 9-12 Hardening

**Дата:** 2026-01-21  
**Статус:** ✅ ВСІ ТЕСТИ ПРОЙДЕНО

---

## Тест 1: КУпАП (Multi-Part Act)

### Документи
- **80731-10:** Кодекс України про адміністративні правопорушення (статті 1 - 212-24)
- **80732-10:** Кодекс України про адміністративні правопорушення (статті 213 - 330)

### Результати

**Part 1 (80731-10):**
- ✅ Expected chunks: 795
- ✅ Indexed chunks: 795
- ✅ act_is_part: true
- ✅ act_part_label: "статті 1 - 212-24"
- ✅ category: administrative_offenses
- ✅ qdrant_status: indexed

**Part 2 (80732-10):**
- ✅ Expected chunks: 477
- ✅ Indexed chunks: 477
- ✅ act_is_part: true
- ✅ act_part_label: "статті 213 - 330"
- ✅ category: administrative_offenses
- ✅ qdrant_status: indexed

**Act Group:**
- ✅ act_group_key однаковий для обох частин: `кодекс-україни-про-адміністративні-правопорушення-03bf457103ce4485`
- ✅ act_part_label різний (правильно)
- ✅ Qdrant payloads оновлені

**Пошук:**
- ✅ "адміністративна відповідальність" знаходить chunks з обох частин КУпАП

### Висновок
✅ **КУпАП test PASSED** — multi-part акт працює коректно

---

## Тест 2: Женевська конвенція (995_153)

### Результати
- ✅ Expected chunks: 170
- ✅ Indexed chunks: 170
- ✅ category: international_eu (не "other"!)
- ✅ qdrant_status: indexed
- ✅ Strategy: AI-assisted article-based (confidence=0.75)

### Висновок
✅ **Женевська конвенція test PASSED** — міжнародна конвенція індексується коректно

---

## Тест 3: Окрема думка судді КСУ (nb07d710-25)

### Результати
- ✅ Expected chunks: 14
- ✅ Indexed chunks: 14
- ✅ category: constitutional (не "other"!)
- ✅ qdrant_status: indexed
- ✅ Strategy: point-based fallback (last resort paragraph splitting)

### Висновок
✅ **Окрема думка test PASSED** — "weird doc" індексується через last resort fallback

---

## Загальний підсумок

### ✅ Всі тести пройдено

1. **КУпАП:** Multi-part акт працює, act_group_key однаковий, пошук знаходить обидві частини
2. **Женевська конвенція:** AI parsing assist працює, category=international_eu
3. **Окрема думка:** Last resort fallback працює, chunks > 0, category=constitutional

### Виправлення

1. **normalizeBaseTitle:** Тепер прибирає діапазони статей "(статті 1 - 212-24)"
2. **Last resort fallback:** Працює для всіх документів з текстом > 100 символів
3. **Act group repair:** Виправлено act_group_key для КУпАП (тепер однаковий)

---

## Acceptance Criteria

✅ Multi-part акти мають однаковий act_group_key  
✅ "Weird docs" індексуються (chunks > 0)  
✅ Categories не "other" для важливих документів  
✅ Пошук працює для multi-part актів

**Всі критерії виконано!** ✅
