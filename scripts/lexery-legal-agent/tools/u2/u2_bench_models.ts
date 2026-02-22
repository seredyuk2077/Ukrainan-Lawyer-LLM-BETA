#!/usr/bin/env node
/**
 * U2 model benchmark — compare CLF models on test dataset (latency, valid JSON, pass rate).
 * Run: OPENROUTER_API_KEY_ONLINE=... pnpm brain:u2:bench-models
 * Uses same 22 queries as u2_test_queries (short only, no long stress).
 */
import dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(process.cwd(), '.env') });
dotenv.config({ path: resolve(__dirname, '../.env') });

import { config } from '../../lib/config.js';
import { extractEntities } from '../../classify/entity-extractor.js';
import { classifyWithLLM } from '../../classify/llm-classifier.js';

const BENCH_QUERIES: Array<{ query: string; expected?: { domain?: string; intent?: string; entitiesMin?: number; ambiguous?: boolean } }> = [
  { query: 'ККУ ст. 115 умисне вбивство', expected: { domain: 'criminal', entitiesMin: 1 } },
  { query: 'ст.115-1 ККУ', expected: { domain: 'criminal', entitiesMin: 1 } },
  { query: 'стаття 115¹ Кримінального кодексу', expected: { domain: 'criminal', entitiesMin: 1 } },
  { query: 'ч. 2 ст. 115 ККУ', expected: { domain: 'criminal', entitiesMin: 1 } },
  { query: 'п. 1 ч. 2 ст. 115 ККУ', expected: { domain: 'criminal', entitiesMin: 1 } },
  { query: 'КЗпП ст. 40 звільнення', expected: { domain: 'labor', entitiesMin: 1 } },
  { query: 'ЦКУ ст. 1166 відшкодування шкоди', expected: { domain: 'civil', entitiesMin: 1 } },
  { query: 'ПКУ штраф за несвоєчасну сплату', expected: { domain: 'tax', entitiesMin: 1 } },
  { query: 'Звільнення працівника за прогул', expected: { domain: 'labor' } },
  { query: 'як захистити право власності', expected: { domain: 'civil' } },
  { query: 'мобілізація', expected: { ambiguous: true } },
  { query: 'складіть заяву про оскарження', expected: { intent: 'drafting' } },
  { query: 'як оскаржити рішення податкової', expected: { intent: 'procedure', domain: 'tax' } },
  { query: 'МВС та СБУ повноваження', expected: { entitiesMin: 2 } },
];

const MODELS = process.env.U2_BENCH_MODELS
  ? process.env.U2_BENCH_MODELS.split(',').map((s) => s.trim())
  : ['openai/gpt-4o-mini', 'google/gemini-2.0-flash-exp:free', 'anthropic/claude-3-5-haiku-latest'];

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (i - lo) * (sorted[hi] - sorted[lo]);
}

function checkPass(expected: typeof BENCH_QUERIES[0]['expected'], actual: { intent?: string; domain?: string; entities_count?: number; ambiguous?: boolean }): boolean {
  if (!expected) return true;
  if (expected.intent !== undefined && expected.intent !== actual.intent) return false;
  if (expected.domain !== undefined && expected.domain !== actual.domain) return false;
  if (expected.entitiesMin !== undefined && (actual.entities_count ?? 0) < expected.entitiesMin) return false;
  if (expected.ambiguous !== undefined && actual.ambiguous !== expected.ambiguous) return false;
  return true;
}

async function main() {
  const apiKey = config.openRouterApiKey || process.env.OPENROUTER_API_KEY_ONLINE || process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error('Set OPENROUTER_API_KEY_ONLINE or OPENROUTER_API_KEY');
    process.exit(1);
  }

  console.log('U2 model benchmark —', BENCH_QUERIES.length, 'queries');
  console.log('Models:', MODELS.join(', '));
  console.log('Timeout:', config.clfTimeoutSec, 's\n');

  const timeoutSec = Math.min(config.clfTimeoutSec, 8);

  const table: { model: string; median_ms: number; p95_ms: number; pass: number; valid: number; degraded: number }[] = [];

  for (const modelId of MODELS) {
    const latencies: number[] = [];
    let valid = 0;
    let pass = 0;
    let degraded = 0;

    for (const { query, expected } of BENCH_QUERIES) {
      const { entities: preEntities } = extractEntities(query);
      const start = Date.now();
      try {
        const result = await classifyWithLLM(
          { apiKey, modelId, timeoutSec: timeoutSec as number, fallbackModelId: undefined },
          { query, pre_entities: preEntities }
        );
        const ms = Date.now() - start;
        latencies.push(ms);
        valid++;
        const ok = checkPass(expected, {
          intent: result.intent,
          domain: result.domain,
          entities_count: result.entities.length,
          ambiguous: result.ambiguity.is_ambiguous,
        });
        if (ok) pass++;
      } catch {
        degraded++;
      }
    }

    const sorted = latencies.slice().sort((a, b) => a - b);
    table.push({
      model: modelId,
      median_ms: Math.round(percentile(sorted, 50)),
      p95_ms: Math.round(percentile(sorted, 95)),
      pass,
      valid,
      degraded,
    });
  }

  console.log('| model | median_ms | p95_ms | pass | valid | degraded |');
  console.log('|-------|-----------|--------|------|-------|----------|');
  for (const r of table) {
    console.log(`| ${r.model} | ${r.median_ms} | ${r.p95_ms} | ${r.pass}/${BENCH_QUERIES.length} | ${r.valid} | ${r.degraded} |`);
  }

  const best = table.filter((r) => r.degraded === 0).sort((a, b) => a.median_ms - b.median_ms)[0];
  const bestPass = table.filter((r) => r.degraded === 0).sort((a, b) => b.pass - a.pass)[0];
  console.log('\nRecommendation: default CLF_MODEL_ID');
  if (bestPass && best) {
    const pick = bestPass.pass >= best.pass ? bestPass : best;
    console.log(`  → ${pick.model} (median ${pick.median_ms} ms, pass ${pick.pass}/${BENCH_QUERIES.length})`);
  } else {
    console.log('  → openai/gpt-4o-mini (fallback)');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
