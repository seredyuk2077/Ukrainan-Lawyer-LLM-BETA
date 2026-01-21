import type { AppConfig } from '../config';
import { QdrantClient } from '../clients/qdrant';
import { EmbeddingClient } from '../clients/embedding';
import { OpenRouterClient } from '../clients/openrouter';
import type { Logger } from '../util/logger';
import type { DocCardPayload, ResolveRequest, ResolveResponse, ResolveResultItem, ResolveStrategy } from '../types';
import { interpretQuery } from './interpret';
import { buildQdrantFilterFromFilters, humanizeOrganCode, humanizeTypeCode } from './filters';
import { QueryCache, makeCacheKey } from '../cache/queryCache';

export interface PipelineDeps {
  cfg: AppConfig;
  logger: Logger;
  qdrant: QdrantClient;
  embedder: EmbeddingClient;
  openrouter?: OpenRouterClient;
  cache?: QueryCache;
  waitUntil?: (p: Promise<unknown>) => void;
}

export async function resolveCatalog(req: ResolveRequest, deps: PipelineDeps): Promise<ResolveResponse> {
  const startedAt = Date.now();

  const query = String(req.query || '').trim();
  if (!query) {
    throw new Error('query is required');
  }

  const k = clampInt(req.k, 5, 1, 20);
  const candidatesRequested = clampInt(req.candidates, 100, 10, 200);
  const mode = req.mode || 'auto';

  const plan = interpretQuery(query);

  // Filters:
  // - Explicit request filters are "hard" (must).
  // - Interpret metadata hints are "soft" by default; we only hard-apply a safe subset.
  const explicitFilters = req.filters && Object.keys(req.filters).length ? req.filters : undefined;
  const hintFilters = plan.metadata_hints;
  const hardHintFilters = explicitFilters ? undefined : hardenHints(hintFilters);
  const qdrantFilters = explicitFilters || hardHintFilters;

  const { qdrantFilter, applied, debug: filterDebug } = buildQdrantFilterFromFilters(qdrantFilters);

  // Optional cache (off by default). We cache only non-debug responses.
  let cacheKey: string | null = null;
  if (deps.cache && !req.debug) {
    cacheKey = await makeCacheKey({
      normalizedQuery: plan.normalized_query,
      filters: qdrantFilters ?? null,
      mode,
      rerankEnabled: deps.cfg.rerank.enabled,
      k,
      candidates: candidatesRequested,
    });
    const cached = await deps.cache.get(cacheKey).catch(() => null);
    if (cached) {
      cached.meta.took_ms = Date.now() - startedAt;
      if (req.debug) {
        cached.debug = { ...(cached.debug || {}), cache_hit: true, cache_key: cacheKey };
      }
      return cached;
    }
  }

  // Fast path: nreg exact
  if (plan.kind === 'nreg_exact' && plan.nreg_candidates?.length) {
    const found = await tryResolveByNregExact(plan.nreg_candidates, deps, qdrantFilter);
    if (found) {
      const out: ResolveResponse = {
        query,
        normalized_query: plan.normalized_query,
        strategy: {
          fast_path: 'nreg_exact',
          rerank_used: false,
          filters_applied: applied,
        },
        results: [
          {
            nreg: found.nreg,
            dokid: found.dokid,
            nazva: found.nazva,
            score: 1,
            source_score: 1,
          },
        ],
        meta: {
          candidates_requested: candidatesRequested,
          candidates_actual: 1,
          returned: 1,
          took_ms: Date.now() - startedAt,
        },
        ...(req.debug
          ? {
              debug: {
                plan: plan.debug,
                filter: filterDebug,
                resolved_by: 'qdrant_scroll(nreg==value)',
                returned_payload_meta: [
                  {
                    nreg: found.nreg,
                    dokid: found.dokid,
                    type: found.type,
                    organ: found.organ,
                    year: found.year,
                    datred: found.datred,
                    status: found.status,
                    minjust: found.minjust,
                  },
                ],
              },
            }
          : {}),
      };
      return out;
    }
  }

  // Vector path (also fallback for failed nreg exact)
  const embeddingText = buildEmbeddingQueryText({
    query: plan.normalized_query,
    filters: mergeForEmbedding(explicitFilters, hintFilters),
  });
  const vector = await deps.embedder.embedQuery(embeddingText);

  const hits = await deps.qdrant.search({
    vector,
    limit: candidatesRequested,
    filter: qdrantFilter || undefined,
  });

  const candidates = hits
    .map((h) => ({
      score: h.score,
      payload: h.payload,
    }))
    .filter((x) => x.payload && x.payload.nreg && Number.isFinite(x.payload.dokid));

  const candidatesActual = candidates.length;

  const vectorRanked: Array<{ payload: DocCardPayload; source_score: number }> = candidates.map((c) => ({
    payload: c.payload as DocCardPayload,
    source_score: c.score || 0,
  }));

  const canRerank =
    mode !== 'vector-only' &&
    deps.cfg.rerank.enabled &&
    Boolean(deps.openrouter) &&
    vectorRanked.length > 0 &&
    shouldRerankAuto(plan, mode, vectorRanked);

  let results: ResolveResultItem[] = [];
  let rerankUsed = false;

  if (mode === 'llm-rerank') {
    if (!deps.cfg.rerank.enabled || !deps.openrouter) {
      throw new Error('mode=llm-rerank requested but rerank is disabled by config');
    }
  }

  if (canRerank || mode === 'llm-rerank') {
    rerankUsed = true;
    results = await rerankAndSelect({
      query,
      normalizedQuery: plan.normalized_query,
      candidates: vectorRanked.slice(0, Math.min(vectorRanked.length, candidatesRequested)),
      k,
      deps,
      filters: mergeForEmbedding(explicitFilters, hintFilters),
    }).catch((e) => {
      deps.logger.warn({ err: e instanceof Error ? e.message : String(e) }, 'rerank failed; falling back to vector rank');
      rerankUsed = false;
      return vectorRanked.slice(0, k).map((c) => ({
        nreg: c.payload.nreg,
        dokid: c.payload.dokid,
        nazva: c.payload.nazva,
        score: c.source_score,
        source_score: c.source_score,
      }));
    });
  } else {
    results = vectorRanked.slice(0, k).map((c) => ({
      nreg: c.payload.nreg,
      dokid: c.payload.dokid,
      nazva: c.payload.nazva,
      score: c.source_score,
      source_score: c.source_score,
    }));
  }

  const strategy: ResolveStrategy = {
    fast_path: plan.kind === 'nreg_partial' ? 'nreg_partial' : 'vector',
    rerank_used: rerankUsed,
    filters_applied: applied,
  };

  const response: ResolveResponse = {
    query,
    normalized_query: plan.normalized_query,
    strategy,
    results,
    meta: {
      candidates_requested: candidatesRequested,
      candidates_actual: candidatesActual,
      returned: results.length,
      took_ms: Date.now() - startedAt,
    },
    ...(req.debug
      ? {
          debug: {
            plan: plan.debug,
            filter: filterDebug,
            embedding_text: embeddingText,
            top_source_score: vectorRanked[0]?.source_score ?? null,
            returned_payload_meta: buildReturnedPayloadMeta(results, vectorRanked),
          },
        }
      : {}),
  };

  if (deps.cache && cacheKey && !req.debug) {
    const p = deps.cache.put(cacheKey, response).catch(() => undefined);
    if (deps.waitUntil) deps.waitUntil(p);
    else await p;
  }

  return response;
}

