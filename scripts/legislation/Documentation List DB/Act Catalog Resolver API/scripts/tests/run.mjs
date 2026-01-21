import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const projectRoot = path.resolve(__dirname, '../..'); // Act Catalog Resolver API/
const wranglerBin = path.resolve(projectRoot, 'node_modules/.bin/wrangler');
const defaultEnvFile = path.resolve(projectRoot, '../../../../.env');

const args = new Map();
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)=(.*)$/);
  if (m) args.set(m[1], m[2]);
}

const baseUrl = args.get('baseUrl') || 'http://127.0.0.1:8787';
const envFile = args.get('envFile') || defaultEnvFile;
const startDev = (args.get('startDev') || 'true') !== 'false';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function nowMs() {
  return Date.now();
}

function fail(msg) {
  throw new Error(msg);
}

function assert(cond, msg) {
  if (!cond) fail(msg);
}

function containsAny(s, parts) {
  const t = String(s || '').toLowerCase();
  return parts.some((p) => t.includes(String(p).toLowerCase()));
}

async function httpJson(method, url, body) {
  const started = nowMs();
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).catch((e) => {
    throw new Error(`fetch failed: ${e?.message || String(e)}`);
  });

  const text = await res.text().catch(() => '');
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  return { status: res.status, ok: res.ok, json, text, took_ms: nowMs() - started };
}

async function waitReady(url, timeoutMs = 30_000) {
  const started = nowMs();
  for (;;) {
    const r = await httpJson('GET', `${url}/health`, null).catch(() => null);
    if (r && r.ok && r.json && r.json.status === 'ok') return;
    if (nowMs() - started > timeoutMs) fail(`Timeout waiting for /health on ${url}`);
    await sleep(250);
  }
}

function logCase(name, r) {
  const top = Array.isArray(r?.json?.results) && r.json.results[0] ? r.json.results[0] : null;
  const topStr = top ? `${top.nreg} | ${String(top.nazva || '').slice(0, 80)}` : '(no results)';
  console.log(`[${name}] HTTP ${r.status} took=${r.took_ms}ms top=${topStr}`);
}

