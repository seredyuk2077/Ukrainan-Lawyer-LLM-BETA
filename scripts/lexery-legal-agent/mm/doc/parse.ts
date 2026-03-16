import unzipper from 'unzipper';
import { parse as parseCsv } from 'csv-parse/sync';
import { execFile as execFileCb, execFileSync } from 'child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { promisify } from 'util';
import * as XLSX from 'xlsx';
import { config } from '../../lib/config.js';
import { inferMmDocFormat, normalizeExtension } from './formats.js';
import type { MmDocFormat, ParsedDocBlock, ParsedDocument } from './types.js';
import { parseMmDocImageWithVision } from './vision.js';

const execFile = promisify(execFileCb);
const DOCX_EMBEDDED_VISION_MAX_IMAGES = 3;

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#10;/g, '\n')
    .replace(/&#13;/g, '\r');
}

function extractXmlText(fragment: string): string {
  return decodeXmlEntities(fragment.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function inferImageContentTypeFromPath(filePath: string): string | undefined {
  const normalized = filePath.toLowerCase();
  if (normalized.endsWith('.png')) return 'image/png';
  if (normalized.endsWith('.jpg') || normalized.endsWith('.jpeg')) return 'image/jpeg';
  if (normalized.endsWith('.webp')) return 'image/webp';
  return undefined;
}

function buildPlainText(blocks: ParsedDocBlock[]): string {
  return blocks.map((b) => b.text).join('\n\n').trim();
}

function maybeRepairMojibake(text: string): string {
  const suspiciousMatches = text.match(/[ÐÑÃ]{2,}/g) ?? [];
  if (suspiciousMatches.length === 0) return text;
  try {
    const repaired = Buffer.from(text, 'latin1').toString('utf8');
    const originalCyrillic = (text.match(/[\u0400-\u04FF]/g) ?? []).length;
    const repairedCyrillic = (repaired.match(/[\u0400-\u04FF]/g) ?? []).length;
    if (repairedCyrillic > originalCyrillic) {
      return repaired;
    }
  } catch {
    // Keep original text when byte reinterpretation fails.
  }
  return text;
}

function stripRtfGroups(raw: string): string {
  let text = raw;
  const ignorableGroups = [
    'fonttbl',
    'colortbl',
    'stylesheet',
    'info',
    'pict',
    'object',
    'header',
    'footer',
  ];
  for (const group of ignorableGroups) {
    const pattern = new RegExp(String.raw`\\{\\${group}[\\s\\S]*?\\}`, 'g');
    text = text.replace(pattern, ' ');
  }
  return text;
}

function extractVisibleTextFromRawRtfUtf8(buffer: Buffer): string {
  let text = buffer.toString('utf8').replace(/\r\n/g, '\n');
  text = stripRtfGroups(text);
  text = text
    .replace(/\\'[0-9a-fA-F]{2}/g, ' ')
    .replace(/\\u-?\d+\??/g, ' ')
    .replace(/\\par[d]?/g, '\n\n')
    .replace(/\\line\b/g, '\n')
    .replace(/\\tab\b/g, '\t')
    .replace(/\\[a-zA-Z]+-?\d* ?/g, ' ')
    .replace(/[{}]/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ');
  return text.trim();
}

function shouldUseRawRtfFallback(params: {
  originalExtractedText: string;
  repairedText: string;
  rawVisibleText: string;
}): boolean {
  const extractedCyrillic = (params.repairedText.match(/[\u0400-\u04FF]/g) ?? []).length;
  const originalCyrillic = (params.originalExtractedText.match(/[\u0400-\u04FF]/g) ?? []).length;
  const rawCyrillic = (params.rawVisibleText.match(/[\u0400-\u04FF]/g) ?? []).length;
  const originalSuspicious = (params.originalExtractedText.match(/[ÐÑÃ]{2,}/g) ?? []).length;
  const repairedSuspicious = (params.repairedText.match(/[—–±]{3,}/g) ?? []).length;
  if (rawCyrillic === 0) return false;
  if (rawCyrillic > extractedCyrillic && extractedCyrillic === 0) return true;
  if (originalSuspicious > 0 && rawCyrillic > originalCyrillic) return true;
  if (repairedSuspicious > 0 && rawCyrillic > extractedCyrillic) return true;
  return false;
}

function rowsToBlocks(rows: string[][], options: {
  sheetName?: string;
  tableName?: string;
}): ParsedDocBlock[] {
  return rows
    .map((row, index) => {
      const text = row.map((cell) => cell.trim()).filter(Boolean).join(' | ').trim();
      if (!text) return null;
      return {
        id: `${options.sheetName || options.tableName || 'row'}-${index}`,
        kind: 'table_row' as const,
        text,
        order: index,
        sheet_name: options.sheetName,
        table_name: options.tableName,
      };
    })
    .filter((row): row is ParsedDocBlock => row != null);
}

async function readZipEntryText(directory: unzipper.CentralDirectory, filePath: string): Promise<string | null> {
  const entry = directory.files.find((f) => f.path === filePath);
  if (!entry) return null;
  const buf = await entry.buffer();
  return buf.toString('utf8');
}

async function parseDocx(buffer: Buffer, filename: string, contentType?: string): Promise<ParsedDocument> {
  const directory = await unzipper.Open.buffer(buffer);
  const xml = await readZipEntryText(directory, 'word/document.xml');
  if (!xml) {
    throw new Error('DOCX parse failed: word/document.xml missing');
  }

  const warnings: string[] = [];
  const blocks: ParsedDocBlock[] = [];
  let order = 0;
  let activeSectionLabel: string | undefined;
  const embeddedImageEntries = directory.files.filter((f) => /^word\/media\//.test(f.path));
  const supportedEmbeddedImages = embeddedImageEntries.filter((entry) => inferImageContentTypeFromPath(entry.path));
  const embeddedImageCount = embeddedImageEntries.length;
  let visionModel: string | undefined;
  if (embeddedImageCount > 0) warnings.push('DOCX_HAS_EMBEDDED_IMAGES');
  let tableIndex = 0;
  for (const match of Array.from(xml.matchAll(/<w:(tbl|p)\b[\s\S]*?<\/w:\1>/g))) {
    const nodeType = match[1];
    const nodeXml = match[0] ?? '';
    if (nodeType === 'tbl') {
      tableIndex += 1;
      const rows = Array.from(nodeXml.matchAll(/<w:tr[\s\S]*?<\/w:tr>/g)).map((rowMatch) =>
        Array.from((rowMatch[0] ?? '').matchAll(/<w:tc[\s\S]*?<\/w:tc>/g))
          .map((cellMatch) => extractXmlText(cellMatch[0] ?? ''))
          .filter(Boolean)
      );
      blocks.push(...rowsToBlocks(rows, { tableName: `table_${tableIndex}` }).map((row) => ({
        ...row,
        order: order++,
        section_label: row.section_label ?? activeSectionLabel,
      })));
      continue;
    }

    const text = extractXmlText(nodeXml);
    if (!text) continue;
    const style = nodeXml.match(/<w:pStyle[^>]*w:val="([^"]+)"/)?.[1]?.toLowerCase() ?? '';
    const isHeading = /heading|title/.test(style);
    if (isHeading) activeSectionLabel = text.slice(0, 160);
    blocks.push({
      id: `p-${order}`,
      kind: isHeading ? 'section' : 'paragraph',
      text,
      order: order++,
      section_label: isHeading ? text.slice(0, 160) : activeSectionLabel,
    });
  }

  if (blocks.length === 0) {
    warnings.push('DOCX_EMPTY_AFTER_PARSE');
  }

  if (supportedEmbeddedImages.length > 0 && config.mmDocsVisionEnabled) {
    const imagesToProcess = supportedEmbeddedImages.slice(0, DOCX_EMBEDDED_VISION_MAX_IMAGES);
    if (supportedEmbeddedImages.length > DOCX_EMBEDDED_VISION_MAX_IMAGES) {
      warnings.push('DOCX_EMBEDDED_IMAGES_PARTIALLY_INDEXED');
    }
    for (const [imageIndex, entry] of imagesToProcess.entries()) {
      try {
        const parsed = await parseImageBufferWithVision({
          buffer: await entry.buffer(),
          filename: `${filename}#${path.basename(entry.path)}`,
          contentType: inferImageContentTypeFromPath(entry.path),
          blockPrefix: `docx-image-${imageIndex + 1}`,
          sectionLabel: `Embedded image ${imageIndex + 1}`,
        });
        if (parsed.blocks.length > 0) {
          warnings.push('DOCX_VISION_FALLBACK_USED');
          visionModel ??= parsed.model;
          blocks.push(
            ...parsed.blocks.map((block) => ({
              ...block,
              order: order++,
            }))
          );
        }
        if (parsed.warnings.length > 0) {
          warnings.push(...parsed.warnings.map((warning) => `DOCX_${warning}`));
        }
      } catch {
        warnings.push(`DOCX_IMAGE_${imageIndex + 1}_VISION_FAILED`);
      }
    }
  }

  return {
    format: 'docx',
    title: filename,
    plainText: buildPlainText(blocks),
    blocks,
    warnings,
    metadata: {
      filename,
      contentType,
      extension: normalizeExtension(filename),
      table_count: tableIndex,
      paragraph_count: blocks.filter((b) => b.kind === 'paragraph').length,
      section_count: blocks.filter((b) => b.kind === 'section').length,
      image_count: embeddedImageCount,
      vision_model: visionModel,
    },
  };
}

function extractSpreadsheetSharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  return Array.from(xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)).map((m) => decodeXmlEntities(m[1] ?? ''));
}

function parseSheetRows(xml: string, sharedStrings: string[], sheetName: string): ParsedDocBlock[] {
  const rows: string[][] = [];
  for (const rowMatch of Array.from(xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g))) {
    const rowXml = rowMatch[1] ?? '';
    const cells: string[] = [];
    for (const cellMatch of Array.from(rowXml.matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g))) {
      const attrs = cellMatch[1] ?? '';
      const cellXml = cellMatch[2] ?? '';
      const typeMatch = attrs.match(/\bt="([^"]+)"/);
      const cellType = typeMatch?.[1];
      let value = '';
      if (cellType === 's') {
        const idx = Number((cellXml.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? '').trim());
        if (Number.isFinite(idx)) value = sharedStrings[idx] ?? '';
      } else if (cellType === 'inlineStr') {
        value = decodeXmlEntities(cellXml.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? '');
      } else {
        value = decodeXmlEntities(cellXml.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? '');
      }
      cells.push(value.trim());
    }
    rows.push(cells);
  }
  return rowsToBlocks(rows, { sheetName });
}

