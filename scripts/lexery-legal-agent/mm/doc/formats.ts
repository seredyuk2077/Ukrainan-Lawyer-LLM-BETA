import path from 'path';
import type { MmDocFormat, MmDocScopeType } from './types.js';

const FORMAT_BY_EXTENSION: Record<string, MmDocFormat> = {
  '.txt': 'text',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.json': 'json',
  '.csv': 'csv',
  '.pdf': 'pdf',
  '.doc': 'doc',
  '.docx': 'docx',
  '.rtf': 'rtf',
  '.xls': 'xls',
  '.xlsx': 'xlsx',
  '.xlsm': 'xlsx',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.webp': 'image',
};

const FORMAT_BY_CONTENT_TYPE: Record<string, MmDocFormat> = {
  'text/plain': 'text',
  'text/markdown': 'markdown',
  'application/json': 'json',
  'text/csv': 'csv',
  'application/csv': 'csv',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/rtf': 'rtf',
  'text/rtf': 'rtf',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel.sheet.macroenabled.12': 'xlsx',
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/jpg': 'image',
  'image/webp': 'image',
};

export function inferMmDocFormat(params: {
  filename?: string | null;
  contentType?: string | null;
}): MmDocFormat | null {
  const normalizedContentType = normalizeContentType(params.contentType);
  if (normalizedContentType && FORMAT_BY_CONTENT_TYPE[normalizedContentType]) {
    return FORMAT_BY_CONTENT_TYPE[normalizedContentType];
  }
  const ext = normalizeExtension(params.filename);
  return ext ? (FORMAT_BY_EXTENSION[ext] ?? null) : null;
}

export function isSupportedMmDocAttachment(params: {
  filename?: string | null;
  contentType?: string | null;
}): boolean {
  return inferMmDocFormat(params) !== null;
}

export function normalizeExtension(filename?: string | null): string | undefined {
  if (!filename) return undefined;
  const ext = path.extname(filename).trim().toLowerCase();
  return ext || undefined;
}

export function normalizeContentType(contentType?: string | null): string | undefined {
  if (!contentType) return undefined;
  return contentType.split(';', 1)[0]?.trim().toLowerCase() || undefined;
}

export function resolveMmDocScope(params: {
  requestedScope?: string | null;
  projectId?: string | null;
  conversationId?: string | null;
}): { type: MmDocScopeType; id: string | null } {
  const requested = (params.requestedScope || '').trim().toLowerCase();
  if (requested === 'user_global') {
    return { type: 'user_global', id: null };
  }
  if (requested === 'project' && params.projectId) {
    return { type: 'project', id: params.projectId };
  }
  if (requested === 'conversation' && params.conversationId) {
    return { type: 'conversation', id: params.conversationId };
  }
  if (params.conversationId) {
    return { type: 'conversation', id: params.conversationId };
  }
  if (params.projectId) {
    return { type: 'project', id: params.projectId };
  }
  return { type: 'user_global', id: null };
}
