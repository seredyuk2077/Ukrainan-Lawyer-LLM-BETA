#!/usr/bin/env tsx
/**
 * Stress test v2: direct import of RAG consumer, 50 concurrent requests.
 * No HTTP overhead, pure RAG latency measurement.
 */
import { performance } from 'node:perf_hooks';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { retrievalConsumer } from '../../retrieval/consumer.js';

const task9Path = join(import.meta.dirname, '../_datasets', 'task9_query.txt');
const task9Text = readFileSync(task9Path, 'utf8');
const queries = task9Text
  .split(/^Задача \d+\./gm)
  .filter((q) => q.trim().length > 50)
  .map((q) => q.trim().slice(0, 500));

const CONCURRENT_REQUESTS = 50;

interface StressResult {
  query_index: number;
  latency_ms: number;
  success: boolean;
  selected_acts_count: number;
  qdrant_calls?: number;
  low_confidence?: boolean;
  error?: string;
}

async function runOne(idx: number, query: string): Promise<StressResult> {
  const start = performance.now();
  try {
    const result = await retrievalConsumer({ query, run_id: `stress_${idx}` });
    const latency = Math.round(performance.now() - start);
    return {
      query_index: idx,
      latency_ms: latency,
      success: true,
      selected_acts_count: result.selected_acts?.length ?? 0,
      qdrant_calls: result.meta?.qdrant_calls_count_total,
      low_confidence: result.low_confidence,
    };
  } catch (err: unknown) {
    return {
      query_index: idx,
      latency_ms: Math.round(performance.now() - start),
      success: false,
      selected_acts_count: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main() {
  console.log(`🔥 Direct RAG Stress Test: ${CONCURRENT_REQUESTS} concurrent`);
  console.log(`Dataset: ${queries.length} queries from task9\n`);

  const selected: string[] = [];
  for (let i = 0; i < CONCURRENT_REQUESTS; i++) {
    selected.push(queries[i % queries.length]);
  }

  const startTime = performance.now();
  const promises = selected.map((q, i) => runOne(i, q));
  const results = await Promise.all(promises);
  const totalTime = Math.round(performance.now() - startTime);

  const ok = results.filter((r) => r.success);
  const fail = results.filter((r) => !r.success);
  const latencies = ok.map((r) => r.latency_ms).sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? 0;
  const p99 = latencies[Math.floor(latencies.length * 0.99)] ?? 0;
  const avg = latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
  const lowConf = ok.filter((r) => r.low_confidence).length;

  console.log(`\n✅ COMPLETED in ${totalTime}ms (wall-clock, concurrent)\n`);
  console.log(`Total: ${CONCURRENT_REQUESTS} | Success: ${ok.length} (${((ok.length / CONCURRENT_REQUESTS) * 100).toFixed(1)}%) | Fail: ${fail.length}`);
  console.log(`Low confidence: ${lowConf} (${((lowConf / ok.length) * 100).toFixed(1)}%)\n`);
  console.log(`Latency (per-request):`);
  console.log(`  p50: ${p50}ms | p95: ${p95}ms | p99: ${p99}ms`);
  console.log(`  avg: ${avg}ms | min: ${latencies[0] ?? 0}ms | max: ${latencies[latencies.length - 1] ?? 0}ms\n`);

  if (fail.length > 0) {
    console.log(`❌ Failed (${fail.length}):`);
    fail.slice(0, 5).forEach((r) => console.log(`  [${r.query_index}] ${r.error}`));
    if (fail.length > 5) console.log(`  ... and ${fail.length - 5} more`);
    console.log();
  }

  const avgQd = ok.filter((r) => r.qdrant_calls).reduce((s, r) => s + (r.qdrant_calls ?? 0), 0) / (ok.filter((r) => r.qdrant_calls).length || 1);
  console.log(`Avg Qdrant calls: ${avgQd.toFixed(1)}`);
  const rps = (CONCURRENT_REQUESTS / (totalTime / 1000)).toFixed(2);
  console.log(`Throughput: ${rps} req/s (concurrent)\n`);

  const successRate = (ok.length / CONCURRENT_REQUESTS) * 100;
  const pass = successRate >= 95 && p95 <= 5000;
  console.log(pass ? `✅ PASS` : `⚠️  NEEDS OPTIMIZATION`);
  if (!pass) {
    if (successRate < 95) console.log(`  - Success rate ${successRate.toFixed(1)}% < 95%`);
    if (p95 > 5000) console.log(`  - p95 latency ${p95}ms > 5000ms target`);
  }

  // Save summary
  const summary = {
    timestamp: new Date().toISOString(),
    concurrent_requests: CONCURRENT_REQUESTS,
    total_time_ms: totalTime,
    success_count: ok.length,
    fail_count: fail.length,
    low_confidence_count: lowConf,
    latency: { p50, p95, p99, avg, min: latencies[0] ?? 0, max: latencies[latencies.length - 1] ?? 0 },
    avg_qdrant_calls: avgQd,
    throughput_rps: parseFloat(rps),
    pass,
  };
  const outPath = join(import.meta.dirname, '../_reports', `stress_test_${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(outPath, JSON.stringify(summary, null, 2), 'utf8');
  console.log(`\nSummary: ${outPath}`);
}

main().catch((err) => {
  console.error('Stress test error:', err);
  process.exit(1);
});