async function parseXlsx(buffer: Buffer, filename: string, contentType?: string): Promise<ParsedDocument> {
  const directory = await unzipper.Open.buffer(buffer);
  const workbookXml = await readZipEntryText(directory, 'xl/workbook.xml');
  const sharedStrings = extractSpreadsheetSharedStrings(await readZipEntryText(directory, 'xl/sharedStrings.xml'));
  const sheetNames = workbookXml
    ? Array.from(workbookXml.matchAll(/<sheet[^>]*name="([^"]+)"/g)).map((m) => decodeXmlEntities(m[1] ?? ''))
    : [];

  const sheetEntries = directory.files
    .filter((file) => /^xl\/worksheets\/sheet\d+\.xml$/.test(file.path))
    .sort((a, b) => a.path.localeCompare(b.path));

  const blocks: ParsedDocBlock[] = [];
  let order = 0;
  for (const [index, entry] of sheetEntries.entries()) {
    const sheetXml = (await entry.buffer()).toString('utf8');
    const sheetName = sheetNames[index] || `sheet_${index + 1}`;
    const sheetBlocks = parseSheetRows(sheetXml, sharedStrings, sheetName).map((block) => ({
      ...block,
      order: order++,
    }));
    blocks.push(...sheetBlocks);
  }

  return {
    format: 'xlsx',
    title: filename,
    plainText: buildPlainText(blocks),
    blocks,
    warnings: blocks.length > 0 ? [] : ['XLSX_EMPTY_AFTER_PARSE'],
    metadata: {
      filename,
      contentType,
      extension: normalizeExtension(filename),
      sheet_count: sheetEntries.length,
      row_count: blocks.length,
      table_count: sheetEntries.length,
    },
  };
}

