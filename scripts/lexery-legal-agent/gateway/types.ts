/**
 * U1 Gateway — Types (LEX-68)
 */
import { z } from 'zod';

// --- Request ---
export const AttachmentInputSchema = z.object({
  name: z.string().min(1).max(255),
  contentType: z.string().optional(),
  contentBase64: z.string().optional(),
  presignedUrl: z.string().url().optional(),
});

export const CreateRunRequestSchema = z.object({
  query: z.string().min(1).max(50000),
  tenant_id: z.string().uuid().optional(),
  user_id: z.string().uuid().optional(),
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
export type RunEventStep = 'U2' | 'U3' | 'U3a' | 'U4' | 'U5' | 'U6' | 'U9';

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
}

export interface AttachmentManifestItem {
  name: string;
  size: number;
  sha256?: string;
  storage: 'inline' | 'r2';
  r2_key?: string;
}
