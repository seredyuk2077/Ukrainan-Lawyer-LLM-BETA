/**
 * Runs helpers.
 * Артефакти пишуться в тимчасову локальну директорію, потім завантажуються в R2 (legislation/tech/runs/)
 * і тимчасова директорія видаляється — локально runs не збираються.
 */
import { mkdir, writeFile, appendFile, mkdtemp, rm } from 'fs/promises';
import { resolve, join } from 'path';
import { tmpdir } from 'os';
import { getR2AdminClient } from './r2Admin.js';
import { uploadDirectoryToR2 } from './r2Admin.js';
import { R2_PREFIX_RUNS } from './r2Guardrails.js';

export interface RunContext {
  /** Тимчасова локальна директорія (після uploadRunToR2 — видаляється) */
  runDir: string;
  /** R2 prefix куди завантажуються артефакти (legislation/tech/runs/<runDirName>/) */
  r2RunPrefix: string;
  reportPath: string;
  enrichmentPath: string;
  canonicalPreviewPath: string;
  logsPath: string;
  qdrantIdsPath: string;
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9а-яіїєґ-]+/giu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'untitled';
}

export function makeRunDirName(params: { title: string; radaNreg: string; tsIso?: string }): string {
  const ts = (params.tsIso || new Date().toISOString())
    .replace(/[:.]/g, '-')
    .replace('T', '__')
    .replace('Z', 'Z');
  const encodedNreg = encodeURIComponent(params.radaNreg);
  const slug = slugify(params.title);
  return `${slug}__${encodedNreg}__${ts}`;
}

export async function createRunContext(params: { title: string; radaNreg: string; tsIso?: string }): Promise<RunContext> {
  const dirName = makeRunDirName(params);
  const runDir = await mkdtemp(join(tmpdir(), 'lexery-legislation-run-'));
  const r2RunPrefix = R2_PREFIX_RUNS + dirName;

  return {
    runDir,
    r2RunPrefix,
    reportPath: resolve(runDir, 'report.json'),
    enrichmentPath: resolve(runDir, 'enrichment.json'),
    canonicalPreviewPath: resolve(runDir, 'canonical.preview.json'),
    logsPath: resolve(runDir, 'logs.txt'),
    qdrantIdsPath: resolve(runDir, 'qdrant_ids.json'),
  };
}

/**
 * Завантажити артефакти run в R2 (legislation/tech/runs/...) і видалити тимчасову директорію.
 * Викликати в кінці add/update/remove (успіх або помилка).
 */
export async function uploadRunToR2(run: RunContext): Promise<void> {
  try {
    const { client, bucket } = getR2AdminClient();
    const { uploaded, keys } = await uploadDirectoryToR2({
      client,
      bucket,
      localDir: run.runDir,
      r2Prefix: run.r2RunPrefix,
    });
    if (uploaded > 0) {
      console.log(`   Run artifacts uploaded to R2: ${run.r2RunPrefix} (${uploaded} files)`);
    }
  } catch (e: any) {
    console.warn(`   Run upload to R2 failed (artifacts remain in temp): ${e?.message ?? String(e)}`);
  } finally {
    try {
      await rm(run.runDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

export async function writeJson(path: string, data: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

export async function logLine(ctx: RunContext, line: string): Promise<void> {
  await appendFile(ctx.logsPath, line + '\n', 'utf-8');
}

