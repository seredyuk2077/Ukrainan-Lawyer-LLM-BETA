# Gate A: Ручний аудит 100 документів

**Дата:** 2026-01-22  
**Метод:** Ручна перевірка 40 документів (20 складних + 20 рандомних)  
**Статус:** total_docs=100, CRITICAL=0, FAIL=0 ✅

---

## STOP RULE Evidence (після 100-го документа)

- **total_docs:** 100 ✅
- **verify FAIL:** 0 ✅
- **detect-type-absurdities CRITICAL:** 0 ✅
- **health_red:** 1 (потребує перевірки)
- **null_type:** 0 ✅
- **null_category:** 0 ✅
- **chunks_mismatch:** 0 ✅

---

## Раунд 1: Складні документи (20)

Дані отримані з SQL запиту. Потрібна ручна перевірка кожного документа на відповідність:
- title/summary відповідає document_type_slug
- category логічно відповідає змісту
- chunks співпадають (expected = indexed)
- health badge коректний

**SQL запит для отримання даних:**
```sql
SELECT 
  rada_nreg,
  LEFT(title, 80) as title_prefix,
  LEFT(summary, 80) as summary_prefix,
  document_type_slug,
  document_type,
  category,
  COALESCE(document_number, law_number, rada_nreg) as doc_number,
  expected_chunks,
  indexed_chunks,
  sync_health
FROM legislation_documents
WHERE document_type_slug IN ('rnbo_decision', 'cec_resolution', 'nbu_letter', 'nbu_resolution', 'presidential_decree', 'vr_speaker_order', 'convention')
   OR category IN ('defense_mobilization', 'national_security')
ORDER BY 
  CASE document_type_slug
    WHEN 'rnbo_decision' THEN 1
    WHEN 'cec_resolution' THEN 2
    WHEN 'presidential_decree' THEN 3
    WHEN 'vr_speaker_order' THEN 4
    WHEN 'nbu_resolution' THEN 5
    ELSE 6
  END,
  rada_nreg
LIMIT 20;
```

---

## Раунд 2: Рандомні документи (20)

Дані отримані з SQL запиту. Потрібна ручна перевірка кожного документа.

**SQL запит для отримання даних:**
```sql
SELECT 
  rada_nreg,
  LEFT(title, 80) as title_prefix,
  LEFT(summary, 80) as summary_prefix,
  document_type_slug,
  document_type,
  category,
  COALESCE(document_number, law_number, rada_nreg) as doc_number,
  expected_chunks,
  indexed_chunks,
  sync_health
FROM legislation_documents
WHERE document_type_slug NOT IN ('rnbo_decision', 'cec_resolution', 'nbu_letter', 'nbu_resolution', 'presidential_decree', 'vr_speaker_order', 'convention')
  AND category NOT IN ('defense_mobilization', 'national_security')
ORDER BY RANDOM()
LIMIT 20;
```

---

## Підсумок

- **OK:** 0 (очікується після ручної перевірки)
- **SUSPICIOUS:** 0 (очікується після ручної перевірки)
- **Root fixes required:** 0 (очікується після ручної перевірки)

---

## Примітки

Ручний аудит виконується вручну через Supabase UI або SQL запити.  
Після завершення аудиту - оновити цей файл з результатами.
