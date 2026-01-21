import { isNonEmptyString } from './utils.js';

export interface RawCatalogRow {
  dokid: number;
  nreg: string;
  nazva: string;
  statusRaw: string;
  typesRaw: string;
  organsRaw: string;
  minjustRaw: string;
  datredRaw: string;
}

export type ParseResult =
  | { ok: true; row: RawCatalogRow }
  | { ok: false; reason: string };

export function parseDocTsvLine(line: string): ParseResult {
  const cols = line.split('\t');
  if (cols.length < 9) return { ok: false, reason: `expected >=9 columns, got ${cols.length}` };

  const dokidStr = (cols[0] ?? '').trim();
  const nreg = (cols[1] ?? '').trim();
  const nazva = normalizeNazva(cols[2] ?? '');
  const statusRaw = (cols[3] ?? '').trim();
  const typesRaw = (cols[4] ?? '').trim();
  const organsRaw = (cols[5] ?? '').trim();
  const minjustRaw = (cols[7] ?? '').trim();
  const datredRaw = (cols[8] ?? '').trim();

  const dokid = Number.parseInt(dokidStr, 10);
  if (!Number.isFinite(dokid)) return { ok: false, reason: `invalid dokid: "${dokidStr}"` };
  if (!isNonEmptyString(nreg)) return { ok: false, reason: 'missing nreg' };
  if (!isNonEmptyString(nazva)) return { ok: false, reason: 'missing nazva' };

  return {
    ok: true,
    row: {
      dokid,
      nreg,
      nazva,
      statusRaw,
      typesRaw,
      organsRaw,
      minjustRaw,
      datredRaw,
    },
  };
}

function normalizeNazva(v: string): string {
  return v
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^["']|["']$/g, '')
    .trim();
}

