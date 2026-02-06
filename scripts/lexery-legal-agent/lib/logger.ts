/**
 * Structured logger for U1 Gateway
 */
type LogLevel = 'info' | 'warn' | 'error' | 'debug';

interface LogContext {
  run_id?: string;
  tenant_id?: string;
  user_id?: string;
  request_id?: string;
  trace_id?: string;
  [key: string]: unknown;
}

function formatLog(level: LogLevel, message: string, ctx?: LogContext): string {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    service: 'lexery-brain-u1',
    ...ctx,
  };
  return JSON.stringify(entry);
}

export const logger = {
  info(message: string, ctx?: LogContext) {
    console.log(formatLog('info', message, ctx));
  },
  warn(message: string, ctx?: LogContext) {
    console.warn(formatLog('warn', message, ctx));
  },
  error(message: string, ctx?: LogContext) {
    console.error(formatLog('error', message, ctx));
  },
  debug(message: string, ctx?: LogContext) {
    if (process.env.LOG_LEVEL === 'debug') {
      console.debug(formatLog('debug', message, ctx));
    }
  },
};
