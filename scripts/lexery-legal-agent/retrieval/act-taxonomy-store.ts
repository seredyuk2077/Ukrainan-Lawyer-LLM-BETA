/**
 * U4 ActTaxonomyStore — runtime data-driven act candidates from Supabase legislation metadata.
 * No hardcoded categories/acts: aliases, keywords, topics, category from DB; TTL refresh; graceful no-taxonomy if Supabase unavailable.
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from '../lib/config.js';
import {
  incrementTaxonomyRefreshSuccess,
  incrementTaxonomyRefreshFailed,
  setTaxonomySnapshotAgeSeconds,
} from '../gateway/observability.js';

const LEGISLATION_TABLE = 'legislation_documents';
const MIN_TOKEN_LEN = 2;
const MAX_ANCHOR_TOKENS = 3;
const ANCHOR_TITLE_WORDS = 5;

interface ActEntry {
  rada_nreg: string;
  title: string;
  category: string | null;
}

interface TaxonomySnapshot {
  byAlias: Map<string, ActEntry[]>;
  byKeyword: Map<string, ActEntry[]>;
  byTopic: Map<string, ActEntry[]>;
  byCategory: Map<string, ActEntry[]>;
  acts: Map<string, ActEntry>;
  version: number;
  loadedAt: number;
}

function normalizeStrings(val: unknown): string[] {
  if (val == null) return [];
  if (Array.isArray(val)) return val.filter((x): x is string => typeof x === 'string');
  if (typeof val === 'string') return [val];
  return [];
}

function toKey(s: string): string {
  return s
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeQuery(q: string): string[] {
  const normalized = (q ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, ' ');
  const tokens = normalized.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= MIN_TOKEN_LEN);
  return [...new Set(tokens)];
}

function addToMap(map: Map<string, ActEntry[]>, key: string, entry: ActEntry): void {
  const k = toKey(key);
  if (!k) return;
  const list = map.get(k) ?? [];
  if (!list.some((e) => e.rada_nreg === entry.rada_nreg)) list.push(entry);
  map.set(k, list);
}

let legislationClient: SupabaseClient | null = null;
let snapshot: TaxonomySnapshot | null = null;
let nextRefreshAt = 0;

function getLegislationClient(): SupabaseClient | null {
  const url = config.supabaseLegislationUrl?.trim();
  const key = config.supabaseLegislationServiceKey?.trim();
  if (!url || !key) return null;
  if (!legislationClient) {
    legislationClient = createClient(url, key, { auth: { persistSession: false } });
  }
  return legislationClient;
}

async function loadSnapshot(): Promise<TaxonomySnapshot | null> {
  const client = getLegislationClient();
  if (!client) return null;

  const { data, error } = await client
    .from(LEGISLATION_TABLE)
    .select('rada_nreg, title, category, aliases, keywords, topics')
    .eq('qdrant_status', 'indexed');

  if (error) {
    incrementTaxonomyRefreshFailed();
    return null;
  }

  const rows = Array.isArray(data) ? data : [];
  const byAlias = new Map<string, ActEntry[]>();
  const byKeyword = new Map<string, ActEntry[]>();
  const byTopic = new Map<string, ActEntry[]>();
  const byCategory = new Map<string, ActEntry[]>();
  const acts = new Map<string, ActEntry>();

  for (const row of rows) {
    const rada_nreg = typeof row?.rada_nreg === 'string' ? row.rada_nreg.trim() : '';
    const title = typeof row?.title === 'string' ? row.title.trim() : '';
    const category = row?.category != null ? String(row.category).trim() : null;
    if (!rada_nreg) continue;

    const entry: ActEntry = { rada_nreg, title, category };
    acts.set(rada_nreg, entry);

    for (const a of normalizeStrings(row?.aliases)) addToMap(byAlias, a, entry);
    for (const k of normalizeStrings(row?.keywords)) addToMap(byKeyword, k, entry);
    for (const t of normalizeStrings(row?.topics)) addToMap(byTopic, t, entry);
    if (category) addToMap(byCategory, category, entry);
  }

  incrementTaxonomyRefreshSuccess();
  const loadedAt = Date.now();
  setTaxonomySnapshotAgeSeconds(0);

  return {
    byAlias,
    byKeyword,
    byTopic,
    byCategory,
    acts,
    version: loadedAt,
    loadedAt,
  };
}

async function ensureSnapshot(): Promise<TaxonomySnapshot | null> {
  const now = Date.now();
  const ttlMs = (config.actTaxonomyTtlSec ?? 3600) * 1000;
  if (snapshot && now < nextRefreshAt) return snapshot;
  const fresh = await loadSnapshot();
  if (fresh) {
    snapshot = fresh;
    nextRefreshAt = now + ttlMs;
    return snapshot;
  }
  if (snapshot) {
    setTaxonomySnapshotAgeSeconds((now - snapshot.loadedAt) / 1000);
    return snapshot;
  }
  return null;
}

export interface TaxonomyCandidatesInput {
  query: string;
  /** Domain from query_profile (e.g. "criminal") — used as hint only, no hardcoded mapping. */
  domainHint?: string;
  /** U2 entities: act_abbrev, article_ref for scoring. */
  entities?: { act_abbrev?: string; article_ref?: string }[];
}