function buildReturnedPayloadMeta(
  results: ResolveResultItem[],
  candidates: Array<{ payload: DocCardPayload; source_score: number }>
): Array<Record<string, unknown>> {
  const byDokid = new Map<number, DocCardPayload>();
  for (const c of candidates) byDokid.set(c.payload.dokid, c.payload);
  const out: Array<Record<string, unknown>> = [];
  for (const r of results) {
    const p = byDokid.get(r.dokid);
    if (!p) continue;
    out.push({
      nreg: p.nreg,
      dokid: p.dokid,
      type: p.type,
      organ: p.organ,
      year: p.year,
      datred: p.datred,
      status: p.status,
      minjust: p.minjust,
    });
  }
  return out;
}

function hardenHints(hints: any | undefined): any | undefined {
  if (!hints) return undefined;
  const out: any = {};
  if (typeof hints.year_from === 'number') out.year_from = hints.year_from;
  if (typeof hints.year_to === 'number') out.year_to = hints.year_to;
  if (Array.isArray(hints.organs) && hints.organs.length) out.organs = hints.organs;

  // Types are often ambiguous as a pure string match; only hard-apply "combined" categories.
  const allowed = new Set([
    'VRU_LAW',
    'VRU_RESOLUTION',
    'KABMIN_RESOLUTION',
    'KABMIN_ORDER',
    'PRESIDENT_DECREE',
    'PRESIDENT_ORDER',
  ]);
  if (Array.isArray(hints.types)) {
    const keep = hints.types.filter((t: any) => allowed.has(String(t)));
    if (keep.length) out.types = keep;
  }

  return Object.keys(out).length ? out : undefined;
}

