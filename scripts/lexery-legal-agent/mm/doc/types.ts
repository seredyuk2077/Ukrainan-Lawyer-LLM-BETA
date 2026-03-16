export type MmDocScopeType = 'conversation' | 'project' | 'user_global';

export type MmDocFormat =
  | 'text'
  | 'markdown'
  | 'json'
  | 'csv'
  | 'pdf'
  | 'doc'
  | 'docx'
  | 'rtf'
  | 'xls'
  | 'xlsx'
  | 'image';

export type MmDocSourceKind = 'chat_attachment' | 'project_upload' | 'user_upload';

export type MmDocStatus =
  | 'pending'
  | 'ingesting'
  | 'indexed'
  | 'failed';

export interface MmDocScope {
  type: MmDocScopeType;
  id: string | null;
}

export interface ParsedDocBlock {
  id: string;
  kind: 'paragraph' | 'table_row' | 'section' | 'json_entry';
  text: string;
  order: number;
  section_label?: string;
  table_name?: string;
  sheet_name?: string;
}

export interface ParsedDocument {
  format: MmDocFormat;
  title: string;
  plainText: string;
  blocks: ParsedDocBlock[];
  warnings: string[];
  metadata: {
    filename: string;
    contentType?: string;
    extension?: string;
    parser_engine?: string;
    table_count?: number;
    row_count?: number;
    sheet_count?: number;
    paragraph_count?: number;
    section_count?: number;
    image_count?: number;
    page_count?: number;
    ocr_page_count?: number;
    vision_model?: string;
  };
}

export interface MmDocChunk {
  chunk_index: number;
  text: string;
  block_ids: string[];
  section_label?: string;
  table_name?: string;
  sheet_name?: string;
  char_count: number;
}

export interface MmDocCanonical {
  version: 1;
  doc_id: string;
  tenant_id: string | null;
  user_id: string;
  project_id: string | null;
  conversation_id: string | null;
  scope: MmDocScope;
  source_kind: MmDocSourceKind;
  source_run_id?: string | null;
  original_filename: string;
  content_type?: string;
  content_sha256: string;
  parser: {
    format: MmDocFormat;
    warnings: string[];
  };
  stats: {
    block_count: number;
    chunk_count: number;
    plain_text_chars: number;
  };
  content: {
    blocks: ParsedDocBlock[];
    chunks: MmDocChunk[];
  };
}

export interface MmDocRecordInput {
  tenant_id: string | null;
  user_id: string;
  project_id?: string | null;
  conversation_id?: string | null;
  scope: MmDocScope;
  source_kind: MmDocSourceKind;
  source_run_id?: string | null;
  original_filename: string;
  content_type?: string;
  content_sha256: string;
  raw_r2_key: string;
  canonical_r2_key?: string | null;
  parser_format?: string | null;
  parser_warnings?: string[] | null;
  chunk_count?: number;
  status?: MmDocStatus;
  error_message?: string | null;
}

export interface MmDocSearchHit {
  id: string;
  score: number;
  doc_id: string;
  chunk_index: number;
  r2_key: string;
  json_path: string;
  scope_type: MmDocScopeType;
  scope_id?: string | null;
  filename?: string;
  title?: string;
  preview?: string;
}
