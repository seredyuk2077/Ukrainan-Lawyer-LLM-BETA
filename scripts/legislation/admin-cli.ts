#!/usr/bin/env node
/**
 * Legislation Admin CLI — адміністративний інструмент для управління Legislation RAG
 * 
 * Команди:
 *   status              - перевірка готовності інфраструктури
 *   add --nreg "..."    - імпорт одного документа
 *   remove --nreg "..."  - видалення документа
 *   inspect --nreg "..." - детальна інформація про документ
 */

import { Command } from 'commander';
import { checkReadiness } from './commands/status.js';
import { addDocument } from './commands/add.js';
import { removeDocument } from './commands/remove.js';
import { inspectDocument } from './commands/inspect.js';
import { updateDocument } from './commands/update.js';
import { addBatch } from './commands/add-batch.js';
import { purgeAll } from './commands/purge-all.js';
import { searchDocuments } from './commands/search.js';
import { listJobs, inspectJob, resumeJob } from './commands/jobs.js';
import { testKkuImport } from './commands/test-kku.js';
import { testCorpus } from './commands/test-corpus.js';
import { repairCategories } from './commands/repair-categories.js';
import { testKupap } from './commands/test-kupap.js';
import { repairActGroups } from './commands/repair-act-groups.js';
import { verifyDocument } from './commands/verify.js';
import { repairConsistency } from './commands/repair-consistency.js';
import { repairDocTypes } from './commands/repair-doc-types.js';
import { repairNumbers } from './commands/repair-numbers.js';
import { repairDocumentTypeConsistency } from './commands/repair-document-type-consistency.js';

const program = new Command();

program
  .name('legislation-admin')
  .description('Адміністративний CLI для Legislation RAG')
  .version('1.0.0');

program
  .command('status')
  .description('Перевірка готовності інфраструктури')
  .action(async () => {
    await checkReadiness();
  });

program
  .command('add')
  .description('Імпорт документа')
  .requiredOption('--nreg <nreg>', 'NREG документа')
  .option('--category <category>', 'Категорія права (опціонально)')
  .option('--dry-run', 'Тільки симуляція, без змін')
  .option('--resume', 'Продовжити з існуючого job якщо є')
  .action(async (options) => {
    await addDocument(options.nreg, {
      category: options.category,
      dryRun: options.dryRun,
      resume: options.resume,
    });
  });

program
  .command('remove')
  .description('Видалення документа')
  .requiredOption('--nreg <nreg>', 'NREG документа')
  .option('--confirm', 'Підтвердити видалення')
  .action(async (options) => {
    // Без --confirm: тільки preview (dry output), без змін
    await removeDocument(options.nreg, { confirm: Boolean(options.confirm) });
  });

program
  .command('inspect')
  .description('Детальна інформація про документ')
  .requiredOption('--nreg <nreg>', 'NREG документа')
  .action(async (options) => {
    await inspectDocument(options.nreg);
  });

program
  .command('update')
  .description('Оновлення/переіндексація документа (тільки якщо змінився content_hash, або --force)')
  .requiredOption('--nreg <nreg>', 'NREG документа')
  .option('--force', 'Примусово переіндексувати навіть якщо content_hash не змінився')
  .option('--resume', 'Продовжити з існуючого job якщо є')
  .action(async (options) => {
    await updateDocument(options.nreg, { 
      force: Boolean(options.force),
      resume: Boolean(options.resume),
    });
  });

program
  .command('add-batch')
  .description('Batch імпорт з файлу (по одному nreg на рядок)')
  .requiredOption('--file <file>', 'Шлях до файлу з nregs (по одному на рядок)')
  .option('--concurrency <n>', 'Кількість одночасних імпортів', '2')
  .option('--dry-run', 'Тільки симуляція, без змін')
  .action(async (options) => {
    await addBatch({
      file: options.file,
      concurrency: Number(options.concurrency) || 2,
      dryRun: Boolean(options.dryRun),
    });
  });

