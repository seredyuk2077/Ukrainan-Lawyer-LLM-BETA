import { Document, HeadingLevel, ImageRun, Packer, Paragraph, Table, TableCell, TableRow, TextRun } from 'docx';
import { S3Client } from '@aws-sdk/client-s3';
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import * as XLSX from 'xlsx';
import { chunkParsedDocument } from '../../mm/doc/chunking.js';
import { extractMmDocAttachmentCandidates, ingestMmDocsFromRun } from '../../mm/doc/from-run.js';
import { isMmDocCanonicalKeyForRecord } from '../../lib/r2-keys.js';
import {
  inferMmDocFormat,
  isSupportedMmDocAttachment,
  resolveMmDocScope,
} from '../../mm/doc/formats.js';
import { parseMmDocument } from '../../mm/doc/parse.js';
import { buildMinimalXlsxBuffer } from './xlsx-fixture.js';
import {
  getMmDocLexicalOverlapCount,
  isMmDocHitLexicallyRelevant,
  mergeMmDocScopeResults,
  rankMmDocResolvedHitsForQuery,
  resolveMmDocSearchScopes,
} from '../../mm/doc/retrieve.js';
import { getMmDocCanonical } from '../../mm/doc/r2.js';
import { buildDocScopeFilter, buildMmDocPointId, shouldRetryMmDocsQdrantStatus } from '../../mm/doc/qdrant.js';
import {
  isTransientMmDocStoreError,
  selectMmDocIngestLogIdsToPrune,
  withTransientMmDocStoreRetry,
} from '../../mm/doc/store.js';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERT FAIL: ${message}`);
}

async function testFormatDetection(): Promise<void> {
  assert(inferMmDocFormat({ filename: 'legacy-contract.doc' }) === 'doc', 'doc by extension');
  assert(inferMmDocFormat({ filename: 'contract.docx' }) === 'docx', 'docx by extension');
  assert(inferMmDocFormat({ filename: 'notes.rtf' }) === 'rtf', 'rtf by extension');
  assert(inferMmDocFormat({ filename: 'ledger.xls' }) === 'xls', 'xls by extension');
  assert(inferMmDocFormat({ filename: 'sheet.xlsx' }) === 'xlsx', 'xlsx by extension');
  assert(inferMmDocFormat({ filename: 'claim.csv' }) === 'csv', 'csv by extension');
  assert(inferMmDocFormat({ filename: 'contract.pdf' }) === 'pdf', 'pdf by extension');
  assert(inferMmDocFormat({ filename: 'scan.png' }) === 'image', 'png by extension');
  assert(
    isSupportedMmDocAttachment({
      filename: 'legacy-contract.doc',
      contentType: 'application/msword',
    }),
    'doc content type supported'
  );
  assert(
    isSupportedMmDocAttachment({
      filename: 'legacy-ledger.xls',
      contentType: 'application/vnd.ms-excel',
    }),
    'xls content type supported'
  );
  assert(
    isSupportedMmDocAttachment({
      filename: 'claim.docx',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }),
    'docx content type supported'
  );
  assert(isSupportedMmDocAttachment({ filename: 'scan.pdf', contentType: 'application/pdf' }), 'pdf supported');
  assert(isSupportedMmDocAttachment({ filename: 'scan.jpg', contentType: 'image/jpeg' }), 'jpeg supported');
  console.log('[OK] MM Docs format detection');
}

async function testLegacyXlsParse(): Promise<void> {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ['Показник', 'Значення'],
    ['Строк', '15 робочих днів'],
    ['Сума', '250000 грн'],
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, 'Аркуш1');
  const buffer = Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'biff8' }) as Uint8Array);
  const parsed = await parseMmDocument({
    buffer,
    filename: 'legacy-terms.xls',
    contentType: 'application/vnd.ms-excel',
  });
  assert(parsed.format === 'xls', 'xls parsed');
  assert(parsed.metadata.sheet_count === 1, 'xls sheet count captured');
  assert(parsed.blocks.some((b) => b.text.includes('Строк | 15 робочих днів')), 'xls row extracted');
  assert(parsed.warnings.includes('XLS_PARSED_WITH_SHEETJS'), 'xls parser warning recorded');
  const chunks = chunkParsedDocument(parsed.blocks);
  assert(chunks.some((chunk) => chunk.text.includes('Строк | 15 робочих днів')), 'xls chunk keeps target row');
  console.log('[OK] MM Docs xls parse');
}

async function testScopeResolution(): Promise<void> {
  const chat = resolveMmDocScope({ requestedScope: 'conversation', conversationId: 'conv-1', projectId: 'proj-1' });
  assert(chat.type === 'conversation' && chat.id === 'conv-1', 'conversation scope preferred');

  const project = resolveMmDocScope({ requestedScope: 'project', projectId: 'proj-1' });
  assert(project.type === 'project' && project.id === 'proj-1', 'project scope selected');

  const fallback = resolveMmDocScope({ requestedScope: 'project', conversationId: 'conv-2' });
  assert(fallback.type === 'conversation' && fallback.id === 'conv-2', 'project without projectId falls back to conversation');

  const global = resolveMmDocScope({});
  assert(global.type === 'user_global' && global.id === null, 'global fallback when no ids');
  console.log('[OK] MM Docs scope resolution');
}

async function testScopeMergingPrefersScopedDocs(): Promise<void> {
  const merged = mergeMmDocScopeResults({
    queryText: 'Повтори лише строк з таблиці щодо передсудового врегулювання з мого документа.',
    topK: 8,
    resolvedByScope: [
      {
        scope: { scopeType: 'project', scopeId: 'proj-1' },
        hits: [
          {
            id: '1',
            doc_id: 'doc-1',
            score: 0.9,
            chunk_index: 1,
            r2_key: 'k1',
            json_path: '$.a',
            scope_type: 'project',
            scope_id: 'proj-1',
            text: 'Передсудове врегулювання | 15 робочих днів',
          },
          {
            id: '2',
            doc_id: 'doc-2',
            score: 0.88,
            chunk_index: 2,
            r2_key: 'k2',
            json_path: '$.b',
            scope_type: 'project',
            scope_id: 'proj-1',
            text: 'Гарантійний платіж | 7 банківських днів',
          },
          {
            id: '3',
            doc_id: 'doc-3',
            score: 0.87,
            chunk_index: 3,
            r2_key: 'k3',
            json_path: '$.c',
            scope_type: 'project',
            scope_id: 'proj-1',
            text: 'Арбітраж ICC',
          },
          {
            id: '4',
            doc_id: 'doc-4',
            score: 0.86,
            chunk_index: 4,
            r2_key: 'k4',
            json_path: '$.d',
            scope_type: 'project',
            scope_id: 'proj-1',
            text: 'PROJECT_LARGE_DOC_NEEDLE',
          },
        ],
      },
      {
        scope: { scopeType: 'user_global', scopeId: null },
        hits: [
          {
            id: 'g1',
            doc_id: 'global-1',
            score: 0.7,
            chunk_index: 0,
            r2_key: 'kg1',
            json_path: '$.g1',
            scope_type: 'user_global',
            scope_id: null,
            text: 'GLOBAL_POLICY_NEEDLE',
          },
        ],
      },
    ],
  });
  assert(merged.length >= 1, 'expected at least one merged hit after rerank');
  assert(!merged.some((hit) => hit.scope_type === 'user_global'), 'global hits should be skipped when scoped hits are sufficient');
  assert(merged[0]?.text.includes('15 робочих днів'), 'globally reranked scoped hits should keep the direct table answer first');
  console.log('[OK] MM Docs scope merging prefers scoped docs before user_global');
}

async function testFormatHintPrefersMatchingDocumentType(): Promise<void> {
  const ranked = rankMmDocResolvedHitsForQuery('Який строк повідомлення про дефект у моєму rtf документі цього проєкту?', [
    {
      id: 'pdf-1',
      doc_id: 'pdf-1',
      score: 0.91,
      chunk_index: 0,
      r2_key: 'pdf-key',
      json_path: '$.content.chunks[0].text',
      scope_type: 'project',
      scope_id: 'proj-1',
      filename: 'project-escrow.pdf',
      title: 'project-escrow.pdf',
      preview: 'Строк оплати escrow-платежу становить 21 календарний день.',
      text: 'Строк оплати escrow-платежу становить 21 календарний день.',
    },
    {
      id: 'rtf-1',
      doc_id: 'rtf-1',
      score: 0.72,
      chunk_index: 0,
      r2_key: 'rtf-key',
      json_path: '$.content.chunks[0].text',
      scope_type: 'project',
      scope_id: 'proj-1',
      filename: 'project-notice.rtf',
      title: 'project-notice.rtf',
      preview: 'Повідомлення про дефект подається за 48 годин.',
      text: 'Повідомлення про дефект подається за 48 годин.',
    },
  ]);
  assert(ranked.length >= 1, 'format hint ranking should keep at least one hit');
  assert(ranked[0]?.filename === 'project-notice.rtf', 'explicit RTF query should prefer matching RTF document');
  console.log('[OK] MM Docs format hint prefers matching document type');
}

async function testMmDocStoreRetry(): Promise<void> {
  assert(isTransientMmDocStoreError(new TypeError('fetch failed')), 'fetch failed is transient store error');
  assert(isTransientMmDocStoreError(new Error('UND_ERR_CONNECT_TIMEOUT')), 'connect timeout is transient store error');
  assert(!isTransientMmDocStoreError(new Error('row level security violation')), 'deterministic DB error is not transient');

  let attempts = 0;
  const result = await withTransientMmDocStoreRetry(async () => {
    attempts += 1;
    if (attempts < 3) throw new TypeError('fetch failed');
    return 'ok';
  }, 3, 1);
  assert(result === 'ok', 'store retry eventually succeeds');
  assert(attempts === 3, 'store retry used expected attempts');
  console.log('[OK] MM Docs store retry');
}

async function testMmDocIngestLogPruneSelection(): Promise<void> {
  const nowMs = Date.parse('2026-03-15T12:00:00.000Z');
  const expiredFirst = selectMmDocIngestLogIdsToPrune({
    oldestRows: [
      { id: 'old-1', created_at: '2026-02-01T00:00:00.000Z' },
      { id: 'old-2', created_at: '2026-02-02T00:00:00.000Z' },
      { id: 'fresh-1', created_at: '2026-03-14T00:00:00.000Z' },
    ],
    totalRows: 3,
    nowMs,
    retentionDays: 21,
    maxRows: 5000,
    batchSize: 10,
  });
  assert(expiredFirst.length === 2, 'expired ingest log rows should be pruned first');
  assert(expiredFirst[0] === 'old-1' && expiredFirst[1] === 'old-2', 'expired rows should keep oldest-first order');

  const overflow = selectMmDocIngestLogIdsToPrune({
    oldestRows: [
      { id: 'row-1', created_at: '2026-03-10T00:00:00.000Z' },
      { id: 'row-2', created_at: '2026-03-11T00:00:00.000Z' },
      { id: 'row-3', created_at: '2026-03-12T00:00:00.000Z' },
    ],
    totalRows: 5102,
    nowMs,
    retentionDays: 30,
    maxRows: 5000,
    batchSize: 2,
  });
  assert(overflow.length === 2, 'overflow prune should cap to batch size');
  assert(overflow[0] === 'row-1' && overflow[1] === 'row-2', 'overflow prune should delete oldest rows first');

  console.log('[OK] MM Docs ingest log prune selection');
}

async function testCsvParseAndChunking(): Promise<void> {
  const parsed = await parseMmDocument({
    buffer: Buffer.from('name,amount\nfee,100\nvat,20\n', 'utf8'),
    filename: 'table.csv',
    contentType: 'text/csv',
  });
  assert(parsed.format === 'csv', 'csv parsed');
  assert(parsed.blocks.length === 3, `expected 3 csv rows, got ${parsed.blocks.length}`);
  assert(parsed.blocks[0]?.text === 'name | amount', 'header row parsed before chunking');
  const chunks = chunkParsedDocument(parsed.blocks, { maxChars: 25, overlapChars: 5 });
  assert(chunks.length >= 2, 'csv rows split into multiple chunks');
  assert(chunks[0]?.text.includes('[Table: csv]'), 'table label kept in chunk');
  console.log('[OK] MM Docs csv parse + chunking');
}

async function testJsonParse(): Promise<void> {
  const parsed = await parseMmDocument({
    buffer: Buffer.from(JSON.stringify({ party: 'ТОВ Ромашка', amount: 120000 }), 'utf8'),
    filename: 'claim.json',
    contentType: 'application/json',
  });
  assert(parsed.format === 'json', 'json parsed');
  assert(parsed.blocks.some((b) => b.text.includes('party: ТОВ Ромашка')), 'json entry extracted');
  console.log('[OK] MM Docs json parse');
}

async function testDocxParse(): Promise<void> {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            children: [new TextRun('Розділ 1. Основні умови')],
          }),
          new Paragraph({
            children: [new TextRun('Договір поставки між сторонами.')],
          }),
          new Table({
            rows: [
              new TableRow({
                children: [
                  new TableCell({ children: [new Paragraph('Показник')] }),
                  new TableCell({ children: [new Paragraph('Значення')] }),
                ],
              }),
              new TableRow({
                children: [
                  new TableCell({ children: [new Paragraph('Сума')] }),
                  new TableCell({ children: [new Paragraph('100000 грн')] }),
                ],
              }),
            ],
          }),
        ],
      },
    ],
  });

  const buffer = Buffer.from(await Packer.toBuffer(doc));
  const parsed = await parseMmDocument({
    buffer,
    filename: 'contract.docx',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });

  assert(parsed.format === 'docx', 'docx parsed');
  assert(parsed.blocks.some((b) => b.kind === 'section' && b.text.includes('Розділ 1')), 'docx heading extracted as section');
  assert(parsed.plainText.includes('Договір поставки'), 'docx paragraph extracted');
  assert(parsed.blocks.some((b) => b.kind === 'table_row' && b.text.includes('Сума | 100000 грн')), 'docx table row extracted');
  assert(parsed.blocks.some((b) => b.kind === 'table_row' && b.section_label?.includes('Розділ 1')), 'docx table rows inherit active section');
  console.log('[OK] MM Docs docx parse');
}

async function testDocxEmbeddedImageVisionFallback(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY_BRAIN;
  process.env.OPENROUTER_API_KEY_BRAIN = 'test-key';
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                extracted_text_lines: ['Графік платежів: 3 етапи'],
                table_like_lines: ['Етап 1 | 100000 грн'],
                visual_notes: ['На зображенні є схема розбивки платежів'],
                warnings: [],
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )) as typeof fetch;

  try {
    const imageBuffer = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2u0AAAAASUVORK5CYII=',
      'base64'
    );
    const doc = new Document({
      sections: [
        {
          children: [
            new Paragraph('Додаток зі схемою платежів'),
            new Paragraph({
              children: [
                new ImageRun({
                  data: imageBuffer,
                  transformation: { width: 32, height: 32 },
                  type: 'png',
                }),
              ],
            }),
          ],
        },
      ],
    });
    const parsed = await parseMmDocument({
      buffer: Buffer.from(await Packer.toBuffer(doc)),
      filename: 'embedded-image.docx',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    assert(parsed.format === 'docx', 'docx with embedded image parsed');
    assert(parsed.plainText.includes('Графік платежів: 3 етапи'), 'embedded image OCR text extracted from docx');
    assert(parsed.blocks.some((b) => b.text.includes('Етап 1 | 100000 грн')), 'embedded image table-like line extracted');
    assert(parsed.warnings.includes('DOCX_VISION_FALLBACK_USED'), 'docx vision fallback warning present');
    assert((parsed.metadata.image_count ?? 0) >= 1, 'embedded image count captured');
    assert(Boolean(parsed.metadata.vision_model), 'embedded image vision model captured');
  } finally {
    globalThis.fetch = originalFetch;
    process.env.OPENROUTER_API_KEY_BRAIN = originalKey;
  }
  console.log('[OK] MM Docs docx embedded image fallback via vision');
}

async function testXlsxParse(): Promise<void> {
  const buffer = buildMinimalXlsxBuffer({
    sheetName: 'Умови',
    rows: [
      ['Показник', 'Значення'],
      ['Строк', '7 банківських днів'],
      ['Штраф', '12 відсотків'],
    ],
  });
  const parsed = await parseMmDocument({
    buffer,
    filename: 'project-terms.xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  assert(parsed.format === 'xlsx', 'xlsx parsed');
  assert(parsed.metadata.sheet_count === 1, 'xlsx sheet count captured');
  assert(parsed.blocks.some((b) => b.text.includes('Строк | 7 банківських днів')), 'xlsx row extracted');
  assert(parsed.blocks.some((b) => b.sheet_name === 'Умови'), 'xlsx sheet name preserved');
  const chunks = chunkParsedDocument(parsed.blocks, { maxChars: 60, overlapChars: 10 });
  assert(chunks.some((chunk) => chunk.text.includes('Строк | 7 банківських днів')), 'xlsx chunk keeps target row');
  console.log('[OK] MM Docs xlsx parse');
}

async function testImageParseWithVision(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY_BRAIN;
  process.env.OPENROUTER_API_KEY_BRAIN = 'test-key';
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                extracted_text_lines: ['Арбітраж ICC', 'Штраф 12 відсотків'],
                table_like_lines: ['Строк | 7 днів'],
                visual_notes: ['На зображенні є підписана схема оплати'],
                warnings: [],
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )) as typeof fetch;

  try {
    const parsed = await parseMmDocument({
      buffer: Buffer.from('fake-image'),
      filename: 'scan.png',
      contentType: 'image/png',
    });
    assert(parsed.format === 'image', 'image parsed');
    assert(parsed.plainText.includes('Арбітраж ICC'), 'vision extracted image text');
    assert(parsed.blocks.some((b) => b.text.includes('Строк | 7 днів')), 'vision extracted table-like line');
    assert(parsed.metadata.vision_model, 'vision model metadata present');
  } finally {
    globalThis.fetch = originalFetch;
    process.env.OPENROUTER_API_KEY_BRAIN = originalKey;
  }
  console.log('[OK] MM Docs image parse via vision');
}

async function testLegacyDocParse(): Promise<void> {
  if (spawnSync('which', ['textutil']).status !== 0) {
    console.log('[SKIP] MM Docs legacy doc parse (textutil not available)');
    return;
  }

  const tempDir = mkdtempSync(path.join(tmpdir(), 'mm-doc-doc-test-'));
  try {
    const txtPath = path.join(tempDir, 'input.txt');
    const docPath = path.join(tempDir, 'input.doc');
    writeFileSync(txtPath, 'Договір оренди\nШтраф 15 відсотків\n', 'utf8');
    execFileSync('textutil', ['-convert', 'doc', txtPath, '-output', docPath], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });

    const parsed = await parseMmDocument({
      buffer: readFileSync(docPath),
      filename: 'legacy-contract.doc',
      contentType: 'application/msword',
    });
    assert(parsed.format === 'doc', 'doc parsed');
    assert(parsed.plainText.includes('Договір оренди'), 'doc text extracted');
    assert(parsed.blocks.some((b) => b.text.includes('Штраф 15 відсотків')), 'doc blocks extracted');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
  console.log('[OK] MM Docs legacy doc parse');
}

async function testRtfParse(): Promise<void> {
  if (spawnSync('which', ['textutil']).status !== 0) {
    console.log('[SKIP] MM Docs RTF parse (textutil not available)');
    return;
  }

  const tempDir = mkdtempSync(path.join(tmpdir(), 'mm-doc-rtf-test-'));
  try {
    const txtPath = path.join(tempDir, 'input.txt');
    const rtfPath = path.join(tempDir, 'input.rtf');
    writeFileSync(txtPath, 'Арбітражне застереження\nICC Париж\n', 'utf8');
    execFileSync('textutil', ['-convert', 'rtf', txtPath, '-output', rtfPath], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });

    const parsed = await parseMmDocument({
      buffer: readFileSync(rtfPath),
      filename: 'annex.rtf',
      contentType: 'application/rtf',
    });
    assert(parsed.format === 'rtf', 'rtf parsed');
    assert(parsed.plainText.includes('Арбітражне застереження'), 'rtf text extracted');
    assert(parsed.blocks.some((b) => b.text.includes('ICC Париж')), 'rtf blocks extracted');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
  console.log('[OK] MM Docs rtf parse');
}

async function testMalformedUtf8RtfParse(): Promise<void> {
  const parsed = await parseMmDocument({
    buffer: Buffer.from(
      [
        '{\\rtf1\\ansi\\deff0',
        '{\\fonttbl{\\f0 Times New Roman;}}',
        '\\f0\\fs24',
        'Додаток до проектного договору.\\par',
        'Повідомлення про дефект подається за 48 годин.\\par',
        'PROJECT_RTF_NEEDLE',
        '}',
      ].join(''),
      'utf8'
    ),
    filename: 'project-notice.rtf',
    contentType: 'application/rtf',
  });
  assert(parsed.format === 'rtf', 'malformed utf8 rtf parsed');
  assert(parsed.plainText.includes('48 годин'), 'malformed utf8 rtf should recover defect notice text');
  console.log('[OK] MM Docs malformed UTF-8 RTF parse');
}

async function testPdfParse(): Promise<void> {
  if (spawnSync('which', ['pdftotext']).status !== 0 || spawnSync('which', ['cupsfilter']).status !== 0) {
    console.log('[SKIP] MM Docs pdf parse (pdftotext/cupsfilter not available)');
    return;
  }

  const tempDir = mkdtempSync(path.join(tmpdir(), 'mm-doc-pdf-test-'));
  try {
    const inputPath = path.join(tempDir, 'input.txt');
    writeFileSync(inputPath, 'Арбітраж ICC PDF TEST\nШтраф 12 відсотків\n', 'utf8');
    const pdfBuffer = execFileSync('cupsfilter', ['-m', 'application/pdf', inputPath], {
      encoding: 'buffer',
      maxBuffer: 8 * 1024 * 1024,
    }) as Buffer;

    const parsed = await parseMmDocument({
      buffer: pdfBuffer,
      filename: 'contract.pdf',
      contentType: 'application/pdf',
    });
    assert(parsed.format === 'pdf', 'pdf parsed');
    assert(parsed.plainText.includes('Арбітраж ICC PDF TEST'), 'pdf text extracted');
    assert(parsed.blocks.some((b) => b.text.includes('Штраф 12 відсотків')), 'pdf blocks extracted');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
  console.log('[OK] MM Docs pdf parse');
}

async function testPdfImageVisionFallback(): Promise<void> {
  if (
    spawnSync('which', ['pdftotext']).status !== 0 ||
    spawnSync('which', ['pdftoppm']).status !== 0 ||
    spawnSync('which', ['pdfimages']).status !== 0 ||
    spawnSync('which', ['sips']).status !== 0
  ) {
    console.log('[SKIP] MM Docs pdf image vision fallback (pdftotext/pdftoppm/pdfimages/sips not available)');
    return;
  }

  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY_BRAIN;
  process.env.OPENROUTER_API_KEY_BRAIN = 'test-key';
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                extracted_text_lines: ['Арбітраж ICC зі скану'],
                table_like_lines: ['Строк | 15 робочих днів'],
                visual_notes: ['На сторінці є сканована таблиця'],
                warnings: [],
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )) as typeof fetch;

  const tempDir = mkdtempSync(path.join(tmpdir(), 'mm-doc-pdf-ocr-test-'));
  try {
    const pngPath = path.join(tempDir, 'scan.png');
    const pdfPath = path.join(tempDir, 'scan.pdf');
    writeFileSync(
      pngPath,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2u0AAAAASUVORK5CYII=',
        'base64'
      )
    );
    execFileSync('sips', ['-s', 'format', 'pdf', pngPath, '--out', pdfPath], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });

    const parsed = await parseMmDocument({
      buffer: readFileSync(pdfPath),
      filename: 'scan.pdf',
      contentType: 'application/pdf',
    });
    assert(parsed.format === 'pdf', 'image-only pdf parsed');
    assert(parsed.plainText.includes('Арбітраж ICC зі скану'), 'pdf OCR fallback extracted scan text');
    assert(parsed.blocks.some((b) => b.text.includes('Строк | 15 робочих днів')), 'pdf OCR fallback extracted table-like line');
    assert(parsed.warnings.includes('PDF_VISION_FALLBACK_USED'), 'pdf OCR fallback warning present');
    assert((parsed.metadata.ocr_page_count ?? 0) >= 1, 'pdf OCR page count captured');
    assert(Boolean(parsed.metadata.vision_model), 'pdf OCR vision model metadata present');
  } finally {
    globalThis.fetch = originalFetch;
    process.env.OPENROUTER_API_KEY_BRAIN = originalKey;
    rmSync(tempDir, { recursive: true, force: true });
  }
  console.log('[OK] MM Docs pdf image fallback via vision');
}

async function testQdrantScopeFilter(): Promise<void> {
  const filter = buildDocScopeFilter({
    tenantId: 'tenant-1',
    userId: 'user-1',
    scopeType: 'conversation',
    scopeId: 'conv-1',
  });
  assert(filter.must.length === 4, `expected 4 must filters, got ${filter.must.length}`);
  assert(filter.must.some((f) => f.key === 'tenant_id' && f.match.value === 'tenant-1'), 'tenant filter present');
  assert(filter.must.some((f) => f.key === 'scope_id' && f.match.value === 'conv-1'), 'scope filter present');
  const nullTenantFilter = buildDocScopeFilter({
    tenantId: null,
    userId: 'user-1',
    scopeType: 'user_global',
    scopeId: null,
  });
  assert(
    nullTenantFilter.must.some((f) => f.key === 'tenant_id' && f.match.value === ''),
    'null tenant must still produce an explicit tenant isolation filter'
  );
  console.log('[OK] MM Docs Qdrant filter');
}

async function testQdrantPointId(): Promise<void> {
  const a = buildMmDocPointId('8aed343a-b025-417d-9e5c-244362162091', 0);
  const b = buildMmDocPointId('8aed343a-b025-417d-9e5c-244362162091', 1);
  assert(a !== b, 'different chunks must produce different point ids');
  assert(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(a),
    'point id must be UUID-shaped for Qdrant'
  );
  console.log('[OK] MM Docs Qdrant point id');
}

async function testQdrantRetryPolicy(): Promise<void> {
  assert(shouldRetryMmDocsQdrantStatus(503), '503 should retry');
  assert(shouldRetryMmDocsQdrantStatus(429), '429 should retry');
  assert(!shouldRetryMmDocsQdrantStatus(400), '400 should not retry');
  console.log('[OK] MM Docs Qdrant retry policy');
}

async function testLexicalRelevanceGate(): Promise<void> {
  assert(
    getMmDocLexicalOverlapCount({
      queryText: 'арбітражна обмовка ICC',
      snippetText: 'арбітражна обмовка: спори вирішуються за правилами ICC у Парижі',
    }) >= 2,
    'lexical overlap count should capture relevant anchors'
  );
  assert(
    getMmDocLexicalOverlapCount({
      queryText: 'манго 99 відсотків FOREIGN_CHAT_NEEDLE',
      snippetText: 'marker | PROJECT_SCOPE_NEEDLE',
    }) === 0,
    'underscore markers must stay atomic and not overlap by shared suffix tokens'
  );
  assert(
    isMmDocHitLexicallyRelevant({
      queryText: 'Повтори лише розмір штрафу за прострочення поставки яблук з мого документа.',
      snippetText: 'штраф за прострочення поставки яблук становить 12 відсотків за кожен день затримки',
      semanticScore: 0.42,
      scopeType: 'conversation',
    }),
    'relevant doc snippet with lexical overlap must pass'
  );
  assert(
    !isMmDocHitLexicallyRelevant({
      queryText: 'манго 99 відсотків FOREIGN_CHAT_NEEDLE',
      snippetText: 'гарантійний платіж повертається за 7 банківських днів',
      semanticScore: 0.61,
      scopeType: 'project',
    }),
    'unrelated snippet without lexical overlap must be dropped'
  );
  assert(
    isMmDocHitLexicallyRelevant({
      queryText: 'арбітражна обмовка ICC',
      snippetText: 'арбітражна обмовка: спори вирішуються за правилами ICC у Парижі',
      semanticScore: 0.33,
      scopeType: 'user_global',
    }),
    'overlap should beat a low semantic score'
  );
  assert(
    isMmDocHitLexicallyRelevant({
      queryText: 'уточни штрафні санкції з цього документа',
      snippetText: 'пеня становить 12 відсотків за кожен день затримки',
      semanticScore: 0.91,
      scopeType: 'conversation',
    }),
    'conversation scope may use strong semantic fallback when lexical overlap is absent'
  );
  assert(
    isMmDocHitLexicallyRelevant({
      queryText: 'уточни штрафні санкції з цього документа',
      snippetText: 'пеня становить 12 відсотків за кожен день затримки',
      semanticScore: 0.91,
      scopeType: 'project',
    }),
    'broader scopes should also allow a strong semantic fallback when wording differs'
  );
  assert(
    !isMmDocHitLexicallyRelevant({
      queryText: 'уточни штрафні санкції з цього документа',
      snippetText: 'пеня становить 12 відсотків за кожен день затримки',
      semanticScore: 0.77,
      scopeType: 'project',
    }),
    'semantic-only fallback still needs a high score floor'
  );
  console.log('[OK] MM Docs lexical relevance gate');
}

async function testHybridRerankPrefersLexicalExactness(): Promise<void> {
  const ranked = rankMmDocResolvedHitsForQuery('арбітражна обмовка ICC Париж', [
    {
      id: 'semantic-only',
      score: 0.96,
      doc_id: 'doc-1',
      chunk_index: 2,
      r2_key: 'r2-1',
      json_path: '$.content.chunks[2].text',
      scope_type: 'conversation',
      text: 'Платіж повертається протягом семи днів після підписання акта.',
    },
    {
      id: 'exactish',
      score: 0.74,
      doc_id: 'doc-1',
      chunk_index: 1,
      r2_key: 'r2-1',
      json_path: '$.content.chunks[1].text',
      scope_type: 'conversation',
      text: 'Арбітражна обмовка: усі спори вирішуються за правилами ICC у Парижі англійською мовою.',
    },
  ]);
  assert(ranked.length === 1 || ranked.length === 2, 'rerank should preserve relevant rows');
  assert(ranked[0]?.id === 'exactish', 'lexically exact MM Docs chunk must outrank semantic-only row');
  console.log('[OK] MM Docs hybrid rerank prefers lexical exactness');
}

async function testHybridRerankHonorsQueryScopePreference(): Promise<void> {
  const ranked = rankMmDocResolvedHitsForQuery(
    'Яка норма закону регулює строк виконання зобовʼязання і що про це сказано в моєму договорі про гарантійний платіж?',
    [
      {
        id: 'project-term',
        score: 0.94,
        doc_id: 'doc-project',
        chunk_index: 1,
        r2_key: 'r2-project',
        json_path: '$.content.chunks[1].text',
        scope_type: 'project',
        scope_id: 'proj-1',
        text: 'Передсудове врегулювання | 15 робочих днів',
      },
      {
        id: 'conversation-contract',
        score: 0.92,
        doc_id: 'doc-conversation',
        chunk_index: 0,
        r2_key: 'r2-conversation',
        json_path: '$.content.chunks[0].text',
        scope_type: 'conversation',
        scope_id: 'conv-1',
        text: 'Гарантійний платіж повертається за 7 банківських днів після підписання остаточного акта приймання-передачі.',
      },
    ]
  );
  assert(
    ranked[0]?.id === 'conversation-contract',
    'conversation contract clause should outrank broader project table hit for in-this-contract query'
  );
  console.log('[OK] MM Docs hybrid rerank honors query scope preference');
}

async function testSearchScopeResolution(): Promise<void> {
  const allScopes = resolveMmDocSearchScopes({
    queryText: 'Що сказано у цьому документі?',
    conversationId: 'conv-1',
    projectId: 'proj-1',
  });
  assert(allScopes.length === 3, `expected 3 search scopes, got ${allScopes.length}`);
  assert(allScopes[0]?.scopeType === 'conversation', 'conversation scope must be first');
  assert(allScopes[1]?.scopeType === 'project', 'project scope must be second');
  assert(allScopes[2]?.scopeType === 'user_global', 'user_global scope must always remain available');

  const projectlessGlobal = resolveMmDocSearchScopes({
    queryText: 'Що сказано у моїх завантажених документах?',
    conversationId: 'conv-2',
    availability: {
      conversation: false,
      project: false,
      user_global: true,
    },
  });
  assert(projectlessGlobal.length === 1, `expected 1 projectless global scope, got ${projectlessGlobal.length}`);
  assert(projectlessGlobal[0]?.scopeType === 'user_global', 'global docs must stay searchable in a new chat without project context');
  const projectPreferred = resolveMmDocSearchScopes({
    queryText: 'Який строк передсудового врегулювання у моїй проектній таблиці?',
    conversationId: 'conv-1',
    projectId: 'proj-1',
  });
  assert(projectPreferred[0]?.scopeType === 'project', 'project-scoped query should search project first');
  console.log('[OK] MM Docs search scope resolution');
}

async function testRunAttachmentCandidateExtraction(): Promise<void> {
  const candidates = extractMmDocAttachmentCandidates({
    snapshot: {
      project_context: {
        project_id: 'proj-1',
        mm_doc_scope: 'project',
      },
    },
    attachmentsManifest: [
      {
        name: 'contract.docx',
        size: 10,
        storage: 'r2',
        r2_key: 'tenant/t/mm/docs/user/u/raw/a/contract.docx',
        content_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        mm_doc_candidate: true,
      },
      {
        name: 'inline.txt',
        size: 5,
        storage: 'inline',
        mm_doc_candidate: true,
      },
      {
        name: 'note.pdf',
        size: 8,
        storage: 'r2',
        r2_key: 'tenant/t/mm/docs/user/u/raw/b/note.pdf',
        content_type: 'application/pdf',
        mm_doc_candidate: false,
      },
    ],
  });

  assert(candidates.length === 1, `expected 1 doc candidate, got ${candidates.length}`);
  assert(candidates[0]?.requested_scope === 'project', 'requested scope propagated from snapshot');
  assert(candidates[0]?.r2_key === 'tenant/t/mm/docs/user/u/raw/a/contract.docx', 'r2 key preserved');
  console.log('[OK] MM Docs run attachment candidate extraction');
}

async function testRunAttachmentCandidateExtractionSkipsUrlLikeKeys(): Promise<void> {
  const candidates = extractMmDocAttachmentCandidates({
    snapshot: {
      project_context: {
        project_id: 'proj-1',
        mm_doc_scope: 'project',
      },
    },
    attachmentsManifest: [
      {
        name: 'unsafe.docx',
        size: 10,
        storage: 'r2',
        r2_key:
          'https://example.com/lexery-legal-agent/tenant/t/runs/run-1/attachments/unsafe.docx?sig=abc',
        content_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        mm_doc_candidate: true,
      },
    ],
  });

  assert(candidates.length === 0, `url-like r2 keys must be rejected, got ${candidates.length}`);
  console.log('[OK] MM Docs run attachment extraction skips url-like keys');
}

async function testRunAttachmentIngestDispatch(): Promise<void> {
  const calls: Array<Record<string, unknown>> = [];
  const results = await ingestMmDocsFromRun({
    runId: 'run-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    conversationId: 'conv-1',
    projectId: 'proj-1',
    snapshot: {
      project_context: {
        project_id: 'proj-1',
        mm_doc_scope: 'project',
      },
    },
    attachmentsManifest: [
      {
        name: 'terms.csv',
        size: 10,
        storage: 'r2',
        r2_key: 'tenant/t/mm/docs/user/u/raw/a/terms.csv',
        content_type: 'text/csv',
        mm_doc_candidate: true,
      },
    ],
    ingestFn: async (params) => {
      calls.push(params as unknown as Record<string, unknown>);
      return {
        docId: 'doc-1',
        canonicalR2Key: 'tenant/t/mm/docs/user/u/scope/project/proj-1/doc-1/canonical.v1.json',
        chunkCount: 3,
      };
    },
  });

  assert(calls.length === 1, `expected 1 ingest call, got ${calls.length}`);
  assert(calls[0]?.requestedScope === 'project', 'ingest requestedScope propagated');
  assert(calls[0]?.sourceKind === 'project_upload', 'project scope uses project_upload source kind');
  assert(results.length === 1 && results[0]?.filename === 'terms.csv', 'ingest results preserve filename');
  console.log('[OK] MM Docs run attachment ingest dispatch');
}

async function testCanonicalR2Caching(): Promise<void> {
  const originalSend = S3Client.prototype.send;
  let fetchCount = 0;
  const canonicalPayload = {
    version: 1,
    doc_id: 'doc-cache',
    tenant_id: 'tenant-1',
    user_id: 'user-1',
    project_id: null,
    conversation_id: 'conv-1',
    scope: { type: 'conversation', id: 'conv-1' },
    source_kind: 'chat_attachment',
    source_run_id: null,
    original_filename: 'cache.txt',
    content_sha256: 'sha',
    parser: { format: 'text', warnings: [] },
    stats: { block_count: 1, chunk_count: 1, plain_text_chars: 12 },
    content: {
      blocks: [{ id: 'b1', kind: 'paragraph', text: 'cached text', order: 0 }],
      chunks: [{ chunk_index: 0, text: 'cached text', block_ids: ['b1'], char_count: 11 }],
    },
  };

  S3Client.prototype.send = (async function mockedSend() {
    fetchCount++;
    return {
      Body: {
        async transformToByteArray() {
          return Buffer.from(JSON.stringify(canonicalPayload), 'utf8');
        },
      },
    } as never;
  }) as typeof S3Client.prototype.send;

  try {
    const first = await getMmDocCanonical('tenant/t/mm/docs/user/u/scope/conversation/conv-1/doc-cache/canonical.v1.json');
    const second = await getMmDocCanonical('tenant/t/mm/docs/user/u/scope/conversation/conv-1/doc-cache/canonical.v1.json');
    assert(first.doc_id === 'doc-cache', 'first canonical fetch must parse payload');
    assert(second.doc_id === 'doc-cache', 'second canonical fetch must reuse payload');
    assert(fetchCount === 1, `canonical fetch cache must collapse duplicate loads, got ${fetchCount}`);
  } finally {
    S3Client.prototype.send = originalSend;
  }
  console.log('[OK] MM Docs canonical R2 caching');
}

async function testCanonicalKeyValidation(): Promise<void> {
  assert(
    isMmDocCanonicalKeyForRecord({
      tenantId: 'tenant-1',
      userId: 'user-1',
      scopeType: 'project',
      scopeId: 'proj-1',
      docId: 'doc-1',
      r2Key: 'tenant/tenant-1/mm/docs/user/user-1/scope/project/proj-1/doc-1/canonical.v1.json',
    }),
    'canonical validator must accept matching tenant/user/scope/doc path'
  );
  assert(
    !isMmDocCanonicalKeyForRecord({
      tenantId: 'tenant-1',
      userId: 'user-1',
      scopeType: 'project',
      scopeId: 'proj-1',
      docId: 'doc-1',
      r2Key: 'tenant/tenant-1/mm/docs/user/other-user/scope/project/proj-1/doc-1/canonical.v1.json',
    }),
    'canonical validator must reject foreign-user path'
  );
  console.log('[OK] MM Docs canonical key validation');
}

async function main(): Promise<void> {
  await testFormatDetection();
  await testScopeResolution();
  await testScopeMergingPrefersScopedDocs();
  await testFormatHintPrefersMatchingDocumentType();
  await testMmDocStoreRetry();
  await testMmDocIngestLogPruneSelection();
  await testCsvParseAndChunking();
  await testJsonParse();
  await testDocxParse();
  await testDocxEmbeddedImageVisionFallback();
  await testLegacyXlsParse();
  await testXlsxParse();
  await testImageParseWithVision();
  await testLegacyDocParse();
  await testRtfParse();
  await testMalformedUtf8RtfParse();
  await testPdfParse();
  await testPdfImageVisionFallback();
  await testQdrantScopeFilter();
  await testQdrantPointId();
  await testQdrantRetryPolicy();
  await testLexicalRelevanceGate();
  await testHybridRerankPrefersLexicalExactness();
  await testHybridRerankHonorsQueryScopePreference();
  await testSearchScopeResolution();
  await testRunAttachmentCandidateExtraction();
  await testRunAttachmentCandidateExtractionSkipsUrlLikeKeys();
  await testRunAttachmentIngestDispatch();
  await testCanonicalR2Caching();
  await testCanonicalKeyValidation();
  console.log('All MM Docs unit tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
