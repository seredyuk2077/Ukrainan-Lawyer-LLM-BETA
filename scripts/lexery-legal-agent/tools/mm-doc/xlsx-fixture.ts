import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function columnName(index: number): string {
  let current = index + 1;
  let out = '';
  while (current > 0) {
    const remainder = (current - 1) % 26;
    out = String.fromCharCode(65 + remainder) + out;
    current = Math.floor((current - 1) / 26);
  }
  return out;
}

export function buildMinimalXlsxBuffer(params: {
  sheetName?: string;
  rows: string[][];
}): Buffer {
  const sheetName = params.sheetName?.trim() || 'Sheet1';
  const tempDir = mkdtempSync(path.join(tmpdir(), 'mm-doc-xlsx-'));
  const rootDir = path.join(tempDir, 'xlsx');
  const sharedStrings: string[] = [];
  const sharedStringIndex = new Map<string, number>();

  const getSharedStringRef = (value: string): number => {
    const existing = sharedStringIndex.get(value);
    if (existing != null) return existing;
    const index = sharedStrings.length;
    sharedStrings.push(value);
    sharedStringIndex.set(value, index);
    return index;
  };

  try {
    mkdirSync(path.join(rootDir, '_rels'), { recursive: true });
    mkdirSync(path.join(rootDir, 'xl', '_rels'), { recursive: true });
    mkdirSync(path.join(rootDir, 'xl', 'worksheets'), { recursive: true });

    const rowsXml = params.rows
      .map((row, rowIndex) => {
        const cellsXml = row
          .map((cellValue, cellIndex) => {
            const ref = `${columnName(cellIndex)}${rowIndex + 1}`;
            const sharedIndex = getSharedStringRef(String(cellValue ?? ''));
            return `<c r="${ref}" t="s"><v>${sharedIndex}</v></c>`;
          })
          .join('');
        return `<row r="${rowIndex + 1}">${cellsXml}</row>`;
      })
      .join('');

    const sharedStringsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">
${sharedStrings.map((value) => `<si><t>${escapeXml(value)}</t></si>`).join('')}
</sst>`;

    const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${rowsXml}</sheetData>
</worksheet>`;

    const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`;

    const workbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`;

    const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

    const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>`;

    writeFileSync(path.join(rootDir, '[Content_Types].xml'), contentTypesXml, 'utf8');
    writeFileSync(path.join(rootDir, '_rels', '.rels'), rootRelsXml, 'utf8');
    writeFileSync(path.join(rootDir, 'xl', 'workbook.xml'), workbookXml, 'utf8');
    writeFileSync(path.join(rootDir, 'xl', '_rels', 'workbook.xml.rels'), workbookRelsXml, 'utf8');
    writeFileSync(path.join(rootDir, 'xl', 'sharedStrings.xml'), sharedStringsXml, 'utf8');
    writeFileSync(path.join(rootDir, 'xl', 'worksheets', 'sheet1.xml'), sheetXml, 'utf8');

    const outPath = path.join(tempDir, 'fixture.xlsx');
    execFileSync('zip', ['-qr', outPath, '.'], {
      cwd: rootDir,
      encoding: 'buffer',
      maxBuffer: 8 * 1024 * 1024,
    });
    return readFileSync(outPath);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