function parseJson(buffer: Buffer, filename: string, contentType?: string): ParsedDocument {
  const value = JSON.parse(buffer.toString('utf8')) as Record<string, unknown>;
  const entries = Object.entries(value);
  const blocks: ParsedDocBlock[] = entries.length > 0
    ? entries.map(([key, entry], index) => ({
        id: `json-${index}`,
        kind: 'json_entry',
        text: `${key}: ${typeof entry === 'string' ? entry : JSON.stringify(entry)}`,
        order: index,
        section_label: key,
      }))
    : [{
        id: 'json-0',
        kind: 'json_entry',
        text: JSON.stringify(value),
        order: 0,
      }];

  return {
    format: 'json',
    title: filename,
    plainText: buildPlainText(blocks),
    blocks,
    warnings: [],
    metadata: {
      filename,
      contentType,
      extension: normalizeExtension(filename),
    },
  };
}

function parseTextLike(
  buffer: Buffer,
  filename: string,
  contentType: string | undefined,
  format: 'text' | 'markdown'
): ParsedDocument {
  const text = buffer.toString('utf8').replace(/\r\n/g, '\n');
  const blocks = text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part, index) => ({
      id: `${format}-${index}`,
      kind: 'paragraph' as const,
      text: part,
      order: index,
      section_label: format === 'markdown' && part.startsWith('#') ? part.replace(/^#+\s*/, '').slice(0, 120) : undefined,
    }));

  return {
    format,
    title: filename,
    plainText: buildPlainText(blocks),
    blocks,
    warnings: [],
    metadata: {
      filename,
      contentType,
      extension: normalizeExtension(filename),
      paragraph_count: blocks.length,
    },
  };
}

