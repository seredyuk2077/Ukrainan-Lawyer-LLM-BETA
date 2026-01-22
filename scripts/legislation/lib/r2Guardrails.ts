/**
 * R2 Guardrails — безпечні перевірки для Legislation bucket + ключів.
 *
 * ВАЖЛИВО:
 * - НЕ чіпаємо Supreme Court bucket (навіть не листимо).
 * - Працюємо ТІЛЬКИ з Legislation bucket.
 * - Canonical key scheme НЕ змінюємо:
 *   legislation/{category}/{encodeURIComponent(nreg)}.json
 * - Cache/log prefixes НЕ змінюємо і НЕ пишемо туди canonical.
 */
import { getR2Config } from './r2Client.js';

export const R2_PREFIX_CANONICAL_ROOT = 'legislation/';
export const R2_PREFIX_CACHE = 'legislation/ActCatalogResolver/cache/';
export const R2_PREFIX_LOGS = 'legislation/DocListDB rada gov updater log/';
export const R2_PREFIX_ARCHIVE = 'legislation/archive/';

const SUPREME_COURT_BUCKETS = new Set(['legal-court-decisions', 'legal-cases']);

export function isCacheOrLogKey(key: string): boolean {
  return key.startsWith(R2_PREFIX_CACHE) || key.startsWith(R2_PREFIX_LOGS);
}

export function isCanonicalKey(key: string): boolean {
  // canonical: legislation/<category>/<encoded_nreg>.json
  // must NOT be cache/log/archive or any nested service prefix
  if (!key.startsWith(R2_PREFIX_CANONICAL_ROOT)) return false;
  if (isCacheOrLogKey(key)) return false;
  if (key.startsWith(R2_PREFIX_ARCHIVE)) return false;

  const rest = key.slice(R2_PREFIX_CANONICAL_ROOT.length);
  const parts = rest.split('/');
  if (parts.length !== 2) return false;
  const [category, filename] = parts;
  if (!category || !filename) return false;
  if (!filename.endsWith('.json')) return false;

  // encoded_nreg must be non-empty (we allow any URI-encoded bytes)
  const encoded = filename.slice(0, -'.json'.length);
  if (!encoded) return false;

  // guardrail: category should not be reserved prefixes
  if (category === 'ActCatalogResolver') return false;
  if (category === 'DocListDB rada gov updater log') return false;
  if (category === 'archive') return false;

  return true;
}

export function assertNoDoubleLegislationPrefix(key: string): void {
  if (key.includes('legislation/legislation/')) {
    throw new Error(`R2 key містить подвійний prefix "legislation/legislation/": ${key}`);
  }
}

export function assertStartsWithLegislationPrefix(key: string): void {
  if (!key.startsWith(R2_PREFIX_CANONICAL_ROOT)) {
    throw new Error(`R2 key не починається з "legislation/": ${key}`);
  }
}

export function assertNotCacheOrLogKey(key: string): void {
  if (isCacheOrLogKey(key)) {
    throw new Error(`Заборонено писати canonical у cache/log prefix: ${key}`);
  }
}

export function assertLegislationBucketConfiguredCorrectly(): void {
  const cfg = getR2Config();
  const bucket = cfg.bucket;
  if (!bucket) {
    throw new Error('R2 legislation bucket не сконфігуровано (bucket порожній).');
  }
  if (SUPREME_COURT_BUCKETS.has(bucket)) {
    throw new Error(
      `Небезпечно: сконфігуровано Supreme Court bucket (${bucket}). ` +
        'Для Legislation RAG має бути використаний Legislation bucket.'
    );
  }
}

/**
 * Guardrail для canonical записів.
 * - canonical key must be exactly under legislation/<category>/<encoded>.json
 * - must not be cache/log
 * - must not contain double legislation prefix
 */
export function assertCanonicalKeyForWrite(key: string): void {
  assertLegislationBucketConfiguredCorrectly();
  assertNoDoubleLegislationPrefix(key);
  assertStartsWithLegislationPrefix(key);
  assertNotCacheOrLogKey(key);

  if (!isCanonicalKey(key)) {
    throw new Error(`R2 key не є canonical key за політикою: ${key}`);
  }
}