program
  .command('purge-all')
  .description('Повне очищення Supabase + Qdrant (з подвійним підтвердженням)')
  .option('--i-know-what-im-doing', 'Перше підтвердження')
  .action(async (options) => {
    await purgeAll({ iKnowWhatImDoing: Boolean(options.iKnowWhatImDoing) });
  });

program
  .command('search')
  .description('Retrieval sanity test (Qdrant search → R2 extract)')
  .requiredOption('--query <query>', 'Пошуковий запит')
  .option('--nreg <nreg>', 'Фільтр по rada_nreg (опціонально)')
  .option('--topk <n>', 'Кількість результатів', '5')
  .action(async (options) => {
    await searchDocuments({
      query: options.query,
      nreg: options.nreg,
      topk: Number(options.topk) || 5,
    });
  });

const jobsCommand = program
  .command('jobs')
  .description('Управління jobs (import tracking)');

jobsCommand
  .command('list')
  .description('Список jobs')
  .option('--failed', 'Тільки failed jobs')
  .option('--running', 'Тільки running jobs')
  .action(async (options) => {
    await listJobs({
      failed: Boolean(options.failed),
      running: Boolean(options.running),
    });
  });

jobsCommand
  .command('inspect')
  .description('Детальна інформація про job')
  .requiredOption('--job-id <jobId>', 'ID job')
  .action(async (options) => {
    await inspectJob(options.jobId);
  });

jobsCommand
  .command('resume')
  .description('Продовжити незавершений job')
  .requiredOption('--job-id <jobId>', 'ID job')
  .action(async (options) => {
    await resumeJob(options.jobId);
  });

program
  .command('test-kku')
  .description('End-to-end test для ККУ (2341-14) з resume evidence')
  .option('--resume', 'Продовжити з існуючого job')
  .option('--fail-after-batch <n>', 'Штучно кинути помилку після N batch (для тесту resume)', parseInt)
  .action(async (options) => {
    await testKkuImport({
      resume: Boolean(options.resume),
      failAfterBatch: options.failAfterBatch,
    });
  });

program
  .command('test-kupap')
  .description('Real world multi-part test для КУпАП (80731-10, 80732-10)')
  .action(async () => {
    await testKupap();
  });

program
  .command('test-weird-docs')
  .description('Test для "weird docs" — окрема думка КСУ + міжнародна конвенція')
  .action(async () => {
    const { testWeirdDocs } = await import('./commands/test-weird-docs.js');
    await testWeirdDocs();
  });

program
  .command('test-corpus')
  .description('Corpus batch import test з report generation')
  .requiredOption('--file <file>', 'Шлях до файлу з nregs (corpus_nregs.txt)')
  .option('--concurrency <n>', 'Кількість одночасних імпортів', '2')
  .option('--report', 'Згенерувати JSON + Markdown reports')
  .option('--resume', 'Продовжити з існуючих jobs якщо є')
  .action(async (options) => {
    await testCorpus({
      file: options.file,
      concurrency: Number(options.concurrency) || 2,
      report: Boolean(options.report),
      resume: Boolean(options.resume),
    });
  });

const repairCommand = program
  .command('repair')
  .description('Repair/backfill команди');

repairCommand
  .command('categories')
  .description('Нормалізувати та перекласифікувати categories')
  .option('--nreg <nreg>', 'Конкретний документ')
  .option('--all', 'Всі документи')
  .option('--force-ai', 'Примусова AI reclassification')
  .option('--dry-run', 'Тільки preview, без змін')
  .action(async (options) => {
    await repairCategories({
      nreg: options.nreg,
      all: Boolean(options.all),
      forceAi: Boolean(options.forceAi),
      dryRun: Boolean(options.dryRun),
    });
  });

repairCommand
  .command('act-groups')
  .description('Перерахувати act_group поля за новими правилами')
  .option('--nreg <nreg>', 'Конкретний документ')
  .option('--all', 'Всі документи')
  .option('--dry-run', 'Тільки preview, без змін')
  .action(async (options) => {
    await repairActGroups({
      nreg: options.nreg,
      all: Boolean(options.all),
      dryRun: Boolean(options.dryRun),
    });
  });

