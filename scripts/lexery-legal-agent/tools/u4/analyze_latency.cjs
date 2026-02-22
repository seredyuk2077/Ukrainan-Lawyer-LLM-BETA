#!/usr/bin/env node
/**
 * Stress test analysis from task9 batch run.
 * Analyzes latency/budget from the most recent task9_runs_dump.
 */
const fs = require('fs');
const path = require('path');

const dumpPath = path.join(__dirname, '_reports', 'task9_runs_dump_2026-02-19.json');
const data = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));
const runs = Array.isArray(data) ? data : data.runs ?? [];

console.log(`📊 RAG Latency Analysis from ${runs.length} runs\n`);

const latencies = runs.map((r, i) => {
  const qp = r.query_profile ?? {};
  const lat = qp.latency_ms ?? r.latency_ms ?? 0;
  const qd = r.meta?.qdrant_calls_count_total ?? 0;
  return {
    task: r.task_index !== undefined ? r.task_index : i + 1,
    latency_ms: lat,
    qdrant_calls: qd,
    low_conf: !!r.low_confidence,
  };
}).filter(x => x.latency_ms > 0);

latencies.sort((a, b) => a.latency_ms - b.latency_ms);
const p50 = latencies[Math.floor(latencies.length * 0.5)]?.latency_ms ?? 0;
const p95 = latencies[Math.floor(latencies.length * 0.95)]?.latency_ms ?? 0;
const p99 = latencies[Math.floor(latencies.length * 0.99)]?.latency_ms ?? 0;
const avg = latencies.reduce((s, x) => s + x.latency_ms, 0) / latencies.length;
const min = latencies[0]?.latency_ms ?? 0;
const max = latencies[latencies.length - 1]?.latency_ms ?? 0;

const avgQdrant = latencies.reduce((s, x) => s + x.qdrant_calls, 0) / latencies.length;
const lowConfCount = latencies.filter(x => x.low_conf).length;

console.log(`Latency distribution (${latencies.length} runs):`);
console.log(`  p50: ${p50}ms | p95: ${p95}ms | p99: ${p99}ms`);
console.log(`  avg: ${Math.round(avg)}ms | min: ${min}ms | max: ${max}ms\n`);

console.log(`Avg Qdrant calls per request: ${avgQdrant.toFixed(1)}`);
console.log(`Low confidence: ${lowConfCount} / ${latencies.length} (${((lowConfCount / latencies.length) * 100).toFixed(1)}%)\n`);

// Individual runs > 5s
const slow = latencies.filter(x => x.latency_ms > 5000);
if (slow.length > 0) {
  console.log(`⚠️  Slow runs (>${slow[0].latency_ms}ms, ${slow.length} total):`);
  slow.slice(0, 5).forEach(x => console.log(`  Task ${x.task}: ${x.latency_ms}ms (${x.qdrant_calls} Qdrant calls)`));
  if (slow.length > 5) console.log(`  ... and ${slow.length - 5} more`);
  console.log();
}

const pass = p95 <= 5000;
console.log(pass ? `✅ LATENCY OK: p95=${p95}ms <= 5000ms` : `⚠️  LATENCY HIGH: p95=${p95}ms > 5000ms target`);

const summary = {
  timestamp: new Date().toISOString(),
  runs_count: latencies.length,
  latency: { p50, p95, p99, avg: Math.round(avg), min, max },
  avg_qdrant_calls: parseFloat(avgQdrant.toFixed(1)),
  low_confidence_count: lowConfCount,
  low_confidence_rate: parseFloat(((lowConfCount / latencies.length) * 100).toFixed(1)),
  pass,
};

const outPath = path.join(__dirname, '_reports', `latency_analysis_${new Date().toISOString().slice(0, 10)}.json`);
fs.writeFileSync(outPath, JSON.stringify(summary, null, 2), 'utf8');
console.log(`\nSummary: ${outPath}`);
