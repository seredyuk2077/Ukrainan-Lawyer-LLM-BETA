/**
 * RunContext — store for query_profile / routing_flags (U2→U3).
 * Interface: get(run_id), set(run_id, payload, ttlSec), del(run_id).
 * Default: InMemoryRunContextStore (dev). Set Redis via setRunContextStore() at startup when REDIS_URL + RUN_CONTEXT_DRIVER=redis.
 */
import type { RunContextStore } from './run-context-store.js';
import { InMemoryRunContextStore } from './run-context-store.js';

const DEFAULT_TTL_SEC = 3600;

let _store: RunContextStore = new InMemoryRunContextStore();

export function setRunContextStore(store: RunContextStore): void {
  _store = store;
}

export function getRunContextStore(): RunContextStore {
  return _store;
}

export async function runContextGet<T>(runId: string): Promise<T | null> {
  return _store.get<T>(runId);
}

export async function runContextSet<T>(runId: string, payload: T, ttlSec: number = DEFAULT_TTL_SEC): Promise<void> {
  await _store.set(runId, payload, ttlSec);
}

export async function runContextDel(runId: string): Promise<void> {
  await _store.del(runId);
}