function mergeForEmbedding(explicit: any | undefined, hints: any | undefined): any | undefined {
  if (!explicit && !hints) return undefined;
  // Prefer explicit filters, but keep hints as additional text context for embeddings/rerank.
  return { ...(hints || {}), ...(explicit || {}) };
}

async function tryResolveByNregExact(
  candidates: string[],
  deps: PipelineDeps,
  extraFilter: any | null
): Promise<DocCardPayload | null> {
  // Try a small number of candidate strings (fast Qdrant scroll by payload index `nreg`).
  const uniq = Array.from(new Set(candidates)).slice(0, 8);
  for (const nreg of uniq) {
    const must: any[] = [{ key: 'nreg', match: { value: nreg } }];
    if (extraFilter?.must?.length) must.push(...extraFilter.must);
    const hits = await deps.qdrant.scroll({ limit: 1, filter: { must } });
    const payload = hits[0]?.payload || null;
    if (payload && payload.nreg === nreg) {
      deps.logger.info({ nreg, dokid: payload.dokid }, 'nreg exact hit');
      return payload;
    }
  }
  return null;
}

function shouldRerankAuto(
  plan: { kind: string; normalized_query: string },
  mode: string,
  ranked: Array<{ payload: DocCardPayload; source_score: number }>
): boolean {
  if (mode !== 'auto') return true; // explicit llm-rerank handled elsewhere
  if (plan.kind !== 'semantic') return false;
  const q = plan.normalized_query;
  // Heuristics (conservative: rerank is expensive and adds subrequests/latency).
  // We rerank only when:
  // - the query is very long/complex, OR
  // - vector confidence is low, OR
  // - the top results are very close (ambiguous).
  const top = ranked[0]?.source_score ?? 0;
  const fifth = ranked[4]?.source_score ?? 0;
  const gap = top - fifth;

  if (q.length >= 80) return true;
  if (top < 0.35) return true;
  if (q.length >= 28 && top < 0.55) return true;
  if (ranked.length >= 5 && gap < 0.015 && top < 0.7) return true;
  return false;
}

function buildEmbeddingQueryText(params: { query: string; filters?: any }): string {
  // Keep it cheap and robust. We append hints in the same shape the importer used:
  // "<query>. Тип: <code>. Орган: <code>. Рік: <year>."
  const q = String(params.query || '').trim();
  const f = params.filters || {};
  const extra: string[] = [];
  if (Array.isArray(f?.types) && f.types.length) {
    extra.push(`Тип: ${String(f.types.join(','))}.`);
  }
  if (Array.isArray(f?.organs) && f.organs.length) {
    extra.push(`Орган: ${String(f.organs.join(','))}.`);
  }
  if (typeof f?.year_from === 'number' || typeof f?.year_to === 'number') {
    extra.push(`Рік: ${String(f.year_from ?? '')}${f.year_to ? '-' + String(f.year_to) : ''}.`);
  }
  if (extra.length === 0) return q;
  return `${q} ${extra.join(' ')}`.trim();
}

