/**
 * Tolerant normalizer for taxonomy fields from DB (aliases, keywords, topics).
 * Accepts string | array | object | jsonb → string[]; NFC, trim, lower, dedup.
 * Runtime/cache only — no DB writes.
 */
export function tolerantNormalizeToStrings(val: unknown): string[] {
  const raw: string[] = [];
  if (val == null) return [];
  if (typeof val === 'string') {
    raw.push(val);
  } else if (Array.isArray(val)) {
    for (const x of val) {
      if (typeof x === 'string') raw.push(x);
    }
  } else if (typeof val === 'object' && val !== null) {
    for (const k of Object.keys(val)) {
      const v = (val as Record<string, unknown>)[k];
      if (typeof v === 'string') raw.push(v);
    }
  }
  const normalized = raw
    .map((s) => (typeof s.normalize === 'function' ? s.normalize('NFC') : s))
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 0)
    .map((s) => s.toLowerCase());
  return [...new Set(normalized)];
}
