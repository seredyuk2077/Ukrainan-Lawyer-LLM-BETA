# R2 Policy — Legislation RAG

## 1) Два бакети (критично)

- **Supreme Court Decisions bucket**: *НЕ ЧІПАТИ*.  
  Жодних операцій (навіть `list`) не виконувати цим тулінгом.

- **Legislation bucket**: використовується для Legislation RAG (цей документ).

> **Guardrail:** код має перевіряти bucket і падати, якщо випадково вказано Supreme Court bucket.

---

## 2) “legislation/” prefix всередині Legislation bucket

У **Legislation bucket** ключі об’єктів мають починатися з префікса:

- `legislation/...`

**ВАЖЛИВИЙ ризик:** випадково сформувати ключ як `legislation/legislation/...`.  
Це трапляється, коли хтось додає “basePrefix=legislation/” поверх вже готового canonical key.

> **Guardrail:** перед будь-яким записом canonical перевіряємо, що ключ:
> - починається з `legislation/`
> - **не** містить `legislation/legislation/`

---

## 3) Canonical key scheme (НЕ змінювати)

Canonical JSON (source-of-truth) зберігається за схемою:

- `legislation/{category}/{encodeURIComponent(nreg)}.json`

Де:
- `{category}` — folder (наприклад: `constitutional`, `civil`, `tax`, …)
- `encodeURIComponent(nreg)` — URI-encoded `rada_nreg`

Ця схема є контрактом. **Не переносимо, не перейменовуємо, не “розкладаємо” існуючі canonical ключі.**

---

## 4) Cache / Logs prefixes (НЕ змінювати, canonical туди не писати)

Існуючі префікси інших компонентів (зберігаються як є):

- Cache (Resolver): `legislation/ActCatalogResolver/cache/...`
- Logs/State (Updater): `legislation/DocListDB rada gov updater log/...`

> **Guardrail:** canonical upload **заборонено** якщо key починається з cache/log prefixes.

---

## 5) Guardrails API (в коді)

У `scripts/legislation/lib/r2Guardrails.ts` реалізовано:

- `assertLegislationBucketConfiguredCorrectly()`  
  Перевіряє, що використовується саме Legislation bucket (і це не Supreme Court bucket).

- `isCanonicalKey(key)`  
  True, якщо key відповідає canonical формату `legislation/{category}/{encoded_nreg}.json` і не є cache/log/archive.

- `isCacheOrLogKey(key)`  
  True, якщо key у `legislation/ActCatalogResolver/cache/` або `legislation/DocListDB rada gov updater log/`.

- `assertCanonicalKeyForWrite(key)`  
  Комплексна перевірка для запису canonical:
  - ключ має бути canonical
  - немає `legislation/legislation/`
  - не cache/log

---

## 6) Verification (що ми робимо і чого не робимо)

Ми можемо робити **read-only** перевірки ключів у **Legislation bucket**, щоб підтвердити:
- canonical keys знаходяться в `legislation/<category>/...`
- cache/log keys залишаються як є

Ми **не робимо**:
- move/rename існуючих об’єктів
- будь-які операції з Supreme Court bucket

