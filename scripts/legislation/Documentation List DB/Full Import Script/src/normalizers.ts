import type { RawCatalogRow } from './parser.js';

export interface NormalizedCatalogRecord {
  dokid: number;
  nreg: string;
  nazva: string;
  status: string;
  types_raw?: string;
  organs_raw?: string;
  type: string;
  organ: string;
  minjust: boolean;
  datred?: string; // YYYYMMDD
  year?: number;
  embedding_text: string;
}

export function normalizeRow(row: RawCatalogRow): NormalizedCatalogRecord {
  const datred = normalizeDatred(row.datredRaw);
  const year = datred ? Number.parseInt(datred.slice(0, 4), 10) : undefined;
  const type = normalizeFirstCode(row.typesRaw) || 'unknown';
  const organ = normalizeFirstCode(row.organsRaw) || 'unknown';
  const status = row.statusRaw ? String(row.statusRaw) : 'unknown';
  const minjust = normalizeMinjust(row.minjustRaw);

  const embedding_text = `${row.nazva}. Тип: ${type}. Орган: ${organ}. Рік: ${year ?? 'unknown'}.`;

  return {
    dokid: row.dokid,
    nreg: row.nreg,
    nazva: row.nazva,
    status,
    types_raw: row.typesRaw || undefined,
    organs_raw: row.organsRaw || undefined,
    type,
    organ,
    minjust,
    datred,
    year,
    embedding_text,
  };
}

function normalizeDatred(v: string): string | undefined {
  const t = (v || '').trim();
  if (!/^\d{8}$/.test(t)) return undefined;
  return t;
}

function normalizeMinjust(v: string): boolean {
  // In the wild this can be "", "0", "1", "2", etc. We treat any positive int as "true".
  const t = (v || '').trim();
  const n = Number.parseInt(t, 10);
  return Number.isFinite(n) && n > 0;
}

function normalizeFirstCode(raw: string): string | undefined {
  const t = (raw || '').trim();
  if (!t) return undefined;

  // Examples observed:
  // - "95"
  // - "[1,2]"
  // - "70:20260114:"
  // Best-effort: extract the first "token-ish" segment.
  const cleaned = t.replace(/[\[\]\(\)]/g, ' ');
  const tokens = cleaned
    .split(/[\s,;:]+/g)
    .map((x) => x.trim())
    .filter(Boolean);
  return tokens[0] || undefined;
}