async function rerankAndSelect(params: {
  query: string;
  normalizedQuery: string;
  candidates: Array<{ payload: DocCardPayload; source_score: number }>;
  k: number;
  deps: PipelineDeps;
  filters?: any;
}): Promise<ResolveResultItem[]> {
  const openrouter = params.deps.openrouter;
  if (!openrouter) throw new Error('openrouter client missing');

  const compact = params.candidates.slice(0, 80).map((c) => {
    const p = c.payload;
    return {
      dokid: p.dokid,
      nreg: p.nreg,
      nazva: p.nazva,
      organ: humanizeOrganCode(p.organ),
      type: humanizeTypeCode(p.type),
      year: p.year,
      datred: p.datred,
      status: p.status,
      source_score: round3(c.source_score),
    };
  });

  const system = [
    'Ти — модуль rerank для каталогу актів України.',
    'У тебе є лише список кандидатів (картки актів).',
    'ВАЖЛИВО: не вигадуй актів. Обирай ТІЛЬКИ з наданих кандидатів.',
    'Поверни СТРОГИЙ JSON без будь-якого додаткового тексту.',
  ].join('\n');

  const user = JSON.stringify(
    {
      task: 'rerank_candidates',
      query: params.query,
      normalized_query: params.normalizedQuery,
      filters: params.filters || null,
      candidates: compact,
      output: {
        ranked: [{ dokid: 0, rerank_score: 0.0, why: 'string (short)' }],
      },
      rules: [
        'ranked[] MUST be a subset of candidates by dokid',
        'rerank_score must be a number between 0 and 1',
        'keep why short (<= 200 chars)',
      ],
    },
    null,
    0
  );

  const content = await openrouter.chatCompletions({
    model: params.deps.cfg.rerank.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.1,
    max_tokens: 700,
  });

  const parsed = safeJsonParse(extractJsonObject(content));
  const ranked = Array.isArray(parsed?.ranked) ? parsed.ranked : [];
  const byDokid = new Map<number, { payload: DocCardPayload; source_score: number }>();
  for (const c of params.candidates) byDokid.set(c.payload.dokid, c);

  const out: ResolveResultItem[] = [];
  for (const item of ranked) {
    const dokid = typeof item?.dokid === 'number' ? item.dokid : Number.parseInt(String(item?.dokid || ''), 10);
    const cand = Number.isFinite(dokid) ? byDokid.get(dokid) : undefined;
    if (!cand) continue;
    const rs = typeof item?.rerank_score === 'number' ? item.rerank_score : Number.parseFloat(String(item?.rerank_score || ''));
    const rerankScore = Number.isFinite(rs) ? clamp01(rs) : undefined;
    const why = typeof item?.why === 'string' ? item.why.slice(0, 240) : undefined;
    out.push({
      nreg: cand.payload.nreg,
      dokid: cand.payload.dokid,
      nazva: cand.payload.nazva,
      source_score: cand.source_score,
      rerank_score: rerankScore,
      score: combineScores(cand.source_score, rerankScore),
      ...(why ? { why } : {}),
    });
    if (out.length >= params.k) break;
  }

  // If JSON parsed but returned empty/invalid, fallback to vector rank.
  if (out.length === 0) {
    return params.candidates.slice(0, params.k).map((c) => ({
      nreg: c.payload.nreg,
      dokid: c.payload.dokid,
      nazva: c.payload.nazva,
      score: c.source_score,
      source_score: c.source_score,
    }));
  }

  return out;
}

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number.parseInt(v, 10) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function combineScores(source: number, rerank?: number): number {
  if (typeof rerank !== 'number' || !Number.isFinite(rerank)) return source;
  return round3(0.35 * source + 0.65 * rerank);
}

function extractJsonObject(text: string): string {
  const s = String(text || '').trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) return s.slice(a, b + 1);
  return s;
}

function safeJsonParse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

