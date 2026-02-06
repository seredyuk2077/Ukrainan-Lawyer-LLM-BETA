/**
 * U1 Rate Limits / Budget (LEX-70)
 */
import { config } from '../lib/config.js';

const windowMs = 60 * 1000; // 1 minute
const counters = new Map<string, { count: number; resetAt: number }>();

export interface LimitCheckResult {
  allowed: boolean;
  remaining?: number;
  error?: string;
}

export function checkRateLimit(tenantId: string): LimitCheckResult {
  const key = `tenant:${tenantId}`;
  const now = Date.now();
  let entry = counters.get(key);

  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + windowMs };
    counters.set(key, entry);
  }

  entry.count += 1;

  if (entry.count > config.runsPerMinute) {
    return {
      allowed: false,
      remaining: 0,
      error: 'ERR_BUDGET_EXHAUSTED',
    };
  }

  return {
    allowed: true,
    remaining: Math.max(0, config.runsPerMinute - entry.count),
  };
}

// Simple active runs counter (stub)
const activeRuns = new Map<string, number>();

export function checkConcurrentRuns(tenantId: string): LimitCheckResult {
  const key = `active:${tenantId}`;
  const current = activeRuns.get(key) || 0;

  if (current >= config.maxConcurrentRuns) {
    return {
      allowed: false,
      error: 'ERR_BUDGET_EXHAUSTED',
    };
  }

  activeRuns.set(key, current + 1);
  return { allowed: true };
}

export function decrementActiveRuns(tenantId: string): void {
  const key = `active:${tenantId}`;
  const current = activeRuns.get(key) || 0;
  if (current > 0) {
    activeRuns.set(key, current - 1);
  }
}
