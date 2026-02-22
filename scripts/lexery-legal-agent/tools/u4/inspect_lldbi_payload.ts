#!/usr/bin/env node
/**
 * Phase 0.1: Inspect Qdrant chunks payload — verify data allows finding articles.
 * (A) Scroll chunks with required payload fields (rada_nreg, article_number, r2_key, json_path).
 * (B) For КУПАП (rada_nreg 80731-10): check that chunks with article_number 130 exist.
 * (C) Output 5 sample payloads (no secrets) + counts.
 * Usage: pnpm exec tsx scripts/lexery-legal-agent/tools/inspect_lldbi_payload.ts [rada_nreg] [article_number]
 * Default: rada_nreg=80731-10 (КУПАП part 1), article_number=130.
 */
import { resolve } from 'path';
import { config as loadEnv } from 'dotenv';
import { getQdrantCollections, qdrantScroll } from '../../retrieval/qdrant-client.js';

loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(process.cwd(), '.env.local') });
loadEnv({ path: resolve(process.cwd(), 'scripts/lexery-legal-agent/.env') });

const RADA_NREG_DEFAULT = '80731-10'; // КУПАП (статті 1–212-24)
const ARTICLE_DEFAULT = '130';

function hasRequiredPayload(p: Record<string, unknown>): boolean {
  return (
    typeof p?.rada_nreg === 'string' &&
    p.rada_nreg.length > 0 &&
    p?.article_number != null &&
    typeof p?.r2_key === 'string' &&
    (p as { json_path?: string }).json_path != null
  );
}

function articleMatches(articleNumber: string | number | null, target: string): boolean {
  if (articleNumber == null) return false;
  const s = String(articleNumber).trim();
  if (s === target) return true;
  if (s.startsWith(target + '-') || s.startsWith(target + ' ')) return true;
  return false;
}

function safePayload(p: Record<string, unknown>): Record<string, unknown> {
  return {
    rada_nreg: p.rada_nreg,
    article_number: p.article_number,
    r2_key: typeof p.r2_key === 'string' ? p.r2_key.slice(0, 80) + (p.r2_key.length > 80 ? '...' : '') : p.r2_key,
    json_path: (p as { json_path?: string }).json_path,
    title: typeof p.title === 'string' ? p.title.slice(0, 100) + (p.title.length > 100 ? '...' : '') : undefined,
  };
}

async function main(): Promise<void> {
  const radaNreg = process.argv[2] ?? RADA_NREG_DEFAULT;
  const articleTarget = process.argv[3] ?? ARTICLE_DEFAULT;

  const { chunks } = getQdrantCollections();
  let totalScrolled = 0;
  let withRequired = 0;
  let articleMatchCount = 0;
  const articleMatchSamples: Array<Record<string, unknown>> = [];
  let offset: string | number | null = null;
  const maxPages = 20;
  const pageSize = 500;

  for (let page = 0; page < maxPages; page++) {
    const res = await qdrantScroll(chunks, {
      limit: pageSize,
      filter: { must: [{ key: 'rada_nreg', match: { value: radaNreg } }] },
      with_payload: true,
      with_vector: false,
      offset: offset ?? undefined,
    });
    const points = res.points;
    totalScrolled += points.length;
    for (const pt of points) {
      const p = pt.payload;
      if (hasRequiredPayload(p)) {
        withRequired++;
        if (articleMatches(p.article_number, articleTarget)) {
          articleMatchCount++;
          if (articleMatchSamples.length < 5) articleMatchSamples.push(safePayload(p));
        }
      }
    }
    offset = res.next_page_offset;
    if (points.length < pageSize || offset == null) break;
  }

  console.log('--- Qdrant chunks inspection (read-only) ---');
  console.log('Collection:', chunks);
  console.log('Filter rada_nreg:', radaNreg);
  console.log('Article target:', articleTarget);
  console.log('Total points scrolled:', totalScrolled);
  console.log('Points with rada_nreg+article_number+r2_key+json_path:', withRequired);
  console.log('Points with article_number matching "' + articleTarget + '":', articleMatchCount);
  console.log('\n--- 5 sample payloads (article match, no secrets) ---');
  articleMatchSamples.forEach((s, i) => console.log(JSON.stringify(s, null, 2)));
  if (articleMatchSamples.length === 0 && totalScrolled > 0) {
    console.log('(No samples: no chunks with article_number matching "' + articleTarget + '" in scrolled set.)');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
