#!/usr/bin/env node
/**
 * Dev Chat Runner — CLI to run U1→U10 via local HTTP (no frontend).
 * Starts server on a free port, POST /v1/runs, polls GET /v1/runs/:id, prints result + MCP instructions.
 * Set LEGAL_AGENT_DISABLE_LLM=true for dry-run (stub answer); omit for real LLM (--real-llm + --i-understand-costs).
 */
import { parseArgs } from 'node:util';

// Use seed-dev-user UUIDs so runs hit the same tenant/conv with memory (see tools/mm/seed-dev-user.ts)
const DEV_TENANT = '00000000-0000-0000-0000-000000000001';
const DEV_USER = '00000000-0000-0000-0000-000000000002';
const DEV_CONV = '00000000-0000-0000-0000-000000000003';
const POLL_INTERVAL_MS = 800;
const POLL_TIMEOUT_MS = 120_000;

interface Parsed {
  message: string;
  tenant: string;
  user: string;
  conversation: string;
  dryRun: boolean;
  realLlm: boolean;
  iUnderstandCosts: boolean;
  projectId?: string;
  promptStackJson?: string;
  promptStackFile?: string;
}

async function parse(): Promise<Parsed> {
  // pnpm passes "--" before script args; strip it so parseArgs sees --message etc.
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
      'project-id': { type: 'string' },
      'prompt-stack-json': { type: 'string' },
      'prompt-stack-file': { type: 'string' },
    },
    allowPositionals: true,
  });

  const message = values.message;
  if (!message || typeof message !== 'string') {
    console.error('Usage: pnpm brain:chat:dev -- --message "<query>" [--tenant ...] [--user ...] [--conversation ...] [--dry-run] [--real-llm] [--i-understand-costs]');
    process.exit(1);
  }

  if (values['real-llm'] && !values['i-understand-costs']) {
    console.error('--real-llm requires --i-understand-costs');
    process.exit(1);
  }

  let promptStack: Record<string, string> | undefined;
  if (values['prompt-stack-json']) {
    try {
      promptStack = JSON.parse(values['prompt-stack-json']) as Record<string, string>;
    } catch {
      console.error('Invalid --prompt-stack-json');
      process.exit(1);
    }
  } else if (values['prompt-stack-file']) {
    try {
      const fs = await import('node:fs/promises');
      const raw = await fs.readFile(values['prompt-stack-file'], 'utf-8');
      promptStack = JSON.parse(raw) as Record<string, string>;
    } catch (e) {
      console.error('Failed to read --prompt-stack-file:', (e as Error).message);
      process.exit(1);
    }
  }

  const realLlm = values['real-llm'] ?? false;
  return {
    message,
    tenant: values.tenant ?? DEV_TENANT,
    user: values.user ?? DEV_USER,
    conversation: values.conversation ?? DEV_CONV,
    dryRun: realLlm ? false : (values['dry-run'] ?? true),
    realLlm,
    iUnderstandCosts: values['i-understand-costs'] ?? false,
    projectId: values['project-id'],
    promptStackJson: promptStack ? JSON.stringify(promptStack) : undefined,
  };
}

