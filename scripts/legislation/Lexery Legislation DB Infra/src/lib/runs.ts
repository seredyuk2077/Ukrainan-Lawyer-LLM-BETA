/**
 * Runs directory helpers.
 * Створює папку під кожну операцію (add/update/remove) з report/logs.
 */
import { mkdir, writeFile, appendFile } from 'fs/promises';
import { resolve } from 'path';

export interface RunContext {
  runDir: string;
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
  const runsRoot = resolve(process.cwd(), 'scripts', 'legislation', 'runs');
  const dirName = makeRunDirName(params);
  const runDir = resolve(runsRoot, dirName);
  await mkdir(runDir, { recursive: true });

  return {
    runDir,
    reportPath: resolve(runDir, 'report.json'),
    enrichmentPath: resolve(runDir, 'enrichment.json'),
    canonicalPreviewPath: resolve(runDir, 'canonical.preview.json'),
    logsPath: resolve(runDir, 'logs.txt'),
    qdrantIdsPath: resolve(runDir, 'qdrant_ids.json'),
  };
}

export async function writeJson(path: string, data: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

export async function logLine(ctx: RunContext, line: string): Promise<void> {
  await appendFile(ctx.logsPath, line + '\n', 'utf-8');
}

