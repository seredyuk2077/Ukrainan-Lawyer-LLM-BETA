import readline from 'node:readline';

const DEFAULT_API_URL = 'https://act-catalog-resolver.andriykosrdkgames.workers.dev';

const args = new Map();
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)=(.*)$/);
  if (m) args.set(m[1], m[2]);
}

function clampInt(v, fallback, min, max) {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number.parseInt(v, 10) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function normalizeBaseUrl(u) {
  return String(u || '').trim().replace(/\/+$/, '');
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function fmtFilters(filtersApplied) {
  const f = filtersApplied && typeof filtersApplied === 'object' ? filtersApplied : {};
  const parts = [];
  if (Array.isArray(f.types) && f.types.length) parts.push(`types=[${f.types.join(', ')}]`);
  if (Array.isArray(f.organs) && f.organs.length) parts.push(`organs=[${f.organs.join(', ')}]`);
  if (typeof f.year_from === 'number') parts.push(`year_from=${f.year_from}`);
  if (typeof f.year_to === 'number') parts.push(`year_to=${f.year_to}`);
  return parts.length ? parts.join(', ') : 'немає';
}

async function postJson(url, body) {
  if (typeof fetch !== 'function') {
    throw new Error('This demo requires Node.js 18+ (global fetch is missing)');
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text().catch(() => '');
  const json = text ? safeJsonParse(text) : null;
  return { status: res.status, ok: res.ok, json, text };
}

function printSteps(query, response, reqParams) {
  const strategy = response?.strategy || {};
  const meta = response?.meta || {};
  const debug = response?.debug || {};
  const planDebug = debug?.plan || {};
  const kind =
    strategy.fast_path === 'nreg_exact'
      ? 'nreg_exact'
      : strategy.fast_path === 'nreg_partial'
        ? 'nreg_partial'
        : 'semantic';
  const detected = typeof planDebug?.detected === 'string' ? String(planDebug.detected) : '';
  const detectedSuffix = detected && detected !== kind ? ` (detected=${detected})` : '';

  console.log(`▶ Запит: "${query}"`);
  console.log(`▶ Крок 1: класифікую запит → ${kind}${detectedSuffix}`);

  console.log(`▶ Крок 2: застосовую фільтри: ${fmtFilters(strategy.filters_applied)}`);

  if (strategy.fast_path === 'nreg_exact') {
    console.log(`▶ Крок 3: embedding не потрібен (fast-path)`);
    const how = debug?.resolved_by ? ` (${debug.resolved_by})` : '';
    console.log(`▶ Крок 4: Qdrant lookup${how}`);
  } else {
    console.log(`▶ Крок 3: генерую embedding запиту (text-embedding-3-small через OpenRouter)`);
    console.log(`▶ Крок 4: векторний пошук в Qdrant (top_k=${meta.candidates_requested ?? reqParams.candidates})`);
  }

  if (strategy.rerank_used === true) {
    console.log(`▶ Крок 5: запускаю LLM rerank через OpenRouter (mode=${reqParams.mode})`);
  } else {
    console.log(`▶ Крок 5: LLM rerank не використано (mode=${reqParams.mode})`);
  }

  const candidatesActual = meta.candidates_actual ?? null;
  if (candidatesActual !== null) {
    console.log(`▶ Крок 6: відбираю top ${meta.returned ?? reqParams.k} з ${candidatesActual} кандидатів`);
  } else {
    console.log(`▶ Крок 6: відбираю top ${meta.returned ?? reqParams.k}`);
  }
}

function printResults(response, limit = 5) {
  const results = Array.isArray(response?.results) ? response.results : [];
  if (!results.length) {
    console.log('\n✅ Результати: (порожньо)\n');
    return;
  }

  console.log('\n✅ Результати:');
  for (let i = 0; i < Math.min(results.length, limit); i++) {
    const r = results[i];
    const nreg = r?.nreg ?? '';
    const nazva = String(r?.nazva ?? '').replace(/\s+/g, ' ').trim();
    const score = typeof r?.score === 'number' ? r.score.toFixed(3) : String(r?.score ?? '');
    console.log(`${i + 1}. [${nreg}] ${nazva} (score: ${score})`);
  }

  console.log('\nТоп знайдених актів (compact):');
  for (let i = 0; i < Math.min(results.length, limit); i++) {
    const r = results[i];
    const nreg = r?.nreg ?? '';
    const dokid = r?.dokid ?? '';
    const nazva = String(r?.nazva ?? '').replace(/\s+/g, ' ').trim();
    const score = typeof r?.score === 'number' ? r.score.toFixed(3) : String(r?.score ?? '');
    console.log(`${i + 1}) nreg: ${nreg} | dokid: ${dokid} | "${nazva}" | score: ${score}`);
  }
  console.log('');
}

async function main() {
  const baseUrl = normalizeBaseUrl(args.get('url') || process.env.CATALOG_RESOLVER_URL || DEFAULT_API_URL);
  const k = clampInt(args.get('k') || process.env.CATALOG_RESOLVER_K, 5, 1, 20);
  const candidates = clampInt(args.get('candidates') || process.env.CATALOG_RESOLVER_CANDIDATES, 100, 10, 200);
  const mode = String(args.get('mode') || process.env.CATALOG_RESOLVER_MODE || 'auto');

  console.log('Act Catalog Resolver DEMO');
  console.log(`API: ${baseUrl}`);
  console.log('Введіть запит (або exit/quit для виходу):\n');

  const isTty = Boolean(process.stdin.isTTY);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: isTty });

  try {
    if (isTty) {
      rl.setPrompt('> ');
      rl.prompt();
    }

    for await (const line of rl) {
      const q = String(line || '').trim();
      if (!q) {
        if (isTty) rl.prompt();
        continue;
      }
      if (q.toLowerCase() === 'exit' || q.toLowerCase() === 'quit') break;

      const req = { query: q, k, candidates, mode, debug: true };
      try {
        const r = await postJson(`${baseUrl}/catalog/resolve`, req);
        if (!r.ok) {
          const errMsg =
            (r.json && typeof r.json === 'object' && r.json.error) || r.text || `HTTP ${r.status}`;
          console.log(`\n⚠️ API error: ${String(errMsg).slice(0, 500)}\n`);
        } else {
          printSteps(q, r.json, req);
          printResults(r.json, k);
        }
      } catch (e) {
        console.log(`\n⚠️ Помилка з’єднання з API: ${e?.message || String(e)}\n`);
      } finally {
        if (isTty) rl.prompt();
      }
    }
  } finally {
    rl.close();
  }
}

main().catch((e) => {
  console.error(`DEMO FAILED: ${e?.message || String(e)}`);
  process.exit(1);
});