export interface AliasHit {
  rada_nreg: string;
  title: string;
  alias: string;
  category?: string | null;
}

export interface TaxonomyCandidatesResult {
  rada_nreg_candidates: string[];
  category_hints: string[];
  alias_hits: AliasHit[];
  anchor_tokens: string[];
  debug: {
    taxonomy_snapshot_version: number | null;
    taxonomy_snapshot_age_seconds: number | null;
    source: 'supabase' | 'none';
  };
}

/**
 * Get act candidates from taxonomy: alias/keyword/topic match from DB; domain as hint; entities for scoring.
 * No hardcoded categories or act names.
 */
export async function getTaxonomyCandidates(
  input: TaxonomyCandidatesInput
): Promise<TaxonomyCandidatesResult> {
  const { query, domainHint, entities = [] } = input;
  const empty: TaxonomyCandidatesResult = {
    rada_nreg_candidates: [],
    category_hints: domainHint ? [domainHint] : [],
    alias_hits: [],
    anchor_tokens: [],
    debug: { taxonomy_snapshot_version: null, taxonomy_snapshot_age_seconds: null, source: 'none' },
  };

  const snap = await ensureSnapshot();
  if (!snap) {
    if (domainHint) empty.category_hints = [domainHint];
    return empty;
  }

  const now = Date.now();
  const ageSec = (now - snap.loadedAt) / 1000;
  setTaxonomySnapshotAgeSeconds(ageSec);

  const radaNregScores = new Map<string, number>();
  const aliasHits: AliasHit[] = [];
  const categoryHintsSet = new Set<string>();
  if (domainHint) categoryHintsSet.add(domainHint);

  const tokens = tokenizeQuery(query);

  for (const token of tokens) {
    const key = toKey(token);
    for (const entry of snap.byAlias.get(key) ?? []) {
      radaNregScores.set(entry.rada_nreg, (radaNregScores.get(entry.rada_nreg) ?? 0) + 2);
      aliasHits.push({
        rada_nreg: entry.rada_nreg,
        title: entry.title,
        alias: token,
        category: entry.category,
      });
    }
    for (const entry of snap.byKeyword.get(key) ?? []) {
      radaNregScores.set(entry.rada_nreg, (radaNregScores.get(entry.rada_nreg) ?? 0) + 1);
    }
    for (const entry of snap.byTopic.get(key) ?? []) {
      radaNregScores.set(entry.rada_nreg, (radaNregScores.get(entry.rada_nreg) ?? 0) + 1);
    }
  }

  for (const e of entities) {
    const abbrev = e?.act_abbrev?.trim();
    if (abbrev) {
      const key = toKey(abbrev);
      for (const entry of snap.byAlias.get(key) ?? []) {
        radaNregScores.set(entry.rada_nreg, (radaNregScores.get(entry.rada_nreg) ?? 0) + 3);
        aliasHits.push({
          rada_nreg: entry.rada_nreg,
          title: entry.title,
          alias: abbrev,
          category: entry.category,
        });
      }
    }
  }

  for (const hit of aliasHits) {
    if (hit.category) categoryHintsSet.add(hit.category);
  }
  const categoryHints = [...categoryHintsSet];

  const sorted = [...radaNregScores.entries()].sort((a, b) => b[1] - a[1]);
  const rada_nreg_candidates = sorted.map(([nreg]) => nreg);

  const anchorTokens: string[] = [];
  const seenNreg = new Set<string>();
  for (const hit of aliasHits) {
    if (anchorTokens.length >= MAX_ANCHOR_TOKENS) break;
    if (seenNreg.has(hit.rada_nreg)) continue;
    seenNreg.add(hit.rada_nreg);
    const short = hit.alias.length <= 50 ? hit.alias : hit.alias.slice(0, 47) + '...';
    if (short && !anchorTokens.includes(short)) anchorTokens.push(short);
  }
  if (anchorTokens.length < MAX_ANCHOR_TOKENS) {
    for (const [nreg] of sorted) {
      if (anchorTokens.length >= MAX_ANCHOR_TOKENS) break;
      const act = snap.acts.get(nreg);
      if (!act || seenNreg.has(nreg)) continue;
      seenNreg.add(nreg);
      const words = act.title.split(/\s+/).slice(0, ANCHOR_TITLE_WORDS).join(' ');
      if (words && !anchorTokens.some((a) => a.includes(words))) anchorTokens.push(words);
    }
  }

  return {
    rada_nreg_candidates,
    category_hints: categoryHints,
    alias_hits: aliasHits.slice(0, 20),
    anchor_tokens: anchorTokens.slice(0, MAX_ANCHOR_TOKENS),
    debug: {
      taxonomy_snapshot_version: snap.version,
      taxonomy_snapshot_age_seconds: Math.round(ageSec * 10) / 10,
      source: 'supabase',
    },
  };
}
