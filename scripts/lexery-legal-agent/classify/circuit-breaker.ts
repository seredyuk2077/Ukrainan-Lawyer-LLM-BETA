/**
 * Circuit breaker for U2 LLM — after many timeouts/429/5xx, temporarily use rules/degraded.
 * Config: U2_CIRCUIT_FAILURE_THRESHOLD (e.g. 5), U2_CIRCUIT_WINDOW_SEC (e.g. 60), U2_CIRCUIT_OPEN_SEC (e.g. 30).
 */
const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_OPEN_MS = 30_000;

let failureTimestamps: number[] = [];
let openedAt: number | null = null;

function getConfig() {
  const threshold = Math.max(1, parseInt(process.env.U2_CIRCUIT_FAILURE_THRESHOLD || String(DEFAULT_FAILURE_THRESHOLD), 10));
  const windowMs = Math.max(1000, parseInt(process.env.U2_CIRCUIT_WINDOW_SEC || '60', 10) * 1000);
  const openMs = Math.max(5000, parseInt(process.env.U2_CIRCUIT_OPEN_SEC || '30', 10) * 1000);
  return { threshold, windowMs, openMs };
}

function prune(now: number, windowMs: number): void {
  const cutoff = now - windowMs;
  failureTimestamps = failureTimestamps.filter((t) => t > cutoff);
}

/** Call when LLM fails (timeout, 429, 5xx). */
export function recordLlmFailure(): void {
  const now = Date.now();
  const { windowMs, threshold, openMs } = getConfig();
  prune(now, windowMs);
  failureTimestamps.push(now);
  if (failureTimestamps.length >= threshold) {
    openedAt = now;
  }
}

/** Returns true if circuit is open — caller should skip LLM and use rules/degraded. */
export function isCircuitOpen(): boolean {
  const now = Date.now();
  const { windowMs, threshold, openMs } = getConfig();
  prune(now, windowMs);
  if (openedAt != null) {
    if (now - openedAt >= openMs) {
      openedAt = null;
      return false;
    }
    return true;
  }
  return failureTimestamps.length >= threshold;
}

/** Reset (e.g. for tests). */
export function resetCircuit(): void {
  failureTimestamps = [];
  openedAt = null;
}
