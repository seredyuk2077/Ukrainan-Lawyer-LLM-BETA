/**
 * RunContextStore — interface for query_profile + routing_flags (U2→U3).
 * Implementations: InMemory (dev), Redis (prod when REDIS_URL set).
 */
export interface RunContextStore {
  get<T>(runId: string): Promise<T | null>;
  set<T>(runId: string, data: T, ttlSec: number): Promise<void>;
  del(runId: string): Promise<void>;
  shutdown?(): Promise<void>;
}

const DEFAULT_TTL_SEC = 3600;

interface Entry<T> {
  payload: T;
  expiresAt: number;
}

/** In-memory store (dev). Keyed by run_id only; no tenant prefix needed — run_id is UUID. */
export class InMemoryRunContextStore implements RunContextStore {
  private store = new Map<string, Entry<unknown>>();

  private prune(): void {
    const now = Date.now();
    for (const [k, v] of this.store.entries()) {
      if (v.expiresAt <= now) this.store.delete(k);
    }
  }

  async get<T>(runId: string): Promise<T | null> {
    this.prune();
    const entry = this.store.get(runId) as Entry<T> | undefined;
    if (!entry || entry.expiresAt <= Date.now()) return null;
    return entry.payload;
  }

  async set<T>(runId: string, data: T, ttlSec: number = DEFAULT_TTL_SEC): Promise<void> {
    this.store.set(runId, {
      payload: data,
      expiresAt: Date.now() + ttlSec * 1000,
    });
  }

  async del(runId: string): Promise<void> {
    this.store.delete(runId);
  }
}
