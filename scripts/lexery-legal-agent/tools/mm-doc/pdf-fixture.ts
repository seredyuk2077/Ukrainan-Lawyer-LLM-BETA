import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';

export function canBuildTextPdf(): boolean {
  return execFileSync('sh', ['-lc', 'command -v cupsfilter >/dev/null 2>&1 && echo ok'], {
    encoding: 'utf8',
  }).trim() === 'ok';
}

export function buildTextPdfBuffer(text: string): Buffer {
  if (!canBuildTextPdf()) {
    throw new Error('PDF fixture requires cupsfilter');
  }
  const tempDir = mkdtempSync(path.join(tmpdir(), 'mm-doc-pdf-'));
  try {
    const inputPath = path.join(tempDir, 'input.txt');
    writeFileSync(inputPath, text, 'utf8');
    const pdfBuffer = execFileSync('cupsfilter', ['-m', 'application/pdf', inputPath], {
      encoding: 'buffer',
      maxBuffer: 8 * 1024 * 1024,
    });
    return Buffer.from(pdfBuffer);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
