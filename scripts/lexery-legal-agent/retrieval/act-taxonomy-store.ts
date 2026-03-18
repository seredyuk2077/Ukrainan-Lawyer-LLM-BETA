/**
 * U4 ActTaxonomyStore — runtime act candidates from LLDBI metadata.
 * Uses aliases, title, summary, keywords, topics, category/doc type, and validity from Supabase;
 * keeps retrieval read-only and tolerant when taxonomy data is unavailable.
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
const MIN_METADATA_TOKEN_LEN = 4;
const MAX_ANCHOR_TOKENS = 3;
const MAX_QUERY_PHRASE_WORDS = 4;
const TITLE_MATCH_BOOST = 1.4;
const SUMMARY_MATCH_BOOST = 0.45;
const KEYWORD_PHRASE_BOOST = 1.6;
const TOPIC_PHRASE_BOOST = 1.3;
const ALIAS_PHRASE_BOOST = 3;
const VALIDITY_IN_FORCE_BOOST = 0.1;
const VALIDITY_STALE_PENALTY = 0.35;
const CATEGORY_HINT_SCORE_BOOST = 0.25;

const QUERY_STOPWORDS = new Set([
  'а',
  'або',
  'але',
  'в',
  'від',
  'до',
  'за',
  'з',
  'і',
  'й',
  'із',
  'коли',
  'на',
  'не',
  'під',
  'по',
  'про',
  'та',
  'у',
  'це',
  'чи',
  'що',
  'щодо',
  'яка',
  'яке',
  'який',
  'які',
  'як',
]);

interface ActEntry {
  rada_nreg: string;
  title: string;
  summary: string | null;
  category: string | null;
  storage_category: string | null;
  document_type: string | null;
  document_type_slug: string | null;
  validity_status: string | null;
}

interface TaxonomySnapshot {
  byAlias: Map<string, ActEntry[]>;
  byKeyword: Map<string, ActEntry[]>;
  byTopic: Map<string, ActEntry[]>;
  byTitle: Map<string, ActEntry[]>;
  bySummary: Map<string, ActEntry[]>;
  byCategory: Map<string, ActEntry[]>;
  byStorageCategory: Map<string, ActEntry[]>;
  byDocumentType: Map<string, ActEntry[]>;
  byDocumentTypeSlug: Map<string, ActEntry[]>;
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
  const tokens = normalized
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= MIN_TOKEN_LEN);
  return [...new Set(tokens)];
}

function tokenizeWords(value: string): string[] {
  return value
    .normalize('NFC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((part) => part.trim())
    .filter(
      (part) => part.length >= MIN_TOKEN_LEN && !QUERY_STOPWORDS.has(part)
    );
}

function addToMap(map: Map<string, ActEntry[]>, key: string, entry: ActEntry): void {
  const k = toKey(key);
  if (!k) return;
  const list = map.get(k) ?? [];
  if (!list.some((e) => e.rada_nreg === entry.rada_nreg)) list.push(entry);
  map.set(k, list);
}

function buildPhraseSignals(tokens: string[], maxWords: number): string[] {
  const out = new Set<string>();
  for (let size = 2; size <= Math.min(maxWords, tokens.length); size += 1) {
    for (let index = 0; index <= tokens.length - size; index += 1) {
      const slice = tokens.slice(index, index + size);
      if (slice.some((token) => token.length < MIN_METADATA_TOKEN_LEN)) continue;
      out.add(slice.join(' '));
    }
  }
  return [...out];
}

function metadataSignals(
  value: unknown,
  options?: { includePhrases?: boolean; maxWords?: number; includeTokenParts?: boolean }
): string[] {
  const values = tolerantNormalizeToStrings(value);
  const out = new Set<string>();
  for (const item of values) {
    const normalized = toKey(item);
    if (!normalized) continue;
    out.add(normalized);
    const parts = tokenizeWords(normalized).filter((part) => part.length >= MIN_METADATA_TOKEN_LEN);
    if (options?.includeTokenParts !== false) {
      for (const part of parts) out.add(part);
    }
    if (options?.includePhrases) {
      for (const phrase of buildPhraseSignals(parts, options.maxWords ?? MAX_QUERY_PHRASE_WORDS)) {
        out.add(phrase);
      }
    }
  }
  return [...out];
}

function aliasSignals(value: unknown): string[] {
  return metadataSignals(value, { includePhrases: true, includeTokenParts: false });
}

export function buildTaxonomyQuerySignals(query: string): { tokens: string[]; phrases: string[] } {
  const rawTokens = tokenizeQuery(query);
  const informativeTokens = tokenizeWords(query);
  const phrases = buildPhraseSignals(informativeTokens, MAX_QUERY_PHRASE_WORDS);
  return {
    tokens: [...new Set(rawTokens)],
    phrases: [...new Set(phrases)],
  };
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
    .select(
      'rada_nreg, title, summary, category, storage_category, document_type, document_type_slug, aliases, keywords, topics, validity_status'
    )
    .eq('qdrant_status', 'indexed');

  if (error) {
    incrementTaxonomyRefreshFailed();
    return null;
  }

  const rows = Array.isArray(data) ? data : [];
  const byAlias = new Map<string, ActEntry[]>();
  const byKeyword = new Map<string, ActEntry[]>();
  const byTopic = new Map<string, ActEntry[]>();
  const byTitle = new Map<string, ActEntry[]>();
  const bySummary = new Map<string, ActEntry[]>();
  const byCategory = new Map<string, ActEntry[]>();
  const byStorageCategory = new Map<string, ActEntry[]>();
  const byDocumentType = new Map<string, ActEntry[]>();
  const byDocumentTypeSlug = new Map<string, ActEntry[]>();
  const acts = new Map<string, ActEntry>();

  function normDocType(v: unknown): string | null {
    if (v == null) return null;
    const s = String(v).trim().replace(/\s+/g, ' ');
    return s || null;
  }

  for (const row of rows) {
    const rada_nreg = typeof row?.rada_nreg === 'string' ? row.rada_nreg.trim() : '';
    const title = typeof row?.title === 'string' ? row.title.trim() : '';
    const summary = typeof row?.summary === 'string' ? row.summary.trim() : null;
    const category = row?.category != null ? String(row.category).trim() : null;
    const storage_category =
      row?.storage_category != null ? String(row.storage_category).trim() : null;
    const document_type = normDocType(row?.document_type);
    const document_type_slug =
      row?.document_type_slug != null ? String(row.document_type_slug).trim() : null;
    const validity_status =
      row?.validity_status != null ? String(row.validity_status).trim().toLowerCase() : null;
    if (!rada_nreg) continue;

    const entry: ActEntry = {
      rada_nreg,
      title,
      summary,
      category,
      storage_category,
      document_type,
      document_type_slug,
      validity_status,
    };
    acts.set(rada_nreg, entry);

    for (const a of aliasSignals(row?.aliases)) addToMap(byAlias, a, entry);
    for (const keyword of metadataSignals(row?.keywords, { includePhrases: true })) {
      addToMap(byKeyword, keyword, entry);
    }
    for (const topic of metadataSignals(row?.topics, { includePhrases: true })) {
      addToMap(byTopic, topic, entry);
    }
    for (const titleSignal of metadataSignals(title, { includePhrases: true })) {
      addToMap(byTitle, titleSignal, entry);
    }
    for (const summarySignal of metadataSignals(summary, { includePhrases: false })) {
      addToMap(bySummary, summarySignal, entry);
    }
    if (category) addToMap(byCategory, category, entry);
    if (storage_category) addToMap(byStorageCategory, storage_category, entry);
    if (document_type) addToMap(byDocumentType, document_type, entry);
    if (document_type_slug) addToMap(byDocumentTypeSlug, document_type_slug, entry);
  }

  incrementTaxonomyRefreshSuccess();
  const loadedAt = Date.now();
  setTaxonomySnapshotAgeSeconds(0);

  return {
    byAlias,
    byKeyword,
    byTopic,
    byTitle,
    bySummary,
    byCategory,
    byStorageCategory,
    byDocumentType,
    byDocumentTypeSlug,
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
 * Get act candidates from taxonomy: alias/keyword/topic match from DB; domain and category as metadata hints; entities for scoring.
 * No hardcoded categories or act names.
 */
