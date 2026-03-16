/**
 * Redis RunContextStore — prod (when REDIS_URL + RUN_CONTEXT_DRIVER=redis).
 * Namespace: lexery:runctx:{run_id} — no tenant mixing; run_id is UUID.
 */
import type { Redis } from 'ioredis';
import type { RunContextStore } from './run-context-store.js';

const PREFIX = 'lexery:runctx:';
const DEFAULT_TTL_SEC = 3600;

async function getRedisCtor(): Promise<typeof import('ioredis').default> {
  try {
    const mod = await import('ioredis');
    return mod.default;
  } catch {
    throw new Error('ioredis not installed; add it for Redis RunContextStore (pnpm add ioredis)');
  }
}

export async function createRedisRunContextStore(redisUrl: string): Promise<RunContextStore> {
  const RedisCtor = await getRedisCtor();
  const client: Redis = new RedisCtor(redisUrl, { maxRetriesPerRequest: 3 });

  return {
    async get<T>(runId: string): Promise<T | null> {
      const key = PREFIX + runId;
      const raw = await client.get(key);
      if (raw == null) return null;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    },

    async set<T>(runId: string, data: T, ttlSec: number = DEFAULT_TTL_SEC): Promise<void> {
      const key = PREFIX + runId;
      const value = JSON.stringify(data);
      await client.setex(key, ttlSec, value);
    },

    async del(runId: string): Promise<void> {
      await client.del(PREFIX + runId);
    },

    async shutdown(): Promise<void> {
      try {
        await client.quit();
      } catch {
        try {
          client.disconnect();
        } catch {
          // ignore best-effort shutdown
        }
      }
    },
  };
}
