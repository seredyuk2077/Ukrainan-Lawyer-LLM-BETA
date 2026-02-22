#!/usr/bin/env tsx
/**
 * Stress test: 50 concurrent RAG requests using run_one_query.ts logic.
 * Measures RAG pipeline latency/budget under concurrent load.
 */
import { performance } from 'node:perf_hooks';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
const task9Path = join(import.meta.dirname, '../_datasets', 'task9_query.txt');
const task9Text = readFileSync(task9Path, 'utf8');
const queries = task9Text
  .split(/^Задача \d+\./gm)
  .filter((q) => q.trim().length > 50)
  .map((q, i) => ({ id: i + 1, text: q.trim().slice(0, 500) }));

const CONCURRENT_REQUESTS = 50;

interface StressResult {
  task_id: number;
  latency_ms: number;
  success: boolean;
  error?: string;
}

async function runOneTask(taskId: number): Promise<StressResult> {
  const start = performance.now();
  try {
    const cmd = `pnpm exec tsx scripts/lexery-legal-agent/tools/run_one_query.ts --task ${taskId} 2>&1 | grep -E "low_confidence|selected_acts|latency_ms" | head -3`;
    await execAsync(cmd, { cwd: join(import.meta.dirname, '../../..'), timeout: 120000 });
    const latency = Math.round(performance.now() - start);
    return { task_id: taskId, latency_ms: latency, success: true };
  } catch (err: unknown) {
    return {
      task_id: taskId,
      latency_ms: Math.round(performance.now() - start),
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main() {
  console.log(`🔥 RAG Stress Test: ${CONCURRENT_REQUESTS} concurrent via run_one_query.ts`);
  console.log(`Dataset: ${queries.length} tasks from task9\n`);

  const taskIds: number[] = [];
  for (let i = 0; i < CONCURRENT_REQUESTS; i++) {
    taskIds.push((i % queries.length) + 1);
  }

  const startTime = performance.now();
  const promises = taskIds.map((id) => runOneTask(id));
  const results = await Promise.all(promises);
  const totalTime = Math.round(performance.now() - startTime);

  const ok = results.filter((r) => r.success);
  const fail = results.filter((r) => !r.success);
  const latencies = ok.map((r) => r.latency_ms).sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? 0;
  const p99 = latencies[Math.floor(latencies.length * 0.99)] ?? 0;
  const avg = latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;

  console.log(`\n✅ COMPLETED in ${totalTime}ms (wall-clock, concurrent)\n`);
  console.log(`Total: ${CONCURRENT_REQUESTS} | Success: ${ok.length} (${((ok.length / CONCURRENT_REQUESTS) * 100).toFixed(1)}%) | Fail: ${fail.length}\n`);
  console.log(`Latency (per-request, includes process spawn overhead):`);
  console.log(`  p50: ${p50}ms | p95: ${p95}ms | p99: ${p99}ms`);
  console.log(`  avg: ${avg}ms | min: ${latencies[0] ?? 0}ms | max: ${latencies[latencies.length - 1] ?? 0}ms\n`);

  if (fail.length > 0) {
    console.log(`❌ Failed (${fail.length}):`);
    fail.slice(0, 5).forEach((r) => console.log(`  Task ${r.task_id}: ${r.error}`));
    if (fail.length > 5) console.log(`  ... and ${fail.length - 5} more`);
    console.log();
  }

  const rps = (CONCURRENT_REQUESTS / (totalTime / 1000)).toFixed(2);
  console.log(`Throughput: ${rps} req/s (concurrent)\n`);

  const successRate = (ok.length / CONCURRENT_REQUESTS) * 100;
  const pass = successRate >= 95 && p95 <= 5000;
  console.log(pass ? `✅ PASS: ${successRate.toFixed(1)}% success, p95=${p95}ms` : `⚠️  NEEDS OPTIMIZATION`);
  if (!pass) {
    if (successRate < 95) console.log(`  - Success rate ${successRate.toFixed(1)}% < 95%`);
    if (p95 > 5000) console.log(`  - p95 latency ${p95}ms > 5000ms target`);
  }

  const summary = {
    timestamp: new Date().toISOString(),
    concurrent_requests: CONCURRENT_REQUESTS,
    total_time_ms: totalTime,
    success_count: ok.length,
    fail_count: fail.length,
    latency: { p50, p95, p99, avg, min: latencies[0] ?? 0, max: latencies[latencies.length - 1] ?? 0 },
    throughput_rps: parseFloat(rps),
    pass,
  };
  const outPath = join(import.meta.dirname, '../_reports', `stress_test_${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(outPath, JSON.stringify(summary, null, 2), 'utf8');
  console.log(`\nSummary saved: ${outPath}`);
}

main().catch((err) => {
  console.error('Stress test error:', err);
  process.exit(1);
});
