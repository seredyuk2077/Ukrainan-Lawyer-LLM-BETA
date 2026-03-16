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
import { resolve } from 'path';
import { checkReadiness } from './Lexery Legislation DB Infra/src/commands/status.js';
import { addDocument } from './Lexery Legislation DB Infra/src/commands/add.js';
import { removeDocument } from './Lexery Legislation DB Infra/src/commands/remove.js';
import { inspectDocument } from './Lexery Legislation DB Infra/src/commands/inspect.js';
import { updateDocument } from './Lexery Legislation DB Infra/src/commands/update.js';
import { addBatch } from './Lexery Legislation DB Infra/src/commands/add-batch.js';
import { purgeAll } from './Lexery Legislation DB Infra/src/commands/purge-all.js';
import { searchDocuments } from './Lexery Legislation DB Infra/src/commands/search.js';
import { listJobs, inspectJob, resumeJob } from './Lexery Legislation DB Infra/src/commands/jobs.js';
import { testKkuImport } from './Lexery Legislation DB Infra/src/commands/test-kku.js';
import { testCorpus } from './Lexery Legislation DB Infra/src/commands/test-corpus.js';
import { repairCategories } from './Lexery Legislation DB Infra/src/commands/repair-categories.js';
import { testKupap } from './Lexery Legislation DB Infra/src/commands/test-kupap.js';
import { repairActGroups } from './Lexery Legislation DB Infra/src/commands/repair-act-groups.js';
import { verifyDocument } from './Lexery Legislation DB Infra/src/commands/verify.js';
import { repairConsistency } from './Lexery Legislation DB Infra/src/commands/repair-consistency.js';
import { repairDocTypes } from './Lexery Legislation DB Infra/src/commands/repair-doc-types.js';
import { repairNumbers } from './Lexery Legislation DB Infra/src/commands/repair-numbers.js';
import { repairDocumentTypeConsistency } from './Lexery Legislation DB Infra/src/commands/repair-document-type-consistency.js';
import { backfillDocumentTypes } from './Lexery Legislation DB Infra/src/commands/backfill-document-types.js';
import { repairConsistencyAll } from './Lexery Legislation DB Infra/src/commands/repair-consistency-all.js';
import { collectGoldenDiversitySet } from './Lexery Legislation DB Infra/src/commands/collect-diverse-candidates.js';
import { collectGoldenDiversitySetFast } from './Lexery Legislation DB Infra/src/commands/collect-diverse-candidates-fast.js';
import { formGoldenDiversitySetFromList } from './Lexery Legislation DB Infra/src/commands/form_diverse_batch.js';
import { importDiverseBatch } from './Lexery Legislation DB Infra/src/commands/import_diverse_batch.js';
import { collectDiverseCandidatesV2 } from './Lexery Legislation DB Infra/src/commands/collect-diverse-candidates-v2.js';
import { collectDiverseCandidatesV3 } from './Lexery Legislation DB Infra/src/commands/collect-diverse-candidates-v3.js';
import { showGoldenSetPreview } from './Lexery Legislation DB Infra/src/commands/show-golden-set-preview.js';
import { prodGateUserSet } from './Lexery Legislation DB Infra/src/commands/prod-gate-user-set.js';
import { auditAllDocuments } from './Lexery Legislation DB Infra/src/commands/audit-documents.js';
import { auditAllDocumentsV2 } from './Lexery Legislation DB Infra/src/commands/audit-documents-v2.js';
import { createSupabaseAdminClient } from './Lexery Legislation DB Infra/src/lib/supabaseAdmin.js';
import { auditParserIntegrity } from './Lexery Legislation DB Infra/src/commands/audit-parser-integrity.js';
import { mreParserIntegrity } from './Lexery Legislation DB Infra/src/commands/mre-parser-integrity.js';
import { auditParserIntegrityV2 } from './Lexery Legislation DB Infra/src/commands/audit-parser-integrity-v2.js';
import { ragSanityArticleCLI } from './Lexery Legislation DB Infra/src/commands/rag-sanity-article.js';
import { comprehensiveRAGSanityTest } from './Lexery Legislation DB Infra/src/commands/rag-sanity-comprehensive.js';
import { ragDebugArticle } from './Lexery Legislation DB Infra/src/commands/rag-debug-article.js';
import { targetedDocTypeBackfill } from './Lexery Legislation DB Infra/src/commands/targeted-doc-type-backfill.js';
import { docTypeRegression } from './Lexery Legislation DB Infra/src/commands/doc-type-regression.js';
import { collectCriticalEvidence } from './Lexery Legislation DB Infra/src/commands/collect-critical-evidence.js';
import { analyzeDokidBatchCLI } from './Lexery Legislation DB Infra/src/commands/analyze-dokid-batch.js';
import { auditResolutionsCLI } from './Lexery Legislation DB Infra/src/commands/audit-resolutions.js';
import { findExplanationsCLI } from './Lexery Legislation DB Infra/src/commands/find-explanations.js';
import { printDocCard } from './Lexery Legislation DB Infra/src/commands/print-doc-card.js';
import { manualAuditCLI } from './Lexery Legislation DB Infra/src/commands/manual-audit.js';
import { analyzeManualAudit } from './Lexery Legislation DB Infra/src/commands/analyze-manual-audit.js';
import { backfillValidity } from './Lexery Legislation DB Infra/src/commands/backfill-validity.js';
import { runValidityRegressionTests } from './Lexery Legislation DB Infra/src/commands/regression-validity.js';
import { testLatestValidity } from './Lexery Legislation DB Infra/src/commands/test-latest-validity.js';
import { repairQdrantDedup } from './Lexery Legislation DB Infra/src/commands/repair-qdrant-dedup.js';
import { auditQdrantPayloadCompleteness } from './Lexery Legislation DB Infra/src/commands/audit-qdrant-payload-completeness.js';

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

