import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
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

export async function ensureDir(dirPath: string): Promise<void> {
  await fsp.mkdir(dirPath, { recursive: true });
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  const raw = await fsp.readFile(filePath, 'utf8');
  return JSON.parse(raw) as T;
}

export async function writeJsonFileAtomic(filePath: string, obj: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const tmp = `${filePath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const payload = JSON.stringify(obj, null, 2);
  await fsp.writeFile(tmp, payload, 'utf8');
  await fsp.rename(tmp, filePath);
}

export async function appendJsonl(filePath: string, entry: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  await fsp.appendFile(filePath, JSON.stringify(entry) + '\n', 'utf8');
}

export function formatSeconds(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return 'n/a';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}h ${m}m ${r}s`;
  if (m > 0) return `${m}m ${r}s`;
  return `${r}s`;
}

export function estimateEtaSeconds(processed: number, total: number | undefined, elapsedSeconds: number): number | undefined {
  if (!total || total <= 0) return undefined;
  if (processed <= 0) return undefined;
  const rate = processed / Math.max(1e-6, elapsedSeconds);
  if (!Number.isFinite(rate) || rate <= 0) return undefined;
  const remaining = Math.max(0, total - processed);
  return remaining / rate;
}

export function safeUrl(u: string): string {
  // ensure we never accidentally log query params with secrets
  try {
    const url = new URL(u);
    url.search = '';
    return url.toString();
  } catch {
    return u;
  }
}

