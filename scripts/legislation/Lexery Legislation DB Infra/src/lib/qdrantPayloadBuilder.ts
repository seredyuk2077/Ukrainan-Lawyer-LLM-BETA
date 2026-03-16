import type { CanonicalDocument } from '../canonical/buildCanonical.js';
import { determineActGroup } from '../canonical/actGrouping.js';
import type { ActPayload, ChunkPayload } from './qdrantRagClient.js';

export interface QdrantPayloadDocRow {
  category?: string | null;
  document_type?: string | null;
  document_type_slug?: string | null;
  r2_key?: string | null;
  summary?: string | null;
  keywords?: unknown;
  topics?: unknown;
  aliases?: unknown;
  validity_status?: string | null;
  source_status_location?: string | null;
  source_status_text?: string | null;
  status_note?: string | null;
}

function toDatredDatetime(datred: string): string {
  if (datred.includes('T')) return datred;
  return `${datred}T00:00:00Z`;
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFC').trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => normalizeString(item))
    .filter((item): item is string => Boolean(item));
}

function resolveSharedFields(canonical: CanonicalDocument, docRow?: QdrantPayloadDocRow) {
  const category = normalizeString(docRow?.category) || normalizeString(canonical.metadata.category) || 'other';
  const documentType =
    normalizeString(docRow?.document_type) || normalizeString(canonical.metadata.document_type) || 'Невідомий акт';
  const documentTypeSlug =
    normalizeString(docRow?.document_type_slug) || normalizeString(canonical.metadata.document_type_slug);
  const r2Key = normalizeString(docRow?.r2_key) || normalizeString(canonical.metadata.r2_key) || '';
  const validityStatus =
    normalizeString(docRow?.validity_status) ||
    normalizeString(canonical.metadata.validity_status) ||
    'unknown';
  const sourceStatusLocation =
    normalizeString(docRow?.source_status_location) ||
    normalizeString(canonical.metadata.source_status_location) ||
    'fallback.no_evidence';
  const sourceStatusText =
    normalizeString(docRow?.source_status_text) ||
    normalizeString(canonical.metadata.source_status_text) ||
    'N/A';
  const statusNote =
    normalizeString(docRow?.status_note) ||
    normalizeString(canonical.metadata.status_note) ||
    'no_evidence';
  const actGroup = determineActGroup({
    title: canonical.metadata.title,
    documentType,
    lawNumber: canonical.metadata.law_number || null,
  });

  return {
    category,
    documentType,
    documentTypeSlug: documentTypeSlug || undefined,
    r2Key,
    validityStatus,
    sourceStatusLocation,
    sourceStatusText,
    statusNote,
    actGroup,
    radaDatred: toDatredDatetime(canonical.metadata.rada_datred),
  };
}

export function buildActPayloadFromCanonical(
  canonical: CanonicalDocument,
  docRow?: QdrantPayloadDocRow
): ActPayload {
  const shared = resolveSharedFields(canonical, docRow);

  return {
    rada_nreg: canonical.metadata.rada_nreg,
    content_hash: canonical.metadata.content_hash,
    previous_hash: canonical.metadata.previous_hash || null,
    title: canonical.metadata.title,
    category: shared.category,
    document_type: shared.documentType,
    document_type_slug: shared.documentTypeSlug,
    rada_datred: shared.radaDatred,
    source_url: canonical.metadata.source_url,
    r2_key: shared.r2Key,
    summary: normalizeString(docRow?.summary) || canonical.metadata.title,
    keywords: normalizeArray(docRow?.keywords),
    topics: normalizeArray(docRow?.topics),
    aliases: normalizeArray(docRow?.aliases),
    act_group_key: shared.actGroup.act_group_key || null,
    act_part_label: shared.actGroup.act_part_label,
    validity_status: shared.validityStatus,
    valid_from: canonical.metadata.valid_from || null,
    valid_to: canonical.metadata.valid_to || null,
    source_status_location: shared.sourceStatusLocation,
    source_status_text: shared.sourceStatusText,
    status_note: shared.statusNote,
  };
}

export function buildChunkPayloadsFromCanonical(
  canonical: CanonicalDocument,
  docRow?: QdrantPayloadDocRow
): ChunkPayload[] {
  const shared = resolveSharedFields(canonical, docRow);

  return canonical.content.chunks.map((chunk) => ({
    rada_nreg: canonical.metadata.rada_nreg,
    content_hash: canonical.metadata.content_hash,
    chunk_index: chunk.chunk_index,
    article_number: chunk.article_number || null,
    chunk_title: chunk.title || null,
    unit_number: chunk.unit_number || chunk.article_number || null,
    unit_type: chunk.unit_type || (chunk.article_number ? 'article' : null),
    token_count: typeof chunk.token_count === 'number' ? chunk.token_count : null,
    r2_key: shared.r2Key,
    json_path: `$.content.chunks[${chunk.chunk_index}].text`,
    category: shared.category,
    document_type: shared.documentType,
    document_type_slug: shared.documentTypeSlug,
    rada_datred: shared.radaDatred,
    title: canonical.metadata.title,
    source_url: canonical.metadata.source_url,
    previous_hash: canonical.metadata.previous_hash || null,
    act_group_key: shared.actGroup.act_group_key || null,
    act_part_label: shared.actGroup.act_part_label,
    validity_status: shared.validityStatus,
    valid_from: canonical.metadata.valid_from || null,
    valid_to: canonical.metadata.valid_to || null,
    source_status_location: shared.sourceStatusLocation,
    source_status_text: shared.sourceStatusText,
    status_note: shared.statusNote,
  }));
}
