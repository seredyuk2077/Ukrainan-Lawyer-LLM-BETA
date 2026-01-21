import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import readline from 'node:readline';
import type { Logger } from 'pino';
import iconv from 'iconv-lite';
import * as yauzl from 'yauzl';
import { backoffDelayMs, ensureDir, fileExists, nowIso, safeUrl, sleep } from './utils.js';
import type { ImporterPaths } from './config.js';

export interface LocalDocStats {
  docTxtPath: string;
  bytes: number;
  mtimeMs: number;
  totalLines?: number;
  sampleLines: string[];
}

export async function downloadDocZip(params: {
  url: string;
  paths: ImporterPaths;
  logger: Logger;
  timeoutMs: number;
  maxRetries: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
}): Promise<void> {
  await ensureDir(params.paths.tmpDir);
  const target = params.paths.docZipPath;

  params.logger.info({ url: safeUrl(params.url), target }, 'downloading doc.zip');

  for (let attempt = 1; attempt <= params.maxRetries; attempt++) {
    try {
      const res = await fetch(params.url, {
        signal: AbortSignal.timeout(params.timeoutMs),
      });
      if (!res.ok) {
        const body = await safeReadText(res);
        const isRetryable = res.status === 429 || res.status >= 500;
        throw new HttpError(res.status, `${res.status} ${res.statusText}`, body, isRetryable);
      }
      if (!res.body) throw new Error('Response has no body');

      const tmp = `${target}.partial`;
      const out = fs.createWriteStream(tmp);
      await pipeline(Readable.fromWeb(res.body as any), out);
      await fsp.rename(tmp, target);

      const st = await fsp.stat(target);
      params.logger.info(
        { bytes: st.size, lastModified: res.headers.get('last-modified') || null },
        'doc.zip downloaded'
      );
      return;
    } catch (err) {
      const e = err as any;
      const retryable = isRetryableError(e);
      if (!retryable || attempt === params.maxRetries) {
        throw err;
      }
      const delay = backoffDelayMs(attempt, params.backoffBaseMs, params.backoffMaxMs);
      params.logger.warn({ attempt, delayMs: delay, err: toErrorFields(e) }, 'download failed; retrying');
      await sleep(delay);
    }
  }
}

export async function extractDocTxtToUtf8(params: { paths: ImporterPaths; logger: Logger }): Promise<void> {
  const zipPath = params.paths.docZipPath;
  const outPath = params.paths.docTxtPath;
  if (!(await fileExists(zipPath))) {
    throw new Error(`Missing ${zipPath}. Run download-doc first.`);
  }
  await ensureDir(params.paths.tmpDir);

  params.logger.info({ zipPath, outPath }, 'extracting doc.txt from zip (cp1251 -> utf8)');

  const zipfile = await openZip(zipPath);
  try {
    const entry = await findEntry(zipfile, 'doc.txt');
    if (!entry) {
      throw new Error(`doc.txt not found inside ${zipPath}`);
    }

    const readStream = await openEntryStream(zipfile, entry);
    const decoded = readStream.pipe(iconv.decodeStream('win1251'));

    const tmpOut = `${outPath}.partial`;
    const out = fs.createWriteStream(tmpOut, { encoding: 'utf8' });
    await pipeline(decoded, out);
    await fsp.rename(tmpOut, outPath);
  } finally {
    zipfile.close();
  }

  const st = await fsp.stat(outPath);
  params.logger.info({ bytes: st.size, mtime: new Date(st.mtimeMs).toISOString() }, 'doc.txt extracted');
}

export async function getLocalDocStats(docTxtPath: string, opts?: { countLines?: boolean; sampleLines?: number }): Promise<LocalDocStats> {
  const st = await fsp.stat(docTxtPath);
  const sample = await readFirstNonEmptyLines(docTxtPath, opts?.sampleLines ?? 3, 2000);
  const stats: LocalDocStats = {
    docTxtPath,
    bytes: st.size,
    mtimeMs: st.mtimeMs,
    sampleLines: sample,
  };
  if (opts?.countLines) {
    stats.totalLines = await countLines(docTxtPath);
  }
  return stats;
}

export async function* readLocalDocLines(docTxtPath: string): AsyncGenerator<string> {
  const stream = fs.createReadStream(docTxtPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      yield line;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

async function readFirstNonEmptyLines(filePath: string, n: number, maxLineLength: number): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of readLocalDocLines(filePath)) {
    const t = line.trimEnd();
    if (!t) continue;
    lines.push(t.length > maxLineLength ? t.slice(0, maxLineLength) + '…' : t);
    if (lines.length >= n) break;
  }
  return lines;
}

async function countLines(filePath: string): Promise<number> {
  let count = 0;
  for await (const _line of readLocalDocLines(filePath)) {
    count++;
  }
  return count;
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body: string,
    public readonly retryable: boolean
  ) {
    super(message);
  }
}

function isRetryableError(e: any): boolean {
  if (e instanceof HttpError) return e.retryable;
  const msg = String(e?.message || e);
  if (msg.includes('ETIMEDOUT') || msg.includes('timeout') || msg.includes('ECONNRESET')) return true;
  return false;
}

function toErrorFields(e: any): { message: string; name?: string; stack?: string } {
  if (e instanceof Error) return { name: e.name, message: e.message, stack: e.stack };
  return { message: String(e) };
}

function openZip(zipPath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err: Error | null, zipfile?: yauzl.ZipFile) => {
      if (err || !zipfile) return reject(err || new Error('Failed to open zip'));
      resolve(zipfile);
    });
  });
}

function findEntry(zipfile: yauzl.ZipFile, filename: string): Promise<yauzl.Entry | null> {
  return new Promise((resolve, reject) => {
    const wanted = filename.toLowerCase();
    let found: yauzl.Entry | null = null;

    const onEntry = (entry: yauzl.Entry) => {
      const name = entry.fileName.toLowerCase();
      if (name === wanted || name.endsWith('/' + wanted)) {
        found = entry;
        zipfile.removeListener('entry', onEntry);
        resolve(found);
        return;
      }
      zipfile.readEntry();
    };

    zipfile.on('entry', onEntry);
    zipfile.on('end', () => resolve(found));
    zipfile.on('error', reject);
    zipfile.readEntry();
  });
}

function openEntryStream(zipfile: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err: Error | null, stream?: NodeJS.ReadableStream) => {
      if (err || !stream) return reject(err || new Error('Failed to open entry stream'));
      resolve(stream);
    });
  });
}

export function makeTestRunId(): string {
  const rand = Math.random().toString(16).slice(2, 10);
  return `${nowIso().replace(/[:.]/g, '-')}_${rand}`;
}

