import type { ResolveFilters } from '../types';
import { isLikelyNregExact, nregCandidates, normalizeWhitespace } from '../util/nreg';

export type SearchKind = 'nreg_exact' | 'nreg_partial' | 'semantic';

export interface SearchPlan {
  kind: SearchKind;
  normalized_query: string;
  nreg_candidates?: string[];
  metadata_hints?: ResolveFilters;
  debug?: Record<string, unknown>;
}

export function interpretQuery(rawQuery: string): SearchPlan {
  const q0 = normalizeWhitespace(rawQuery);
  const qLower = q0.toLowerCase();

  const hints: ResolveFilters = {};

  // Years: "2010-2015", "2010–2015"
  {
    const m = qLower.match(/\b(19\d{2}|20\d{2})\s*[-–—]\s*(19\d{2}|20\d{2})\b/);
    if (m) {
      const a = Number.parseInt(m[1], 10);
      const b = Number.parseInt(m[2], 10);
      if (Number.isFinite(a) && Number.isFinite(b)) {
        hints.year_from = Math.min(a, b);
        hints.year_to = Math.max(a, b);
      }
    } else {
      const y = qLower.match(/\b(19\d{2}|20\d{2})\b/);
      if (y) {
        const yy = Number.parseInt(y[1], 10);
        if (Number.isFinite(yy)) {
          hints.year_from = yy;
          hints.year_to = yy;
        }
      }
    }
  }

  // Organs
  {
    const organs: string[] = [];
    if (qLower.includes('кму') || qLower.includes('кабмін') || /кабінет\s+міністр/.test(qLower)) organs.push('KMU');
    if (qLower.includes('вру') || /верховн(а|ої)\s+рад/.test(qLower)) organs.push('VRU');
    if (qLower.includes('президент')) organs.push('PRESIDENT');
    if (organs.length) hints.organs = Array.from(new Set(organs)) as any;
  }

  // Types (plus some combined shortcuts)
  {
    const types: string[] = [];
    if (qLower.includes('конституц') || /головн(ий|ого)\s+закон/.test(qLower)) types.push('CONSTITUTION');
    if (qLower.includes('кодекс')) types.push('CODE');
    if (qLower.includes('закон')) types.push('LAW');
    if (qLower.includes('постанова')) types.push('RESOLUTION');
    if (qLower.includes('указ')) types.push('DECREE');
    if (/розпоряджен/.test(qLower)) types.push('ORDER');

    // Combined intents
    if (/постанова.*кму|кму.*постанова/.test(qLower)) types.push('KABMIN_RESOLUTION');
    if (/розпоряджен.*кму|кму.*розпоряджен/.test(qLower)) types.push('KABMIN_ORDER');
    if (/указ.*президент|президент.*указ/.test(qLower)) types.push('PRESIDENT_DECREE');
    if (/розпоряджен.*президент|президент.*розпоряджен/.test(qLower)) types.push('PRESIDENT_ORDER');

    if (types.length) hints.types = Array.from(new Set(types)) as any;
  }

  const hintKeys = Object.keys(hints).length ? hints : undefined;

  // Known aliases (no LLM):
  // - treat as "exact nreg intent" for a fast/cheap deterministic lookup.
  {
    const alias = resolveKnownAlias(qLower);
    if (alias) {
      const cands = nregCandidates(alias);
      return {
        kind: 'nreg_exact',
        normalized_query: q0,
        nreg_candidates: cands,
        metadata_hints: hintKeys,
        debug: { detected: 'known_alias', alias, candidates: cands },
      };
    }
  }

  // Exact nreg: query itself is nreg-ish and contains no spaces.
  if (isLikelyNregExact(q0)) {
    const cands = nregCandidates(q0);
    return {
      kind: 'nreg_exact',
      normalized_query: q0,
      nreg_candidates: cands,
      metadata_hints: hintKeys,
      debug: { detected: 'nreg_exact', candidates: cands },
    };
  }

  // Extract nreg-like token from longer text (treat as partial path).
  const tokenInfo = extractNregTokenInfo(q0);
  if (tokenInfo.token) {
    const cands = nregCandidates(tokenInfo.token);
    return {
      kind: cands.length ? 'nreg_exact' : 'nreg_partial',
      normalized_query: q0,
      nreg_candidates: cands.length ? cands : undefined,
      metadata_hints: hintKeys,
      debug: { detected: 'nreg_token', token: tokenInfo.token, candidates: cands, tokens: tokenInfo.tokens.slice(0, 8) },
    };
  }

  return {
    kind: 'semantic',
    normalized_query: q0,
    metadata_hints: hintKeys,
    debug: { detected: 'semantic', token_candidate: tokenInfo.token, tokens: tokenInfo.tokens.slice(0, 8) },
  };
}

function extractNregTokenInfo(query: string): { token: string | null; tokens: string[] } {
  const s = String(query || '');
  // Avoid `\b` (ASCII-only word boundary) because nreg часто містить кирилицю (-п, -р, -вр).
  // Instead: tokenize by whitespace + common punctuation, then pick the "most nreg-like" token.
  const parts = s
    .split(/[\s,;()\[\]{}"“”'’]+/g)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => p.replace(/[.,!?]+$/g, '')); // strip trailing punctuation

  let best: string | null = null;
  for (const p of parts) {
    // normalize common dash-like characters (incl. non-breaking hyphen)
    const t = p.replace(/[\u2010-\u2015\u2212]/g, '-');
    if (!/\d/.test(t)) continue;
    if (!t.includes('-') && !t.includes('/')) continue;
    if (!/^[0-9a-zа-яіїєґ\/\-.]+$/i.test(t)) continue;
    if (!best || t.length > best.length) best = t;
  }
  return { token: best, tokens: parts };
}

function resolveKnownAlias(qLower: string): string | null {
  const q = qLower.trim();
  // Конституція України (1996)
  if (q === 'конституція' || q === 'конституція україни' || q.includes('головн') && q.includes('закон')) {
    return '254к/96-вр';
  }
  return null;
}

