#!/usr/bin/env node

/**
 * Upload Full Canonical JSON to R2
 * 
 * Завантажує повний canonical JSON файл в R2 через MCP
 */

import { readFile } from 'fs/promises';
import { resolve } from 'path';

async function main() {
  const canonicalPath = resolve(process.cwd(), 'tmp/canonical/254к-96-вр.canonical.json');
  const content = await readFile(canonicalPath, 'utf-8');
  const canonical = JSON.parse(content);
  
  const r2Key = canonical.metadata.r2_key;
  
  console.log(`📤 Завантаження canonical JSON в R2...`);
  console.log(`   Key: ${r2Key}`);
  console.log(`   Розмір: ${(content.length / 1024).toFixed(2)} KB`);
  console.log(`   Chunks: ${canonical.content.chunks.length}`);
  console.log(`\n⚠️  Для завантаження використайте MCP:`);
  console.log(`   mcp_cloudflare-r2-legislation_upload_file`);
  console.log(`   key: ${r2Key}`);
  console.log(`   content: [повний JSON з файлу]`);
  console.log(`   contentType: application/json`);
}

main().catch(console.error);

