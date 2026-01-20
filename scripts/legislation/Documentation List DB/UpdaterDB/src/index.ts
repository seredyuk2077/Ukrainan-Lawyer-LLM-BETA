#!/usr/bin/env node
import { Command } from 'commander';
import { createLogger, type LogLevel } from './logger.js';
import { getEnv, loadEnv, validateCliOptions, validateEnv, type CliOptions } from './config.js';
import { runSync } from './pipeline/sync.js';
import { parsePositiveInt } from './utils.js';

loadEnv();

const program = new Command();
program.name('doclistdb-updater').description('Daily incremental updater for DocListDB (Rada cards -> embeddings -> Qdrant).');

program
  .option('--dry-run', 'Do not generate embeddings and do not upsert to Qdrant', false)
  .option('--backstop', 'Force 30-day backstop feed (https://data.rada.gov.ua/laws/main/n)', false)
  .option('--selftest', 'If there are no changes, run Qdrant self-test (insert/retrieve/delete)', false)
  .option('--max-docs <n>', 'Process at most N candidate nregs')
  .option('--concurrency <n>', 'Concurrency for fetching cards + Qdrant compares', '1')
  .option('--rada-delay-min-ms <n>', 'Min delay between Rada requests in ms', '5000')
  .option('--rada-delay-max-ms <n>', 'Max delay between Rada requests in ms', '7000')
  .option('--skip-retrieve', 'Skip Qdrant retrieve/compare step (useful for dry-run smoke tests)', false)
  .option('--log-level <level>', 'Log level: debug|info|warn|error', 'info')
  .option('--log-pretty', 'Pretty logs', false);

program.parse(process.argv);
const opts = program.opts();

const cli: CliOptions = {
  dryRun: Boolean(opts.dryRun),
  backstop: Boolean(opts.backstop),
  selftest: Boolean(opts.selftest),
  maxDocs: opts.maxDocs ? parsePositiveInt(opts.maxDocs, 0) || undefined : undefined,
  concurrency: parsePositiveInt(opts.concurrency, 1),
  radaDelayMinMs: parsePositiveInt(opts.radaDelayMinMs, 5000),
  radaDelayMaxMs: parsePositiveInt(opts.radaDelayMaxMs, 7000),
  skipRetrieve: Boolean(opts.skipRetrieve),
  logLevel: (String(opts.logLevel || 'info').toLowerCase() as LogLevel) || 'info',
  logPretty: Boolean(opts.logPretty),
};

try {
  validateCliOptions(cli);
  const env = getEnv();
  validateEnv(env, cli);

  const logger = createLogger({ level: cli.logLevel, pretty: cli.logPretty });
  runSync({ logger, env, cli })
    .then((res) => {
      logger.info({ ok: res.ok, runId: res.runId }, 'sync finished');
      process.exit(0);
    })
    .catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      // Keep CI output concise; detailed errors go to R2 run report.
      console.error(`ERROR: ${msg}`);
      process.exit(1);
    });
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

