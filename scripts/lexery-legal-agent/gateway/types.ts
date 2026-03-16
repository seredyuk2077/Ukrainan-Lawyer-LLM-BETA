/**
 * U1 Gateway — Types (LEX-68)
 */
import { z } from 'zod';

function isValidAttachmentBase64(value: string): boolean {
  const normalized = value.replace(/\s+/g, '');
  if (normalized.length === 0) return false;
  const canonical = normalized.replace(/-/g, '+').replace(/_/g, '/');
  if (canonical.length % 4 === 1) return false;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(canonical)) return false;
  try {
    const decoded = Buffer.from(canonical, 'base64');
    if (decoded.length === 0) return false;
    const reEncoded = decoded.toString('base64').replace(/=+$/, '');
    return reEncoded === canonical.replace(/=+$/, '');
  } catch {
    return false;
  }
}

// --- Request ---
export const AttachmentInputSchema = z
  .object({
    name: z.string().min(1).max(255),
    contentType: z.string().optional(),
    contentBase64: z.string().optional(),
    presignedUrl: z.string().url().optional(),
  })
  .superRefine((value, ctx) => {
    const hasInline = typeof value.contentBase64 === 'string' && value.contentBase64.length > 0;
    const hasPresigned = typeof value.presignedUrl === 'string' && value.presignedUrl.length > 0;
    if (hasInline === hasPresigned) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Attachment must provide exactly one source: contentBase64 or presignedUrl',
        path: ['contentBase64'],
      });
    }
    if (hasInline && !isValidAttachmentBase64(value.contentBase64!)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Attachment contentBase64 must be valid base64 data',
        path: ['contentBase64'],
      });
    }
  });

export const CreateRunRequestSchema = z.object({
  query: z.string().min(1).max(50000),
  tenant_id: z.string().uuid().optional(),
  user_id: z.string().uuid().optional(),
  conversation_id: z.string().max(255).optional(),
  locale: z.string().max(16).optional(),
  client_context: z.record(z.unknown()).optional(),
  attachments: z.array(AttachmentInputSchema).optional().default([]),
  dry_run: z.boolean().optional().default(false),
  debug: z.boolean().optional().default(false),
  idempotency_key: z.string().max(128).optional(),
  allow_anonymous: z.boolean().optional(), // dev only
});

export type CreateRunRequest = z.infer<typeof CreateRunRequestSchema>;
export type AttachmentInput = z.infer<typeof AttachmentInputSchema>;

// --- Response ---
export interface CreateRunResponse {
  run_id: string;
  status: 'accepted' | 'dry_run_accepted';
  accepted_at: string;
  degraded?: boolean;
  warnings?: string[];
}

// --- Auth ---
export interface AuthContext {
  tenant_id: string;
  user_id: string;
  plan_tier: string;
  features: Record<string, boolean>;
}

// --- Queue ---
export type RunEventStep = 'U2' | 'U3' | 'U3a' | 'U4' | 'U5' | 'U6' | 'U9' | 'U10' | 'U11' | 'U12';

export interface RunEvent {
  run_id: string;
  step: RunEventStep;
  created_at: string;
  trace_id?: string;
}

// --- RunRecord / Snapshot ---
export interface QueryOverflowRef {
  storage: 'r2';
  r2_bucket: string;
  r2_key: string;
  content_type: string;
  original_length: number;
}

export interface QueryPreview {
  head: string;
  tail: string;
  original_length: number;
  effective_length_hint: number;
}

export interface SnapshotInput {
  query_overflow: boolean;
  query_ref?: QueryOverflowRef | null;
  query_preview?: QueryPreview;
  input_overflow_store_failed?: boolean;
}

export interface RunSnapshot {
  request?: Partial<CreateRunRequest>;
  auth?: AuthContext;
  flags?: { dry_run: boolean; debug: boolean };
  version?: { api_version: string; service?: string };
  input?: SnapshotInput;
  project_context?: {
    project_id?: string | null;
    mm_doc_scope?: 'conversation' | 'project' | 'user_global' | null;
  };
}

export interface AttachmentManifestItem {
  name: string;
  size: number;
  sha256?: string;
  content_type?: string;
  storage: 'inline' | 'r2';
  r2_key?: string;
  mm_doc_candidate?: boolean;
}
