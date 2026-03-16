import { config } from '../../lib/config.js';
import type { MmDocChunk, ParsedDocBlock } from './types.js';

function normalizeBlockText(block: ParsedDocBlock): string {
  const labels: string[] = [];
  if (block.section_label) labels.push(block.section_label);
  if (block.sheet_name) labels.push(`Sheet: ${block.sheet_name}`);
  if (block.table_name) labels.push(`Table: ${block.table_name}`);
  const prefix = labels.length > 0 ? `[${labels.join(' | ')}]\n` : '';
  return `${prefix}${block.text}`.trim();
}

function overlapTail(text: string, overlapChars: number): string {
  if (overlapChars <= 0 || text.length <= overlapChars) return text;
  const slice = text.slice(-overlapChars);
  const boundary = slice.indexOf(' ');
  return boundary >= 0 ? slice.slice(boundary + 1) : slice;
}

export function chunkParsedDocument(
  blocks: ParsedDocBlock[],
  options?: { maxChars?: number; overlapChars?: number }
): MmDocChunk[] {
  const maxChars = options?.maxChars ?? config.mmDocsChunkMaxChars;
  const overlapChars = options?.overlapChars ?? config.mmDocsChunkOverlapChars;
  const chunks: MmDocChunk[] = [];

  let currentText = '';
  let currentBlockIds: string[] = [];
  let currentSection: string | undefined;
  let currentTable: string | undefined;
  let currentSheet: string | undefined;

  function flush(): void {
    const text = currentText.trim();
    if (!text) return;
    chunks.push({
      chunk_index: chunks.length,
      text,
      block_ids: [...currentBlockIds],
      section_label: currentSection,
      table_name: currentTable,
      sheet_name: currentSheet,
      char_count: text.length,
    });
    currentText = overlapTail(text, overlapChars);
    currentBlockIds = [];
    currentSection = undefined;
    currentTable = undefined;
    currentSheet = undefined;
  }

  for (const block of blocks) {
    const normalized = normalizeBlockText(block);
    if (!normalized) continue;

    if (block.kind === 'section' && currentText.trim()) {
      flush();
    } else if (currentText.trim() && block.section_label && currentSection && block.section_label !== currentSection) {
      flush();
    }

    if (normalized.length > maxChars) {
      flush();
      let cursor = 0;
      while (cursor < normalized.length) {
        const end = Math.min(normalized.length, cursor + maxChars);
        const slice = normalized.slice(cursor, end).trim();
        if (slice) {
          chunks.push({
            chunk_index: chunks.length,
            text: slice,
            block_ids: [block.id],
            section_label: block.section_label,
            table_name: block.table_name,
            sheet_name: block.sheet_name,
            char_count: slice.length,
          });
        }
        if (end >= normalized.length) break;
        cursor = Math.max(end - overlapChars, cursor + 1);
      }
      continue;
    }

    const candidate = currentText ? `${currentText}\n\n${normalized}` : normalized;
    if (candidate.length > maxChars && currentText) {
      flush();
      currentText = normalized;
    } else {
      currentText = candidate;
    }
    currentBlockIds.push(block.id);
    currentSection = currentSection ?? block.section_label;
    currentTable = currentTable ?? block.table_name;
    currentSheet = currentSheet ?? block.sheet_name;
  }

  flush();
  return chunks;
}