function parseCsvFile(buffer: Buffer, filename: string, contentType?: string): ParsedDocument {
  const rows = parseCsv(buffer.toString('utf8'), {
    relax_column_count: true,
    skip_empty_lines: true,
  }) as string[][];
  const blocks = rowsToBlocks(rows, { tableName: 'csv' });
  return {
    format: 'csv',
    title: filename,
    plainText: buildPlainText(blocks),
    blocks,
    warnings: [],
    metadata: {
      filename,
      contentType,
      extension: normalizeExtension(filename),
      row_count: rows.length,
      table_count: 1,
    },
  };
}

async function parsePdf(buffer: Buffer, filename: string, contentType?: string): Promise<ParsedDocument> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'mm-doc-pdf-'));
  const inputPath = path.join(tempDir, 'input.pdf');
  try {
    await writeFile(inputPath, buffer);
    let pageCount: number | undefined;
    let imageCount = 0;
    try {
      const { stdout: infoStdout } = await execFile('pdfinfo', [inputPath], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        timeout: 10_000,
      });
      const pageMatch = infoStdout.match(/^Pages:\s+(\d+)/m);
      if (pageMatch) pageCount = Number(pageMatch[1]);
    } catch {
      // best-effort only
    }
    try {
      const { stdout: imagesStdout } = await execFile('pdfimages', ['-list', inputPath], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        timeout: 10_000,
      });
      const lines = imagesStdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      imageCount = Math.max(0, lines.filter((line) => /^\d+\s+\d+\s+image\b/i.test(line)).length);
    } catch {
      // best-effort only
    }
    const { stdout } = await execFile('pdftotext', ['-layout', '-nopgbrk', '-enc', 'UTF-8', inputPath, '-'], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout: 15_000,
    });
    const text = stdout.replace(/\r\n/g, '\n').trim();
    let blocks = text
      .split(/\n{2,}/)
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part, index) => ({
        id: `pdf-${index}`,
        kind: 'paragraph' as const,
        text: part,
        order: index,
      }));

    const warnings = blocks.length > 0 ? [] : ['PDF_EMPTY_AFTER_PARSE'];
    let ocrPageCount = 0;
    let visionModel: string | undefined;
    if (imageCount > 0) warnings.push('PDF_HAS_EMBEDDED_IMAGES');
    const shouldTryVisionPdfFallback =
      blocks.length === 0 &&
      (imageCount > 0 || (pageCount ?? 0) > 0) &&
      config.mmDocsVisionEnabled &&
      config.mmDocsPdfVisionOcrEnabled;
    if (shouldTryVisionPdfFallback) {
      const visionFallback = await tryParsePdfWithVisionFallback({
        inputPath,
        filename,
        contentType,
        pageCount,
      });
      warnings.push(...visionFallback.warnings);
      if (visionFallback.blocks.length > 0) {
        blocks = visionFallback.blocks;
        ocrPageCount = visionFallback.ocrPageCount;
        visionModel = visionFallback.visionModel;
        const mayRequireOcrIndex = warnings.indexOf('PDF_MAY_REQUIRE_OCR');
        if (mayRequireOcrIndex >= 0) warnings.splice(mayRequireOcrIndex, 1);
      } else {
        warnings.push('PDF_MAY_REQUIRE_OCR');
      }
    } else if (blocks.length === 0 && (imageCount > 0 || (pageCount ?? 0) > 0)) {
      warnings.push('PDF_MAY_REQUIRE_OCR');
    }

    return {
      format: 'pdf',
      title: filename,
      plainText: buildPlainText(blocks),
      blocks,
      warnings: Array.from(new Set(warnings)),
      metadata: {
        filename,
        contentType,
        extension: normalizeExtension(filename),
        paragraph_count: blocks.length,
        image_count: imageCount,
        page_count: pageCount,
        ocr_page_count: ocrPageCount,
        vision_model: visionModel,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/ENOENT/.test(message)) {
      throw new Error('PDF parse failed: pdftotext binary is not available');
    }
    throw new Error(`PDF parse failed: ${message}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function parseImageBufferWithVision(params: {
  buffer: Buffer;
  filename: string;
  contentType?: string;
  blockPrefix: string;
  sectionLabel?: string;
}): Promise<{ blocks: ParsedDocBlock[]; warnings: string[]; model: string }> {
  const vision = await parseMmDocImageWithVision({
    buffer: params.buffer,
    filename: params.filename,
    contentType: params.contentType,
  });
  const blocks = vision.lines.map((line, index) => ({
    id: `${params.blockPrefix}-${index}`,
    kind: 'paragraph' as const,
    text: line,
    order: index,
    section_label: params.sectionLabel,
  }));
  const warnings = [...vision.warnings];
  if (blocks.length === 0) warnings.push('IMAGE_EMPTY_AFTER_VISION');
  return {
    blocks,
    warnings: Array.from(new Set(warnings)),
    model: vision.model,
  };
}

async function tryParsePdfWithVisionFallback(params: {
  inputPath: string;
  filename: string;
  contentType?: string;
  pageCount?: number;
}): Promise<{
  blocks: ParsedDocBlock[];
  warnings: string[];
  visionModel?: string;
  ocrPageCount: number;
}> {
  const maxPages = Math.max(
    1,
    Math.min(config.mmDocsPdfVisionMaxPages, params.pageCount ?? config.mmDocsPdfVisionMaxPages)
  );
  const outputPrefix = path.join(path.dirname(params.inputPath), 'ocr-page');
  const warnings: string[] = [];
  try {
    await execFile(
      'pdftoppm',
      ['-png', '-f', '1', '-l', String(maxPages), '-scale-to', '1600', params.inputPath, outputPrefix],
      {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        timeout: 20_000,
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/ENOENT/.test(message)) {
      warnings.push('PDF_OCR_BINARY_UNAVAILABLE');
      return { blocks: [], warnings, ocrPageCount: 0 };
    }
    warnings.push('PDF_OCR_RENDER_FAILED');
    return { blocks: [], warnings, ocrPageCount: 0 };
  }

  const pageFiles = (await readdir(path.dirname(params.inputPath)))
    .filter((name) => /^ocr-page-\d+\.png$/i.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .slice(0, maxPages);

  const blocks: ParsedDocBlock[] = [];
  let visionModel: string | undefined;
  for (const [pageIndex, pageFile] of pageFiles.entries()) {
    try {
      const imageBuffer = await readFile(path.join(path.dirname(params.inputPath), pageFile));
      const parsed = await parseImageBufferWithVision({
        buffer: imageBuffer,
        filename: `${params.filename}#page-${pageIndex + 1}.png`,
        contentType: 'image/png',
        blockPrefix: `pdf-ocr-${pageIndex + 1}`,
        sectionLabel: `OCR page ${pageIndex + 1}`,
      });
      if (parsed.blocks.length > 0) {
        blocks.push(
          ...parsed.blocks.map((block, index) => ({
            ...block,
            order: blocks.length + index,
          }))
        );
        visionModel = parsed.model;
      }
      if (parsed.warnings.length > 0) {
        warnings.push(...parsed.warnings.map((warning) => `PDF_${warning}`));
      }
    } catch {
      warnings.push(`PDF_VISION_PAGE_${pageIndex + 1}_FAILED`);
    }
  }

  if (blocks.length > 0) warnings.push('PDF_VISION_FALLBACK_USED');
  return {
    blocks,
    warnings: Array.from(new Set(warnings)),
    visionModel,
    ocrPageCount: blocks.length > 0 ? pageFiles.length : 0,
  };
}

