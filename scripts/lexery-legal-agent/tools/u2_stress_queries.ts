#!/usr/bin/env node
/**
 * U2 stress test — long, absurd, mixed-language inputs. Expect: valid QueryProfile always, no timeout.
 * Run: pnpm brain:u2:stress (loads .env for DEV_API_KEY; server on 3081).
 */
import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(__dirname, '../.env') });

const BASE = process.env.BRAIN_URL || 'http://localhost:3081';
const DEV_KEY = process.env.DEV_API_KEY || 'dev-key-change-me';

const POLL_INTERVAL_MS = 200;
const POLL_MAX_INTERVAL_MS = 800;
const POLL_TIMEOUT_MS = 25000;
/** Run this many stress queries in parallel */
const CONCURRENCY = 5;

function repeat(s: string, n: number): string {
  let out = '';
  for (let i = 0; i < n; i++) out += s;
  return out;
}

// Contract-like: ~50k chars (triggers R2 overflow when QUERY_R2_THRESHOLD_BYTES=32k; schema max 50k)
const CONTRACT_LIKE =
  'Договір купівлі-продажу. Сторона 1 (Продавець). Сторона 2 (Покупець). Пункт 1. Предмет договору. Умови договору. ' +
  repeat(
    'Стаття 2. Розділ II. Підпункт 2.1. Ціна та порядок розрахунків. Стаття 3. Заключні положення. ',
    400
  );

// Table-like: CSV / markdown table
const TABLE_LIKE = `name,article,law,note
ККУ,115,Кримінальний кодекс,вбивство
ЦКУ,207,Цивільний кодекс,договір
КЗпП,36,Кодекс законів про працю,звільнення
| Норма | Акт    | Стаття |
|-------|--------|--------|
| ККУ   | Кримінальний | 115   |
| ЦКУ   | Цивільний   | 207   |`;

// Legal text excerpt: ~40k chars
const LEGAL_EXCERPT =
  'Стаття 1. Поняття та засади. ' +
  repeat(
    'Пункт 1. Закон України застосовується до правовідносин. Частина 2. Абзац перший. Стаття 2. Норма права. ',
    450
  );

// Legal essay ~10k chars (jurist-style)
const LEGAL_ESSAY_10K =
  'Юридичне есе: тлумачення норм права. ' +
  repeat(
    'У контексті статті 1 ККУ та статті 10 ЦКУ виникає питання про застосування закону. Пункт 1 частини 2 передбачає. Абзац перший. Розділ II. ',
    120
  ).slice(0, 10000);

// Long query with multiple article refs
const LONG_MULTI_REF =
  'п. 1 ч. 2 ст. 115 ККУ та ст. 10 ЗУ "Про Національну поліцію" та ЦКУ ст. 207 відшкодування. ' +
  repeat('Додатковий контекст для перевірки обробки довгого запиту з кількома посиланнями на норми. ', 80);

const STRESS_QUERIES: string[] = [
  repeat('Текст запиту для перевірки обробки. ', 500),
  repeat('a'.repeat(80) + '\n', 200).slice(0, 14000),
  '🔴🟢🟡 ст. 115-1 ККУ що таке?',
  'Random x7k!@# ывап 123 zzz',
  'Мобілізація и призыв и mobilization mixed',
  'Стаття 1. Поняття. ' + repeat('Дуже довгий фрагмент закону. ', 300),
  'пункт 1 статті 10 ЗУ "Про Нацполіцію" ' + repeat('контекст. ', 200),
  '!!! ??? ### ___ ' + 'абзац українською. ',
  repeat('noise', 500),
  'ККУ ст. 115 ' + repeat('додатковий текст. ', 100),
  'ЗУ про мобілізацію ст 22 ' + repeat('пояснення. ', 80),
  'як оскаржити рішення податкової ' + repeat('деталі. ', 50),
  repeat('эмодзи не нужны ', 100) + 'ст. 10¹',
  'Short',
  'А' + repeat('б', 2000) + ' в',
  CONTRACT_LIKE,
  TABLE_LIKE,
  LEGAL_EXCERPT,
  LEGAL_ESSAY_10K,
  LONG_MULTI_REF,
];

