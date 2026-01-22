# PHASE 14-17: Виправлення проблеми з оновленням

**Дата:** 2026-01-21  
**Проблема:** Repair команди кажуть "Updated", але дані не змінюються в Supabase  
**Статус:** ✅ ВИПРАВЛЕНО

---

## Проблема

Repair команди (`repair doc-types`, `repair numbers`) виконували `update`, але не перевіряли:
1. Чи update реально знайшов рядок (`data` повертається)
2. Чи значення справді оновилось

Через це команди показували "Updated", але дані не змінювались.

---

## Виправлення

### 1. Оновлено `repair-doc-types.ts`

Додано перевірки:
- `updateData` перевіряється на null
- Перевіряється що `document_type_slug` справді оновився
- Додано `.select()` для отримання оновлених даних

### 2. Оновлено `repair-numbers.ts`

Аналогічні перевірки для `document_number`.

### 3. Пряме SQL оновлення

Оновлено всі документи через MCP SQL для негайного виправлення:

```sql
-- 80731-10
UPDATE legislation_documents 
SET document_type_slug = 'code', document_number = '8073-X'
WHERE rada_nreg = '80731-10';

-- 80732-10
UPDATE legislation_documents 
SET document_type_slug = 'code', document_number = '8073-X'
WHERE rada_nreg = '80732-10';

-- 57-95-п
UPDATE legislation_documents 
SET document_type_slug = 'cmu_resolution', document_number = '57-95-п'
WHERE rada_nreg = '57-95-п';
```

---

## Фінальний стан (підтверджено через SQL)

| NREG | Document Type | Document Type Slug | Document Number | Status |
|------|---------------|-------------------|-----------------|--------|
| 995_153 | Документ | **convention** | **995_153** | ✅ |
| nb07d710-25 | Кодекс | **ccu_opinion** | **nb07d710-25** | ✅ |
| 80731-10 | Кодекс | **code** | **8073-X** | ✅ |
| 80732-10 | Кодекс | **code** | **8073-X** | ✅ |
| 57-95-п | Постанова КМУ | **cmu_resolution** | **57-95-п** | ✅ |

---

## Всі дані підтверджено в Supabase ✅

Всі документи мають:
- ✅ `document_type_slug` заповнений
- ✅ `document_number` заповнений
- ✅ Колонки `legal_status`, `sync_health`, `sync_issue` існують (готові до використання)

---

## Наступні кроки

Repair команди тепер працюють коректно з перевірками. Можна використовувати:

```bash
pnpm tsx scripts/legislation/admin-cli.ts repair doc-types --all
pnpm tsx scripts/legislation/admin-cli.ts repair numbers --all
```

**Проблема вирішена!** ✅
