/**
 * Redis Streams–based task queue for at-least-once durable processing.
 * Uses consumer group, XACK on success, retry stream with retry_count, DLQ after max retries,
 * and XAUTOCLAIM to reclaim pending messages abandoned by crashed consumers.
 *
 * Streams:
 *   - lexery:stream:run_events — main
 *   - lexery:stream:run_events_retry — retries (same consumer group)
 *   - lexery:stream:run_events_dlq — dead-letter after max retries
 *
 * Optional verifier/runtime isolation:
 *   - REDIS_QUEUE_NAMESPACE=lexery:verify:mm:123 → namespace-scoped streams/groups
 *   - REDIS_QUEUE_GROUP_NAME=custom_consumers → override only the consumer group name
 */
import type { RunEvent } from './types.js';
import type { TaskQueue } from './queue.js';
import { logger } from '../lib/logger.js';

const DEFAULT_STREAM_MAIN = 'lexery:stream:run_events';
const DEFAULT_STREAM_RETRY = 'lexery:stream:run_events_retry';
const DEFAULT_STREAM_DLQ = 'lexery:stream:run_events_dlq';
const DEFAULT_GROUP_NAME = 'lexery_consumers';
/** Main stream block (ms). Retry stream uses shorter block so retries are processed promptly. */
const BLOCK_MS = parseInt(process.env.REDIS_QUEUE_BLOCK_MS ?? '5000', 10);
/** Retry stream: short block so we don't starve retries behind main-stream blocking. */
const BLOCK_RETRY_MS = Math.min(2000, Math.max(100, parseInt(process.env.REDIS_QUEUE_RETRY_BLOCK_MS ?? '500', 10)));
const MAX_RETRIES = 3;
/** Min idle time (ms) before claiming pending messages from another consumer. Override in tests via REDIS_RECLAIM_MIN_IDLE_MS. */
const PENDING_MIN_IDLE_MS = process.env.REDIS_RECLAIM_MIN_IDLE_MS
  ? parseInt(process.env.REDIS_RECLAIM_MIN_IDLE_MS, 10)
  : 60000;
type EventHandler = (event: RunEvent) => void | Promise<void>;

async function createRedisClient(redisUrl: string): Promise<import('ioredis').Redis> {
  const mod = await import('ioredis').catch((e) => {
    throw new Error('ioredis required for Redis queue (pnpm add ioredis): ' + (e as Error).message);
  });
  return new (mod.default)(redisUrl, { maxRetriesPerRequest: 3 });
}

function parsePayload(payload: string): { event: RunEvent; retry_count: number } {
  const raw = JSON.parse(payload) as { event?: RunEvent; retry_count?: number } | RunEvent;
  if (raw && typeof raw === 'object' && 'run_id' in raw) {
    return { event: raw as RunEvent, retry_count: 0 };
  }
  const wrapped = raw as { event?: RunEvent; retry_count?: number };
  return {
    event: (wrapped?.event ?? raw) as RunEvent,
    retry_count: typeof wrapped?.retry_count === 'number' ? wrapped.retry_count : 0,
  };
}

export interface RedisQueueOptions {
  redisUrl: string;
  /** Test isolation: use unique stream/group names so tests do not share production streams. */
  streamMain?: string;
  streamRetry?: string;
  streamDlq?: string;
  groupName?: string;
}

export interface RedisQueueNames {
  streamMain: string;
  streamRetry: string;
  streamDlq: string;
  groupName: string;
}

export function getDefaultRedisQueueNames(env: NodeJS.ProcessEnv = process.env): RedisQueueNames {
  const namespace = env.REDIS_QUEUE_NAMESPACE?.trim();
  const groupOverride = env.REDIS_QUEUE_GROUP_NAME?.trim();
  if (!namespace) {
    return {
      streamMain: DEFAULT_STREAM_MAIN,
      streamRetry: DEFAULT_STREAM_RETRY,
      streamDlq: DEFAULT_STREAM_DLQ,
      groupName: groupOverride || DEFAULT_GROUP_NAME,
    };
  }
  return {
    streamMain: `${namespace}:stream:run_events`,
    streamRetry: `${namespace}:stream:run_events_retry`,
    streamDlq: `${namespace}:stream:run_events_dlq`,
    groupName: groupOverride || `${namespace}:consumers`,
  };
}

export class RedisQueue implements TaskQueue {
  private redisUrl: string;
  private readonly streamMain: string;
  private readonly streamRetry: string;
  private readonly streamDlq: string;
  private readonly groupName: string;
  private handlers: EventHandler[] = [];
  private consumerRunning = false;
  private adminRedis: import('ioredis').Redis | null = null;
  private consumerRedis: import('ioredis').Redis | null = null;
  private shuttingDown = false;

  constructor(options: RedisQueueOptions) {
    const defaults = getDefaultRedisQueueNames();
    this.redisUrl = options.redisUrl;
    this.streamMain = options.streamMain ?? defaults.streamMain;
    this.streamRetry = options.streamRetry ?? defaults.streamRetry;
    this.streamDlq = options.streamDlq ?? defaults.streamDlq;
    this.groupName = options.groupName ?? defaults.groupName;
  }

