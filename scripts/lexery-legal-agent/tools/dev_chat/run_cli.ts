#!/usr/bin/env node
/**
 * Single-shot dev chat: pnpm brain:chat:run -- --message "..." [--dry-run|--real-llm] [--verbose]
 * Uses core.runOnce; prints answer + run summary. Optional fetchRunSummary for DB verification.
 */
// Default auth for local CLI so server accepts tenant_id/user_id without DEV_API_KEY
if (process.env.DEV_ALLOW_ANONYMOUS === undefined) process.env.DEV_ALLOW_ANONYMOUS = 'true';

import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(process.cwd(), 'scripts/lexery-legal-agent/.env') });

import {
  runOnce,
  fetchRunSummary,
  DEV_TENANT,
  DEV_USER,
  DEV_CONV,
  type RunOnceOptions,
  type ChatMode,
} from './core.js';

const ALIASES: Record<string, string> = {
  'tenant-dev': DEV_TENANT,
  'user-dev-andrii': DEV_USER,
  'conv-dev-andrii': DEV_CONV,
};

function resolveId(value: string, defaultVal: string): string {
  return ALIASES[value] ?? value;
}

async function main() {
  if (process.argv[2] === '--') process.argv.splice(2, 1);
  const { values } = parseArgs({
    options: {
      message: { type: 'string', short: 'm' },
      tenant: { type: 'string', default: DEV_TENANT },
      user: { type: 'string', default: DEV_USER },
      conversation: { type: 'string', default: DEV_CONV },
      'dry-run': { type: 'boolean', default: true },
      'real-llm': { type: 'boolean', default: false },
      'i-understand-costs': { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
      'prompt-stack-json': { type: 'string' },
      'prompt-stack-file': { type: 'string' },
      'project-id': { type: 'string' },
    },
    allowPositionals: true,
  });

  const message = values.message;
  if (!message || typeof message !== 'string') {
    console.error('Usage: pnpm brain:chat:run -- --message "<query>" [--dry-run] [--real-llm] [--i-understand-costs] [--verbose]');
    process.exit(1);
  }

  const realLlm = values['real-llm'] ?? false;
  if (realLlm && !values['i-understand-costs']) {
    console.error('--real-llm requires --i-understand-costs');
    process.exit(1);
  }

  let prompt_stack: Record<string, string> | undefined;
  if (values['prompt-stack-json']) {
    try {
      prompt_stack = JSON.parse(values['prompt-stack-json']) as Record<string, string>;
    } catch {
      console.error('Invalid --prompt-stack-json');
      process.exit(1);
    }
  } else if (values['prompt-stack-file']) {
    try {
      const fs = await import('node:fs/promises');
      const raw = await fs.readFile(values['prompt-stack-file'], 'utf-8');
      prompt_stack = JSON.parse(raw) as Record<string, string>;
    } catch (e) {
      console.error('Failed to read --prompt-stack-file:', (e as Error).message);
      process.exit(1);
    }
  }

  const mode: ChatMode = realLlm ? 'real' : 'dry';
  const options: RunOnceOptions = {
    message,
    tenant_id: resolveId(values.tenant ?? DEV_TENANT, DEV_TENANT),
    user_id: resolveId(values.user ?? DEV_USER, DEV_USER),
    conversation_id: resolveId(values.conversation ?? DEV_CONV, DEV_CONV),
    mode,
    prompt_stack,
    project_id: values['project-id'],
  };

  let result;
  try {
    result = await runOnce(options);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  const verbose = values.verbose ?? false;

  console.log('\n--- Lexery ---');
  console.log(result.answerText);

  console.log('\n--- Run summary ---');
  console.log('run_id:', result.run_id);
  console.log('status:', result.status);
  console.log('total_ms:', result.total_ms);
  if (result.lawCount != null) console.log('lawCount:', result.lawCount);
  if (result.memoryCount != null) console.log('memoryCount:', result.memoryCount);
  if (result.triage_used != null) console.log('triage_used:', result.triage_used);
  if (result.triage_selected_count != null) console.log('triage_selected_count:', result.triage_selected_count);
  if (result.evidence_insufficient != null) console.log('evidence_insufficient:', result.evidence_insufficient);
  if (result.usage) console.log('usage:', JSON.stringify(result.usage));
  if (result.model) console.log('model:', result.model);
  if (result.warnings?.length) console.log('warnings:', result.warnings);

  if (verbose) {
    const summary = await fetchRunSummary(result.run_id);
    if (summary) {
      console.log('\n--- DB verification ---');
      console.log('completed_at:', summary.completed_at ?? '—');
      console.log('has_assembled:', summary.has_assembled);
      console.log('has_llm_result:', summary.has_llm_result);
      if (summary.lawCount != null) console.log('db lawCount:', summary.lawCount);
      if (summary.memoryCount != null) console.log('db memoryCount:', summary.memoryCount);
    }
  }

  console.log('\n--- Verify in Supabase ---');
  console.log(`  SELECT run_id, status, assembled_prompt IS NOT NULL AS has_assembled, llm_result IS NOT NULL AS has_llm_result, completed_at FROM runs WHERE run_id = '${result.run_id}';`);
  console.log('');

  process.exit(result.status === 'failed' ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