repairCommand
  .command('consistency')
  .description('Виправити невідповідності між Supabase/Qdrant/R2')
  .requiredOption('--nreg <nreg>', 'NREG документа')
  .option('--dry-run', 'Тільки preview, без змін')
  .action(async (options) => {
    await repairConsistency(options.nreg, {
      dryRun: Boolean(options.dryRun),
    });
  });

repairCommand
  .command('doc-types')
  .description('Виправити document_type_slug (PHASE 14)')
  .option('--nreg <nreg>', 'Конкретний документ')
  .option('--all', 'Всі документи')
  .option('--force-ai', 'Примусова AI reclassification')
  .option('--dry-run', 'Тільки preview, без змін')
  .action(async (options) => {
    await repairDocTypes({
      nreg: options.nreg,
      all: Boolean(options.all),
      forceAi: Boolean(options.forceAi),
      dryRun: Boolean(options.dryRun),
    });
  });

repairCommand
  .command('numbers')
  .description('Заповнити document_number (PHASE 15)')
  .option('--nreg <nreg>', 'Конкретний документ')
  .option('--all', 'Всі документи')
  .option('--dry-run', 'Тільки preview, без змін')
  .action(async (options) => {
    await repairNumbers({
      nreg: options.nreg,
      all: Boolean(options.all),
      dryRun: Boolean(options.dryRun),
    });
  });

repairCommand
  .command('doc-type-consistency')
  .description('Виправити document_type для консистентності з document_type_slug')
  .option('--nreg <nreg>', 'Конкретний документ')
  .option('--all', 'Всі документи')
  .option('--dry-run', 'Тільки preview, без змін')
  .action(async (options) => {
    await repairDocumentTypeConsistency({
      nreg: options.nreg,
      all: Boolean(options.all),
      dryRun: Boolean(options.dryRun),
    });
  });

program
  .command('verify')
  .description('Перевірка консистентності Supabase ↔ Qdrant ↔ R2 (PHASE 18: Invariants V1)')
  .option('--nreg <nreg>', 'NREG документа')
  .option('--all', 'Всі документи (з пагінацією)')
  .option('--write-health', 'Записати sync_health на основі результатів (PHASE 19)')
  .option('--evidence', 'Вивести SQL evidence queries (PHASE 18.2)')
  .option('--page <page>', 'Номер сторінки (для --all)', '0')
  .option('--page-size <size>', 'Розмір сторінки (для --all)', '100')
  .action(async (options) => {
    const { verifyDocument, verifyAll } = await import('./commands/verify.js');
    if (options.all) {
      await verifyAll({
        writeHealth: Boolean(options.writeHealth),
        evidence: Boolean(options.evidence),
        page: Number(options.page) || 0,
        pageSize: Number(options.pageSize) || 100,
      });
    } else if (options.nreg) {
      await verifyDocument(options.nreg, { writeHealth: Boolean(options.writeHealth) });
      if (options.evidence) {
        const { printEvidenceQueries } = await import('./commands/verify.js');
        await (printEvidenceQueries as any)();
      }
    } else {
      console.error('❌ Потрібно вказати --nreg або --all');
      process.exit(1);
    }
  });

program
  .command('collect-soak-nregs')
  .description('Зібрати різноманітні nreg для soak test (PHASE 20B)')
  .action(async () => {
    const { collectSoakNregs } = await import('./test/collect_soak_nregs.js');
    await collectSoakNregs();
  });

program
  .command('soak-test')
  .description('Soak test на різноманітних документах (PHASE 20)')
  .option('--file <file>', 'Файл з nregs (default: test/soak_nregs.txt)', 'test/soak_nregs.txt')
  .option('--dry-run', 'Тільки preview, без імпорту')
  .option('--no-repair', 'Не виконувати repair при FAIL')
  .action(async (options) => {
    const { runSoakTest } = await import('./commands/soak-test.js');
    await runSoakTest({
      file: options.file,
      dryRun: Boolean(options.dryRun),
      repairOnFail: !Boolean(options.noRepair),
    });
  });

program.parse();