async function main() {
  const opts = await parse();

  // Set LLM disable before loading server/config (dynamic import below)
  if (opts.dryRun || !opts.realLlm) {
    process.env.LEGAL_AGENT_DISABLE_LLM = 'true';
  } else {
    process.env.LEGAL_AGENT_DISABLE_LLM = 'false';
  }

  const { start } = await import('../../server.js');
  const { port } = await start(0);
  const base = `http://127.0.0.1:${port}`;

  const devApiKey = process.env.DEV_API_KEY ?? '';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(devApiKey ? { 'X-Dev-API-Key': devApiKey } : {}),
    ...(!devApiKey ? { 'X-Tenant-Id': opts.tenant, 'X-User-Id': opts.user } : {}),
  };

  const body: Record<string, unknown> = {
    query: opts.message,
    tenant_id: opts.tenant,
    user_id: opts.user,
    conversation_id: opts.conversation,
    dry_run: false, // we want a real run; LLM on/off is via env
  };
  const clientContext: Record<string, unknown> = {};
  if (opts.promptStackJson) clientContext.prompt_stack = JSON.parse(opts.promptStackJson);
  if (opts.projectId) clientContext.project_id = opts.projectId;
  if (Object.keys(clientContext).length > 0) body.client_context = clientContext;

  const created = await fetch(`${base}/v1/runs`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!created.ok) {
    const text = await created.text();
    console.error('POST /v1/runs failed:', created.status, text);
    process.exit(1);
  }

  const createdJson = (await created.json()) as { run_id: string; status: string };
  const runId = createdJson.run_id;
  if (!runId) {
    console.error('No run_id in response');
    process.exit(1);
  }

  const startWall = Date.now();
  let run: { run_id: string; status: string; llm_result?: unknown; query?: string; [k: string]: unknown };
  const getHeaders = { ...headers };
  delete (getHeaders as Record<string, string>)['Content-Type'];
  while (Date.now() - startWall < POLL_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const getRes = await fetch(`${base}/v1/runs/${runId}`, { headers: getHeaders });
    if (!getRes.ok) {
      console.error('GET /v1/runs/:id failed:', getRes.status);
      process.exit(1);
    }
    run = (await getRes.json()) as typeof run;
    if (run.status === 'completed' || run.status === 'failed') break;
  }

  const totalMs = Date.now() - startWall;
  if (run!.status !== 'completed' && run!.status !== 'failed') {
    console.error('Poll timeout; last status:', run!.status);
    process.exit(1);
  }

  // ----- output -----
  console.log('\n--- Dev Chat Runner ---');
  console.log('run_id:', run!.run_id);
  console.log('tenant_id:', opts.tenant);
  console.log('conversation_id:', opts.conversation);
  console.log('user_id:', opts.user);
  console.log('mode:', opts.dryRun ? 'dry-run (LLM disabled)' : 'real-llm');
  console.log('status:', run!.status);
  console.log('total_ms:', totalMs);

  const llm = run!.llm_result as { answerText?: string; answer?: string; usage?: unknown; model_id?: string; model?: string; evidence_insufficient?: boolean } | undefined;
  if (llm) {
    if (typeof llm.usage === 'object' && llm.usage !== null) console.log('usage:', JSON.stringify(llm.usage));
    if (llm.model_id ?? llm.model) console.log('model:', llm.model_id ?? llm.model);
    if (typeof llm.evidence_insufficient === 'boolean') console.log('evidence_insufficient:', llm.evidence_insufficient);
  }

  console.log('\n--- Evidence summary (counts only) ---');
  const trace = run!.retrieval_trace as Record<string, unknown> | undefined;
  if (trace && typeof trace === 'object') {
    const lawCount = trace.lawCount ?? trace.hits_count ?? trace.hitsCount;
    const memCount = trace.memoryCount ?? trace.memory_count;
    console.log('lawCount:', lawCount ?? '—');
    console.log('memoryCount:', memCount ?? '—');
  } else {
    console.log('(retrieval_trace not in GET response; check DB for full snapshot)');
  }

  console.log('\n--- Final answer ---');
  const answer = llm?.answerText ?? llm?.answer ?? '(no llm_result.answerText)';
  console.log(typeof answer === 'string' ? answer : JSON.stringify(answer));

  console.log('\n--- MCP / DB proof ---');
  console.log('Verify run in Supabase:');
  console.log(`  SELECT run_id, status, assembled_prompt IS NOT NULL AS has_assembled, llm_result IS NOT NULL AS has_llm_result, completed_at FROM runs WHERE run_id = '${run!.run_id}';`);
  console.log('');

  process.exit(run!.status === 'failed' ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
