/**
 * Bounded memory summary: plain, factual, no markdown/legal structure.
 * Used for mm_summaries and memory extraction input (not raw answer slice).
 *
 * Rules: structural only, no domain wordlists.
 * - Strip markdown headings (lines that are only #, ##, ###)
 * - Collapse whitespace; no multi-block markdown
 * - Bound length at word boundary
 */

const DEFAULT_MAX_CHARS = 500;

function ensureSentenceLikeFact(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (!trimmed) return '';
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * Normalize text for memory summary: strip structural noise, bound length.
 * No domain-specific stripping (no "Норма / Аналіз" wordlists).
 */
export function normalizeMemorySummary(text: string, maxChars: number = DEFAULT_MAX_CHARS): string {
  const t = text.trim();
  if (!t) return '';
  const lines = t.split(/\r?\n/);
  const cleaned: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^#+\s*$/.test(trimmed)) continue;
    if (/^#{1,6}\s/.test(trimmed)) {
      const withoutHash = trimmed.replace(/^#+\s*/, '').trim();
      if (withoutHash) cleaned.push(withoutHash);
      continue;
    }
    cleaned.push(trimmed);
  }
  const joined = cleaned.join(' ').replace(/\s+/g, ' ').trim();
  if (!joined) return '';
  if (joined.length <= maxChars) return joined;
  const cut = joined.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  const atWord = lastSpace > maxChars * 0.5 ? cut.slice(0, lastSpace) : cut;
  return atWord + '…';
}

/** Split text into sentence- or clause-level parts (by . ! ? or |). */
export function splitIntoClauses(text: string): string[] {
  if (!text.trim()) return [];
  const parts = text
    .split(/\s*\|\s*|[.!?]+\s+/)
    .map((p) => p.trim().replace(/[.!?…]+$/, '').trim())
    .filter((p) => p.length > 0);
  return parts;
}

function normalizeClauseForDedupe(p: string): string {
  return p
    .normalize('NFC')
    .replace(/[.!?…,:;]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function clauseDedupeKey(p: string): string {
  return normalizeClauseForDedupe(p);
}

/**
 * Merge existing and new summary: dedupe, preserve chronology, bounded.
 * Split first so sentence boundaries are preserved for dedupe.
 */
export function mergeRollingSummary(
  existingText: string,
  newText: string,
  maxChars: number = DEFAULT_MAX_CHARS
): string {
  // Normalize structural noise before clause splitting so markdown headings
  // do not leak into the rolling summary dedupe path.
  const existingTrim = normalizeMemorySummary(existingText, Number.MAX_SAFE_INTEGER).trim();
  const newTrim = normalizeMemorySummary(newText, Number.MAX_SAFE_INTEGER).trim();
  if (!newTrim && !existingTrim) return '';
  if (!newTrim) return normalizeMemorySummary(existingTrim, maxChars);
  if (!existingTrim) return normalizeMemorySummary(newTrim, maxChars);

  const newParts = splitIntoClauses(newTrim);
  const existingParts = splitIntoClauses(existingTrim);
  const seen = new Set<string>();
  const ordered: string[] = [];
  // Preserve chronology so early durable facts are not pushed to the tail of the
  // rolling summary. Recent facts are still appended and preserved via memory items.
  for (const p of existingParts) {
    const key = clauseDedupeKey(p);
    if (key && !seen.has(key)) {
      seen.add(key);
      ordered.push(p);
    }
  }
  for (const p of newParts) {
    const key = clauseDedupeKey(p);
    if (key && !seen.has(key)) {
      seen.add(key);
      ordered.push(p);
    }
  }
  const joined = ordered.join(' ').replace(/\s+/g, ' ').trim();
  return normalizeMemorySummary(joined, maxChars);
}

/**
 * Build memory-like summary from extracted facts (not answer text).
 * Plain, factual, no markdown; bounded. Use when facts exist; otherwise fall back to normalized answer.
 */
export function buildSummaryFromFacts(facts: string[], maxChars: number = DEFAULT_MAX_CHARS): string {
  if (!facts.length) return '';
  const seen = new Set<string>();
  const normalizedFacts = facts
    .map((f) => ensureSentenceLikeFact(f))
    .filter((f) => {
      const key = clauseDedupeKey(f.replace(/[.!?]+$/, ''));
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const raw = normalizedFacts.join(' ');
  const noMarkdown = raw
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!noMarkdown) return '';
  if (noMarkdown.length <= maxChars) return noMarkdown;
  const cut = noMarkdown.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > maxChars * 0.5 ? cut.slice(0, lastSpace) : cut) + '…';
}
