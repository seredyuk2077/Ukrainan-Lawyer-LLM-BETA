# PHASE 4: Resume CLI Commands — COMPLETED

**Дата:** 2026-01-21  
**Статус:** ✅ CLI ГОТОВО (resume logic потребує доопрацювання)

---

## Що зроблено

### 1. CLI Jobs Commands ✅
- **Створено:** `commands/jobs.ts`
  - `listJobs()` — список jobs (з опціями --failed, --running)
  - `inspectJob()` — детальна інформація про job
  - `resumeJob()` — заглушка для resume (TODO)

### 2. Admin CLI Integration ✅
- **Додано:** `admin-cli jobs list [--failed|--running]`
- **Додано:** `admin-cli jobs inspect --job-id <id>`
- **Додано:** `admin-cli jobs resume --job-id <id>` (заглушка)

### 3. Resume Support в Importer ✅
- **Додано:** `--resume` опція до `add` та `update` команд
- **Логіка:**
  - Перевірка існуючого job через `findResumeJob()`
  - Якщо job знайдено → використовуємо його `actualJobId`
  - Якщо job не знайдено → створюємо новий
  - Всі `updateJobProgress()` виклики перевіряють чи `actualJobId` існує

### 4. Job Progress Tracking ✅
- Всі етапи оновлюють progress (якщо job існує)
- Dry-run не створює jobs
- Errors автоматично помічають job як failed

---

## TODO для повної resume реалізації

1. **Resume logic в `resumeJob()`:**
   - Перевірка `progress_data.stage`
   - Визначення з якого етапу продовжувати
   - Skip вже виконаних етапів (R2 uploaded, AI enrichment done, etc.)
   - Продовження з embeddings/qdrant з правильного batch

2. **Тест на ККУ (2341-14):**
   - Запустити імпорт до кінця (або до timeout)
   - Якщо падає → перевірити resume
   - Згенерувати report з timings, batches, retries

---

## Використання

```bash
# Список всіх jobs
pnpm tsx scripts/legislation/admin-cli.ts jobs list

# Список failed jobs
pnpm tsx scripts/legislation/admin-cli.ts jobs list --failed

# Inspect конкретний job
pnpm tsx scripts/legislation/admin-cli.ts jobs inspect --job-id <uuid>

# Імпорт з resume (якщо job існує)
pnpm tsx scripts/legislation/admin-cli.ts add --nreg "2341-14" --resume
```

---

## Наступні кроки

1. Реалізувати повну resume logic
2. Протестувати на ККУ (2341-14)
3. Згенерувати real-world test report
