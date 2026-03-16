/**
 * Bracket-balanced JSON extraction for triage/classifier output.
 * Tolerates prelude, markdown, trailing text. No greedy match.
 * Only double-quote " delimits JSON strings (apostrophe in text like п'яти is not a delimiter).
 */
function skipDoubleQuotedString(trimmed: string, i: number): number {
  if (trimmed[i] !== '"') return i;
  i++;
  while (i < trimmed.length) {
    const c = trimmed[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '"') return i + 1;
    i++;
  }
  return i;
}

/**
 * Extract first complete JSON object {...} with bracket balancing.
 */
export function extractFirstJsonObject(s: string): string {
  const trimmed = s.replace(/^```json\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  const start = trimmed.indexOf('{');
  if (start === -1) return '';
  let depth = 0;
  let i = start;
  while (i < trimmed.length) {
    const ch = trimmed[i];
    if (ch === '"') {
      i = skipDoubleQuotedString(trimmed, i);
      continue;
    }
    if (ch === '{') {
      depth++;
      i++;
      continue;
    }
    if (ch === '}') {
      depth--;
      i++;
      if (depth === 0) return trimmed.slice(start, i);
      continue;
    }
    i++;
  }
  return trimmed.slice(start);
}

/**
 * Extract first complete JSON array [...] with bracket balancing.
 * Only [ and ] count toward depth; { } are skipped as content.
 */
export function extractFirstJsonArray(s: string): string {
  const trimmed = s.replace(/^```json\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  const start = trimmed.indexOf('[');
  if (start === -1) return '';
  let depth = 0;
  let i = start;
  while (i < trimmed.length) {
    const ch = trimmed[i];
    if (ch === '"') {
      i = skipDoubleQuotedString(trimmed, i);
      continue;
    }
    if (ch === '[') {
      depth++;
      i++;
      continue;
    }
    if (ch === ']') {
      depth--;
      i++;
      if (depth === 0) return trimmed.slice(start, i);
      continue;
    }
    if (ch === '{') {
      const obj = extractFirstJsonObject(trimmed.slice(i));
      i += obj.length || 1;
      continue;
    }
    i++;
  }
  return trimmed.slice(start);
}
