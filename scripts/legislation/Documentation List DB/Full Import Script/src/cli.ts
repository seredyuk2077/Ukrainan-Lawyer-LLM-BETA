#!/usr/bin/env node
import { Command } from 'commander';
import fsp from 'node:fs/promises';
import { createLogger } from './logger.js';
import { getDefaults, getEnv, getPaths, loadEnv, parseCliCommonOptions, type CliCommonOptions } from './config.js';
import { downloadDocZip, extractDocTxtToUtf8, getLocalDocStats, makeTestRunId } from './source.js';
import { resetLocalArtifacts, readInsertedIdEntries, readInsertedIds, loadState } from './state.js';
import { runImport } from './runner.js';
import { writeReport } from './reporter.js';
import { OpenRouterEmbeddingProvider } from './embeddingProvider.js';
import { QdrantVectorDbClient, getQdrantConnectionFromEnv } from './qdrantClient.js';
import { sleep } from './utils.js';

loadEnv();

const defaults = getDefaults();
const paths = getPaths();
const env = getEnv();

const program = new Command();
program.name('doclistdb-full-import').description('DocListDB Catalog full importer (Rada doc.txt -> Qdrant)');

function createQdrant(logger: ReturnType<typeof createLogger>, collectionName: string) {
  const { baseUrl, apiKey } = getQdrantConnectionFromEnv(env);
  return new QdrantVectorDbClient(logger, {
    baseUrl,
    apiKey,
    collectionName,
    timeoutMs: env.qdrantTimeoutMs ?? defaults.defaultQdrantTimeoutMs,
    maxRetries: defaults.defaultMaxRetries,
    backoffBaseMs: defaults.defaultBackoffBaseMs,
    backoffMaxMs: defaults.defaultBackoffMaxMs,
  });
}

function createEmbedder(logger: ReturnType<typeof createLogger>, cfg: { model: string; dimensions?: number }) {
  const openRouterKey = env.openRouterApiKey;
  if (!openRouterKey) throw new Error('OPEN_ROUTER_API_RAG missing.');
  return new OpenRouterEmbeddingProvider(logger, {
    apiKey: openRouterKey,
    model: cfg.model,
    dimensions: cfg.dimensions,
    timeoutMs: defaults.defaultOpenRouterTimeoutMs,
    maxRetries: defaults.defaultMaxRetries,
    backoffBaseMs: defaults.defaultBackoffBaseMs,
    backoffMaxMs: defaults.defaultBackoffMaxMs,
  });
}

async function runAudit(params: { logger: ReturnType<typeof createLogger>; indexName: string; topK: number }): Promise<{
  ok: true;
  firstId: string;
  matches: number;
}> {
  const entries = await readInsertedIdEntries(paths.insertedIdsPath);
  if (entries.length === 0) {
    throw new Error(`No inserted IDs found at ${paths.insertedIdsPath}. Run "test" or enable ID tracking.`);
  }

  const state = await loadState(paths.statePath).catch(() => null);
  const embeddingModel = state?.run_config.openrouterModel || defaults.defaultEmbeddingModel;
  const embeddingDims = state?.run_config.openrouterDimensions;

  const qdrant = createQdrant(params.logger, params.indexName);
  await qdrant.initialize();
  const dims = qdrant.getIndexDimensions();
  if (!dims) throw new Error('Could not determine Qdrant collection dims');

  const first = entries[0];
  if (!first?.nreg) throw new Error(`Audit FAIL: inserted_ids entry is missing nreg (path: ${paths.insertedIdsPath}).`);
  const firstId = first.id;
  const zero = new Array(dims).fill(0);

  params.logger.info({ nreg: first.nreg, pointId: firstId }, 'audit: filter query by nreg');
  const byNreg = await qdrant.search({ vector: zero, topK: 1, filter: { nreg: first.nreg } });
  if (!byNreg[0] || byNreg[0].id !== firstId) {
    throw new Error(`Audit FAIL: filter query by nreg did not return the expected point id (${firstId}).`);
  }

  const nazva = String((byNreg[0].metadata as any)?.nazva || '').trim();
  if (!nazva) throw new Error('Audit FAIL: could not read nazva from returned metadata.');

  const embedder = createEmbedder(params.logger, { model: embeddingModel, dimensions: embeddingDims });
  const qVec = await embedder.embedQuery(nazva);
  if (qVec.length !== dims) {
    throw new Error(`Audit FAIL: embedding dims mismatch for query: got ${qVec.length}, expected ${dims}`);
  }

  params.logger.info({ query: nazva.slice(0, 80) }, 'audit: semantic query (nazva)');
  const semantic = await qdrant.search({ vector: qVec, topK: params.topK, filter: { is_test: true } });
  const found = semantic.some((m) => m.id === firstId);
  if (!found) {
    throw new Error(`Audit FAIL: semantic query did not return the known test id (${firstId}).`);
  }

  params.logger.info({ ok: true, firstId, matches: semantic.length }, 'audit PASS');
  return { ok: true, firstId, matches: semantic.length };
}

