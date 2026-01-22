# Versioning Policy — Legislation RAG

**Дата:** 2026-01-21  
**Статус:** ACTIVE

---

## Політика версіонування

### Source of Truth

**Supabase `legislation_documents`:**
- Зберігає **поточну версію** документа
- `content_hash` — детермінований hash canonical JSON (SHA-256)
- При оновленні документа: `content_hash` змінюється, `previous_hash` зберігає старий hash
- **Тільки один запис на `rada_nreg`** (поточна версія)

### Qdrant Collections

**Політика: CURRENT VERSION ONLY**

- **`lexery_legislation_acts`**: Рівно 1 point на документ (поточний `content_hash`)
- **`lexery_legislation_chunks`**: Рівно `expected_chunks` points на документ (поточний `content_hash`)
- **Старі версії видаляються** при імпорті нової версії або через `repair-qdrant-dedup`

**Обґрунтування:**
- Qdrant — data plane для пошуку, не архів
- Історія версій зберігається в Supabase (`previous_hash`) та R2 (canonical JSON з різними `content_hash`)
- Детерміновані IDs (`qdrantIds.ts`) забезпечують idempotent upsert

---

## Dedup Logic

### При імпорті

1. **Upsert з детермінованим ID:**
   - Act ID: `deterministicUuidFromString("${nreg}|${content_hash}")`
   - Chunk ID: `deterministicUuidFromString("${nreg}|${content_hash}|${chunk_index}")`
   - Якщо point з таким ID існує — оновлюється (upsert)

2. **Cleanup старих версій (опціонально):**
   - Якщо `previous_hash` існує — можна видалити points зі старим `content_hash`
   - За замовчуванням: cleanup виконується через `repair-qdrant-dedup` (не автоматично)

### Repair Dedup

**Команда:** `repair-qdrant-dedup --nreg <nreg>`

**Логіка:**
1. Отримує `content_hash` з Supabase (поточна версія)
2. Знаходить всі points для `nreg` в Qdrant
3. Видаляє points з `content_hash !== current_content_hash`
4. Якщо є дублікати з поточним hash — залишає один (deterministic ID)

**Логування:**
- Виводить кількість видалених acts/chunks
- Показує IDs старих версій
- Не видаляє "тихо" — завжди логує

---

## Майбутнє: Історія версій (якщо потрібно)

### Варіант 1: Окремі collections

```
lexery_legislation_acts_v1
lexery_legislation_acts_v2
...
```

**Плюси:** Простота, ізоляція  
**Мінуси:** Потрібно міняти collection name при версіонуванні

### Варіант 2: Filter by content_hash

- Зберігати N останніх версій в одній collection
- Filter: `{ must: [{ key: 'rada_nreg', match: { value: nreg } }, { key: 'content_hash', match: { value: hash } }] }`
- Keep N versions: при імпорті нової версії видаляти найстарішу (якщо > N)

**Плюси:** Одна collection, гнучкість  
**Мінуси:** Складніша логіка cleanup

### Варіант 3: Archive collection

- `lexery_legislation_acts_archive` для старих версій
- При імпорті нової версії: move old version to archive

**Плюси:** Чітке розділення current/archive  
**Мінуси:** Потрібно підтримувати дві collections

---

## Поточна реалізація

**Статус:** CURRENT VERSION ONLY

- ✅ Supabase: поточна версія + `previous_hash` для історії
- ✅ R2: canonical JSON з `content_hash` в metadata (можна зберігати всі версії)
- ✅ Qdrant: тільки поточна версія (стара видаляється через dedup)

**Команди:**
- `repair-qdrant-dedup --nreg <nreg>` — видалити старі версії
- `verify --nreg <nreg>` — перевірити acts count == 1

---

**Ця політика відповідає поточній реалізації dedup.** ✅
