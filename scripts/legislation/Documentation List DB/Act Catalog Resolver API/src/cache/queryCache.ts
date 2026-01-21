import type { Logger } from '../util/logger';
import type { ResolveResponse } from '../types';
import { R2S3Client } from './r2S3Client';

export class QueryCache {
  constructor(
    private readonly logger: Logger,
    private readonly r2: R2S3Client
  ) {}

  async get(key: string): Promise<ResolveResponse | null> {
    return await this.r2.getJson<ResolveResponse>(`by_query/${key}.json`);
  }

  async put(key: string, value: ResolveResponse): Promise<void> {
    await this.r2.putJson(`by_query/${key}.json`, value);
  }
}

export async function makeCacheKey(params: {
  normalizedQuery: string;
  filters: unknown;
  mode: string;
  rerankEnabled: boolean;
  k: number;
  candidates: number;
}): Promise<string> {
  const stable = stableStringify({
    normalized_query: params.normalizedQuery,
    filters: params.filters ?? null,
    mode: params.mode,
    rerank_enabled: params.rerankEnabled,
    k: params.k,
    candidates: params.candidates,
  });
  const hash = await sha256Hex(stable);
  return hash.slice(0, 40);
}

function stableStringify(v: any): string {
  const seen = new Set<any>();
  const norm = (x: any): any => {
    if (x === null || x === undefined) return x;
    if (typeof x !== 'object') return x;
    if (seen.has(x)) return '[circular]';
    seen.add(x);
    if (Array.isArray(x)) return x.map(norm);
    const out: any = {};
    for (const k of Object.keys(x).sort()) out[k] = norm(x[k]);
    return out;
  };
  return JSON.stringify(norm(v));
}

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