async function parseImage(buffer: Buffer, filename: string, contentType?: string): Promise<ParsedDocument> {
  const parsed = await parseImageBufferWithVision({
    buffer,
    filename,
    contentType,
    blockPrefix: 'image',
  });
  return {
    format: 'image',
    title: filename,
    plainText: buildPlainText(parsed.blocks),
    blocks: parsed.blocks,
    warnings: parsed.warnings,
    metadata: {
      filename,
      contentType,
      extension: normalizeExtension(filename),
      paragraph_count: parsed.blocks.length,
      image_count: 1,
      vision_model: parsed.model,
    },
  };
}

type OfficeTextExtractResult = {
  text: string;
  parserEngine: 'soffice' | 'textutil';
};

function splitParagraphBlocks(params: {
  text: string;
  format: 'doc' | 'rtf';
}): ParsedDocBlock[] {
  return params.text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part, index) => ({
      id: `${params.format}-${index}`,
      kind: 'paragraph' as const,
      text: part,
      order: index,
    }));
}

async function tryExtractOfficeTextWithSoffice(params: {
  inputPath: string;
  tempDir: string;
}): Promise<OfficeTextExtractResult | null> {
  const binary = ['soffice', 'libreoffice'].find((candidate) => {
    try {
      execFileSync(candidate, ['--version'], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        timeout: 5_000,
      });
      return true;
    } catch {
      return false;
    }
  });
  if (!binary) return null;

  await execFile(binary, ['--headless', '--convert-to', 'txt:Text', '--outdir', params.tempDir, params.inputPath], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30_000,
  });
  const txtPath = path.join(
    params.tempDir,
    `${path.basename(params.inputPath, path.extname(params.inputPath))}.txt`
  );
  const text = (await readFile(txtPath, 'utf8')).replace(/\r\n/g, '\n').trim();
  return { text, parserEngine: 'soffice' };
}