async function runCleanup(params: { logger: ReturnType<typeof createLogger>; indexName: string }): Promise<{
  ids: number;
  deleted: number;
}> {
  const entries = await readInsertedIdEntries(paths.insertedIdsPath);
  const ids = entries.map((e) => e.id);
  if (ids.length === 0) {
    params.logger.warn('no inserted IDs found; nothing to delete');
    return { ids: 0, deleted: 0 };
  }

  const qdrant = createQdrant(params.logger, params.indexName);
  await qdrant.initialize();

  // Delete in chunks to avoid request size limits.
  const chunkSize = 500;
  let deleted = 0;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    await qdrant.deleteByIds(chunk);
    deleted += chunk.length;
    await sleep(150); // small pacing to be gentle
  }

  params.logger.info({ ids: ids.length, deleted }, 'cleanup delete-by-ids complete');

  // Verify deletion (sampled)
  const dims = qdrant.getIndexDimensions();
  if (!dims) throw new Error('Could not determine Qdrant collection dims');
  const zero = new Array(dims).fill(0);

  const verifyCount = entries.length <= 25 ? entries.length : 25;
  const sample = entries.length <= 25 ? entries : shuffle(entries).slice(0, verifyCount);
  let stillPresent = 0;
  for (const e of sample) {
    if (!e.nreg) continue;
    const matches = await qdrant.search({ vector: zero, topK: 1, filter: { nreg: e.nreg } });
    if (matches.some((m) => m.id === e.id)) stillPresent++;
  }
  if (stillPresent > 0) {
    throw new Error(`Cleanup verification failed: ${stillPresent}/${sample.length} sampled ids still present in collection.`);
  }

  params.logger.info({ sampled: sample.length, ok: true }, 'cleanup verification PASS');
  await resetLocalArtifacts(paths.tmpDir, { keepDocFiles: true });
  return { ids: ids.length, deleted };
}

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

program
  .command('download-doc')
  .description('Download doc.zip, extract doc.txt (cp1251 -> utf8) into local tmp/')
  .option('--log-level <level>', 'Log level', defaults.defaultLogLevel)
  .option('--log-pretty', 'Pretty logs', false)
  .action(async (opts) => {
    const logger = createLogger({ level: opts.logLevel, pretty: Boolean(opts.logPretty) });
    await downloadDocZip({
      url: defaults.sourceUrl,
      paths,
      logger,
      timeoutMs: defaults.defaultHttpTimeoutMs,
      maxRetries: defaults.defaultMaxRetries,
      backoffBaseMs: defaults.defaultBackoffBaseMs,
      backoffMaxMs: defaults.defaultBackoffMaxMs,
    });
    await extractDocTxtToUtf8({ paths, logger });
    const stats = await getLocalDocStats(paths.docTxtPath, { countLines: true, sampleLines: 3 });
    logger.info(
      { bytes: stats.bytes, totalLines: stats.totalLines, mtimeMs: stats.mtimeMs, sampleLines: stats.sampleLines },
      'local doc.txt ready'
    );
  });

function addCommonOptions(cmd: Command): Command {
  return cmd
    .option('--index-name <name>', 'Qdrant collection name', defaults.defaultIndexName)
    .option('--expected-index-dimensions <n>', 'Expected Qdrant vector dimensions', String(defaults.defaultExpectedIndexDimensions))
    .option('--batch-size <n>', 'Records per batch', String(defaults.defaultBatchSize))
    .option('--time-limit <seconds>', 'Time limit in seconds (graceful stop with final flush)')
    .option('--pause-after-batches <n>', 'Pause after N flushed batches (final flush still runs)')
    .option('--max-records <n>', 'Process at most N valid records')
    .option('--skip-supabase-sync', 'Disable Supabase sync (nreg->supabase_doc_id)', false)
    .option('--openrouter-model <name>', 'OpenRouter embedding model', defaults.defaultEmbeddingModel)
    .option('--openrouter-dimensions <n>', 'Request embeddings in specific dimensions (no truncation)')
    .option('--log-level <level>', 'Log level', defaults.defaultLogLevel)
    .option('--log-pretty', 'Pretty logs', false);
}

