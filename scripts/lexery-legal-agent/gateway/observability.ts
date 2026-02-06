/**
 * U1 Observability (LEX-74) — Metrics stub
 */
const metrics: Record<string, number> = {
  runs_started_total: 0,
  runs_rejected_total: 0,
  runs_failed_total: 0,
  enqueue_latency_ms: 0,
  db_write_latency_ms: 0,
};

export function incrementRunsStarted() {
  metrics.runs_started_total += 1;
}

export function incrementRunsRejected(reason: string) {
  metrics.runs_rejected_total += 1;
}

export function incrementRunsFailed(reason: string) {
  metrics.runs_failed_total += 1;
}

export function recordEnqueueLatency(ms: number) {
  metrics.enqueue_latency_ms = ms;
}

export function recordDbWriteLatency(ms: number) {
  metrics.db_write_latency_ms = ms;
}

export function getMetrics() {
  return { ...metrics };
}