async function tryExtractOfficeTextWithTextutil(params: {
  inputPath: string;
}): Promise<OfficeTextExtractResult | null> {
  try {
    const { stdout } = await execFile('textutil', ['-convert', 'txt', '-stdout', params.inputPath], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout: 15_000,
    });
    return {
      text: stdout.replace(/\r\n/g, '\n').trim(),
      parserEngine: 'textutil',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/ENOENT/.test(message)) return null;
    throw error;
  }
}

async function parseTextUtilDocument(params: {
  buffer: Buffer;
  filename: string;
  contentType?: string;
  format: 'doc' | 'rtf';
}): Promise<ParsedDocument> {
  const tempDir = await mkdtemp(path.join(tmpdir(), `mm-doc-${params.format}-`));
  const inputPath = path.join(tempDir, params.filename);
  try {
    await writeFile(inputPath, params.buffer);
    const extracted =
      (await tryExtractOfficeTextWithSoffice({ inputPath, tempDir })) ??
      (await tryExtractOfficeTextWithTextutil({ inputPath }));
    if (!extracted) {
      throw new Error(
        `${params.format.toUpperCase()} parse failed: no compatible office converter available (expected soffice/libreoffice or textutil)`
      );
    }
    const repairedText = maybeRepairMojibake(extracted.text);
    const rawRtfFallbackText = params.format === 'rtf' ? extractVisibleTextFromRawRtfUtf8(params.buffer) : '';
    const preferredText =
      params.format === 'rtf' && shouldUseRawRtfFallback({
        originalExtractedText: extracted.text,
        repairedText,
        rawVisibleText: rawRtfFallbackText,
      })
        ? rawRtfFallbackText
        : repairedText;
    const blocks = splitParagraphBlocks({
      text: preferredText,
      format: params.format,
    });

    return {
      format: params.format,
      title: params.filename,
      plainText: buildPlainText(blocks),
      blocks,
      warnings: blocks.length > 0 ? [] : [`${params.format.toUpperCase()}_EMPTY_AFTER_PARSE`],
      metadata: {
        filename: params.filename,
        contentType: params.contentType,
        extension: normalizeExtension(params.filename),
        parser_engine: extracted.parserEngine,
        paragraph_count: blocks.length,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${params.format.toUpperCase()} parse failed: ${message}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function parseLegacySpreadsheet(params: {
  buffer: Buffer;
  filename: string;
  contentType?: string;
}): Promise<ParsedDocument> {
  try {
    const workbook = XLSX.read(params.buffer, {
      type: 'buffer',
      dense: true,
      cellDates: false,
      cellText: true,
    });
    const sheetNames = workbook.SheetNames ?? [];
    const blocks: ParsedDocBlock[] = [];
    let order = 0;
    for (const sheetName of sheetNames) {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet) continue;
      const rows = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        raw: false,
        defval: '',
        blankrows: false,
      }) as unknown[][];
      const sheetBlocks = rowsToBlocks(
        rows.map((row) => row.map((cell) => String(cell ?? '').trim())),
        { sheetName }
      ).map((block) => ({
        ...block,
        order: order++,
      }));
      blocks.push(...sheetBlocks);
    }
    return {
      format: 'xls',
      title: params.filename,
      plainText: buildPlainText(blocks),
      blocks,
      warnings: blocks.length > 0 ? ['XLS_PARSED_WITH_SHEETJS'] : ['XLS_EMPTY_AFTER_PARSE'],
      metadata: {
        filename: params.filename,
        contentType: params.contentType,
        extension: normalizeExtension(params.filename),
        parser_engine: 'sheetjs',
        sheet_count: sheetNames.length,
        row_count: blocks.length,
        table_count: sheetNames.length,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`XLS parse failed: ${message}`);
  }
}

export async function parseMmDocument(params: {
  buffer: Buffer;
  filename: string;
  contentType?: string | null;
}): Promise<ParsedDocument> {
  const contentType = params.contentType ?? undefined;
  const format = inferMmDocFormat({
    filename: params.filename,
    contentType,
  });

  if (!format) {
    throw new Error(`Unsupported MM Docs format: ${params.filename}`);
  }

  switch (format) {
    case 'text':
      return parseTextLike(params.buffer, params.filename, contentType, 'text');
    case 'markdown':
      return parseTextLike(params.buffer, params.filename, contentType, 'markdown');
    case 'json':
      return parseJson(params.buffer, params.filename, contentType);
    case 'csv':
      return parseCsvFile(params.buffer, params.filename, contentType);
    case 'pdf':
      return await parsePdf(params.buffer, params.filename, contentType);
    case 'doc':
      return await parseTextUtilDocument({
        buffer: params.buffer,
        filename: params.filename,
        contentType,
        format: 'doc',
      });
    case 'docx':
      return await parseDocx(params.buffer, params.filename, contentType);
    case 'rtf':
      return await parseTextUtilDocument({
        buffer: params.buffer,
        filename: params.filename,
        contentType,
        format: 'rtf',
      });
    case 'xls':
      return await parseLegacySpreadsheet({
        buffer: params.buffer,
        filename: params.filename,
        contentType,
      });
    case 'xlsx':
      return await parseXlsx(params.buffer, params.filename, contentType);
    case 'image':
      return await parseImage(params.buffer, params.filename, contentType);
    default:
      throw new Error(`Unsupported MM Docs parser: ${String(format)}`);
  }
}
