export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

function emit(level: LogLevel, obj: unknown, msg?: string): void {
  const rec: Record<string, unknown> =
    obj && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, unknown>) : { value: obj };
  const line = {
    ts: new Date().toISOString(),
    level,
    msg: msg || '',
    ...rec,
  };
  const s = JSON.stringify(line);
  if (level === 'error') console.error(s);
  else if (level === 'warn') console.warn(s);
  else console.log(s);
}

export function createLogger(params: { debug: boolean; requestId: string }): Logger {
  return {
    debug: (obj, msg) => {
      if (!params.debug) return;
      emit('debug', { request_id: params.requestId, ...asObj(obj) }, msg);
    },
    info: (obj, msg) => emit('info', { request_id: params.requestId, ...asObj(obj) }, msg),
    warn: (obj, msg) => emit('warn', { request_id: params.requestId, ...asObj(obj) }, msg),
    error: (obj, msg) => emit('error', { request_id: params.requestId, ...asObj(obj) }, msg),
  };
}

function asObj(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as any;
  return { value: v };
}

