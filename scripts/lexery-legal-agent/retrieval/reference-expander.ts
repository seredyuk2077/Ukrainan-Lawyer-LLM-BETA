/**
 * U4 Reference expansion — evidence-driven: extract refs from top chunks, resolve via taxonomy, add hits.
 * Budgeted: max +2 referenced acts, +10 added hits, +4 qdrant calls. No word→act dictionary; taxonomy only.
 */
import type { RawHit, RawHitSource } from './types.js';
import { classifyActKind } from './selected-acts.js';

export const REFERENCE_EXPANSION_SOURCE = 'REFERENCE_EXPANSION' as const;

export interface ReferenceContext {
  from_rada_nreg: string;
  from_json_path: string;
  ref_text: string;
  ref_type: 'article_self' | 'article_other' | 'quoted_title' | 'alias' | 'self_ref';
  resolved_to_rada_nreg: string;
}

export interface ReferenceExpansionMeta {
  enabled: boolean;
  attempted: boolean;
  added_count: number;
  referenced_acts: string[];
  parse_hits_used: number;
  skipped_reason_codes: string[];
}

export interface ExpandReferencesInput {
  /** Top M hits after final sort, before cap (8–12). */
  finalHitsBeforeCap: RawHit[];
  /** Fetch chunk text from R2. */
  fetchChunkText: (r2Key: string, jsonPath: string) => Promise<string | null>;
  /** Resolve title fragment to rada_nreg[] (taxonomy only). */
  resolveActByTitleFragment: (fragment: string) => Promise<string[]>;
  /** Resolve alias to rada_nreg[] (taxonomy only). */
  resolveActByAlias: (alias: string) => Promise<string[]>;
  /** Retrieve chunks for act (filtered); caller enforces qdrant budget. */
  retrieveChunksForAct: (params: {
    rada_nreg: string;
    articleRef?: string;
    queryVariant?: string;
    limit: number;
  }) => Promise<RawHit[]>;
  /** Get act title for act_kind filter. */
  getActMeta: (rada_nreg: string) => Promise<{ title?: string; category?: string | null } | null>;
  config: {
    maxParseHits?: number;
    maxReferencedActs?: number;
    maxAddedHits?: number;
  };
  /** When true, may skip expansion or only self-refs (set skipped_reason_codes). */
  lowConfidence?: boolean;
  /** Existing hit keys for dedupe: `${r2_key}:${json_path}`. */
  existingKeys?: Set<string>;
}

const DEFAULT_CONFIG = {
  maxParseHits: 10,
  maxReferencedActs: 2,
  maxAddedHits: 10,
};

// Article refs: ст. 123, ст. 123-4, стаття 5, ч. 2 ст. 10
const RE_ARTICLE =
  /ст\.?\s*(\d+)(?:-\d+)?|статт(?:я|і)\s*(\d+)|ч\.\s*(\d+)\s*ст\.?\s*(\d+)/gi;
// Quoted title: Закон України «...», Конвенція «...»
const RE_QUOTED_TITLE = /(?:Закон\s+України|Конвенці(?:я|ї)|договір)\s*[«""]([^»""]{5,80})[»""]/gi;
// Self ref: цього Кодексу, цього Закону
const RE_SELF_REF = /цього\s+(?:Кодексу|Закону|Закону\s+України)/i;

function extractArticleRefs(text: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  RE_ARTICLE.lastIndex = 0;
  while ((m = RE_ARTICLE.exec(text)) !== null) {
    const num = m[1] ?? m[2] ?? m[4];
    if (num) out.push(`ст. ${num}`);
  }
  return [...new Set(out)];
}

function extractQuotedTitles(text: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  RE_QUOTED_TITLE.lastIndex = 0;
  while ((m = RE_QUOTED_TITLE.exec(text)) !== null) {
    const frag = (m[1] ?? '').trim();
    if (frag.length >= 5) out.push(frag);
  }
  return [...new Set(out)];
}

function hasSelfRef(text: string): boolean {
  return RE_SELF_REF.test(text);
}

/** Precheck: prefer PRIMARY_LAW hits for ref extraction; skip noisy/caselaw. */
function hitsForRefParse(hits: RawHit[], getActMeta: ExpandReferencesInput['getActMeta'], maxM: number): Promise<RawHit[]> {
  return (async () => {
    const withKind: Array<{ hit: RawHit; isPrimary: boolean }> = [];
    for (const h of hits.slice(0, maxM * 2)) {
      const meta = h.rada_nreg ? await getActMeta(h.rada_nreg) : null;
      const title = h.title ?? meta?.title ?? '';
      const kind = classifyActKind(title, meta?.document_type, meta?.category);
      withKind.push({ hit: h, isPrimary: kind === 'PRIMARY_LAW' });
    }
    withKind.sort((a, b) => (a.isPrimary === b.isPrimary ? 0 : a.isPrimary ? -1 : 1));
    return withKind.slice(0, maxM).map((x) => x.hit);
  })();
}

