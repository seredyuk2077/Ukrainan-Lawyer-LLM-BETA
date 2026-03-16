import type { AttachmentManifestItem, RunSnapshot } from '../../gateway/types.js';
import { ingestMmDocFromRawR2 } from './ingest.js';

export interface MmDocRunAttachmentCandidate {
  name: string;
  r2_key: string;
  content_type?: string | null;
  requested_scope?: 'conversation' | 'project' | 'user_global' | null;
}

function isRequestedScope(
  value: unknown
): value is 'conversation' | 'project' | 'user_global' {
  return value === 'conversation' || value === 'project' || value === 'user_global';
}

function isUrlLikeR2Key(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

export function extractMmDocAttachmentCandidates(params: {
  snapshot?: RunSnapshot | null;
  attachmentsManifest?: AttachmentManifestItem[] | null;
}): MmDocRunAttachmentCandidate[] {
  const requestedScope = isRequestedScope(params.snapshot?.project_context?.mm_doc_scope)
    ? params.snapshot?.project_context?.mm_doc_scope
    : null;
  const manifest = params.attachmentsManifest ?? [];
  const seen = new Set<string>();
  const out: MmDocRunAttachmentCandidate[] = [];

  for (const item of manifest) {
    if (item.storage !== 'r2' || !item.r2_key) continue;
    if (item.mm_doc_candidate !== true) continue;
    if (isUrlLikeR2Key(item.r2_key)) continue;
    const dedupeKey = `${item.r2_key}::${item.name}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({
      name: item.name,
      r2_key: item.r2_key,
      content_type: item.content_type ?? null,
      requested_scope: requestedScope,
    });
  }

  return out;
}

export async function ingestMmDocsFromRun(params: {
  runId: string;
  tenantId: string | null;
  userId: string;
  conversationId?: string | null;
  projectId?: string | null;
  snapshot?: RunSnapshot | null;
  attachmentsManifest?: AttachmentManifestItem[] | null;
  ingestFn?: typeof ingestMmDocFromRawR2;
}): Promise<Array<{ docId: string; canonicalR2Key: string; chunkCount: number; filename: string }>> {
  const candidates = extractMmDocAttachmentCandidates({
    snapshot: params.snapshot,
    attachmentsManifest: params.attachmentsManifest,
  });
  const ingestFn = params.ingestFn ?? ingestMmDocFromRawR2;
  const out: Array<{ docId: string; canonicalR2Key: string; chunkCount: number; filename: string }> = [];

  for (const candidate of candidates) {
    const result = await ingestFn({
      tenantId: params.tenantId,
      userId: params.userId,
      conversationId: params.conversationId ?? null,
      projectId: params.projectId ?? null,
      requestedScope: candidate.requested_scope ?? null,
      runId: params.runId,
      sourceKind: candidate.requested_scope === 'project' ? 'project_upload' : 'chat_attachment',
      rawR2Key: candidate.r2_key,
      filename: candidate.name,
      contentType: candidate.content_type ?? undefined,
    });
    out.push({
      ...result,
      filename: candidate.name,
    });
  }

  return out;
}
