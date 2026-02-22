/**
 * U8 Import — ImportJob + FastModeResult contracts (LEX-108)
 */
import { z } from 'zod';

export const ImportJobSchema = z.object({
  rada_nreg: z.string().min(1),
  run_id: z.string().uuid().optional(),
  priority: z.number().int().min(0).optional(),
  status: z.enum(['pending', 'running', 'done', 'failed', 'skipped']).optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});

export type ImportJob = z.infer<typeof ImportJobSchema>;

export const FastModeResultSchema = z.object({
  imported: z.array(z.string()),
  queued: z.array(z.string()),
  timed_out: z.boolean().optional(),
  degraded_reason: z.string().optional(),
});

export type FastModeResult = z.infer<typeof FastModeResultSchema>;