jobsCommand
  .command('reconcile')
  .description('Помітити stuck running jobs як failed (TTL-based)')
  .option('--dry-run', 'Тільки preview, без змін')
  .option('--ttl-hours <n>', 'TTL в годинах (default: 24)', '24')
  .action(async (options) => {
    const { reconcileJobs } = await import('./Lexery Legislation DB Infra/src/commands/jobs-reconcile.js');
    await reconcileJobs({
      dryRun: Boolean(options.dryRun),
      ttlHours: options.ttlHours ? Number(options.ttlHours) : 24,
    });
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
    const { testWeirdDocs } = await import('./Lexery Legislation DB Infra/src/commands/test-weird-docs.js');
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
  .command('qdrant-dedup')
  .description('Видалити старі Qdrant-версії документа, залишивши тільки current content_hash')
  .requiredOption('--nreg <nreg>', 'Конкретний документ')
  .option('--dry-run', 'Тільки preview, без змін')
  .action(async (options) => {
    await repairQdrantDedup(options.nreg, { dryRun: Boolean(options.dryRun) });
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
  .option('--nreg <nreg>', 'NREG документа')
  .option('--all', 'Всі документи')
  .option('--dry-run', 'Тільки preview, без змін')
  .option('--limit <n>', 'Обмежити кількість документів (для --all)', parseInt)
  .action(async (options) => {
    if (options.all) {
      await repairConsistencyAll({
        dryRun: Boolean(options.dryRun),
        limit: options.limit ? Number(options.limit) : undefined,
      });
    } else if (options.nreg) {
      await repairConsistency(options.nreg, {
        dryRun: Boolean(options.dryRun),
      });
    } else {
      console.error('❌ Потрібно вказати --nreg або --all');
      process.exit(1);
    }
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
    const { verifyDocument, verifyAll } = await import('./Lexery Legislation DB Infra/src/commands/verify.js');
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
        const { printEvidenceQueries } = await import('./Lexery Legislation DB Infra/src/commands/verify.js');
        await (printEvidenceQueries as any)();
      }
    } else {
      console.error('❌ Потрібно вказати --nreg або --all');
      process.exit(1);
    }
  });

program
  .command('backfill-document-types')
  .description('Backfill document_type_slug та document_type для всіх документів (PHASE 21)')
  .option('--dry-run', 'Тільки preview, без змін')
  .option('--limit <n>', 'Обмежити кількість документів', parseInt)
  .action(async (options) => {
    await backfillDocumentTypes({
      dryRun: Boolean(options.dryRun),
      limit: options.limit ? Number(options.limit) : undefined,
    });
  });

program
  .command('collect-soak-nregs')
  .description('Зібрати різноманітні nreg для soak test (PHASE 20B)')
  .action(async () => {
    const { collectSoakNregs } = await import('./Lexery Legislation DB Infra/src/commands/collect-soak-nregs.js');
    await collectSoakNregs();
  });

program
  .command('detect-type-absurdities')
  .description('Системний детектор абсурдних класифікацій document_type (PHASE 1)')
  .option('--limit <n>', 'Кількість документів для перевірки')
  .option('--only-red', 'Тільки CRITICAL findings')
  .action(async (options) => {
    const { detectTypeAbsurdities } = await import('./Lexery Legislation DB Infra/src/commands/detect-type-absurdities.js');
    await detectTypeAbsurdities({
      limit: options.limit ? Number(options.limit) : undefined,
      onlyRed: Boolean(options.onlyRed),
    });
  });

program
  .command('collect-hard-soak')
  .description('Збір 50 складних документів для stress-test (PHASE 3)')
  .option('--limit <n>', 'Кількість документів', '50')
  .option('--output <path>', 'Шлях до вихідного файлу')
  .action(async (options) => {
    const { collectHardSoak } = await import('./Lexery Legislation DB Infra/src/commands/collect-hard-soak.js');
    await collectHardSoak({
      limit: Number(options.limit) || 50,
      outputPath: options.output,
    });
  });

program
  .command('collect-diverse-candidates')
  .description('Збір різноманітних кандидатів з diversity scoring (PHASE 2)')
  .option('--min-candidates <n>', 'Мінімальна кількість кандидатів', '30')
  .option('--output <path>', 'Шлях до вихідного JSON файлу')
  .option('--input <path>', 'Шлях до вхідного файлу з nregs (за замовчуванням: hard_stream_200_candidates.txt)')
  .option('--fast', 'Швидка версія (використовує існуючий список, без завантаження feed)')
  .option('--instant', 'Миттєва версія (тільки nreg patterns, без API calls)')
  .option('--v2', 'V2 версія (keyword mining + 3 джерела, PHASE 2 REWORK)')
  .option('--v3', 'V3 версія (Stage A/B модель, PHASE 2.1 REWORK)')
  .action(async (options) => {
    if (options.v3) {
      await collectDiverseCandidatesV3({
        outputPath: options.output || resolve(process.cwd(), 'runs', 'diverse', 'golden_diversity_set.json'),
      });
    } else if (options.v2) {
      await collectDiverseCandidatesV2({
        outputPath: options.output || resolve(process.cwd(), 'scripts/legislation/test/golden_diversity_set.json'),
      });
    } else if (options.instant) {
      await formGoldenDiversitySetFromList({
        inputFile: options.input,
        outputPath: options.output || resolve(process.cwd(), 'scripts/legislation/test/golden_diversity_set.json'),
        minCandidates: Number(options.minCandidates) || 30,
      });
    } else if (options.fast) {
      await collectGoldenDiversitySetFast({
        minCandidates: Number(options.minCandidates) || 30,
        inputFile: options.input,
        outputPath: options.output || resolve(process.cwd(), 'scripts/legislation/test/golden_diversity_set.json'),
      });
    } else {
      await collectGoldenDiversitySet({
        minCandidates: Number(options.minCandidates) || 30,
        outputPath: options.output || resolve(process.cwd(), 'scripts/legislation/test/golden_diversity_set.json'),
      });
    }
  });

program
  .command('import-hard-soak')
  .description('Імпорт hard soak документів пачками по 10 з циклами контролю (PHASE 3.3)')
  .option('--batch-size <n>', 'Розмір пачки', '10')
  .option('--file <path>', 'Шлях до файлу з nreg', 'scripts/legislation/test/hard_soak_nregs.txt')
  .action(async (options) => {
    const { importHardSoakBatch } = await import('./Lexery Legislation DB Infra/src/commands/import-hard-soak-batch.js');
    await importHardSoakBatch({
      batchSize: Number(options.batchSize) || 10,
      nregsFile: options.file,
    });
  });

program
  .command('collect-mismatch-evidence')
  .description('Збір "golden mismatch list" для валідації типів (PHASE 22)')
  .option('--limit <n>', 'Кількість документів для перевірки', '20')
  .action(async (options) => {
    const { collectMismatchEvidence } = await import('./Lexery Legislation DB Infra/src/commands/collect-mismatch-evidence.js');
    const mismatches = await collectMismatchEvidence(Number(options.limit) || 20);
    
    // Виводимо таблицю
    console.log(`\n═══════════════════════════════════════════════════════════`);
    console.log(`Golden Mismatch List (BEFORE)`);
    console.log(`═══════════════════════════════════════════════════════════`);
    console.log(`NREG | Title | Slug | UA | Typ | Summary Prefix`);
    console.log(`-----|-------|------|----|-----|----------------`);
    mismatches.forEach(m => {
      const title = m.title.substring(0, 40);
      const summary = m.summary_prefix?.substring(0, 40) || 'N/A';
      console.log(`${m.nreg} | ${title}... | ${m.document_type_slug} | ${m.document_type} | ${m.typ || 'NULL'} | ${summary}...`);
    });
  });

program
  .command('test-validation-mismatches')
  .description('Тестування валідації на знайдених місматчах (PHASE 22)')
  .action(async () => {
    const { testValidationOnMismatches } = await import('./Lexery Legislation DB Infra/src/commands/test-validation-on-mismatches.js');
    await testValidationOnMismatches();
  });

program
  .command('test-doc-types-regression')
  .description('Регресійний тест document_type_slug для різних типів (PHASE 21)')
  .action(async () => {
    const { testDocumentTypesRegression } = await import('./Lexery Legislation DB Infra/src/commands/test-document-types-regression.js');
    await testDocumentTypesRegression();
  });

program
  .command('propose-import')
  .description('Створити proposal на імпорт акта (AI-controlled importer stub)')
  .requiredOption('--nreg <nreg>', 'rada_nreg документа')
  .option('--proposed-by <source>', 'manual/system/ai', 'manual')
  .action(async (options) => {
    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase
      .from('legislation_import_proposals')
      .insert({
        rada_nreg: options.nreg,
        proposed_by: options.proposedBy || options['proposed-by'] || 'manual',
      })
      .select('id,rada_nreg,proposed_by,decision,created_at')
      .maybeSingle();
    if (error) {
      console.error(`❌ Failed to create proposal: ${error.message}`);
      process.exit(1);
    }
    console.log('✅ Proposal created:', data);
  });

program
  .command('approve-proposal')
  .description('Позначити proposal як approved/rejected (без запуску імпорту, тільки stub)')
  .requiredOption('--id <id>', 'ID proposal')
  .option('--decision <decision>', 'approved/rejected', 'approved')
  .option('--reason <reason>', 'Коротке пояснення рішення')
  .action(async (options) => {
    const supabase = createSupabaseAdminClient();
    const decision = options.decision === 'rejected' ? 'rejected' : 'approved';
    const { data, error } = await supabase
      .from('legislation_import_proposals')
      .update({
        decision,
        decision_reason: options.reason || null,
        decided_at: new Date().toISOString(),
      })
      .eq('id', options.id)
      .select('id,rada_nreg,decision,decision_reason,decided_at')
      .maybeSingle();
    if (error) {
      console.error(`❌ Failed to update proposal: ${error.message}`);
      process.exit(1);
    }
    if (!data) {
      console.error('❌ Proposal not found');
      process.exit(1);
    }
    console.log('✅ Proposal updated:', data);
  });

program
  .command('soak-test')
  .description('Soak test на різноманітних документах (PHASE 20)')
  .option('--file <file>', 'Файл з nregs (default: test/soak_nregs.txt)', 'test/soak_nregs.txt')
  .option('--dry-run', 'Тільки preview, без імпорту')
  .option('--no-repair', 'Не виконувати repair при FAIL')
  .action(async (options) => {
    const { runSoakTest } = await import('./Lexery Legislation DB Infra/src/commands/soak-test.js');
    await runSoakTest({
      file: options.file,
      dryRun: Boolean(options.dryRun),
      repairOnFail: !Boolean(options.noRepair),
    });
  });

program
  .command('import-diverse-batch')
  .description('Імпорт batch з diversity policy + Gate checks (PHASE 3.1)')
  .option('--batch-size <n>', 'Розмір batch', '10')
  .option('--start-from <n>', 'Почати з індексу', '0')
  .option('--input <path>', 'Шлях до golden_diversity_set.json')
  .action(async (options) => {
    await importDiverseBatch({
      batchSize: Number(options.batchSize) || 10,
      startFrom: Number(options.startFrom) || 0,
      inputFile: options.input,
    });
  });

program
  .command('show-golden-set-preview')
  .description('Показати preview-evidence таблицю з golden_diversity_set.json (PHASE 2.5)')
  .option('--input <path>', 'Шлях до golden_diversity_set.json')
  .action(async (options) => {
    await showGoldenSetPreview(options.input);
  });

program
  .command('prod-gate-user-set')
  .description('Prod Gate для вручну підібраного списку NREG (PHASE 6.3)')
  .option('--input <path>', 'Шлях до файлу з NREG (за замовчуванням: test/prod_gate_user_gold_set.txt)')
  .option('--batch-size <n>', 'Розмір batch', '8')
  .action(async (options) => {
    await prodGateUserSet({
      inputFile: options.input,
      batchSize: Number(options.batchSize) || 8,
    });
  });

program
  .command('audit-documents')
  .description('Генерація audit records для ручної перевірки документів (рефакторинг)')
  .option('--limit <n>', 'Обмежити кількість документів', '190')
  .option('--output <path>', 'Шлях до вихідного файлу', 'runs/audit_records.json')
  .action(async (options) => {
    await auditAllDocuments({
      limit: Number(options.limit) || undefined,
      outputFile: options.output,
    });
  });

program
  .command('audit-documents-v2')
  .description('Повний аудит документів з evidence (Supabase + canonical + Qdrant + signals)')
  .option('--limit <n>', 'Обмежити кількість документів')
  .option('--nregs <nregs>', 'Список nreg через кому (для аудиту конкретних документів)')
  .option('--output <path>', 'Шлях до JSON файлу', 'runs/audit/AUDIT_FLAGS_190.json')
  .option('--output-markdown <path>', 'Шлях до Markdown таблиці', 'runs/audit/AUDIT_TABLE_190.md')
  .action(async (options) => {
    const nregs = options.nregs ? (options.nregs as string).split(',').map((s: string) => s.trim()) : undefined;
    await auditAllDocumentsV2({
      limit: options.limit ? Number(options.limit) : undefined,
      nregs,
      outputFile: options.output,
      outputMarkdown: options.outputMarkdown,
    });
  });

program
  .command('audit-parser-integrity')
  .description('Перевірка зсуву статей/пунктів (parser integrity audit)')
  .option('--file <path>', 'Файл з nregs (по одному на рядок)')
  .option('--limit <n>', 'Обмежити кількість документів (якщо не вказано --file)')
  .option('--output <path>', 'Шлях до JSON файлу', 'runs/audit/PARSER_INTEGRITY_REPORT.json')
  .action(async (options) => {
    await auditParserIntegrity({
      file: options.file,
      limit: options.limit ? Number(options.limit) : undefined,
      outputFile: options.output,
    });
  });

program
  .command('mre-parser-integrity')
  .description('MRE для parser integrity (ККУ та КУпАП, 5 статей)')
  .action(async () => {
    await mreParserIntegrity();
  });

program
  .command('audit-parser-integrity-v2')
  .description('Перевірка structural consistency (canonical ↔ Qdrant payload)')
  .option('--file <path>', 'Файл з nregs (по одному на рядок)')
  .option('--limit <n>', 'Обмежити кількість документів (якщо не вказано --file)')
  .option('--output <path>', 'Шлях до JSON файлу', 'runs/audit/PARSER_INTEGRITY_V2_REPORT.json')
  .action(async (options) => {
    await auditParserIntegrityV2({
      file: options.file,
      limit: options.limit ? Number(options.limit) : undefined,
      outputFile: options.output,
    });
  });

program
  .command('audit-qdrant-payload')
  .description('Аудит payload completeness і version drift для LLDBI Qdrant')
  .option('--limit <n>', 'Обмежити кількість документів')
  .option('--nregs <nregs>', 'Список nreg через кому')
  .option('--concurrency <n>', 'Паралельність audit workers', '4')
  .option('--output <path>', 'Шлях до JSON файлу', 'runs/audit/QDRANT_PAYLOAD_AUDIT.json')
  .option('--output-markdown <path>', 'Шлях до Markdown звіту', 'runs/audit/QDRANT_PAYLOAD_AUDIT.md')
  .action(async (options) => {
    const nregs = options.nregs ? (options.nregs as string).split(',').map((s: string) => s.trim()) : undefined;
    await auditQdrantPayloadCompleteness({
      limit: options.limit ? Number(options.limit) : undefined,
      nregs,
      concurrency: options.concurrency ? Number(options.concurrency) : 4,
      outputFile: options.output,
      outputMarkdown: options.outputMarkdown,
    });
  });

program
  .command('rag-sanity-article')
  .description('RAG retrieval sanity test для конкретної статті')
  .requiredOption('--nreg <nreg>', 'NREG документа')
  .requiredOption('--article <article>', 'Номер статті')
  .option('--query <query>', 'Пошуковий запит (за замовчуванням: "ККУ стаття N умисне вбивство")')
  .option('--topk <n>', 'Кількість результатів', '5')
  .action(async (options) => {
    await ragSanityArticleCLI({
      nreg: options.nreg,
      article: options.article,
      query: options.query,
      topK: options.topk ? Number(options.topk) : 5,
    });
  });

program
  .command('rag-sanity-comprehensive')
  .description('Комплексний RAG sanity test для ККУ (6 тестів)')
  .action(async () => {
    await comprehensiveRAGSanityTest();
  });

program
  .command('rag-debug-article')
  .description('Детальна перевірка конкретної статті (debug)')
  .requiredOption('--nreg <nreg>', 'NREG документа')
  .requiredOption('--article <article>', 'Номер статті')
  .action(async (options) => {
    await ragDebugArticle(options.nreg, options.article);
  });

program
  .command('targeted-doc-type-backfill')
  .description('Targeted backfill для відомих проблемних кейсів (декрети, EU law, НКРЕКП)')
  .option('--dry-run', 'Dry run (не оновлювати БД)')
  .option('--nregs <nregs>', 'Список nreg через кому (за замовчуванням: відомі кейси)')
  .action(async (options) => {
    const nregs = options.nregs ? (options.nregs as string).split(',').map((s: string) => s.trim()) : undefined;
    await targetedDocTypeBackfill({
      dryRun: Boolean(options.dryRun),
      nregs,
    });
  });

program
  .command('doc-type-regression')
  .description('Regression test для golden set (перевірка правильності doc types)')
  .action(async () => {
    await docTypeRegression();
  });

program
  .command('collect-critical-evidence')
  .description('Збір evidence для CRITICAL документів (Supabase + R2 + Qdrant)')
  .action(async () => {
    await collectCriticalEvidence();
  });

program
  .command('analyze-dokid-batch')
  .description('Аналіз документів за dokid для виявлення проблем з класифікацією')
  .requiredOption('--dokids <dokids>', 'Список dokid через кому')
  .action(async (options) => {
    const dokids = options.dokids
      .split(',')
      .map((s: string) => parseInt(s.trim(), 10))
      .filter((n: number) => !isNaN(n));
    await analyzeDokidBatchCLI(dokids);
  });

program
  .command('audit-resolutions')
  .description('Аудит всіх постанов (cmu_resolution, vr_resolution) для виявлення проблем')
  .action(async () => {
    await auditResolutionsCLI();
  });

program
  .command('find-explanations')
  .description('Знайти всі документи з роз\'ясненнями (typ=12 або містить "РОЗ\'ЯСНЕННЯ")')
  .action(async () => {
    await findExplanationsCLI();
  });

program
  .command('print-doc-card')
  .description('Компактна картка документа для ручного аудиту')
  .requiredOption('--nreg <nreg>', 'NREG документа')
  .action(async (options) => {
    await printDocCard(options.nreg);
  });

program
  .command('manual-audit')
  .description('Ручний аудит документів один за одним')
  .option('--nregs <nregs>', 'Список nreg через кому')
  .option('--non-cmu', 'Всі non-CMU документи')
  .option('--type <slug>', 'Документи конкретного типу')
  .action(async (options) => {
    await manualAuditCLI({
      nregs: options.nregs,
      nonCmu: Boolean(options.nonCmu),
      type: options.type,
    });
  });

program
  .command('analyze-manual-audit')
  .description('Автоматичний аналіз semantic correctness для non-CMU документів')
  .option('--non-cmu', 'Всі non-CMU документи')
  .action(async (options) => {
    await analyzeManualAudit({
      nonCmu: Boolean(options.nonCmu),
    });
  });

program
  .command('backfill-validity')
  .description('Backfill validity_status для існуючих документів (PROD PIPELINE)')
  .option('--dry-run', 'Тільки preview, без змін')
  .option('--limit <n>', 'Обмежити кількість документів', parseInt)
  .option('--only-null', 'Тільки документи з NULL validity_status')
  .option('--nreg <nreg>', 'Конкретний документ')
  .action(async (options) => {
    await backfillValidity({
      dryRun: Boolean(options.dryRun),
      limit: options.limit ? Number(options.limit) : undefined,
      onlyNull: Boolean(options.onlyNull),
      nreg: options.nreg,
    });
  });

program
  .command('regression-validity')
  .description('Regression тести для validity pipeline')
  .action(async () => {
    await runValidityRegressionTests();
  });

program
  .command('test-latest-validity')
  .description('Тест validity на останніх документах')
  .option('--limit <n>', 'Кількість документів для тесту', '50')
  .action(async (options) => {
    await testLatestValidity(Number(options.limit) || 50);
  });

program.parse();