function parseCommon(opts: any): CliCommonOptions {
  return parseCliCommonOptions({
    indexName: opts.indexName,
    expectedIndexDimensions: opts.expectedIndexDimensions,
    batchSize: opts.batchSize,
    timeLimit: opts.timeLimit,
    pauseAfterBatches: opts.pauseAfterBatches,
    maxRecords: opts.maxRecords,
    skipSupabaseSync: opts.skipSupabaseSync,
    openrouterModel: opts.openrouterModel,
    openrouterDimensions: opts.openrouterDimensions,
    logLevel: opts.logLevel,
    logPretty: opts.logPretty,
  });
}

addCommonOptions(
  program
    .command('import')
    .description('Start a new full import to Qdrant (overwrites local state; starts from line 0).')
).action(async (opts) => {
  const common = parseCommon(opts);
  const logger = createLogger({ level: common.logLevel, pretty: common.logPretty });
  const report = await runImport({ mode: 'import', options: common, paths, env, logger });
  await writeReport(paths.reportPath, report);
  logger.info({ reportPath: paths.reportPath }, 'run complete');
});

addCommonOptions(program.command('resume').description('Resume from local state (strict fingerprint check)')).action(async (opts) => {
  // For resume, default to the saved run_config when flags are not provided.
  const logger = createLogger({ level: opts.logLevel || defaults.defaultLogLevel, pretty: Boolean(opts.logPretty) });
  const state = await loadState(paths.statePath);

  const merged = parseCliCommonOptions({
    indexName: opts.indexName ?? state.run_config.indexName,
    expectedIndexDimensions: opts.expectedIndexDimensions ?? state.run_config.expectedIndexDimensions,
    batchSize: opts.batchSize ?? state.run_config.batchSize,
    timeLimit: opts.timeLimit,
    pauseAfterBatches: opts.pauseAfterBatches,
    maxRecords: opts.maxRecords,
    skipSupabaseSync: opts.skipSupabaseSync ?? state.run_config.skipSupabaseSync,
    openrouterModel: opts.openrouterModel ?? state.run_config.openrouterModel,
    openrouterDimensions: opts.openrouterDimensions ?? state.run_config.openrouterDimensions,
    logLevel: opts.logLevel || defaults.defaultLogLevel,
    logPretty: opts.logPretty,
  });

  const report = await runImport({ mode: 'resume', options: merged, paths, env, logger, trackInsertedIds: state.mode === 'test' });
  await writeReport(paths.reportPath, report);
  logger.info({ reportPath: paths.reportPath }, 'resume complete');
});

program
  .command('audit')
  .description('Audit test data in Qdrant: filter query + semantic query')
  .option('--index-name <name>', 'Qdrant collection name', defaults.defaultIndexName)
  .option('--log-level <level>', 'Log level', defaults.defaultLogLevel)
  .option('--log-pretty', 'Pretty logs', false)
  .option('--topk <n>', 'TopK for semantic query', '5')
  .action(async (opts) => {
    const logger = createLogger({ level: opts.logLevel, pretty: Boolean(opts.logPretty) });
    const topK = Number.parseInt(opts.topk, 10) || 5;
    await runAudit({ logger, indexName: opts.indexName || defaults.defaultIndexName, topK });
  });

program
  .command('cleanup')
  .description('Delete vectors by IDs from tmp/inserted_ids.jsonl (test cleanup)')
  .option('--index-name <name>', 'Qdrant collection name', defaults.defaultIndexName)
  .option('--log-level <level>', 'Log level', defaults.defaultLogLevel)
  .option('--log-pretty', 'Pretty logs', false)
  .action(async (opts) => {
    const logger = createLogger({ level: opts.logLevel, pretty: Boolean(opts.logPretty) });
    await runCleanup({ logger, indexName: opts.indexName || defaults.defaultIndexName });
  });

program
  .command('reset-state')
  .description('Delete local state/errors/ids/report (does NOT touch remote index). Requires --force.')
  .option('--force', 'Required confirmation', false)
  .option('--log-level <level>', 'Log level', defaults.defaultLogLevel)
  .option('--log-pretty', 'Pretty logs', false)
  .action(async (opts) => {
    const logger = createLogger({ level: opts.logLevel, pretty: Boolean(opts.logPretty) });
    if (!opts.force) {
      throw new Error('Refusing to reset without --force');
    }
    await resetLocalArtifacts(paths.tmpDir, { keepDocFiles: true });
    logger.info({ tmpDir: paths.tmpDir }, 'local state reset complete (doc files preserved)');
  });

