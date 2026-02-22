#!/usr/bin/env tsx
/**
 * Stress test: 50 concurrent RAG requests, measure latency/budget/errors.
 * Usage: pnpm exec tsx scripts/lexery-legal-agent/tools/stress_test_prod.ts
 */
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Read task9_query.txt and split into individual queries
const task9Path = join(import.meta.dirname, '../_datasets', 'task9_query.txt');
const task9Text = readFileSync(task9Path, 'utf8');
const queries = task9Text
  .split(/^Задача \d+\./gm)
  .filter((q) => q.trim().length > 50)
  .map((q) => q.trim().slice(0, 500));

const CONCURRENT_REQUESTS = 50;
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3033/retrieval';
const TOTAL_RUNS = CONCURRENT_REQUESTS;

interface StressTestResult {
  query_index: number;
  query_preview: string;
  latency_ms: number;
  success: boolean;
  selected_acts_count: number;
  qdrant_calls?: number;
  low_confidence?: boolean;
  error?: string;
}

async function runOneRequest(queryIndex: number, query: string): Promise<StressTestResult> {
  const start = performance.now();
  try {
    const response = await fetch(GATEWAY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, task_id: `stress_${queryIndex}` }),
    });
    const latency_ms = Math.round(performance.now() - start);
    if (!response.ok) {
      return {
        query_index: queryIndex,
        query_preview: query.slice(0, 60),
        latency_ms,
        success: false,
        selected_acts_count: 0,
        error: `HTTP ${response.status}`,
      };
    }
    const data = await response.json();
    return {
      query_index: queryIndex,
      query_preview: query.slice(0, 60),
      latency_ms,
      success: true,
      selected_acts_count: data.selected_acts?.length ?? 0,
      qdrant_calls: data.meta?.qdrant_calls_count_total,
      low_confidence: data.low_confidence,
    };
  } catch (err: unknown) {
    const latency_ms = Math.round(performance.now() - start);
    return {
      query_index: queryIndex,
      query_preview: query.slice(0, 60),
      latency_ms,
      success: false,
      selected_acts_count: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main() {
  console.log(`🔥 Stress Test: ${CONCURRENT_REQUESTS} concurrent requests`);
  console.log(`Gateway: ${GATEWAY_URL}`);
  console.log(`Dataset: ${queries.length} queries from task9\n`);

  const selectedQueries: string[] = [];
  for (let i = 0; i < TOTAL_RUNS; i++) {
    selectedQueries.push(queries[i % queries.length]);
  }

  const startTime = performance.now();
  const promises = selectedQueries.map((q, i) => runOneRequest(i, q));
  const results = await Promise.all(promises);
  const totalTime = Math.round(performance.now() - startTime);

  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);
  const latencies = successful.map((r) => r.latency_ms).sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? 0;
  const p99 = latencies[Math.floor(latencies.length * 0.99)] ?? 0;
  const avgLatency = latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
  const lowConfCount = successful.filter((r) => r.low_confidence).length;

  console.log(`\n✅ STRESS TEST COMPLETED in ${totalTime}ms\n`);
  console.log(`Total requests: ${CONCURRENT_REQUESTS}`);
  console.log(`Successful: ${successful.length} (${((successful.length / CONCURRENT_REQUESTS) * 100).toFixed(1)}%)`);
  console.log(`Failed: ${failed.length}`);
  console.log(`Low confidence: ${lowConfCount} (${((lowConfCount / successful.length) * 100).toFixed(1)}%)\n`);

  console.log(`Latency (successful only):`);
  console.log(`  p50: ${p50}ms`);
  console.log(`  p95: ${p95}ms`);
  console.log(`  p99: ${p99}ms`);
  console.log(`  avg: ${avgLatency}ms`);
  console.log(`  min: ${latencies[0] ?? 0}ms`);
  console.log(`  max: ${latencies[latencies.length - 1] ?? 0}ms\n`);

  if (failed.length > 0) {
    console.log(`❌ Failed requests (${failed.length}):`);
    failed.forEach((r) => {
      console.log(`  [${r.query_index}] ${r.error ?? 'unknown'} | ${r.query_preview}`);
    });
    console.log();
  }

  const avgQdrant = successful.filter((r) => r.qdrant_calls).reduce((s, r) => s + (r.qdrant_calls ?? 0), 0) / (successful.filter((r) => r.qdrant_calls).length || 1);
  console.log(`Avg Qdrant calls per request: ${avgQdrant.toFixed(1)}`);

  // Throughput: requests per second (concurrent, so total_time is wall-clock)
  const rps = (CONCURRENT_REQUESTS / (totalTime / 1000)).toFixed(2);
  console.log(`Throughput: ${rps} req/s (concurrent)\n`);

  // Pass/fail criteria
  const successRate = (successful.length / CONCURRENT_REQUESTS) * 100;
  if (successRate < 95) {
    console.log(`⚠️  STRESS TEST WARNING: success rate ${successRate.toFixed(1)}% < 95%`);
  }
  if (p95 > 5000) {
    console.log(`⚠️  STRESS TEST WARNING: p95 latency ${p95}ms > 5000ms`);
  }
  if (successRate >= 95 && p95 <= 5000) {
    console.log(`✅ STRESS TEST PASS: success rate ${successRate.toFixed(1)}% >= 95%, p95 ${p95}ms <= 5000ms`);
  }
}

main().catch((err) => {
  console.error('Stress test error:', err);
  process.exit(1);
});
