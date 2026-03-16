/**
 * Unified R2 key namespace for new writes.
 * Pattern: tenant/{tenant_id}/runs/{run_id}/... or tenant/{tenant_id}/mm/...
 * Legacy keys (runs/{tenant}/{run}/...) remain readable; new writes use this module.
 */
const DEFAULT_TENANT = 'dev-tenant';
const DEFAULT_SCOPE_ID = 'global';

function safeSegment(value: string | null | undefined): string {
  const trimmed = (value || DEFAULT_SCOPE_ID).trim();
  return (trimmed.replace(/[^\w.-]+/g, '_').slice(0, 255) || DEFAULT_SCOPE_ID);
}

function resolveTenantSegment(tenantId: string | null | undefined, fallback = DEFAULT_TENANT): string {
  return tenantId || fallback;
}

export function r2KeyQuery(tenantId: string, runId: string): string {
  const tenant = resolveTenantSegment(tenantId);
  return `tenant/${tenant}/runs/${runId}/input/query.txt`;
}

export function r2KeyAttachment(tenantId: string, runId: string, filename: string): string {
  const tenant = resolveTenantSegment(tenantId);
  return `tenant/${tenant}/runs/${runId}/attachments/${filename}`;
}

export function r2KeyRetrievalTrace(tenantId: string, runId: string): string {
  const tenant = resolveTenantSegment(tenantId);
  return `tenant/${tenant}/runs/${runId}/retrieval/trace_full.v1.json`;
}

export function r2KeyMmOffload(tenantId: string, memoryItemId: string): string {
  const tenant = resolveTenantSegment(tenantId);
  return `tenant/${tenant}/mm/offload/${memoryItemId}.json`;
}

export type MmDocScopeKey = 'conversation' | 'project' | 'user_global';

export function r2KeyMmDocRaw(
  tenantId: string,
  userId: string,
  docId: string,
  filename: string
): string {
  const tenant = resolveTenantSegment(tenantId, 'global');
  const user = safeSegment(userId || 'anonymous');
  const file = safeSegment(filename || 'document');
  return `tenant/${tenant}/mm/docs/user/${user}/raw/${docId}/${file}`;
}

export function r2KeyMmDocCanonical(
  tenantId: string,
  userId: string,
  scopeType: MmDocScopeKey,
  scopeId: string | null | undefined,
  docId: string
): string {
  const tenant = resolveTenantSegment(tenantId, 'global');
  const user = safeSegment(userId || 'anonymous');
  const scope = safeSegment(scopeId);
  return `tenant/${tenant}/mm/docs/user/${user}/scope/${scopeType}/${scope}/${docId}/canonical.v1.json`;
}

function legacyMmDocRawPrefix(tenantId: string | null | undefined, userId: string): string {
  const tenant = resolveTenantSegment(tenantId, 'global');
  const user = safeSegment(userId || 'anonymous');
  return `tenant/${tenant}/mm/docs/${user}/raw/`;
}

function legacyMmDocCanonicalKey(params: {
  tenantId: string | null | undefined;
  userId: string;
  scopeType: MmDocScopeKey;
  scopeId: string | null | undefined;
  docId: string;
}): string {
  const tenant = resolveTenantSegment(params.tenantId, 'global');
  const user = safeSegment(params.userId || 'anonymous');
  const scope = safeSegment(params.scopeId);
  return `tenant/${tenant}/mm/docs/${user}/scope/${params.scopeType}/${scope}/${params.docId}/canonical.json`;
}

export function isRunsAttachmentKeyForTenant(params: {
  tenantId: string | null | undefined;
  r2Key: string;
}): boolean {
  const tenant = resolveTenantSegment(params.tenantId);
  return params.r2Key.startsWith(`tenant/${tenant}/runs/`) && params.r2Key.includes('/attachments/');
}

export function extractRunIdFromRunsAttachmentKey(r2Key: string): string | null {
  const match = r2Key.match(/^tenant\/[^/]+\/runs\/([^/]+)\/attachments\/.+$/);
  return match?.[1] ?? null;
}

export function isMmDocRawKeyForIdentity(params: {
  tenantId: string | null | undefined;
  userId: string;
  r2Key: string;
}): boolean {
  const tenant = resolveTenantSegment(params.tenantId, 'global');
  const user = safeSegment(params.userId || 'anonymous');
  return (
    params.r2Key.startsWith(`tenant/${tenant}/mm/docs/user/${user}/raw/`) ||
    params.r2Key.startsWith(legacyMmDocRawPrefix(params.tenantId, params.userId))
  );
}

export function isMmDocCanonicalKeyForRecord(params: {
  tenantId: string | null | undefined;
  userId: string;
  scopeType: MmDocScopeKey;
  scopeId: string | null | undefined;
  docId: string;
  r2Key: string;
}): boolean {
  return (
    params.r2Key ===
      r2KeyMmDocCanonical(
        resolveTenantSegment(params.tenantId, 'global'),
        params.userId,
        params.scopeType,
        params.scopeId,
        params.docId
      ) ||
    params.r2Key ===
      legacyMmDocCanonicalKey({
        tenantId: params.tenantId,
        userId: params.userId,
        scopeType: params.scopeType,
        scopeId: params.scopeId,
        docId: params.docId,
      })
  );
}

export function isAllowedInternalAttachmentReference(params: {
  tenantId: string | null | undefined;
  userId: string;
  r2Key: string;
}): boolean {
  return (
    isRunsAttachmentKeyForTenant({
      tenantId: params.tenantId,
      r2Key: params.r2Key,
    }) ||
    isMmDocRawKeyForIdentity({
      tenantId: params.tenantId,
      userId: params.userId,
      r2Key: params.r2Key,
    })
  );
}