const DOMAIN_CATEGORY_BOOST = 1;
const KEYWORD_MATCH_BOOST = 1.25;
const TOPIC_MATCH_BOOST = 1;
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

  const { tokens, phrases } = buildTaxonomyQuerySignals(query);
  const phraseSet = new Set(phrases);

  const applyMetadataMatches = (
    signal: string,
    options: {
      aliasBoost: number;
      keywordBoost: number;
      topicBoost: number;
      titleBoost: number;
      summaryBoost: number;
    }
  ): void => {
    const key = toKey(signal);
    if (!key) return;
    for (const entry of snap.byAlias.get(key) ?? []) {
      radaNregScores.set(
        entry.rada_nreg,
        (radaNregScores.get(entry.rada_nreg) ?? 0) + options.aliasBoost
      );
      aliasHits.push({
        rada_nreg: entry.rada_nreg,
        title: entry.title,
        alias: signal,
        category: entry.category,
      });
    }
    for (const entry of snap.byKeyword.get(key) ?? []) {
      radaNregScores.set(
        entry.rada_nreg,
        (radaNregScores.get(entry.rada_nreg) ?? 0) + options.keywordBoost
      );
      if (entry.category) categoryHintsSet.add(entry.category);
    }
    for (const entry of snap.byTopic.get(key) ?? []) {
      radaNregScores.set(
        entry.rada_nreg,
        (radaNregScores.get(entry.rada_nreg) ?? 0) + options.topicBoost
      );
      if (entry.category) categoryHintsSet.add(entry.category);
    }
    for (const entry of snap.byTitle.get(key) ?? []) {
      radaNregScores.set(
        entry.rada_nreg,
        (radaNregScores.get(entry.rada_nreg) ?? 0) + options.titleBoost
      );
      if (entry.category) categoryHintsSet.add(entry.category);
    }
    for (const entry of snap.bySummary.get(key) ?? []) {
      radaNregScores.set(
        entry.rada_nreg,
        (radaNregScores.get(entry.rada_nreg) ?? 0) + options.summaryBoost
      );
      if (entry.category) categoryHintsSet.add(entry.category);
    }
  };

  for (const phrase of phrases) {
    applyMetadataMatches(phrase, {
      aliasBoost: ALIAS_PHRASE_BOOST,
      keywordBoost: KEYWORD_PHRASE_BOOST,
      topicBoost: TOPIC_PHRASE_BOOST,
      titleBoost: TITLE_MATCH_BOOST,
      summaryBoost: SUMMARY_MATCH_BOOST,
    });
  }

  for (const token of tokens) {
    if (phraseSet.has(token)) continue;
    applyMetadataMatches(token, {
      aliasBoost: 2,
      keywordBoost: KEYWORD_MATCH_BOOST,
      topicBoost: TOPIC_MATCH_BOOST,
      titleBoost: TITLE_MATCH_BOOST * 0.6,
      summaryBoost: SUMMARY_MATCH_BOOST,
    });
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
    const entries = snap.byDocumentType.get(key) ?? snap.byDocumentTypeSlug.get(key) ?? [];
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

  // Anchor tokens: alias-hit aliases only (structural, data-driven from DB).
  // Title-word fallback removed: appending act title words to the embedding query is a lexical
  // prior that can bias semantic retrieval toward the act name rather than the article content.
  const anchorTokens: string[] = [];
  const seenNreg = new Set<string>();
  for (const hit of aliasHits) {
    if (anchorTokens.length >= MAX_ANCHOR_TOKENS) break;
    if (seenNreg.has(hit.rada_nreg)) continue;
    seenNreg.add(hit.rada_nreg);
    const short = hit.alias.length <= 50 ? hit.alias : hit.alias.slice(0, 47) + '...';
    if (short && !anchorTokens.includes(short)) anchorTokens.push(short);
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
  summary?: string | null;
  category: string | null;
  storage_category?: string | null;
  document_type: string | null;
  document_type_slug?: string | null;
  validity_status?: string | null;
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
    summary: entry.summary,
    category: entry.category,
    storage_category: entry.storage_category,
    document_type: entry.document_type,
    document_type_slug: entry.document_type_slug,
    validity_status: entry.validity_status,
  };
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

/**
 * Resolve an explicit quoted title fragment to rada_nreg[] using indexed act titles only.
 * This is intentionally narrower than the removed title-based routing heuristics:
 * it exists solely for reference expansion of already-extracted quoted legal titles.
 */
export async function findActByTitleFragment(fragment: string): Promise<string[]> {
  const snap = await ensureSnapshot();
  if (!snap) return [];
  const key = toKey(fragment);
  if (!key || key.length < 5) return [];

  const matches: string[] = [];
  for (const entry of snap.acts.values()) {
    const titleKey = toKey(entry.title);
    if (!titleKey) continue;
    if (titleKey.includes(key) || key.includes(titleKey)) {
      matches.push(entry.rada_nreg);
    }
  }

  return [...new Set(matches)].sort((a, b) => a.localeCompare(b));
}

/** Find act candidates by alias token overlap (structural only). Returns rada_nreg[]. */
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
  querySignals: string[],
  domainHint?: string
): Promise<ActCandidateScore> {
  const snap = await ensureSnapshot();
  if (!snap) return { score: 0, reasons: [] };
  const entry = snap.acts.get(rada_nreg.trim());
  if (!entry) return { score: 0, reasons: [] };
  let score = 0;
  const reasons: string[] = [];
  const signals = [...new Set(querySignals.map((signal) => toKey(signal)).filter(Boolean))];
  for (const key of signals) {
    if (!key) continue;
    const isPhrase = key.includes(' ');
    for (const e of snap.byAlias.get(key) ?? []) {
      if (e.rada_nreg === entry.rada_nreg) {
        score += isPhrase ? ALIAS_PHRASE_BOOST : 2;
        if (!reasons.includes('alias_match')) reasons.push('alias_match');
      }
    }
    for (const e of snap.byKeyword.get(key) ?? []) {
      if (e.rada_nreg === entry.rada_nreg) {
        score += isPhrase ? KEYWORD_PHRASE_BOOST : KEYWORD_MATCH_BOOST;
        if (!reasons.includes('keyword_match')) reasons.push('keyword_match');
      }
    }
    for (const e of snap.byTopic.get(key) ?? []) {
      if (e.rada_nreg === entry.rada_nreg) {
        score += isPhrase ? TOPIC_PHRASE_BOOST : TOPIC_MATCH_BOOST;
        if (!reasons.includes('topic_match')) reasons.push('topic_match');
      }
    }
    for (const e of snap.byTitle.get(key) ?? []) {
      if (e.rada_nreg === entry.rada_nreg) {
        score += isPhrase ? TITLE_MATCH_BOOST : TITLE_MATCH_BOOST * 0.6;
        if (!reasons.includes('title_match')) reasons.push('title_match');
      }
    }
    for (const e of snap.bySummary.get(key) ?? []) {
      if (e.rada_nreg === entry.rada_nreg) {
        score += SUMMARY_MATCH_BOOST;
        if (!reasons.includes('summary_match')) reasons.push('summary_match');
      }
    }
  }
  if (domainHint && entry.category && toKey(entry.category) === toKey(domainHint)) {
    score += CATEGORY_HINT_SCORE_BOOST;
    reasons.push('category_hint');
  }
  if (entry.validity_status === 'in_force') {
    score += VALIDITY_IN_FORCE_BOOST;
    reasons.push('validity_in_force');
  } else if (entry.validity_status === 'expired' || entry.validity_status === 'not_in_force') {
    score -= VALIDITY_STALE_PENALTY;
    reasons.push('validity_penalty');
  }
  return { score, reasons };
}
