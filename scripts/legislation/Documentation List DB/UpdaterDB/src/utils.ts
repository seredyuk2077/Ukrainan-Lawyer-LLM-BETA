import crypto from 'node:crypto';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

export function nowIso(): string {
  return new Date().toISOString();
}

export function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

export function parsePositiveInt(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number.parseInt(v, 10) : NaN;
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

export function parseOptionalPositiveInt(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number.parseInt(v, 10) : NaN;
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

export function parseOptionalInt(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number.parseInt(v, 10) : NaN;
  if (!Number.isFinite(n)) return undefined;
  return n;
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export function jitterMs(baseMs: number, jitterRatio: number = 0.2): number {
  const j = baseMs * jitterRatio;
  const delta = (Math.random() * 2 - 1) * j;
  return Math.max(0, Math.round(baseMs + delta));
}

export function backoffDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  const exp = Math.min(maxMs, baseMs * Math.pow(2, Math.max(0, attempt - 1)));
  return jitterMs(exp);
}

export function randomIntBetween(minInclusive: number, maxInclusive: number): number {
  const min = Math.min(minInclusive, maxInclusive);
  const max = Math.max(minInclusive, maxInclusive);
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function safeUrl(u: string): string {
  // Ensure we never accidentally log query params with secrets.
  try {
    const url = new URL(u);
    url.search = '';
    return url.toString();
  } catch {
    return u;
  }
}

export function makeRunId(prefix?: string): string {
  const iso = nowIso().replace(/[:.]/g, '-');
  const rand = crypto.randomBytes(4).toString('hex');
  return `${prefix ? prefix + '_' : ''}${iso}_${rand}`;
}

export function truncate(v: string, max: number): string {
  if (!v) return '';
  if (v.length <= max) return v;
  return v.slice(0, max) + '…';
}

export function toErrorFields(e: unknown): { message: string; name?: string; stack?: string } {
  if (e instanceof Error) return { name: e.name, message: e.message, stack: e.stack };
  return { message: String(e) };
}

export function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

