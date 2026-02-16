#!/usr/bin/env node
/**
 * Dev utility: one HTTP request to local brain gateway. Returns run_id, status, latency.
 * Prints MCP hint for manual_run_inspect. Server must be running (BRAIN_PORT) or set BRAIN_BASE_URL.
 * Usage: pnpm exec tsx scripts/lexery-legal-agent/tools/manual_query_run.ts "Ваш запит"
 *        BRAIN_BASE_URL=http://127.0.0.1:3081 pnpm exec tsx ... "Запит"
 */
import { resolve } from 'path';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(process.cwd(), 'scripts/lexery-legal-agent/.env') });

const DEV_KEY = process.env.DEV_API_KEY ?? 'dev-key-change-me';
const BASE_URL = process.env.BRAIN_BASE_URL ?? `http://127.0.0.1:${process.env.BRAIN_PORT ?? '3081'}`;
const QUERY = process.argv[2] ?? 'ККУ ст. 115 умисне вбивство';
const POLL_MS = 400;
const POLL_TIMEOUT_MS = 90_000;

async function main(): Promise<void> {
  const start = Date.now();
  let runId: string;
  try {
    const postRes = await fetch(`${BASE_URL}/v1/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Dev-API-Key': DEV_KEY },
      body: JSON.stringify({
        query: QUERY,
        tenant_id: '00000000-0000-0000-0000-000000000001',
        user_id: '00000000-0000-0000-0000-000000000002',
      }),
    });
    if (postRes.status !== 202) {
      console.error('POST failed', postRes.status, await postRes.text());
      process.exit(1);
    }
    const postJson = (await postRes.json()) as { run_id?: string };
    runId = postJson.run_id ?? '';
    if (!runId) {
      console.error('No run_id in response');
      process.exit(1);
    }
  } catch (e) {
    console.error('Request failed', e);
    process.exit(1);
  }

  const pollStart = Date.now();
  let status = 'pending';
  while (Date.now() - pollStart < POLL_TIMEOUT_MS) {
    try {
      const getRes = await fetch(`${BASE_URL}/v1/runs/${runId}`, {
        headers: { 'X-Dev-API-Key': DEV_KEY },
      });
      if (getRes.status !== 200) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        continue;
      }
      const run = (await getRes.json()) as {
        status?: string;
        retrieval_trace?: { meta?: { hits_count?: number; low_confidence?: boolean } };
      };
      status = run.status ?? 'unknown';
      const rt = run.retrieval_trace;
      if (rt != null && typeof rt === 'object' && (rt.meta?.hits_count != null || rt.meta?.low_confidence === true)) {
        const latencyMs = Date.now() - start;
        console.log(JSON.stringify({ run_id: runId, status, latency_ms: latencyMs }));
        console.error(`\n# Inspect run (Supabase): run_id=${runId}`);
        console.error(`# Local: pnpm exec tsx scripts/lexery-legal-agent/tools/manual_run_inspect.ts ${runId}`);
        process.exit(0);
      }
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  const latencyMs = Date.now() - start;
  console.log(JSON.stringify({ run_id: runId, status: 'timeout', latency_ms: latencyMs }));
  console.error(`\n# Timeout waiting for retrieval_trace. Inspect anyway: manual_run_inspect.ts ${runId}`);
  process.exit(0);
}

main();
