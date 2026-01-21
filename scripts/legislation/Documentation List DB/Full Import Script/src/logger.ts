import pino from 'pino';
import type { Logger } from 'pino';
import { estimateEtaSeconds, formatSeconds } from './utils.js';

export interface CreateLoggerOptions {
  level: string;
  pretty: boolean;
}

export function createLogger(opts: CreateLoggerOptions): Logger {
  const transport = opts.pretty
    ? pino.transport({
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      })
    : undefined;

  return pino(
    {
      level: opts.level,
      redact: {
        paths: [
          'env.OPEN_ROUTER_API_RAG',
          'env.SUPABASE_SERVICE_ROLE_KEY',
          'env.QDRANT_API_KEY',
          'env.QDRANT_API',
          '*.QDRANT_API_KEY',
          '*.QDRANT_API',
          '*.OPEN_ROUTER_API_RAG',
          '*.SUPABASE_SERVICE_ROLE_KEY',
        ],
        censor: '[REDACTED]',
      },
    },
    transport as any
  );
}

export interface HeartbeatSnapshot {
  processed: number;
  upserted: number;
  failed: number;
  skipped: number;
  batches: number;
  cursorLine: number;
  bufferSize: number;
  batchSize: number;
  estimatedTotalRecords?: number;
  startedAtMs: number;
}

export class Heartbeat {
  private interval: NodeJS.Timeout | null = null;

  constructor(
    private readonly logger: Logger,
    private readonly everySeconds: number,
    private readonly getSnapshot: () => HeartbeatSnapshot
  ) {}

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => {
      const s = this.getSnapshot();
      const elapsedSeconds = (Date.now() - s.startedAtMs) / 1000;
      const speed = s.processed > 0 ? s.processed / Math.max(1e-6, elapsedSeconds) : 0;
      const etaSeconds = estimateEtaSeconds(s.processed, s.estimatedTotalRecords, elapsedSeconds);

      this.logger.info(
        {
          kind: 'heartbeat',
          processed: s.processed,
          upserted: s.upserted,
          failed: s.failed,
          skipped: s.skipped,
          batches: s.batches,
          cursorLine: s.cursorLine,
          bufferSize: s.bufferSize,
          batchSize: s.batchSize,
          speedRps: Number.isFinite(speed) ? Number(speed.toFixed(2)) : null,
          etaSeconds: etaSeconds !== undefined ? Math.round(etaSeconds) : null,
        },
        `progress: processed=${s.processed} upserted=${s.upserted} failed=${s.failed} batches=${s.batches} speed=${speed.toFixed(
          2
        )} rec/s eta=${etaSeconds !== undefined ? formatSeconds(etaSeconds) : 'n/a'} cursorLine=${s.cursorLine} buffer=${
          s.bufferSize
        }/${s.batchSize}`
      );
    }, this.everySeconds * 1000);
    this.interval.unref?.();
  }

  stop(): void {
    if (!this.interval) return;
    clearInterval(this.interval);
    this.interval = null;
  }
}