  private async ensureGroups(client: import('ioredis').Redis): Promise<void> {
    try {
      await client.xgroup('CREATE', this.streamMain, this.groupName, '0', 'MKSTREAM');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes('BUSYGROUP')) throw e;
    }
    try {
      await client.xgroup('CREATE', this.streamRetry, this.groupName, '0', 'MKSTREAM');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes('BUSYGROUP')) throw e;
    }
  }

  private async getAdminClient(): Promise<import('ioredis').Redis> {
    if (!this.adminRedis) {
      this.adminRedis = await createRedisClient(this.redisUrl);
      await this.ensureGroups(this.adminRedis);
    }
    return this.adminRedis;
  }

  private async getConsumerClient(): Promise<import('ioredis').Redis> {
    if (!this.consumerRedis) {
      this.consumerRedis = await createRedisClient(this.redisUrl);
      await this.ensureGroups(this.consumerRedis);
    }
    return this.consumerRedis;
  }

  private async getClient(): Promise<import('ioredis').Redis> {
    return this.getAdminClient();
  }

  async enqueue(event: RunEvent): Promise<void> {
    const client = await this.getClient();
    const payload = JSON.stringify({ event, retry_count: 0 });
    await client.xadd(this.streamMain, '*', 'payload', payload);
  }

  onEvent(handler: EventHandler): void {
    if (this.shuttingDown) {
      throw new Error('RedisQueue is shutting down');
    }
    this.handlers.push(handler);
    if (!this.consumerRunning && this.handlers.length > 0) {
      this.consumerRunning = true;
      this.runConsumer().catch((err) => {
        logger.warn('Redis Streams consumer error', { error: err instanceof Error ? err.message : String(err) });
        this.consumerRunning = false;
      });
    }
  }

  private async runConsumer(): Promise<void> {
    const client = await this.getConsumerClient();
    const consumerId = `consumer-${process.pid}-${Date.now()}`;
    const processOne = async (
      streamKey: string,
      messageId: string,
      payload: string
    ): Promise<'ack' | 'retry' | 'dlq'> => {
      const { event, retry_count } = parsePayload(payload);
      for (const h of this.handlers) {
        try {
          await h(event);
          return 'ack';
        } catch (err) {
          logger.error('Redis queue handler error', { run_id: event.run_id, error: String(err) });
          if (retry_count >= MAX_RETRIES) return 'dlq';
          const nextPayload = JSON.stringify({ event, retry_count: retry_count + 1 });
          await client.xadd(this.streamRetry, '*', 'payload', nextPayload);
          return 'ack';
        }
      }
      return 'ack';
    };

    const readStream = async (stream: string, blockMs: number = BLOCK_MS): Promise<boolean> => {
      const replies = (await client.xreadgroup(
        'GROUP', this.groupName, consumerId,
        'BLOCK', blockMs,
        'COUNT', 1,
        'STREAMS', stream, '>'
      )) as [string, [string, string[]][]][] | null;
      if (!replies || replies.length === 0) return false;
      const [, messages] = replies[0];
      if (!messages || messages.length === 0) return false;
      const [id, fields] = messages[0];
      const payIdx = Array.isArray(fields) ? fields.indexOf('payload') : -1;
      const payload = payIdx >= 0 && fields[payIdx + 1] != null ? String(fields[payIdx + 1]) : '';
      const outcome = await processOne(stream, id, payload);
      if (outcome === 'ack') {
        await client.xack(stream, this.groupName, id);
      } else if (outcome === 'dlq') {
        await client.xadd(this.streamDlq, '*', 'payload', payload, 'original_stream', stream, 'message_id', id);
        await client.xack(stream, this.groupName, id);
      }
      return true;
    };

    /** Reclaim pending messages idle longer than PENDING_MIN_IDLE_MS (e.g. after consumer crash). */
    const reclaimPending = async (stream: string): Promise<boolean> => {
      const raw = await client.call(
        'XAUTOCLAIM', stream, this.groupName, consumerId, PENDING_MIN_IDLE_MS, '0', 'COUNT', 1
      ) as [string, [string, string[]][]];
      if (!Array.isArray(raw) || raw.length < 2) return false;
      const messages = raw[1];
      if (!messages || messages.length === 0) return false;
      const [id, fields] = messages[0];
      const payIdx = Array.isArray(fields) ? fields.indexOf('payload') : -1;
      const payload = payIdx >= 0 && fields[payIdx + 1] != null ? String(fields[payIdx + 1]) : '';
      logger.info('Redis queue reclaim pending', { stream, message_id: id });
      const outcome = await processOne(stream, id, payload);
      if (outcome === 'ack') {
        await client.xack(stream, this.groupName, id);
      } else if (outcome === 'dlq') {
        await client.xadd(this.streamDlq, '*', 'payload', payload, 'original_stream', stream, 'message_id', id);
        await client.xack(stream, this.groupName, id);
      }
      return true;
    };

    while (this.handlers.length > 0 && !this.shuttingDown) {
      try {
        // Read retry first, then reclaim stale pending work before the long main-stream block.
        // Otherwise abandoned messages can sit idle behind BLOCK_MS even when already reclaimable.
        let had = await readStream(this.streamRetry, BLOCK_RETRY_MS);
        if (!had) had = await reclaimPending(this.streamRetry);
        if (!had) had = await reclaimPending(this.streamMain);
        if (!had) had = await readStream(this.streamMain, BLOCK_MS);
        if (!had) {
          await new Promise((r) => setTimeout(r, 100));
        }
      } catch (err) {
        logger.warn('Redis Streams read error', { error: err instanceof Error ? err.message : String(err) });
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    this.consumerRunning = false;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.handlers = [];
    this.consumerRunning = false;
    const clients = [this.consumerRedis, this.adminRedis].filter(Boolean) as import('ioredis').Redis[];
    if (clients.length === 0) return;
    this.consumerRedis = null;
    this.adminRedis = null;
    await Promise.all(
      clients.map(async (client) => {
        try {
          await client.quit();
        } catch {
          try {
            client.disconnect();
          } catch {
            // ignore best-effort shutdown
          }
        }
      })
    );
  }
}
