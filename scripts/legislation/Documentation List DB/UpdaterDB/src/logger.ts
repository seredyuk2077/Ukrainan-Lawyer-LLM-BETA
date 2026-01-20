import pino from 'pino';
import type { Logger } from 'pino';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export interface CreateLoggerOptions {
  level: LogLevel;
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
          // common
          '*.OPEN_ROUTER_API_RAG',
          '*.OPEN_ROUTER_API_KEY',
          '*.OPENAI_API_KEY',
          '*.CLAUDE_API_KEY',
          '*.EMBEDDING_API_KEY',
          '*.QDRANT_API_KEY',
          '*.QDRANT_API',
          '*.SUPABASE_SERVICE_ROLE_KEY',
          '*.R2_SECRET_ACCESS_KEY',
          '*.R2_SECRET_KEY',
          '*.R2_ACCESS_KEY_ID',
          '*.R2_ACCESS_KEY',
          // structured config objects
          'env.OPEN_ROUTER_API_RAG',
          'env.OPEN_ROUTER_API_KEY',
          'env.OPENAI_API_KEY',
          'env.CLAUDE_API_KEY',
          'env.EMBEDDING_API_KEY',
          'env.QDRANT_API_KEY',
          'env.QDRANT_API',
          'env.SUPABASE_SERVICE_ROLE_KEY',
          'env.R2_SECRET_ACCESS_KEY',
          'env.R2_SECRET_KEY',
          'env.R2_ACCESS_KEY_ID',
          'env.R2_ACCESS_KEY',
        ],
        censor: '[REDACTED]',
      },
    },
    transport as any
  );
}

