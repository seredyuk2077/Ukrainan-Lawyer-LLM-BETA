/**
 * Lexery Legal Agent — Config
 */
import dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(process.cwd(), '.env') });
dotenv.config({ path: resolve(__dirname, '../.env') });

export const config = {
  port: parseInt(process.env.BRAIN_PORT || '3081', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  isDev: process.env.NODE_ENV !== 'production',

  // Dev auth (LEX-69)
  devApiKey: process.env.DEV_API_KEY || '',
  devAllowAnonymous: process.env.DEV_ALLOW_ANONYMOUS === 'true',

  // Supabase (LEXERY LEGAL AGENT DB)
  supabaseUrl: process.env.SUPABASE_LEXERY_LEGAL_AGENT_DB_URL || '',
  supabaseServiceKey: process.env.SUPABASE_LEXERY_LEGAL_AGENT_DB_SERVICE_ROLE_KEY || '',

  // R2 (for attachments overflow)
  r2Endpoint: process.env.R2_ENDPOINT || '',
  r2AccessKey: process.env.R2_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY || '',
  r2SecretKey: process.env.R2_SECRET_ACCESS_KEY || process.env.R2_SECRET_KEY || '',
  r2BucketRuns: process.env.R2_RUNS_BUCKET || process.env.R2_BUCKET_RUNS || 'lexery-legal-agent',
  r2BucketLegislation: process.env.R2_LEGISLATION_BUCKET || 'legislation',
  r2Region: process.env.R2_REGION || 'auto',

  // Limits (LEX-70)
  runsPerMinute: parseInt(process.env.RUNS_PER_MINUTE || '30', 10),
  maxConcurrentRuns: parseInt(process.env.MAX_CONCURRENT_RUNS || '10', 10),

  // Attachments (LEX-72)
  attachmentInlineMaxBytes: parseInt(process.env.ATTACHMENT_INLINE_MAX_BYTES || '524288', 10), // 512KB
  requestInlineMaxBytes: parseInt(process.env.REQUEST_INLINE_MAX_BYTES || '2097152', 10), // 2MB

  // API version
  apiVersion: 'v1',
} as const;

export function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env: ${name}`);
  return val;
}
