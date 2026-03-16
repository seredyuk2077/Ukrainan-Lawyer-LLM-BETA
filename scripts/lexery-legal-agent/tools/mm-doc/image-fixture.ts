import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

export function canBuildTextImagePng(): boolean {
  return spawnSync('which', ['cupsfilter'], { encoding: 'utf8' }).status === 0 &&
    spawnSync('which', ['pdftoppm'], { encoding: 'utf8' }).status === 0;
}

export function buildTextImagePngBuffer(params: {
  filenameBase?: string;
  text: string;
}): Buffer {
  if (!canBuildTextImagePng()) {
    throw new Error('Image fixture requires cupsfilter and pdftoppm');
  }

  const tempDir = mkdtempSync(path.join(tmpdir(), 'mm-doc-image-'));
  try {
    const inputPath = path.join(tempDir, `${params.filenameBase || 'input'}.txt`);
    const outputPrefix = path.join(tempDir, 'page');
    writeFileSync(inputPath, params.text, 'utf8');
    const pdfBuffer = execFileSync('cupsfilter', ['-m', 'application/pdf', inputPath], {
      encoding: 'buffer',
      maxBuffer: 16 * 1024 * 1024,
    }) as Buffer;
    const pdfPath = path.join(tempDir, 'input.pdf');
    writeFileSync(pdfPath, pdfBuffer);
    execFileSync('pdftoppm', ['-png', '-f', '1', '-l', '1', '-scale-to', '1800', pdfPath, outputPrefix], {
      encoding: 'buffer',
      maxBuffer: 16 * 1024 * 1024,
    });
    return readFileSync(path.join(tempDir, 'page-1.png'));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
