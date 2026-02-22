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
  addU4TaxonomyCategoryHintsUsed,
  addU4TaxonomyDocTypeHintsUsed,
  addU4TaxonomyHintsInjectedActs,
} from '../gateway/observability.js';
import { tolerantNormalizeToStrings } from './tolerant-normalizer.js';

const LEGISLATION_TABLE = 'legislation_documents';
const MIN_TOKEN_LEN = 2;
const MAX_ANCHOR_TOKENS = 3;
const ANCHOR_TITLE_WORDS = 5;

interface ActEntry {
  rada_nreg: string;
  title: string;
  category: string | null;
  document_type: string | null;
}

interface TaxonomySnapshot {
  byAlias: Map<string, ActEntry[]>;
  byKeyword: Map<string, ActEntry[]>;
  byTopic: Map<string, ActEntry[]>;
  byCategory: Map<string, ActEntry[]>;
  byDocumentType: Map<string, ActEntry[]>;
  acts: Map<string, ActEntry>;
  version: number;
  loadedAt: number;
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
    .select('rada_nreg, title, category, document_type, aliases, keywords, topics')
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
  const byDocumentType = new Map<string, ActEntry[]>();
  const acts = new Map<string, ActEntry>();

  function normDocType(v: unknown): string | null {
    if (v == null) return null;
    const s = String(v).trim().replace(/\s+/g, ' ');
    return s || null;
  }

  for (const row of rows) {
    const rada_nreg = typeof row?.rada_nreg === 'string' ? row.rada_nreg.trim() : '';
    const title = typeof row?.title === 'string' ? row.title.trim() : '';
    const category = row?.category != null ? String(row.category).trim() : null;
    const document_type = normDocType(row?.document_type);
    if (!rada_nreg) continue;

    const entry: ActEntry = { rada_nreg, title, category, document_type };
    acts.set(rada_nreg, entry);

    for (const a of tolerantNormalizeToStrings(row?.aliases)) addToMap(byAlias, a, entry);
    for (const k of tolerantNormalizeToStrings(row?.keywords)) addToMap(byKeyword, k, entry);
    for (const t of tolerantNormalizeToStrings(row?.topics)) addToMap(byTopic, t, entry);
    if (category) addToMap(byCategory, category, entry);
    if (document_type) addToMap(byDocumentType, document_type, entry);
  }

  incrementTaxonomyRefreshSuccess();
  const loadedAt = Date.now();
  setTaxonomySnapshotAgeSeconds(0);

