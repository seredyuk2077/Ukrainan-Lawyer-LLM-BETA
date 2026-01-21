import { getConfig, type Env } from './config';
import { createLogger } from './util/logger';
import { QdrantClient } from './clients/qdrant';
import { EmbeddingClient } from './clients/embedding';
import { OpenRouterClient } from './clients/openrouter';
import { resolveCatalog } from './search/pipeline';
import type { ResolveRequest } from './types';
import { R2S3Client } from './cache/r2S3Client';
import { QueryCache } from './cache/queryCache';

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body, null, 2), {
    ...init,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...(init?.headers || {}),
    },
  });
}

function withCors(res: Response): Response {
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  h.set('Access-Control-Max-Age', '86400');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return withCors(new Response(null, { status: 204 }));
    }

    const requestId = request.headers.get('cf-ray') || crypto.randomUUID();
    const debug = url.searchParams.get('debug') === '1';
    const logger = createLogger({ debug, requestId });

    if (request.method === 'GET' && (path === '/' || path === '/health')) {
      return withCors(
        jsonResponse({
          status: 'ok',
          ok: true,
          service: 'act-catalog-resolver-api',
          ts: new Date().toISOString(),
        })
      );
    }

    if (request.method === 'POST' && path === '/catalog/resolve') {
      try {
        const cfg = getConfig(env);
        const json = (await request.json().catch(() => null)) as ResolveRequest | null;
        if (!json || typeof json !== 'object') {
          return withCors(jsonResponse({ error: 'Invalid JSON body' }, { status: 400 }));
        }
        if (typeof (json as any).query !== 'string' || !(json as any).query.trim()) {
          return withCors(jsonResponse({ error: 'query is required' }, { status: 400 }));
        }

        const cache =
          cfg.cache.enabled && cfg.cache.r2
            ? new QueryCache(
                logger,
                new R2S3Client(logger, {
                  endpoint: cfg.cache.r2.endpoint,
                  region: cfg.cache.r2.region,
                  accessKeyId: cfg.cache.r2.accessKeyId,
                  secretAccessKey: cfg.cache.r2.secretAccessKey,
                  bucket: cfg.cache.r2.bucket,
                  prefix: cfg.cache.r2.prefix,
                  timeoutMs: 15_000,
                })
              )
            : undefined;

        const deps = {
          cfg,
          logger,
          qdrant: new QdrantClient(logger, cfg.qdrant),
          embedder: new EmbeddingClient(logger, cfg.embedding),
          openrouter:
            cfg.rerank.enabled && cfg.rerank.apiKey
              ? new OpenRouterClient(logger, {
                  apiKey: cfg.rerank.apiKey,
                  baseUrl: cfg.rerank.baseUrl,
                  timeoutMs: cfg.rerank.timeoutMs,
                })
              : undefined,
          cache,
          waitUntil: (p: Promise<unknown>) => ctx.waitUntil(p),
        };

        const out = await resolveCatalog(
          { ...json, debug: Boolean(json.debug) || debug },
          deps
        );
        return withCors(jsonResponse(out, { status: 200 }));
      } catch (e: any) {
        const msg = e instanceof Error ? e.message : String(e);
        const status = isClientErrorMessage(msg) ? 400 : 500;
        if (status >= 500) logger.error({ err: msg }, 'request failed');
        else logger.warn({ err: msg }, 'request rejected');
        return withCors(jsonResponse({ error: msg }, { status }));
      }
    }

    return withCors(jsonResponse({ error: 'Not found' }, { status: 404 }));
  },
};

function isClientErrorMessage(msg: string): boolean {
  const m = String(msg || '').toLowerCase();
  if (!m) return false;
  if (m.includes('query is required')) return true;
  if (m.includes('invalid json')) return true;
  if (m.includes('mode=llm-rerank')) return true;
  if (m.includes('rerank is disabled')) return true;
  if (m.includes('missing') && (m.includes('qdrant') || m.includes('embedding') || m.includes('openrouter'))) return true;
  return false;
}

