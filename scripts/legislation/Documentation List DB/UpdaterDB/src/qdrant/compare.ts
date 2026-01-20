import { truncate } from '../utils.js';

export interface DocCardPayload {
  nreg: string;
  dokid: number;
  nazva: string;
  type: string;
  organ: string;
  status: string;
  year: number | null;
  datred: string | null; // YYYYMMDD
  minjust: boolean;
  source_system: 'rada';
  is_in_supabase: boolean;
  supabase_doc_id: string | null;
  types_raw?: string;
  organs_raw?: string;
}

export const DOC_PAYLOAD_KEYS_ORDERED: Array<keyof DocCardPayload> = [
  'nreg',
  'dokid',
  'nazva',
  'type',
  'organ',
  'status',
  'year',
  'datred',
  'minjust',
  'source_system',
  'is_in_supabase',
  'supabase_doc_id',
  'types_raw',
  'organs_raw',
];

function isYYYYMMDD(v: unknown): v is string {
  return typeof v === 'string' && /^\d{8}$/.test(v);
}

function normalizeBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  const t = typeof v === 'string' ? v.trim() : '';
  if (t === 'true') return true;
  if (t === 'false') return false;
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number.parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0;
}

function normalizeOptionalString(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t : undefined;
}

function normalizeOptionalNumber(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number.parseInt(v, 10) : NaN;
  if (!Number.isFinite(n)) return undefined;
  return n;
}

export function canonicalizePayload(input: Partial<DocCardPayload>): DocCardPayload {
  const nreg = String(input.nreg || '').trim();
  const dokid = typeof input.dokid === 'number' ? input.dokid : Number.parseInt(String(input.dokid || ''), 10);

  const nazva = truncate(String(input.nazva || '').trim().replace(/\s+/g, ' '), 800);
  const type = truncate(String(input.type || '').trim(), 200);
  const organ = truncate(String(input.organ || '').trim(), 200);
  const status = truncate(String(input.status || '').trim(), 50);

  const year = input.year === null ? null : normalizeOptionalNumber(input.year) ?? null;
  const datred = input.datred === null ? null : isYYYYMMDD(input.datred) ? input.datred : null;
  const minjust = normalizeBool(input.minjust);

  // Always keep these keys present.
  const source_system: 'rada' = 'rada';
  const is_in_supabase = Boolean(input.is_in_supabase);
  const supabase_doc_id = input.supabase_doc_id ? String(input.supabase_doc_id) : null;

  const types_raw = normalizeOptionalString(input.types_raw);
  const organs_raw = normalizeOptionalString(input.organs_raw);

  if (!nreg) throw new Error('payload: missing nreg');
  if (!Number.isFinite(dokid)) throw new Error('payload: missing/invalid dokid');

  const payload: DocCardPayload = {
    nreg,
    dokid,
    nazva,
    type: type || 'unknown',
    organ: organ || 'unknown',
    status: status || 'unknown',
    year,
    datred,
    minjust,
    source_system,
    is_in_supabase,
    supabase_doc_id,
    ...(types_raw ? { types_raw } : {}),
    ...(organs_raw ? { organs_raw } : {}),
  };
  return payload;
}

export function payloadEquals(a: DocCardPayload, b: DocCardPayload): boolean {
  // Compare only the schema keys and require identical key presence + identical primitive values.
  for (const k of DOC_PAYLOAD_KEYS_ORDERED) {
    const hasA = Object.prototype.hasOwnProperty.call(a, k);
    const hasB = Object.prototype.hasOwnProperty.call(b, k);
    if (hasA !== hasB) return false;
    if (!hasA) continue;
    const va = (a as any)[k];
    const vb = (b as any)[k];
    if (va !== vb) return false;
  }
  return true;
}

