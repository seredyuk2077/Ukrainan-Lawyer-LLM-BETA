import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { appendJsonl, ensureDir, fileExists, nowIso, readJsonFile, writeJsonFileAtomic } from './utils.js';

export interface SourceFingerprint {
  path: string;
  size: number;
  mtimeMs: number;
  sha256?: string;
}

export interface ImportCounters {
  processed: number;
  upserted: number;
  failed: number;
  skipped: number;
  batches: number;
}

export interface ImportCursor {
  lineNumber: number;
}

export interface ImportTimestamps {
  started_at: string;
  updated_at: string;
  stopped_at?: string;
}

export interface RunConfigSnapshot {
  indexName: string;
  expectedIndexDimensions: number;
  batchSize: number;
  openrouterModel: string;
  openrouterDimensions?: number;
  skipSupabaseSync: boolean;
}

export interface ImportState {
  schema_version: 2;
  vector_db: 'qdrant';
  mode: 'import' | 'test';
  test_run_id?: string;
  cursor: ImportCursor;
  fingerprint: SourceFingerprint;
  counters: ImportCounters;
  timestamps: ImportTimestamps;
  run_config: RunConfigSnapshot;
  estimated_total_records?: number;
}

export interface ErrorEntry {
  ts: string;
  kind: 'parse_error' | 'embedding_error' | 'vector_db_error' | 'supabase_error' | 'fatal';
  message: string;
  stack?: string;
  context?: Record<string, unknown>;
}

export function createNewState(params: {
  mode: ImportState['mode'];
  fingerprint: SourceFingerprint;
  runConfig: RunConfigSnapshot;
  estimatedTotalRecords?: number;
  testRunId?: string;
}): ImportState {
  return {
    schema_version: 2,
    vector_db: 'qdrant',
    mode: params.mode,
    test_run_id: params.testRunId,
    cursor: { lineNumber: 0 },
    fingerprint: params.fingerprint,
    counters: { processed: 0, upserted: 0, failed: 0, skipped: 0, batches: 0 },
    timestamps: { started_at: nowIso(), updated_at: nowIso() },
    run_config: params.runConfig,
    estimated_total_records: params.estimatedTotalRecords,
  };
}

export async function loadState(statePath: string): Promise<ImportState> {
  const st = await readJsonFile<any>(statePath);
  const ver = Number(st?.schema_version);
  if (ver === 2) {
    if (st.vector_db !== 'qdrant') {
      throw new Error(`Unsupported state vector_db: ${String(st.vector_db)}`);
    }
    return st as ImportState;
  }
  if (ver === 1) {
    throw new Error(
      'Legacy state detected (Cloudflare Vectorize run). Resume is disabled for legacy state.\n' +
        'Fix: run "reset-state --force" and start a fresh import to Qdrant.'
    );
  }
  throw new Error(`Unsupported state schema_version: ${String(st?.schema_version)}`);
}

export async function saveState(statePath: string, state: ImportState): Promise<void> {
  state.timestamps.updated_at = nowIso();
  await writeJsonFileAtomic(statePath, state);
}

export function assertFingerprintMatch(state: ImportState, current: SourceFingerprint): void {
  const a = state.fingerprint;
  const b = current;
  const same =
    a.path === b.path &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    (a.sha256 ? a.sha256 === b.sha256 : true);

  if (!same) {
    const details = {
      expected: a,
      actual: b,
    };
    throw new Error(
      `Source fingerprint mismatch. Refusing to resume.\n` +
        `Expected: ${JSON.stringify(details.expected)}\n` +
        `Actual:   ${JSON.stringify(details.actual)}\n` +
        `Fix: re-run download-doc (or use reset-state --force if you intentionally changed the file).`
    );
  }
}

export async function computeFingerprint(filePath: string, opts?: { sha256?: boolean }): Promise<SourceFingerprint> {
  const st = await fsp.stat(filePath);
  const fp: SourceFingerprint = { path: filePath, size: st.size, mtimeMs: st.mtimeMs };
  if (opts?.sha256) {
    fp.sha256 = await sha256File(filePath);
  }
  return fp;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve());
  });
  return hash.digest('hex');
}

export async function logError(errorsPath: string, entry: ErrorEntry): Promise<void> {
  await appendJsonl(errorsPath, entry);
}

export interface InsertedIdEntry {
  id: string; // Qdrant point id (UUID)
  nreg?: string; // original string id (payload key)
  test_run_id?: string;
}

export async function appendInsertedIdEntries(insertedIdsPath: string, entries: InsertedIdEntry[]): Promise<void> {
  for (const e of entries) {
    await appendJsonl(insertedIdsPath, e);
  }
}

export async function readInsertedIdEntries(insertedIdsPath: string): Promise<InsertedIdEntry[]> {
  if (!(await fileExists(insertedIdsPath))) return [];
  const raw = await fsp.readFile(insertedIdsPath, 'utf8');
  const out: InsertedIdEntry[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t) as any;
      const id = typeof obj?.id === 'string' ? obj.id.trim() : '';
      if (!id) continue;
      const nreg = typeof obj?.nreg === 'string' ? obj.nreg : undefined;
      const test_run_id = typeof obj?.test_run_id === 'string' ? obj.test_run_id : undefined;
      out.push({ id, nreg, test_run_id });
    } catch {
      // ignore malformed line
    }
  }
  return out;
}

export async function readInsertedIds(insertedIdsPath: string): Promise<string[]> {
  const entries = await readInsertedIdEntries(insertedIdsPath);
  return entries.map((e) => e.id);
}

export async function resetLocalArtifacts(tmpDir: string, opts?: { keepDocFiles?: boolean }): Promise<void> {
  const keepDocFiles = Boolean(opts?.keepDocFiles);
  if (!fs.existsSync(tmpDir)) return;
  const entries = await fsp.readdir(tmpDir);
  const toDelete = entries.filter((name) => {
    if (keepDocFiles && (name === 'doc.txt' || name === 'doc.zip')) return false;
    return true;
  });

  for (const name of toDelete) {
    const p = path.join(tmpDir, name);
    try {
      const st = await fsp.lstat(p);
      if (st.isDirectory()) {
        await fsp.rm(p, { recursive: true, force: true });
      } else {
        await fsp.unlink(p);
      }
    } catch {
      // ignore
    }
  }

  // If empty, remove tmpDir (optional). We keep it as a stable location.
  await ensureDir(tmpDir);
}

