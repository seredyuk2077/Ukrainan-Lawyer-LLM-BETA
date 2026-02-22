/**
 * LLDBI Vocabulary — runtime cache of allowed categories and document_types from legislation_documents.
 * Read-only; used by U2 AI routing classifier and U4 taxonomy/doc_type hints. Fallback to snapshot when Supabase unavailable.
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { config } from '../lib/config.js';

const LEGISLATION_TABLE = 'legislation_documents';
const VOCABULARY_TTL_SEC = Math.max(300, parseInt(process.env.LLDBI_VOCABULARY_TTL_SEC || '1800', 10)); // 30 min default
const SNAPSHOT_PATH = 'scripts/lexery-legal-agent/tools/_datasets/lldbi_vocabulary_snapshot.json';

export interface LldbiVocabularyResult {
  categories: string[];
  documentTypes: string[];
  stats: { totalDocs: number; distinctCategories: number; distinctDocumentTypes: number };
  fetchedAt: number;
  source: 'supabase' | 'stub';
}

let legislationClient: SupabaseClient | null = null;
let cached: LldbiVocabularyResult | null = null;
let cacheExpiresAt = 0;

function getLegislationClient(): SupabaseClient | null {
  const url = config.supabaseLegislationUrl?.trim();
  const key = config.supabaseLegislationServiceKey?.trim();
  if (!url || !key) return null;
  if (!legislationClient) {
    legislationClient = createClient(url, key, { auth: { persistSession: false } });
  }
  return legislationClient;
}

function loadSnapshotFromDisk(): LldbiVocabularyResult | null {
  try {
    const path = resolve(process.cwd(), SNAPSHOT_PATH);
    const raw = readFileSync(path, 'utf-8');
    const data = JSON.parse(raw) as {
      categories?: string[];
      document_types?: string[];
      documentTypes?: string[];
      stats?: { totalDocs?: number; distinctCategories?: number; distinctDocumentTypes?: number };
      generated_at?: string;
    };
    const categories = Array.isArray(data.categories) ? data.categories : [];
    const documentTypes =
      Array.isArray(data.documentTypes) ? data.documentTypes : Array.isArray(data.document_types) ? data.document_types : [];
    const stats = data.stats ?? {};
    const fetchedAt = data.generated_at ? new Date(data.generated_at).getTime() : Date.now();
    return {
      categories: [...categories].sort(),
      documentTypes: [...documentTypes].sort(),
      stats: {
        totalDocs: stats.totalDocs ?? 0,
        distinctCategories: stats.distinctCategories ?? categories.length,
        distinctDocumentTypes: stats.distinctDocumentTypes ?? documentTypes.length,
      },
      fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : Date.now(),
      source: 'stub',
    };
  } catch {
    return null;
  }
}

async function fetchFromSupabase(): Promise<LldbiVocabularyResult | null> {
  const client = getLegislationClient();
  if (!client) return null;

  const { data: rows, error } = await client
    .from(LEGISLATION_TABLE)
    .select('category, document_type')
    .eq('is_active', true)
    .eq('qdrant_status', 'indexed');

  if (error || !Array.isArray(rows)) return null;

  const categorySet = new Set<string>();
  const documentTypeSet = new Set<string>();
  for (const row of rows) {
    const cat = row?.category != null ? String(row.category).trim() : '';
    const docType = row?.document_type != null ? String(row.document_type).trim() : '';
    if (cat) categorySet.add(cat);
    if (docType) documentTypeSet.add(docType);
  }

  return {
    categories: [...categorySet].sort(),
    documentTypes: [...documentTypeSet].sort(),
    stats: {
      totalDocs: rows.length,
      distinctCategories: categorySet.size,
      distinctDocumentTypes: documentTypeSet.size,
    },
    fetchedAt: Date.now(),
    source: 'supabase',
  };
}

/**
 * Returns allowed categories and document_types for U2 routing and U4 hints.
 * Uses in-memory cache with TTL; on Supabase failure falls back to snapshot from _datasets.
 */
export async function getLldbiVocabulary(): Promise<LldbiVocabularyResult> {
  const now = Date.now();
  if (cached && now < cacheExpiresAt) return cached;

  const fromDb = await fetchFromSupabase();
  if (fromDb) {
    cached = fromDb;
    cacheExpiresAt = now + VOCABULARY_TTL_SEC * 1000;
    return cached;
  }

  const fromSnapshot = loadSnapshotFromDisk();
  if (fromSnapshot) {
    cached = fromSnapshot;
    cacheExpiresAt = now + VOCABULARY_TTL_SEC * 1000;
    return cached;
  }

  // No DB, no snapshot: return empty allowed lists (callers should handle gracefully)
  const empty: LldbiVocabularyResult = {
    categories: [],
    documentTypes: [],
    stats: { totalDocs: 0, distinctCategories: 0, distinctDocumentTypes: 0 },
    fetchedAt: now,
    source: 'stub',
  };
  cached = empty;
  cacheExpiresAt = now + 60 * 1000; // short TTL so we retry soon
  return empty;
}
