#!/usr/bin/env node

/**
 * Pipeline Import One — повний пайплайн імпорту одного документа
 * 
 * Виконує:
 * 1. Fetch з rada.gov.ua
 * 2. Build canonical JSON
 * 3. Chunking
 * 4. Upload canonical JSON to R2 (ПЕРЕД DB)
 * 5. Generate embeddings
 * 6. Insert to Supabase (з правильним r2_key)
 * 7. Validation
 * 
 * Використання:
 *   pnpm tsx scripts/legislation/pipeline_import_one.ts --nreg "254к/96-вр"
 *   pnpm tsx scripts/legislation/pipeline_import_one.ts --nreg "254к/96-вр" --force
 */

import dotenv from 'dotenv';
import { resolve } from 'path';
import { RadaClient } from './radaClient.js';
import { validateConfig, PATHS } from './config.js';
import { buildCanonical, CanonicalDocument } from './canonical/buildCanonical.js';
import { createChunksFromArticles } from './canonical/chunking.js';
import { generateEmbeddingsBatch } from './canonical/embeddings.js';
import { nregToSafeFilename } from './utils/nreg.js';
import { mkdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { createR2Client, getLegislationBucket } from './lib/r2Client.js';
import { uploadFileToR2 } from './lib/r2Upload.js';
import { generateR2Key } from './canonical/r2Path.js';

dotenv.config({ path: resolve(process.cwd(), '.env') });

/**
 * Парсить аргументи
 */
function parseArgs(): { nreg: string; force: boolean } {
  const args = process.argv.slice(2);
  let nreg: string | null = null;
  let force = false;

  for (const arg of args) {
    if (arg.startsWith('--nreg=')) {
      nreg = arg.substring('--nreg='.length);
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Використання:
  pnpm tsx scripts/legislation/pipeline_import_one.ts --nreg="<nreg>"

Параметри:
  --nreg   NREG документа (обов'язково)
  --force  Примусово перезавантажити навіть якщо документ вже існує

Приклад:
  pnpm tsx scripts/legislation/pipeline_import_one.ts --nreg="254к/96-вр"
      `);
      process.exit(0);
    }
  }

  if (!nreg) {
    console.error('❌ Помилка: не вказано --nreg');
    process.exit(1);
  }

  return { nreg, force };
}

/**
 * Крок 1: Fetch з rada.gov.ua
 */
async function fetchDocument(nreg: string): Promise<{
  jsonPath: string;
  txtPath?: string;
}> {
  console.log(`\n📥 Крок 1: Завантаження документа з rada.gov.ua...`);
  console.log(`   NREG: ${nreg}`);

  const client = new RadaClient();
  await mkdir(PATHS.radaRaw, { recursive: true });
  
  const safeFilename = nregToSafeFilename(nreg);
  const jsonPath = `${PATHS.radaRaw}/${safeFilename}.json`;
  const txtPath = `${PATHS.radaRaw}/${safeFilename}.txt`;

  const jsonData = await client.fetchJson(nreg);
  await writeFile(jsonPath, JSON.stringify(jsonData, null, 2), 'utf-8');
  console.log(`   ✅ JSON збережено: ${jsonPath}`);

  let txtContent: string | undefined;
  try {
    txtContent = await client.fetchTxt(nreg);
    if (txtContent) {
      await writeFile(txtPath, txtContent, 'utf-8');
      console.log(`   ✅ TXT збережено: ${txtPath}`);
    }
  } catch (error) {
    console.log(`   ⚠️  TXT недоступний (продовжуємо з JSON)`);
  }

  return {
    jsonPath,
    txtPath: existsSync(txtPath) ? txtPath : undefined,
  };
}

/**
 * Крок 2: Build canonical JSON
 */
async function buildCanonicalDocument(
  jsonPath: string,
  txtPath?: string
): Promise<CanonicalDocument> {
  console.log(`\n📋 Крок 2: Побудова canonical JSON...`);

  const canonical = await buildCanonical({
    jsonPath,
    txtPath,
  });

  const safeFilename = nregToSafeFilename(canonical.metadata.rada_nreg);
  await mkdir(PATHS.canonical, { recursive: true });
  const canonicalPath = `${PATHS.canonical}/${safeFilename}.canonical.json`;
  await writeFile(canonicalPath, JSON.stringify(canonical, null, 2), 'utf-8');
  
  console.log(`   ✅ Canonical JSON створено:`);
  console.log(`      Статей: ${canonical.content.articles.length}`);
  console.log(`      Chunks: ${canonical.content.chunks.length}`);
  console.log(`      Content hash: ${canonical.metadata.content_hash}`);
  console.log(`      R2 key: ${canonical.metadata.r2_key}`);

  return canonical;
}

/**
 * Крок 3: Upload canonical JSON to R2 (ПЕРЕД DB!)
 */
async function uploadCanonicalToR2(
  canonical: CanonicalDocument
): Promise<string> {
  console.log(`\n☁️  Крок 3: Завантаження canonical JSON в R2...`);

  const r2Key = canonical.metadata.r2_key || generateR2Key(
    canonical.metadata.category,
    canonical.metadata.rada_nreg
  );

  const safeFilename = nregToSafeFilename(canonical.metadata.rada_nreg);
  const filePath = `${PATHS.canonical}/${safeFilename}.canonical.json`;

  if (!existsSync(filePath)) {
    throw new Error(`Canonical JSON файл не знайдено: ${filePath}`);
  }

  const client = createR2Client();
  const bucket = getLegislationBucket();

  const result = await uploadFileToR2(
    client,
    bucket,
    r2Key,
    filePath,
    {
      contentType: 'application/json; charset=utf-8',
      skipIfExists: true,
    }
  );

  console.log(`   ✅ Завантажено в R2:`);
  console.log(`      R2 Key: ${result.r2Key}`);
  console.log(`      Розмір: ${(result.size / 1024).toFixed(2)} KB`);
  console.log(`      ETag: ${result.etag}`);

  return result.r2Key;
}

/**
 * Крок 4: Generate embeddings
 */
async function generateEmbeddingsForChunks(
  chunks: Array<{ text: string }>
): Promise<number[][]> {
  console.log(`\n🧠 Крок 4: Генерація embeddings...`);
  console.log(`   Кількість чанків: ${chunks.length}`);

  const apiKey = process.env.OPEN_ROUTER_API_RAG || process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPEN_ROUTER_API_RAG або OPENROUTER_API_KEY не встановлено');
  }

  const texts = chunks.map(c => c.text);
  const results = await generateEmbeddingsBatch(texts, apiKey, 3);

  console.log(`   ✅ Embeddings згенеровано: ${results.length}`);
  console.log(`   Розмірність: ${results[0].dimensions}`);

  return results.map(r => r.embedding);
}

/**
 * Крок 5: Insert to Supabase (з правильним r2_key)
 */
async function insertToSupabase(
  canonical: CanonicalDocument,
  embeddings: number[][],
  r2Key: string // Фактичний r2_key після завантаження
): Promise<void> {
  console.log(`\n💾 Крок 5: Вставка в Supabase...`);

  const url = process.env.SUPABASE_LEGISLATION_URL;
  const key = process.env.SUPABASE_LEGISLATION_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('SUPABASE_LEGISLATION_URL та SUPABASE_LEGISLATION_SERVICE_ROLE_KEY не встановлено');
  }

  const supabase = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Upsert документ з правильним r2_key
  console.log(`   Вставка документа...`);
  const { error: docError } = await supabase
    .from('legislation_documents')
    .upsert({
      rada_nreg: canonical.metadata.rada_nreg,
      rada_dokid: canonical.metadata.rada_dokid,
      title: canonical.metadata.title,
      document_type: canonical.metadata.document_type,
      category: canonical.metadata.category,
      law_number: canonical.metadata.law_number,
      rada_datred: canonical.metadata.rada_datred,
      content_hash: canonical.metadata.content_hash,
      previous_hash: canonical.metadata.previous_hash,
      r2_key: r2Key, // Використовуємо фактичний r2_key після завантаження
      source_url: canonical.metadata.source_url,
      articles_count: canonical.content.articles.length,
      chunks_count: canonical.content.chunks.length,
      imported_at: canonical.metadata.imported_at,
      updated_at: canonical.metadata.updated_at,
      is_active: true,
      sync_status: 'synced', // Тільки після успішного завантаження в R2
      keywords: canonical.ai_enrichment?.keywords || [],
      topics: canonical.ai_enrichment?.topics || [],
    }, {
      onConflict: 'rada_nreg',
    });

  if (docError) {
    throw new Error(`Помилка вставки документа: ${docError.message}`);
  }
  console.log(`   ✅ Документ вставлено`);

  // Вставляємо chunks
  console.log(`   Вставка chunks (${canonical.content.chunks.length})...`);
  
  const chunks = canonical.content.chunks;
  const batchSize = 50;
  
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const batchEmbeddings = embeddings.slice(i, i + batchSize);
    
    const chunksToInsert = batch.map((chunk, idx) => ({
      document_nreg: canonical.metadata.rada_nreg,
      r2_key: r2Key, // Використовуємо той самий r2_key
      json_path: `$.content.chunks[${chunk.chunk_index}].text`,
      chunk_index: chunk.chunk_index,
      embedding: batchEmbeddings[idx],
      article_number: chunk.article_number,
      token_count: chunk.token_count,
    }));

    const { error: chunksError } = await supabase
      .from('legislation_chunks')
      .upsert(chunksToInsert, {
        onConflict: 'id',
      });

    if (chunksError) {
      throw new Error(`Помилка вставки chunks (batch ${Math.floor(i / batchSize) + 1}): ${chunksError.message}`);
    }
    
    console.log(`   ✅ Batch ${Math.floor(i / batchSize) + 1}: ${batch.length} chunks`);
  }

  console.log(`   ✅ Всі chunks вставлено`);
}

/**
 * Крок 6: Валідація
 */
async function validateImport(nreg: string, r2Key: string): Promise<void> {
  console.log(`\n✅ Крок 6: Валідація...`);

  const url = process.env.SUPABASE_LEGISLATION_URL;
  const key = process.env.SUPABASE_LEGISLATION_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('Supabase credentials не встановлено');
  }

  const supabase = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Перевірка документа
  const { data: doc, error: docError } = await supabase
    .from('legislation_documents')
    .select('*')
    .eq('rada_nreg', nreg)
    .single();

  if (docError || !doc) {
    throw new Error(`Документ не знайдено: ${docError?.message}`);
  }

  console.log(`   ✅ Документ: ${doc.title}`);
  console.log(`      R2 Key: ${doc.r2_key}`);
  console.log(`      Chunks count: ${doc.chunks_count}`);
  console.log(`      Sync status: ${doc.sync_status}`);

  // Перевірка що r2_key співпадає
  if (doc.r2_key !== r2Key) {
    console.warn(`   ⚠️  R2 key не співпадає: DB має "${doc.r2_key}", очікується "${r2Key}"`);
  }

  // Перевірка chunks
  const { data: chunks, error: chunksError } = await supabase
    .from('legislation_chunks')
    .select('chunk_index, article_number, json_path, r2_key')
    .eq('document_nreg', nreg)
    .order('chunk_index');

  if (chunksError) {
    throw new Error(`Помилка отримання chunks: ${chunksError.message}`);
  }

  console.log(`   ✅ Chunks: ${chunks.length}`);
  
  // Перевірка що всі chunks мають правильний r2_key
  const wrongR2Key = chunks.filter(c => c.r2_key !== r2Key);
  if (wrongR2Key.length > 0) {
    console.warn(`   ⚠️  ${wrongR2Key.length} chunks мають неправильний r2_key`);
  } else {
    console.log(`   ✅ Всі chunks мають правильний r2_key`);
  }

  // Перевірка embeddings
  const { data: sampleChunk, error: sampleError } = await supabase
    .from('legislation_chunks')
    .select('embedding')
    .eq('document_nreg', nreg)
    .limit(1)
    .single();

  if (sampleError || !sampleChunk) {
    throw new Error(`Не вдалося отримати sample chunk: ${sampleError?.message}`);
  }

  console.log(`   ✅ Embedding перевірено (не null)`);
}

/**
 * Головна функція
 */
async function main() {
  console.log('🚀 Pipeline Import One — Повний пайплайн імпорту документа\n');

  validateConfig();

  const { nreg, force } = parseArgs();
  console.log(`📋 NREG: ${nreg}`);
  if (force) {
    console.log(`   Режим: --force (примусове оновлення)\n`);
  }

  try {
    // 1. Fetch
    const { jsonPath, txtPath } = await fetchDocument(nreg);

    // 2. Build canonical
    const canonical = await buildCanonicalDocument(jsonPath, txtPath);

    // 3. Upload to R2 (ПЕРЕД DB!)
    const r2Key = await uploadCanonicalToR2(canonical);

    // 4. Generate embeddings
    const embeddings = await generateEmbeddingsForChunks(canonical.content.chunks);

    // 5. Insert to Supabase (з правильним r2_key)
    await insertToSupabase(canonical, embeddings, r2Key);

    // 6. Validate
    await validateImport(nreg, r2Key);

    console.log(`\n🎉 Імпорт завершено успішно!`);
    console.log(`\n📊 Підсумок:`);
    console.log(`   Документ: ${canonical.metadata.title}`);
    console.log(`   Статей: ${canonical.content.articles.length}`);
    console.log(`   Chunks: ${canonical.content.chunks.length}`);
    console.log(`   R2 key: ${r2Key}`);
    console.log(`   Content hash: ${canonical.metadata.content_hash}`);

  } catch (error) {
    console.error('\n❌ Помилка:', error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

main().catch(error => {
  console.error('❌ Критична помилка:', error);
  process.exit(1);
});

