const CYR_EQUIV: Record<string, string> = {
  // Minimal latin->cyrillic for typical nreg suffix letters users often type as latin.
  k: 'к',
  r: 'р',
  p: 'п',
  v: 'в',
};

const CYR_ROMAN_EQUIV: Record<string, string> = {
  // Cyrillic letters sometimes appear in roman suffixes.
  'і': 'i',
  'х': 'x',
};

export function normalizeWhitespace(s: string): string {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

export function normalizeNregLikeInput(raw: string): string {
  // Normalize:
  // - trim, lower-case
  // - normalize hyphens
  // - remove spaces
  // - map some latin suffix letters to cyrillic
  let s = String(raw || '')
    .trim()
    .replace(/[–—−]/g, '-')
    .replace(/\s+/g, '');

  s = s.toLowerCase();

  // Apply minimal latin->cyr mapping only where it's likely nreg-ish.
  // We do NOT attempt full transliteration; just enough for common suffixes: -p/-r/-vr and "k" in "254k/96".
  s = s.replace(/[krpv]/g, (ch) => CYR_EQUIV[ch] || ch);

  return s;
}

export function isLikelyNregExact(raw: string): boolean {
  // Exact nreg queries should not contain whitespace (sentences like "постанова КМУ 211-2020-п" are NOT exact).
  if (/\s/.test(String(raw || ''))) return false;
  const s = normalizeNregLikeInput(raw);
  if (!s) return false;
  if (s.length > 40) return false;
  if (!/\d/.test(s)) return false;
  // Must include a structural separator typical for nreg.
  if (!s.includes('-') && !s.includes('/')) return false;
  // Allow digits, cyr/lat letters, dashes, slashes, dots.
  if (!/^[0-9a-zа-яіїєґ\/\-.]+$/i.test(s)) return false;
  return true;
}

export function tryCanonicalizeVruRomanSuffix(nreg: string): string {
  // Rada card canonicalizes VRU convocation suffix:
  // -III -> -14, -IV -> -15, -IX -> -20 (roman + 11)
  const s0 = normalizeNregLikeInput(nreg);
  const m = s0.match(/^(.*?)-([ivxlcdmіх]+)$/i);
  if (!m) return s0;
  const head = m[1];
  const rawRoman = m[2] || '';
  const romanLatin = rawRoman
    .split('')
    .map((ch) => CYR_ROMAN_EQUIV[ch] || ch)
    .join('')
    .toUpperCase();
  const n = romanToInt(romanLatin);
  if (!Number.isFinite(n) || n <= 0 || n > 50) return s0;
  const conv = n + 11;
  return `${head}-${conv}`;
}

export function nregCandidates(raw: string): string[] {
  const out: string[] = [];
  const base = normalizeNregLikeInput(raw);
  if (!base) return out;

  // 1) Canonicalize roman suffix if present
  const canon = tryCanonicalizeVruRomanSuffix(base);
  if (canon !== base) out.push(canon);

  // 2) As-is (normalized)
  out.push(base);

  // 2.1) If token already has a suffix, also try the "base id" without suffix.
  // Example: "211-2020-п" -> also try "211-2020" (+ common suffixes below).
  const mBase = base.match(/^(\d{1,6}-\d{4})-[0-9a-zа-яіїєґ]+$/i);
  if (mBase?.[1]) out.push(mBase[1]);

  // 3) Heuristics for partial inputs
  // - 70-2022 -> try common act suffixes
  // - 254к/96 -> try -вр (VRU)
  if (/^\d{1,6}-\d{4}$/.test(base)) {
    // Order/Resolution are most common for KMU; keep list small to avoid many Qdrant calls.
    out.push(`${base}-р`);
    out.push(`${base}-п`);
  } else if (mBase?.[1] && /^\d{1,6}-\d{4}$/.test(mBase[1])) {
    // If we derived the base id, add common suffixes for it.
    out.push(`${mBase[1]}-р`);
    out.push(`${mBase[1]}-п`);
  }

  if (/^\d{1,6}[а-яіїєґ]\/\d{2,4}$/.test(base) && !base.includes('-')) {
    out.push(`${base}-вр`);
  }

  // De-duplicate
  return Array.from(new Set(out));
}

function romanToInt(roman: string): number {
  const m: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let total = 0;
  let prev = 0;
  for (let i = roman.length - 1; i >= 0; i--) {
    const ch = roman[i];
    const v = m[ch];
    if (!v) return NaN;
    if (v < prev) total -= v;
    else total += v;
    prev = v;
  }
  return total;
}

