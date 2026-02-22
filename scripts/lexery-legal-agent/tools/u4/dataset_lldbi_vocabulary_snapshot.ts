#!/usr/bin/env node
/**
 * One-off snapshot of LLDBI vocabulary (categories, document_types) from Supabase legislation_documents.
 * Writes: _datasets/lldbi_vocabulary_snapshot.json, _reports/lldbi_vocabulary_snapshot.md
 * Usage: pnpm exec tsx scripts/lexery-legal-agent/tools/dataset_lldbi_vocabulary_snapshot.ts
 */
import { createClient } from '@supabase/supabase-js';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config as loadEnv } from 'dotenv';
import { config } from '../../lib/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(__dirname, '../.env') });

const LEGISLATION_TABLE = 'legislation_documents';
const DATASETS_DIR = resolve(__dirname, '../_datasets');
const REPORTS_DIR = resolve(__dirname, '../_reports');

async function main(): Promise<void> {
  const url = config.supabaseLegislationUrl?.trim();
  const key = config.supabaseLegislationServiceKey?.trim();
  if (!url || !key) {
    console.error('SUPABASE_LEGISLATION_URL and SUPABASE_LEGISLATION_SERVICE_ROLE_KEY (or RAG variants) required');
    process.exit(1);
  }

  const client = createClient(url, key, { auth: { persistSession: false } });

  const { data: rows, error } = await client
    .from(LEGISLATION_TABLE)
    .select('category, document_type, title')
    .eq('is_active', true)
    .eq('qdrant_status', 'indexed');

  if (error) {
    console.error('Supabase error:', error.message);
    process.exit(1);
  }

  const list = Array.isArray(rows) ? rows : [];
  const categoryCounts: Record<string, number> = {};
  const documentTypeCounts: Record<string, number> = {};
  const titlesByDocType: Record<string, string[]> = {};
  const maxTitlesPerType = 5;

  for (const row of list) {
    const cat = row?.category != null ? String(row.category).trim() : '';
    const docType = row?.document_type != null ? String(row.document_type).trim() : '';
    const title = row?.title != null ? String(row.title).trim() : '';
    if (cat) categoryCounts[cat] = (categoryCounts[cat] ?? 0) + 1;
    if (docType) {
      documentTypeCounts[docType] = (documentTypeCounts[docType] ?? 0) + 1;
      if (title && (!titlesByDocType[docType] || titlesByDocType[docType].length < maxTitlesPerType)) {
        const arr = titlesByDocType[docType] ?? [];
        if (!arr.includes(title)) arr.push(title);
        titlesByDocType[docType] = arr;
      }
    }
  }

  const categories = [...new Set(Object.keys(categoryCounts))].sort();
  const documentTypes = [...new Set(Object.keys(documentTypeCounts))].sort();
  const generated_at = new Date().toISOString();

  const jsonPayload = {
    generated_at,
    categories,
    documentTypes,
    stats: {
      totalDocs: list.length,
      distinctCategories: categories.length,
      distinctDocumentTypes: documentTypes.length,
    },
    sample_titles_by_document_type: titlesByDocType,
  };

  mkdirSync(DATASETS_DIR, { recursive: true });
  mkdirSync(REPORTS_DIR, { recursive: true });

  const jsonPath = resolve(DATASETS_DIR, 'lldbi_vocabulary_snapshot.json');
  writeFileSync(jsonPath, JSON.stringify(jsonPayload, null, 2), 'utf-8');
  console.log('Wrote', jsonPath);

  const topCategories = categories
    .map((c) => ({ key: c, cnt: categoryCounts[c]! }))
    .sort((a, b) => b.cnt - a.cnt)
    .slice(0, 15);
  const topDocTypes = documentTypes
    .map((d) => ({ key: d, cnt: documentTypeCounts[d]! }))
    .sort((a, b) => b.cnt - a.cnt)
    .slice(0, 15);

  let md = `# LLDBI vocabulary snapshot\n\nGenerated: ${generated_at}\n\n`;
  md += `## Stats\n\n`;
  md += `- Total documents (is_active, qdrant_status=indexed): ${list.length}\n`;
  md += `- Distinct categories: ${categories.length}\n`;
  md += `- Distinct document_types: ${documentTypes.length}\n\n`;
  md += `## Top 15 categories (by count)\n\n| Category | Count |\n|----------|-------|\n`;
  for (const { key, cnt } of topCategories) {
    md += `| ${key} | ${cnt} |\n`;
  }
  md += `\n## Top 15 document_types (by count)\n\n| Document type | Count |\n|---------------|-------|\n`;
  for (const { key, cnt } of topDocTypes) {
    md += `| ${key} | ${cnt} |\n`;
  }
  md += `\n## Sample titles by document_type (up to 5 per type)\n\n`;
  for (const docType of documentTypes.slice(0, 10)) {
    const samples = titlesByDocType[docType] ?? [];
    md += `### ${docType}\n\n`;
    for (const t of samples) md += `- ${t.slice(0, 100)}${t.length > 100 ? '…' : ''}\n`;
    md += '\n';
  }

  const mdPath = resolve(REPORTS_DIR, 'lldbi_vocabulary_snapshot.md');
  writeFileSync(mdPath, md, 'utf-8');
  console.log('Wrote', mdPath);
  console.log('Done. Categories:', categories.length, 'Document types:', documentTypes.length);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