async function run() {
  let child = null;
  try {
    if (startDev) {
      console.log(`Starting wrangler dev (envFile=${envFile})...`);
      child = spawn(
        wranglerBin,
        [
          'dev',
          '--env-file',
          envFile,
          '--ip',
          '127.0.0.1',
          '--port',
          '8787',
          '--var',
          'RERANK_ENABLED:true',
          '--var',
          'CACHE_ENABLED:false',
        ],
        { cwd: projectRoot, stdio: 'inherit' }
      );
      await waitReady(baseUrl, 40_000);
    }

    // 2.1 Healthcheck
    {
      const r = await httpJson('GET', `${baseUrl}/health`, null);
      assert(r.status === 200, 'health should be 200');
      assert(r.json && r.json.status === 'ok', 'health should return {status:"ok"}');
      console.log('[health] ok');
    }

    // 2.8 empty query should be 400
    {
      const r = await httpJson('POST', `${baseUrl}/catalog/resolve`, { query: '', k: 5 });
      assert(r.status === 400, 'empty query should be 400');
      console.log('[empty_query] ok');
    }

    // 2.2 nreg exact
    {
      const r = await httpJson('POST', `${baseUrl}/catalog/resolve`, {
        query: '70-2022-р',
        k: 3,
        candidates: 50,
        mode: 'vector-only',
        debug: true,
      });
      logCase('nreg_exact_vector_only', r);
      assert(r.status === 200, 'nreg exact should be 200');
      assert(r.json?.results?.[0]?.nreg === '70-2022-р', 'results[0].nreg must be 70-2022-р');
      assert(r.json?.strategy?.fast_path === 'nreg_exact', 'fast_path should be nreg_exact');
    }

    {
      const r = await httpJson('POST', `${baseUrl}/catalog/resolve`, {
        query: '70-2022-р',
        k: 1,
        candidates: 20,
        mode: 'auto',
        debug: true,
      });
      logCase('nreg_exact_auto', r);
      assert(r.status === 200, 'nreg exact auto should be 200');
      assert(r.json?.strategy?.fast_path === 'nreg_exact', 'fast_path should be nreg_exact');
    }

    // 2.3 partial nreg / roman
    {
      const r = await httpJson('POST', `${baseUrl}/catalog/resolve`, {
        query: '254к/96-вр',
        k: 1,
        candidates: 20,
        mode: 'auto',
      });
      logCase('constitution_nreg_exact', r);
      assert(r.json?.results?.[0]?.nazva?.toLowerCase?.().includes('конституц'), 'should return Constitution');
    }

    {
      const r = await httpJson('POST', `${baseUrl}/catalog/resolve`, {
        query: '254к/96',
        k: 3,
        candidates: 50,
        mode: 'auto',
      });
      logCase('constitution_partial', r);
      const nregs = (r.json?.results || []).map((x) => x.nreg);
      assert(nregs.includes('254к/96-вр'), 'top-3 should include 254к/96-вр');
    }

    {
      const r = await httpJson('POST', `${baseUrl}/catalog/resolve`, {
        query: '530-IX',
        k: 5,
        candidates: 50,
        mode: 'auto',
        debug: true,
      });
      logCase('roman_suffix', r);
      assert(r.status === 200, '530-IX should be 200');
      assert((r.json?.results || []).length > 0, '530-IX should return results');
      assert(r.json?.results?.[0]?.nreg === '530-20', 'expected canonical nreg 530-20');
    }

    // 2.4 aliases
    for (const q of ['Конституція України', 'Конституція', 'головний закон держави']) {
      const r = await httpJson('POST', `${baseUrl}/catalog/resolve`, { query: q, k: 3, candidates: 50, mode: 'auto' });
      logCase(`alias_${q}`, r);
      const nregs = (r.json?.results || []).map((x) => x.nreg);
      assert(nregs.includes('254к/96-вр'), `alias "${q}" should include 254к/96-вр`);
    }

    // 2.5 thematic (vector vs rerank)
    {
      const q = 'закон про Національну поліцію України';
      const rVec = await httpJson('POST', `${baseUrl}/catalog/resolve`, { query: q, k: 5, candidates: 100, mode: 'vector-only' });
      logCase('police_vector_only', rVec);
      assert((rVec.json?.results || []).length > 0, 'police vector-only should return results');
      assert(
        rVec.json.results.some((x) => containsAny(x.nazva, ['поліці', 'поліцію'])),
        'police query should return at least one result mentioning police'
      );

      const rR = await httpJson('POST', `${baseUrl}/catalog/resolve`, { query: q, k: 5, candidates: 100, mode: 'llm-rerank' });
      logCase('police_llm_rerank', rR);
      assert(rR.status === 200, 'police llm-rerank should be 200');
      assert(rR.json?.strategy?.rerank_used === true, 'rerank_used should be true');
      assert((rR.json?.results || []).some((x) => typeof x.rerank_score === 'number'), 'rerank should add rerank_score');
    }

    // 2.6 complex thematic (llm-rerank)
    {
      const r = await httpJson('POST', `${baseUrl}/catalog/resolve`, {
        query: 'акт яким регулюються інвестиції в нерухомість на рівні котловану',
        k: 5,
        candidates: 100,
        mode: 'llm-rerank',
      });
      logCase('complex_investments', r);
      assert(r.status === 200, 'complex llm-rerank should be 200');
      assert((r.json?.results || []).length > 0, 'complex llm-rerank should return some results');
    }

    // 2.7 filters must-filter verification via debug payload meta
    {
      const r = await httpJson('POST', `${baseUrl}/catalog/resolve`, {
        query: 'державне регулювання цін на газ',
        k: 5,
        candidates: 100,
        filters: { types: ['KABMIN_RESOLUTION'], organs: ['KMU'] },
        mode: 'auto',
        debug: true,
      });
      logCase('filter_kmu_resolution', r);
      assert(r.status === 200, 'filter kmu resolution should be 200');
      const meta = r.json?.debug?.returned_payload_meta || [];
      assert(meta.length > 0, 'debug.returned_payload_meta must be present');
      for (const m of meta) {
        assert(String(m.organ) === '2', 'organ must be KMU (2)');
        assert(String(m.type) === '2', 'type must be Resolution (2)');
      }
    }

    {
      const r = await httpJson('POST', `${baseUrl}/catalog/resolve`, {
        query: 'нагородження державними нагородами України',
        k: 5,
        candidates: 100,
        filters: { types: ['PRESIDENT_DECREE'], organs: ['PRESIDENT'] },
        mode: 'auto',
        debug: true,
      });
      logCase('filter_president_decree', r);
      assert(r.status === 200, 'filter president decree should be 200');
      const meta = r.json?.debug?.returned_payload_meta || [];
      assert(meta.length > 0, 'debug.returned_payload_meta must be present');
      for (const m of meta) {
        assert(String(m.organ) === '4', 'organ must be President (4)');
        assert(String(m.type) === '3', 'type must be Decree (3)');
      }
    }

    {
      const r = await httpJson('POST', `${baseUrl}/catalog/resolve`, {
        query: 'реєстрація актів цивільного стану',
        k: 5,
        candidates: 100,
        filters: { year_from: 2010, year_to: 2015 },
        mode: 'auto',
        debug: true,
      });
      logCase('filter_year_range', r);
      assert(r.status === 200, 'filter year range should be 200');
      const meta = r.json?.debug?.returned_payload_meta || [];
      for (const m of meta) {
        const y = m.year;
        assert(typeof y === 'number', 'year must be present for year-filtered results');
        assert(y >= 2010 && y <= 2015, 'year must be within range');
      }
    }

    // 2.8 nonsense / english
    {
      const r = await httpJson('POST', `${baseUrl}/catalog/resolve`, { query: 'йцуйцуйцуйцу 12341234', k: 5, mode: 'auto' });
      logCase('nonsense', r);
      assert(r.status === 200, 'nonsense should be 200');
      assert(Array.isArray(r.json?.results), 'nonsense should return results array');
    }

    {
      const r = await httpJson('POST', `${baseUrl}/catalog/resolve`, {
        query: 'find a law that regulates cryptocurrencies in Ukraine',
        k: 5,
        mode: 'auto',
      });
      logCase('english', r);
      assert(r.status === 200, 'english should be 200');
      assert(Array.isArray(r.json?.results), 'english should return results array');
    }

    // 3 stress test (mix)
    {
      const cases = [
        { query: '70-2022-р', mode: 'auto' },
        { query: '530-IX', mode: 'auto' },
        { query: 'Конституція', mode: 'auto' },
        { query: 'закон про поліцію', mode: 'auto' },
        { query: 'реєстрація актів цивільного стану', mode: 'auto', filters: { year_from: 2010, year_to: 2015 } },
        { query: 'державне регулювання цін на газ', mode: 'auto', filters: { types: ['KABMIN_RESOLUTION'], organs: ['KMU'] } },
        { query: 'нагородження державними нагородами України', mode: 'auto', filters: { types: ['PRESIDENT_DECREE'], organs: ['PRESIDENT'] } },
        { query: 'акт яким регулюються інвестиції в нерухомість на рівні котловану', mode: 'llm-rerank' },
      ];
      const N = 30;
      const times = [];
      for (let i = 0; i < N; i++) {
        const c = cases[i % cases.length];
        const r = await httpJson('POST', `${baseUrl}/catalog/resolve`, { ...c, k: 3, candidates: 80 });
        assert(r.status === 200, `stress case ${i} should be 200`);
        times.push(r.took_ms);
      }
      times.sort((a, b) => a - b);
      const p50 = times[Math.floor(times.length * 0.5)];
      const p95 = times[Math.floor(times.length * 0.95)];
      console.log(`[stress] ok N=${N} p50=${p50}ms p95=${p95}ms`);
    }

    console.log('\nALL TESTS PASSED');
  } finally {
    if (child) {
      child.kill('SIGINT');
      await sleep(500);
    }
  }
}

run().catch((e) => {
  console.error(`TESTS FAILED: ${e?.message || String(e)}`);
  process.exit(1);
});