export async function expandReferences(input: ExpandReferencesInput): Promise<{
  addedHits: RawHit[];
  meta: ReferenceExpansionMeta;
}> {
  const config = { ...DEFAULT_CONFIG, ...input.config };
  const maxParseHits = config.maxParseHits ?? 10;
  const maxReferencedActs = config.maxReferencedActs ?? 2;
  const maxAddedHits = config.maxAddedHits ?? 10;
  const existingKeys = input.existingKeys ?? new Set<string>();

  const meta: ReferenceExpansionMeta = {
    enabled: true,
    attempted: false,
    added_count: 0,
    referenced_acts: [],
    parse_hits_used: 0,
    skipped_reason_codes: [],
  };

  if (input.finalHitsBeforeCap.length === 0) {
    meta.skipped_reason_codes.push('NO_HITS');
    return { addedHits: [], meta };
  }

  if (input.lowConfidence) {
    meta.attempted = true;
    meta.skipped_reason_codes.push('LOW_CONFIDENCE_SKIP');
    return { addedHits: [], meta };
  }

  const hitsToParse = await hitsForRefParse(
    input.finalHitsBeforeCap,
    input.getActMeta,
    maxParseHits
  );
  meta.parse_hits_used = hitsToParse.length;
  if (hitsToParse.length === 0) {
    meta.attempted = true;
    return { addedHits: [], meta };
  }

  type ResolvedRef = {
    rada_nreg: string;
    ref_text: string;
    ref_type: ReferenceContext['ref_type'];
    from_rada_nreg: string;
    from_json_path: string;
    articleRef?: string;
    queryVariant?: string;
  };
  const resolvedRefs: ResolvedRef[] = [];
  const seenNreg = new Set<string>();

  for (const hit of hitsToParse) {
    const text = await input.fetchChunkText(hit.r2_key, hit.json_path);
    if (!text || text.length < 20) continue;

    const hitNreg = (hit.rada_nreg ?? '').trim();

    if (hasSelfRef(text)) {
      if (hitNreg && !seenNreg.has(hitNreg)) {
        seenNreg.add(hitNreg);
        const artRefs = extractArticleRefs(text);
        resolvedRefs.push({
          rada_nreg: hitNreg,
          ref_text: 'цього Закону/Кодексу',
          ref_type: 'self_ref',
          from_rada_nreg: hitNreg,
          from_json_path: hit.json_path,
          articleRef: artRefs[0],
          queryVariant: artRefs[0] ?? undefined,
        });
      }
    }

    for (const frag of extractQuotedTitles(text)) {
      const nregs = await input.resolveActByTitleFragment(frag);
      if (nregs.length === 0 && frag.length >= 5 && !meta.skipped_reason_codes.includes('NO_MATCH_IN_TAXONOMY')) {
        meta.skipped_reason_codes.push('NO_MATCH_IN_TAXONOMY');
      }
      for (const nreg of nregs) {
        if (seenNreg.has(nreg) || resolvedRefs.some((r) => r.rada_nreg === nreg)) continue;
        if (resolvedRefs.length >= maxReferencedActs) break;
        seenNreg.add(nreg);
        resolvedRefs.push({
          rada_nreg: nreg,
          ref_text: frag,
          ref_type: 'quoted_title',
          from_rada_nreg: hitNreg,
          from_json_path: hit.json_path,
        });
      }
      if (resolvedRefs.length >= maxReferencedActs) break;
    }
    if (resolvedRefs.length >= maxReferencedActs) break;
  }

  meta.attempted = true;
  meta.referenced_acts = [...seenNreg];

  const addedHits: RawHit[] = [];
  const addedKeys = new Set<string>();

  for (const ref of resolvedRefs.slice(0, maxReferencedActs)) {
    if (addedHits.length >= maxAddedHits) {
      meta.skipped_reason_codes.push('BUDGET_EXCEEDED');
      break;
    }
    const limit = Math.min(6, maxAddedHits - addedHits.length);
    const hits = await input.retrieveChunksForAct({
      rada_nreg: ref.rada_nreg,
      articleRef: ref.articleRef,
      queryVariant: ref.queryVariant,
      limit,
    });
    for (const h of hits) {
      const key = `${h.r2_key}:${h.json_path}`;
      if (existingKeys.has(key) || addedKeys.has(key)) continue;
      addedKeys.add(key);
      const withMeta: RawHit = {
        ...h,
        source: REFERENCE_EXPANSION_SOURCE as RawHitSource,
        metadata: {
          ...(h.metadata ?? {}),
          reference_context: {
            from_rada_nreg: ref.from_rada_nreg,
            from_json_path: ref.from_json_path,
            ref_text: ref.ref_text,
            ref_type: ref.ref_type,
            resolved_to_rada_nreg: ref.rada_nreg,
          } as ReferenceContext,
        },
      };
      addedHits.push(withMeta);
      if (addedHits.length >= maxAddedHits) break;
    }
  }

  meta.added_count = addedHits.length;
  return { addedHits, meta };
}
