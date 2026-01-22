# Safety Audit — Checkpoint Commit

**Дата:** 2026-01-22  
**Commit:** `1123474` — `chore(legislation): checkpoint recap + infra evidence`

---

## 0.1 Перевірка секретів

### Методика
- Сканування коміту на паттерни: `SUPABASE.*KEY`, `SERVICE_ROLE`, `R2_SECRET`, `OPEN_ROUTER.*KEY`, `API_KEY`, `ENDPOINT`, JWT токени (`eyJ`), API ключі (`sk-`), паролі, токени
- Перевірка JSON файлів у runs/ на наявність секретів

### Результати

**✅ СЕКРЕТІВ НЕ ЗНАЙДЕНО**

- Перевірено коміт `HEAD`: знайдено тільки `token_count` як поле (не токени)
- Перевірено `enrichment.json` файли: містять тільки AI output (summary, keywords, topics), без API ключів
- Перевірено `rada_raw.json` файли: містять тільки дані з rada.gov.ua API, без секретів
- Перевірено `canonical.preview.json`: містять тільки метадані та preview контенту

**Висновок:** Коміт безпечний, секрети не потрапили в git.

---

## 0.2 Аналіз "сміття" / generated artifacts

### Статистика коміту
- **673 файли змінено**
- **302,927 insertions**
- **717 deletions**

### Топ-директорії за обсягом

1. **`scripts/legislation/runs/`** — 39MB, 559 файлів
   - **Типи файлів:**
     - `rada_raw.json` — raw дані з rada.gov.ua API (найбільші: до 1.2MB)
     - `rada_raw.txt` — raw текст (найбільші: до 1.1MB)
     - `canonical.preview.json` — preview canonical JSON (до 32KB)
     - `enrichment.json` — AI enrichment output (до 2.3KB)
     - `report.json` — звіти про імпорт (до 1KB)
     - `logs.txt` — логи операцій (до 1.8KB)

2. **`scripts/legislation/`** — документація та код
   - Phase reports (MD файли)
   - Test fixtures (JSON)
   - Source code (TS)

### Класифікація

#### ✅ MUST-KEEP (fixtures/docs)
- `scripts/legislation/test/fixtures/` — тестові fixtures
- `scripts/legislation/*.md` — документація
- `scripts/legislation/PHASE_*.md` — фазові репорти
- `scripts/legislation/commands/` — CLI команди
- `scripts/legislation/lib/` — core логіка
- `scripts/legislation/canonical/` — canonical builders

#### ⚠️ GENERATED (можна видалити з git, але залишити локально)
- `scripts/legislation/runs/**/*.json` — generated artifacts від імпортів
- `scripts/legislation/runs/**/*.txt` — логи та raw дані
- `scripts/legislation/runs/corpus_report_*.json` — generated reports

**Обґрунтування:**
- Runs/ директорія — це evidence/artifacts від тестових імпортів
- Корисно для debugging локально, але не потрібно в git
- Займає 39MB (559 файлів) — значний обсяг для репо

### Рекомендації

1. **Додати `.gitignore` правило:**
   ```
   # Legislation runs (generated artifacts)
   scripts/legislation/runs/**/*.json
   scripts/legislation/runs/**/*.txt
   scripts/legislation/runs/**/logs.txt
   !scripts/legislation/runs/.gitkeep
   ```

2. **Видалити tracked files через `git rm --cached`:**
   ```bash
   git rm -r --cached scripts/legislation/runs/**/*.json
   git rm -r --cached scripts/legislation/runs/**/*.txt
   ```

3. **Залишити структуру (якщо потрібно):**
   ```bash
   touch scripts/legislation/runs/.gitkeep
   ```

4. **Окремий cleanup коміт:**
   ```bash
   git commit -m "chore(legislation): remove generated runs artifacts from git"
   ```

---

## Acceptance для 0

- ✅ **0 витоків секретів** — підтверджено
- ⚠️ **Політика runs/:** потрібно додати `.gitignore` та видалити tracked artifacts
- ⚠️ **Cleanup коміт:** потрібно зробити після додавання `.gitignore`

---

## План дій

1. Додати `.gitignore` правила для runs/
2. Видалити tracked artifacts через `git rm --cached`
3. Зробити cleanup коміт
4. Продовжити з пункту 1 (Document Type система)
