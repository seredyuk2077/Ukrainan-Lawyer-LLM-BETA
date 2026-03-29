function replaceDashVariants(value: string): string {
  return value.replace(/[‐‑–—−]/gu, '-');
}

function normalizeSeparators(value: string): string {
  return replaceDashVariants(value).replace(/\s*([/_-])\s*/gu, '$1');
}

function isCompactNumericPrefix(segment: string): boolean {
  return /^\d{1,8}$/u.test(segment) || /^[\p{L}]{1,3}\d{1,8}$/u.test(segment);
}

function isNumericSegment(segment: string): boolean {
  return /^\d{1,8}$/u.test(segment);
}

function isRomanNumeralSegment(segment: string): boolean {
  return /^[ivxlcdm]{1,8}$/iu.test(segment);
}

function isCompactAlphaSuffix(segment: string): boolean {
  return /^[\p{L}]{1,6}$/u.test(segment);
}

export function normalizeStructuredActIdentifier(value: string): string {
  return normalizeSeparators(
    value
      .normalize('NFC')
      .toLowerCase()
      .trim()
  );
}

export function looksLikeStructuredActIdentifier(value: string): boolean {
  const normalized = normalizeStructuredActIdentifier(value);
  if (!normalized || normalized.length < 4 || normalized.length > 32) return false;
  if (!/\d/u.test(normalized)) return false;
  if (!/[-_/]/u.test(normalized)) return false;
  if (!/^[\p{L}\p{N}_/-]+$/u.test(normalized)) return false;
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/u.test(normalized)) return false;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(normalized)) return false;

  const segments = normalized.split(/[-_/]/u).filter(Boolean);
  if (segments.length < 2) return false;
  if (!isCompactNumericPrefix(segments[0] ?? '')) return false;

  const twoSegmentMatch = normalized.match(/^(\d{3,8})-(\d{2,4})$/u);
  if (twoSegmentMatch) {
    const left = Number(twoSegmentMatch[1]);
    const right = Number(twoSegmentMatch[2]);
    if (
      twoSegmentMatch[1].length === 4 &&
      Number.isFinite(left) &&
      left >= 1900 &&
      left <= 2100 &&
      Number.isFinite(right) &&
      right >= 1 &&
      right <= 12
    ) {
      return false;
    }
  }

  if (segments.length === 2) {
    return (
      isNumericSegment(segments[1] ?? '') ||
      (
        /^\d{3,8}$/u.test(segments[0] ?? '') &&
        isRomanNumeralSegment(segments[1] ?? '')
      )
    );
  }

  let sawNumericSuffix = false;
  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index] ?? '';
    if (isNumericSegment(segment)) {
      sawNumericSuffix = true;
      continue;
    }
    if (
      index === segments.length - 1 &&
      sawNumericSuffix &&
      (
        isCompactAlphaSuffix(segment) ||
        isRomanNumeralSegment(segment)
      )
    ) {
      return true;
    }
    return false;
  }

  return sawNumericSuffix;
}

export function extractStructuredActIdentifiers(query: string): string[] {
  const matches = query
    .normalize('NFC')
    .match(/[\p{L}\p{N}_/‐‑–—−-]{4,32}/gu) ?? [];
  const out = new Set<string>();
  for (const match of matches) {
    if (!looksLikeStructuredActIdentifier(match)) continue;
    out.add(normalizeStructuredActIdentifier(match));
  }
  return [...out];
}
