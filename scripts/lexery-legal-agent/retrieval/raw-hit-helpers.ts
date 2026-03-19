import type { RawHit, RawHitSource, SampleHit } from './types.js';
import { buildHitCitationPath } from './structural-citation.js';

function readString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload?.[key];
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFC').trim();
  return normalized.length > 0 ? normalized : null;
}

export function payloadToRawHit(
  hit: { score: number; payload: Record<string, unknown> },
  source: Extract<RawHitSource, 'lldbi_chunks' | 'lldbi_acts'>
): RawHit {
  const p = hit.payload;
  return {
    r2_key: String(p?.r2_key ?? ''),
    json_path: String(p?.json_path ?? ''),
    score: hit.score,
    source,
    rada_nreg: readString(p, 'rada_nreg') ?? undefined,
    article_number: readString(p, 'article_number'),
    unit_number: readString(p, 'unit_number'),
    unit_type: readString(p, 'unit_type'),
    article_part_number: readString(p, 'article_part_number'),
    point_number: readString(p, 'point_number'),
    subpoint_number: readString(p, 'subpoint_number'),
    paragraph_number: readString(p, 'paragraph_number'),
    note_number: readString(p, 'note_number'),
    citation_path: readString(p, 'citation_path'),
    title: readString(p, 'title') ?? undefined,
    document_type: readString(p, 'document_type'),
    document_type_slug: readString(p, 'document_type_slug'),
    category: readString(p, 'category'),
    storage_category: readString(p, 'storage_category'),
    validity_status: readString(p, 'validity_status'),
    unstructured_fallback: p?.unstructured_fallback === true,
    metadata: p ? { ...p } : undefined,
  };
}

export function buildSampleHits(hits: RawHit[]): SampleHit[] {
  return hits.slice(0, 5).map((hit) => ({
    source: hit.source,
    score: hit.score,
    r2_key: hit.r2_key,
    json_path: hit.json_path,
    act_title: hit.title,
    article_ref: hit.article_number ?? null,
    unit_ref: hit.unit_number ?? null,
    unit_type: hit.unit_type ?? null,
    citation_ref: buildHitCitationPath(hit),
  }));
}
