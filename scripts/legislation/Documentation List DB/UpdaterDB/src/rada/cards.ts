import type { Logger } from 'pino';
import { safeUrl } from '../utils.js';
import type { RadaHttpClient } from './client.js';
import { encodeNregForPath } from './nreg.js';
import type { DocCardPayload } from '../qdrant/compare.js';

export const RADA_CARD_BASE_URL = 'https://data.rada.gov.ua/laws/card/';

export interface NormalizedCard {
  nreg: string;
  dokid: number;
  payload: DocCardPayload;
  embedding_text: string;
}

function normalizeDatred(v: unknown): string | null {
  const t = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
  if (!/^\d{8}$/.test(t)) return null;
  return t;
}

function normalizeMinjust(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  const t = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
  const n = Number.parseInt(t, 10);
  return Number.isFinite(n) && n > 0;
}

function normalizeFirstCode(raw: unknown): string | undefined {
  const t = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (!t) return undefined;
  const cleaned = t.replace(/[\[\]\(\)]/g, ' ');
  const tokens = cleaned
    .split(/[\s,;:]+/g)
    .map((x) => x.trim())
    .filter(Boolean);
  return tokens[0] || undefined;
}

export async function fetchAndNormalizeCard(params: {
  logger: Logger;
  client: RadaHttpClient;
  nreg: string;
}): Promise<NormalizedCard> {
  const encoded = encodeNregForPath(params.nreg);
  const url = `${RADA_CARD_BASE_URL}${encoded}.json`;
  const res = await params.client.fetchJson<any>(url);
  if (!res.ok || res.status !== 200) {
    throw new Error(`Failed to fetch card JSON: ${safeUrl(url)} (status=${res.status})`);
  }

  const j: any = res.data || {};

  const nreg = String(j.nreg || params.nreg || '').trim();
  const dokid = typeof j.dokid === 'number' ? j.dokid : Number.parseInt(String(j.dokid || ''), 10);
  const nazva = String(j.nazva || '').trim().replace(/\s+/g, ' ');

  if (!nreg) {
    throw new Error(`Card JSON missing nreg: ${safeUrl(url)}`);
  }
  if (!Number.isFinite(dokid) || dokid <= 0) {
    throw new Error(`Card JSON missing/invalid dokid for nreg="${nreg}": ${safeUrl(url)}`);
  }

  // "types" is the raw type codes string (e.g. "6|5"); "typ" is sometimes the first code (e.g. 6).
  const types_raw = typeof j.types === 'string' ? j.types.trim() : typeof j.typ !== 'undefined' ? String(j.typ).trim() : '';
  // "organs" is the raw organ string (e.g. "2:20220119:70-р"); "org" is sometimes the first code (e.g. 2).
  const organs_raw = typeof j.organs === 'string' ? j.organs.trim() : typeof j.org !== 'undefined' ? String(j.org).trim() : '';

  const type = normalizeFirstCode(types_raw) || 'unknown';
  const organ = normalizeFirstCode(organs_raw) || 'unknown';

  const status = typeof j.status === 'number' ? String(j.status) : typeof j.status === 'string' ? j.status.trim() : 'unknown';
  const datred = normalizeDatred(j.datred);
  const year = datred ? Number.parseInt(datred.slice(0, 4), 10) : null;
  const minjust = normalizeMinjust(j.minjust);

  const embedding_text = `${nazva}. Тип: ${type}. Орган: ${organ}. Рік: ${year ?? 'unknown'}.`;

  const payload: DocCardPayload = {
    nreg,
    dokid,
    nazva,
    type,
    organ,
    status,
    year,
    datred,
    minjust,
    source_system: 'rada',
    is_in_supabase: false,
    supabase_doc_id: null,
    ...(types_raw ? { types_raw } : {}),
    ...(organs_raw ? { organs_raw } : {}),
  };

  params.logger.debug({ nreg, dokid }, 'rada card normalized');
  return { nreg, dokid, payload, embedding_text };
}