async function pollUntilQueryProfile(runId: string): Promise<{ hasProfile: boolean; latencyMs: number }> {
  const start = Date.now();
  let interval = POLL_INTERVAL_MS;
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const getRes = await fetch(`${BASE}/v1/runs/${runId}`, {
      headers: { 'X-Dev-API-Key': DEV_KEY },
    });
    if (getRes.status !== 200) {
      await new Promise((r) => setTimeout(r, interval));
      interval = Math.min(interval + 100, POLL_MAX_INTERVAL_MS);
      continue;
    }
    const run = (await getRes.json()) as { query_profile?: { intent?: string; meta?: { classifier_mode?: string } } };
    const qp = run.query_profile;
    if (qp && (qp.intent !== undefined || qp.meta?.classifier_mode !== undefined)) {
      return { hasProfile: true, latencyMs: Date.now() - start };
    }
    await new Promise((r) => setTimeout(r, interval));
    interval = Math.min(interval + 100, POLL_MAX_INTERVAL_MS);
  }
  return { hasProfile: false, latencyMs: Date.now() - start };
}

async function main() {
  const tenantId =
    process.env.U2_STRESS_TENANT_ID ||
    `00000000-0000-0000-0000-${(Date.now() + 1).toString(16).padStart(12, '0').slice(-12)}`;
  const userId = process.env.U2_STRESS_USER_ID || tenantId;

  console.log('U2 stress queries —', BASE);
  console.log('tenant_id:', tenantId, '| Queries:', STRESS_QUERIES.length, 'concurrency:', CONCURRENCY, '\n');
  const results: { queryPreview: string; status: string; latencyMs?: number }[] = [];

  const runOne = async (idx: number): Promise<{ queryPreview: string; status: string; latencyMs?: number }> => {
    const query = STRESS_QUERIES[idx];
    const preview = query.length > 50 ? query.slice(0, 47) + '...' : query;
    try {
      const res = await fetch(`${BASE}/v1/runs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Dev-API-Key': DEV_KEY,
        },
        body: JSON.stringify({ query, tenant_id: tenantId, user_id: userId }),
      });
      if (res.status !== 202) {
        const is429 = res.status === 429;
        return { queryPreview: preview, status: is429 ? 'FAIL POST 429' : `FAIL POST ${res.status}` };
      }
      const json = (await res.json()) as { run_id?: string };
      const runId = json.run_id;
      if (!runId) {
        return { queryPreview: preview, status: 'FAIL no run_id' };
      }
      const { hasProfile, latencyMs } = await pollUntilQueryProfile(runId);
      return {
        queryPreview: preview,
        status: hasProfile ? '✅' : '❌ timeout',
        latencyMs,
      };
    } catch (e) {
      return { queryPreview: preview, status: `❌ ${(e as Error).message}` };
    }
  };

  for (let i = 0; i < STRESS_QUERIES.length; i += CONCURRENCY) {
    const chunk = STRESS_QUERIES.slice(i, i + CONCURRENCY).map((_, j) => runOne(i + j));
    const chunkResults = await Promise.all(chunk);
    results.push(...chunkResults);
  }

  console.log('| # | query (preview) | status | latency_ms |');
  console.log('|---|-----------------|--------|------------|');
  results.forEach((r, i) => {
    console.log(`| ${i + 1} | ${r.queryPreview.slice(0, 40)} | ${r.status} | ${r.latencyMs ?? '-'} |`);
  });

  const passed = results.filter((r) => r.status === '✅').length;
  const failed = results.filter((r) => r.status !== '✅');
  const count429 = results.filter((r) => r.status === 'FAIL POST 429').length;
  console.log('\n--- Stress summary ---');
  console.log('Passed:', passed, '/', STRESS_QUERIES.length);
  if (count429 > 0) {
    console.log('429 count:', count429, '— raise MAX_CONCURRENT_RUNS / RUNS_PER_MINUTE on server.');
    process.exit(1);
  }
  if (failed.length > 0) {
    console.log('Failed:', failed.length);
    process.exit(1);
  }
  console.log('All stress queries returned valid profile.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