  return {
    byAlias,
    byKeyword,
    byTopic,
    byCategory,
    byDocumentType,
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
  /** U2 lldbi: categories_ranked_top3 — inject acts from byCategory for each. */
  categoryHints?: string[];
  /** U2 lldbi: document_types_ranked_top3 — inject acts from byDocumentType for each. */
  documentTypeHints?: string[];
  /** U2 entities: act_abbrev, article_ref for scoring. */
  entities?: { act_abbrev?: string; article_ref?: string }[];
}

export interface AliasHit {
  rada_nreg: string;
  title: string;
  alias: string;
  category?: string | null;
}

export interface TaxonomyHintsUsed {
  categories_used: string[];
  document_types_used: string[];
  injected_counts: { by_domain: number; by_category_hints: number; by_doc_type_hints: number };
}

export interface TaxonomyCandidatesResult {
  rada_nreg_candidates: string[];
  category_hints: string[];
  alias_hits: AliasHit[];
  anchor_tokens: string[];
  taxonomy_hints_used?: TaxonomyHintsUsed;
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
const DOMAIN_CATEGORY_BOOST = 1;
const MAX_DOMAIN_ACTS = 15;
const MAX_HINTS_INJECTED_TOTAL = 30;
const HINTS_TOP_K_PER_KEY = 10;

export async function getTaxonomyCandidates(
  input: TaxonomyCandidatesInput
): Promise<TaxonomyCandidatesResult> {
  const { query, domainHint, categoryHints = [], documentTypeHints = [], entities = [] } = input;
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

  const injectedByDomain: string[] = [];
  const injectedByCategoryHints: string[] = [];
  const injectedByDocTypeHints: string[] = [];
  const categoriesUsed: string[] = [];
  const documentTypesUsed: string[] = [];

  // Domain-based act injection (cap K=15, no hardcoded category keys)
  if (domainHint) {
    const domainKey = toKey(domainHint);
    for (const entry of snap.byCategory.get(domainKey) ?? []) {
      if (injectedByDomain.length >= MAX_DOMAIN_ACTS) break;
      if (injectedByDomain.includes(entry.rada_nreg)) continue;
      injectedByDomain.push(entry.rada_nreg);
      radaNregScores.set(
        entry.rada_nreg,
        (radaNregScores.get(entry.rada_nreg) ?? 0) + DOMAIN_CATEGORY_BOOST
      );
    }
  }

  // Category hints injection (U2 lldbi.categories_ranked_top3)
  let hintsBudget = MAX_HINTS_INJECTED_TOTAL - injectedByDomain.length;
  const seenHints = new Set<string>();
  for (const hint of categoryHints) {
    if (hintsBudget <= 0) break;
    const key = toKey(hint);
    if (!key) continue;
    const entries = snap.byCategory.get(key) ?? [];
    if (entries.length > 0) categoriesUsed.push(hint);
    let added = 0;
    for (const entry of entries) {
      if (added >= HINTS_TOP_K_PER_KEY || hintsBudget <= 0) break;
      if (seenHints.has(entry.rada_nreg)) continue;
      seenHints.add(entry.rada_nreg);
      injectedByCategoryHints.push(entry.rada_nreg);
      radaNregScores.set(entry.rada_nreg, (radaNregScores.get(entry.rada_nreg) ?? 0) + DOMAIN_CATEGORY_BOOST);
      added++;
      hintsBudget--;
    }
  }

  // Document type hints injection (U2 lldbi.document_types_ranked_top3)
  for (const hint of documentTypeHints) {
    if (hintsBudget <= 0) break;
    const key = toKey(hint);
    if (!key) continue;
    const entries = snap.byDocumentType.get(key) ?? [];
    if (entries.length > 0) documentTypesUsed.push(hint);
    let added = 0;
    for (const entry of entries) {
      if (added >= HINTS_TOP_K_PER_KEY || hintsBudget <= 0) break;
      if (seenHints.has(entry.rada_nreg)) continue;
      seenHints.add(entry.rada_nreg);
      injectedByDocTypeHints.push(entry.rada_nreg);
      radaNregScores.set(entry.rada_nreg, (radaNregScores.get(entry.rada_nreg) ?? 0) + DOMAIN_CATEGORY_BOOST);
      added++;
      hintsBudget--;
    }
  }

  if (categoriesUsed.length > 0) addU4TaxonomyCategoryHintsUsed(categoriesUsed.length);
  if (documentTypesUsed.length > 0) addU4TaxonomyDocTypeHintsUsed(documentTypesUsed.length);
  const totalHintsInjected = injectedByCategoryHints.length + injectedByDocTypeHints.length;
  if (totalHintsInjected > 0) addU4TaxonomyHintsInjectedActs(totalHintsInjected);

  for (const hit of aliasHits) {
    if (hit.category) categoryHintsSet.add(hit.category);
  }
  const categoryHintsOut = [...categoryHintsSet];

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

  const taxonomy_hints_used: TaxonomyHintsUsed = {
    categories_used: categoriesUsed,
    document_types_used: documentTypesUsed,
    injected_counts: {
      by_domain: injectedByDomain.length,
      by_category_hints: injectedByCategoryHints.length,
      by_doc_type_hints: injectedByDocTypeHints.length,
    },
  };

  return {
    rada_nreg_candidates,
    category_hints: categoryHintsOut,
    alias_hits: aliasHits.slice(0, 20),
    anchor_tokens: anchorTokens.slice(0, MAX_ANCHOR_TOKENS),
    taxonomy_hints_used,
    debug: {
      taxonomy_snapshot_version: snap.version,
      taxonomy_snapshot_age_seconds: Math.round(ageSec * 10) / 10,
      source: 'supabase',
    },
  };
}

export interface ActMeta {
  rada_nreg: string;
  title: string;
  category: string | null;
  document_type: string | null;
}

/** Get act metadata by rada_nreg (from snapshot; no DB write). */
export async function getActMeta(rada_nreg: string): Promise<ActMeta | null> {
  const snap = await ensureSnapshot();
  if (!snap) return null;
  const entry = snap.acts.get(rada_nreg.trim());
  if (!entry) return null;
  return {
    rada_nreg: entry.rada_nreg,
    title: entry.title,
    category: entry.category,
    document_type: entry.document_type,
  };
}

/** Resolve act by title fragment (substring match in act title). Returns rada_nreg[] (deterministic order). */
export async function findActByTitleFragment(fragment: string): Promise<string[]> {
  const snap = await ensureSnapshot();
  if (!snap) return [];
  const key = toKey(fragment);
  if (!key || key.length < 2) return [];
  const out: string[] = [];
  for (const [, entry] of snap.acts) {
    if (toKey(entry.title).includes(key) || entry.title.toLowerCase().includes(fragment.toLowerCase()))
      out.push(entry.rada_nreg);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/** Resolve act by alias (exact key match in taxonomy). Returns rada_nreg[]. */
export async function findActByAlias(alias: string): Promise<string[]> {
  const snap = await ensureSnapshot();
  if (!snap) return [];
  const key = toKey(alias);
  if (!key) return [];
  const entries = snap.byAlias.get(key) ?? [];
  return [...new Set(entries.map((e) => e.rada_nreg))].sort((a, b) => a.localeCompare(b));
}

/** Find act candidates by alias/keyword/topic token overlap. Returns rada_nreg[]. */
export async function findCandidatesByAliasTokens(tokens: string[]): Promise<string[]> {
  const snap = await ensureSnapshot();
  if (!snap) return [];
  const scores = new Map<string, number>();
  for (const t of tokens) {
    const key = toKey(t);
    if (!key) continue;
    for (const entry of snap.byAlias.get(key) ?? []) {
      scores.set(entry.rada_nreg, (scores.get(entry.rada_nreg) ?? 0) + 2);
    }
    for (const entry of snap.byKeyword.get(key) ?? []) {
      scores.set(entry.rada_nreg, (scores.get(entry.rada_nreg) ?? 0) + 1);
    }
    for (const entry of snap.byTopic.get(key) ?? []) {
      scores.set(entry.rada_nreg, (scores.get(entry.rada_nreg) ?? 0) + 1);
    }
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([nreg]) => nreg);
}

export interface ActCandidateScore {
  score: number;
  reasons: string[];
}

/** Score one act candidate by query tokens and domain hint (no DB write). */
export async function scoreActCandidate(
  rada_nreg: string,
  queryTokens: string[],
  domainHint?: string
): Promise<ActCandidateScore> {
  const snap = await ensureSnapshot();
  if (!snap) return { score: 0, reasons: [] };
  const entry = snap.acts.get(rada_nreg.trim());
  if (!entry) return { score: 0, reasons: [] };
  let score = 0;
  const reasons: string[] = [];
  for (const t of queryTokens) {
    const key = toKey(t);
    if (!key) continue;
    for (const e of snap.byAlias.get(key) ?? []) {
      if (e.rada_nreg === entry.rada_nreg) {
        score += 2;
        if (!reasons.includes('alias_match')) reasons.push('alias_match');
      }
    }
    for (const e of snap.byKeyword.get(key) ?? []) {
      if (e.rada_nreg === entry.rada_nreg) {
        score += 1;
        if (!reasons.includes('keyword_match')) reasons.push('keyword_match');
      }
    }
    for (const e of snap.byTopic.get(key) ?? []) {
      if (e.rada_nreg === entry.rada_nreg) {
        score += 1;
        if (!reasons.includes('topic_match')) reasons.push('topic_match');
      }
    }
  }
  if (domainHint && entry.category && toKey(entry.category) === toKey(domainHint)) {
    score += 1;
    reasons.push('category_hint');
  }
  return { score, reasons };
}
