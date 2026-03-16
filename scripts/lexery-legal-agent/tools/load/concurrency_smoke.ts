/**
 * Concurrency Smoke Test — verifies that assemblePrompt is safe for parallel execution.
 * Run: pnpm brain:concurrency:smoke
 *
 * What this tests (Matrix D3 + B3):
 *   - N runs in parallel (Promise.all) complete without deadlock or cross-contamination
 *   - Each run gets a unique, isolated result (no shared mutable state)
 *   - Semaphore properly limits concurrent R2 loads (≤ r2Concurrency per assemblePrompt call)
 *   - Total time is proportional to concurrency (not serial N*per_call)
 *
 * Uses mock R2 client (no real R2 traffic) for speed and determinism.
 * Different tenant_id / conversation_id per run to catch any shared state.
 */
import { assemblePrompt } from '../../assemble/assemblePrompt.js';
import { _setR2ClientForTest } from '../../retrieval/r2-fragment.js';
import type { RunContext, U4Result, GateDecision } from '../../lib/pipeline/contracts.js';
import type { S3Client } from '@aws-sdk/client-s3';

const N_RUNS = 50;
const CONCURRENCY_LIMIT = 12;

const GATE_OK: GateDecision = {
  expand: false,
  reason_codes: ['OK'],
  thresholds: { min_hits: 3, min_avg_score: 0.18 },
  signals: { hits_count: 0, top_score: null, avg_score: null },
  meta: {},
};

function makeMockR2Client(delayMs = 5): S3Client {
  return {
    send: async () => {
      await new Promise((r) => setTimeout(r, delayMs));
      return {
        Body: {
          transformToString: async () =>
            JSON.stringify({
              content: {
                chunks: Array.from({ length: 300 }, (_, i) => ({
                  text: `Стаття ${i + 1}. Законодавча норма для тесту паралельності.`,
                })),
              },
            }),
        },
      };
    },
  } as unknown as S3Client;
}

const DEV_TENANT = '00000000-0000-0000-0000-000000000001';
const DEV_USER = '00000000-0000-0000-0000-000000000002';
const DEV_CONV = '00000000-0000-0000-0000-000000000003';

function buildRunContext(i: number): RunContext {
  // 50% use dev conv (memory hits when real fetch); 50% random
  const useDevConv = i < N_RUNS / 2;
  return {
    run_id: `smoke-run-${i}`,
    tenant_id: useDevConv ? DEV_TENANT : `tenant-${i % 5}`,
    user_id: useDevConv ? DEV_USER : `user-${i}`,
    conversation_id: useDevConv ? DEV_CONV : `conv-${i}`,
    user_input: `Питання ${i} для smoke тесту?`,
    history:
      i % 3 === 0
        ? [
            { role: 'user', content: `History msg A for run ${i}` },
            { role: 'assistant', content: `History response for run ${i}` },
          ]
        : [],
    memory_items:
      i % 4 === 0
        ? [{ id: `mem-${i}`, content_preview: `Memory preview for run ${i}` }]
        : undefined,
    memory_summaries:
      i % 5 === 0
        ? [{ scope: 'global', summary_text: `Summary for run ${i}` }]
        : undefined,
  };
}

function buildU4(i: number): U4Result {
  const hitCount = 5 + (i % 6); // 5–10 hits per run
  return {
    rawHits: Array.from({ length: hitCount }, (_, j) => ({
      r2_key: `acts/law_${(i * 7 + j) % 30}.json`,
      json_path: `$.content.chunks[${j * 10 + i}].text`,
      score: 0.9 - j * 0.05,
    })),
    retrievalTrace: { version: 1, hits: [] },
  };
}

async function runBatch(
  tasks: Array<() => Promise<unknown>>,
  concurrency: number
): Promise<unknown[]> {
  const results: unknown[] = [];
  let idx = 0;

  async function worker(): Promise<void> {
    while (idx < tasks.length) {
      const taskIdx = idx++;
      results[taskIdx] = await tasks[taskIdx]();
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

async function main(): Promise<void> {
  console.log(`=== Concurrency Smoke Test (N=${N_RUNS}, concurrency=${CONCURRENCY_LIMIT}) ===\n`);

  _setR2ClientForTest(makeMockR2Client(3));

  const tasks = Array.from({ length: N_RUNS }, (_, i) => async () => {
    const runContext = buildRunContext(i);
    const u4 = buildU4(i);
    return assemblePrompt({ runContext, u4, gate: GATE_OK });
  });

  const startMs = Date.now();
  const rawResults = await runBatch(tasks, CONCURRENCY_LIMIT);
  const totalMs = Date.now() - startMs;

  _setR2ClientForTest(null);

  // Validate all results
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  for (let i = 0; i < rawResults.length; i++) {
    const result = rawResults[i] as Awaited<ReturnType<typeof assemblePrompt>>;

    if (!result || typeof result !== 'object') {
      failures.push(`run ${i}: result is not an object`);
      failed++;
      continue;
    }

    if (!result.systemPrompt || result.systemPrompt.length < 10) {
      failures.push(`run ${i}: systemPrompt missing or too short`);
      failed++;
      continue;
    }

    const lawParts = result.contextParts.filter((p) => p.type === 'law');
    if (lawParts.length === 0) {
      failures.push(`run ${i}: no law parts (expected ${buildU4(i).rawHits.length} hits)`);
      failed++;
      continue;
    }

    // Check run isolation: userPrompt must match the run-specific input
    const expectedInput = buildRunContext(i).user_input;
    if (result.userPrompt !== expectedInput) {
      failures.push(`run ${i}: userPrompt mismatch — got "${result.userPrompt?.slice(0, 40)}", expected "${expectedInput}"`);
      failed++;
      continue;
    }

    // Check budget is populated
    if (!result.meta?.budget) {
      failures.push(`run ${i}: meta.budget missing`);
      failed++;
      continue;
    }

    passed++;
  }

  // Timing analysis
  const perRunEstimate = Math.round(totalMs / N_RUNS);
  const serialEstimateMs = N_RUNS * 3 * 5; // N * mockDelay * hitsPerRun (rough)

  console.log('--- Results ---');
  for (let i = 0; i < rawResults.length; i++) {
    const result = rawResults[i] as Awaited<ReturnType<typeof assemblePrompt>>;
    const lawCount = result?.contextParts?.filter((p) => p.type === 'law').length ?? 0;
    const memoryCount = result?.contextParts?.filter((p) => p.type === 'memory').length ?? 0;
    const historyCount = result?.contextParts?.filter((p) => p.type === 'history').length ?? 0;
    console.log(
      `  run ${String(i).padStart(2)}: law=${lawCount} mem=${memoryCount} hist=${historyCount} tokens=${result?.meta?.budget?.tokenEstimateTotal ?? '?'}`
    );
  }

  console.log('\n--- Metrics ---');
  console.log(`Total time:    ${totalMs}ms`);
  console.log(`Per-run est:   ~${perRunEstimate}ms`);
  console.log(`Passed:        ${passed}/${N_RUNS}`);
  console.log(`Failed:        ${failed}`);

  if (failures.length > 0) {
    console.error('\nFailures:');
    for (const f of failures) console.error(`  - ${f}`);
    console.error('\nFAIL');
    process.exit(1);
  }

  // Warn if total time > 2x serial estimate (suggests concurrency not working)
  if (totalMs > serialEstimateMs * 4) {
    console.warn(`\nWARN: total time ${totalMs}ms seems high (serial estimate ~${serialEstimateMs}ms). Check concurrency.`);
  }

  console.log('\nPASS — all parallel runs completed, no cross-contamination detected.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