program
  .command('test')
  .description('E2E test: import 10 records with pause/resume, audit, cleanup, PASS/FAIL')
  .option('--index-name <name>', 'Qdrant collection name', defaults.defaultIndexName)
  .option('--expected-index-dimensions <n>', 'Expected Qdrant vector dimensions', String(defaults.defaultExpectedIndexDimensions))
  .option('--openrouter-model <name>', 'OpenRouter embedding model', defaults.defaultEmbeddingModel)
  .option('--openrouter-dimensions <n>', 'Request embeddings in specific dimensions (no truncation)')
  .option('--log-level <level>', 'Log level', defaults.defaultLogLevel)
  .option('--log-pretty', 'Pretty logs', true)
  .option('--skip-supabase-sync', 'Disable Supabase sync', false)
  .action(async (opts) => {
    const logger = createLogger({ level: opts.logLevel, pretty: Boolean(opts.logPretty) });
    const testRunId = makeTestRunId();
    logger.info({ testRunId }, 'starting test suite');

    // Ensure local doc.txt exists; if missing, download it.
    try {
      await fsp.stat(paths.docTxtPath);
    } catch {
      logger.warn('doc.txt missing; running download-doc automatically');
      await downloadDocZip({
        url: defaults.sourceUrl,
        paths,
        logger,
        timeoutMs: defaults.defaultHttpTimeoutMs,
        maxRetries: defaults.defaultMaxRetries,
        backoffBaseMs: defaults.defaultBackoffBaseMs,
        backoffMaxMs: defaults.defaultBackoffMaxMs,
      });
      await extractDocTxtToUtf8({ paths, logger });
    }

    // Clean local state (keep doc files)
    await resetLocalArtifacts(paths.tmpDir, { keepDocFiles: true });

    const common: CliCommonOptions = parseCliCommonOptions({
      indexName: opts.indexName,
      expectedIndexDimensions: opts.expectedIndexDimensions,
      batchSize: 5, // force 2 batches for pause/resume
      timeLimit: undefined,
      pauseAfterBatches: 1,
      maxRecords: 10,
      skipSupabaseSync: opts.skipSupabaseSync,
      openrouterModel: opts.openrouterModel,
      // For the built-in test we default to requesting embeddings in the index dimensions
      // (no truncation; the provider must support this or the test will fail loudly).
      openrouterDimensions: opts.openrouterDimensions ?? opts.expectedIndexDimensions,
      logLevel: opts.logLevel,
      logPretty: opts.logPretty,
    });

    let pass = false;
    let failReason: string | null = null;
    let pausedRun: any = null;
    let resumedRun: any = null;
    let audit: any = null;
    let cleanup: any = null;
    try {
      logger.info('test step 1/4: run with pause-after-batches=1');
      const r1 = await runImport({
        mode: 'test',
        options: common,
        paths,
        env,
        logger,
        testRunId,
        trackInsertedIds: true,
      });
      pausedRun = r1;

      logger.info('test step 2/4: resume to completion');
      const resumeOptions: CliCommonOptions = {
        ...common,
        pauseAfterBatches: undefined,
        timeLimitSeconds: undefined,
      };
      const r2 = await runImport({
        mode: 'resume',
        options: resumeOptions,
        paths,
        env,
        logger,
        trackInsertedIds: true,
      });
      resumedRun = r2;

      // Hard assertion for the required test invariants
      if (resumedRun?.counters?.processed !== 10 || resumedRun?.counters?.upserted !== 10 || resumedRun?.counters?.failed !== 0) {
        throw new Error(
          `Test counters mismatch. Expected processed=10 upserted=10 failed=0; got processed=${resumedRun?.counters?.processed} upserted=${resumedRun?.counters?.upserted} failed=${resumedRun?.counters?.failed}`
        );
      }

      logger.info('test step 3/4: audit');
      audit = await runAudit({ logger, indexName: common.indexName, topK: 5 });

      logger.info('test step 4/4: cleanup');
      cleanup = await runCleanup({ logger, indexName: common.indexName });
      if (cleanup.deleted !== 10) {
        throw new Error(`Cleanup mismatch: expected deleted=10, got deleted=${cleanup.deleted}`);
      }

      pass = true;
    } catch (e) {
      pass = false;
      failReason = e instanceof Error ? e.message : String(e);
      logger.error({ err: failReason }, 'test FAILED');
      // Always attempt cleanup if we created inserted IDs
      try {
        cleanup = await runCleanup({ logger, indexName: opts.indexName || defaults.defaultIndexName });
      } catch {
        // ignore
      }
    } finally {
      await writeReport(paths.reportPath, {
        kind: 'test_report',
        pass,
        failReason,
        testRunId,
        finished_at: new Date().toISOString(),
        pausedRun,
        resumedRun,
        audit,
        cleanup,
      });
    }

    if (!pass) {
      throw new Error(`TEST FAIL: ${failReason || 'unknown error'}`);
    }
    logger.info({ pass: true, testRunId }, 'TEST PASS');
  });

program.parseAsync(process.argv).catch((err) => {
  // Ensure non-zero exit code for CI / scripts
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

