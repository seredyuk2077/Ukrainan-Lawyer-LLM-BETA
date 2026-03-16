#!/usr/bin/env node
/**
 * Forensics: print u10_prompt_debug + assembled_prompt.meta.budget for a run (DEV RUN v18).
 * Usage: pnpm brain:forensics:u10-debug -- --run-id <uuid>
 */
import { parseArgs } from 'node:util';
import { RunRepository } from '../../gateway/storage.js';

async function main() {
  if (process.argv[2] === '--') process.argv.splice(2, 1);
  const { values } = parseArgs({
    options: { 'run-id': { type: 'string' } },
    allowPositionals: true,
  });
  const runId = values['run-id'];
  if (!runId) {
    console.error('Usage: pnpm brain:forensics:u10-debug -- --run-id <uuid>');
    process.exit(1);
  }

  const repo = new RunRepository();
  const run = await repo.findByRunId(runId);
  if (!run) {
    console.error('Run not found:', runId);
    process.exit(1);
  }

  const snapshot = run.snapshot as Record<string, unknown> | undefined;
  const u10Debug = snapshot?.u10_prompt_debug as Record<string, unknown> | undefined;
  const ap = run.assembled_prompt as Record<string, unknown> | undefined;
  const meta = ap?.meta as Record<string, unknown> | undefined;
  const budget = meta?.budget as Record<string, unknown> | undefined;

  console.log('--- U10 prompt debug ---');
  console.log('run_id:', run.run_id);
  console.log('status:', run.status);
  console.log('');
  if (u10Debug) {
    console.log('snapshot.u10_prompt_debug:');
    console.log(JSON.stringify(u10Debug, null, 2));
  } else {
    console.log('snapshot.u10_prompt_debug: (not set)');
  }
  console.log('');
  console.log('assembled_prompt.meta.budget:');
  if (budget) {
    console.log(JSON.stringify(budget, null, 2));
  } else {
    console.log('(not set)');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
