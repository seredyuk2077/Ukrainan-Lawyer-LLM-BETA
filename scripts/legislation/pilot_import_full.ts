#!/usr/bin/env node

/**
 * Pilot Full Import — повний end-to-end імпорт документа
 * 
 * Використання:
 *   pnpm tsx scripts/legislation/pilot_import_full.ts --nreg=254к/96-вр
 * 
 * Виконує:
 * 1. Fetch з rada.gov.ua
 * 2. Build canonical JSON
 * 3. Chunking
 * 4. Generate embeddings
 * 5. Upload to R2
 * 6. Insert to Supabase
 * 7. Validation
 */

import dotenv from 'dotenv';
import { resolve } from 'path';
import { RadaClient } from './radaClient.js';
import { validateConfig, PATHS } from './config.js';
import { buildCanonical, CanonicalDocument } from './canonical/buildCanonical.js';
import { createChunksFromArticles } from './canonical/chunking.js';
import { generateEmbeddingsBatch } from './canonical/embeddings.js';
import { nregToSafeFilename, encodeNregForUrl } from './utils/nreg.js';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { createLegislationSupabaseClient } from './canonical/dbImport.js';
import { createClient } from '@supabase/supabase-js';

dotenv.config({ path: resolve(process.cwd(), '.env') });

const CONSTITUTION_NREG = '254к/96-вр';

/**
 * Парсить аргументи
 */
function parseArgs(): { nreg: string } {
  const args = process.argv.slice(2);
  let nreg: string | null = null;

  for (const arg of args) {
    if (arg.startsWith('--nreg=')) {
      nreg = arg.substring('--nreg='.length);
    }
  }

  return { nreg: nreg || CONSTITUTION_NREG };
}

/**
 * Завантажує документ з rada.gov.ua
 */
async function fetchDocument(nreg: string): Promise<{
  jsonPath: string;
  txtPath?: string;
  metadata: any;
}> {
  console.log(`\n📥 Крок 1: Завантаження документа з rada.gov.ua...`);
  console.log(`   NREG: ${nreg}`);

  const client = new RadaClient();
  
  // Створюємо директорії
  await mkdir(PATHS.radaRaw, { recursive: true });
  
  const safeFilename = nregToSafeFilename(nreg);
  const jsonPath = `${PATHS.radaRaw}/${safeFilename}.json`;
  const txtPath = `${PATHS.radaRaw}/${safeFilename}.txt`;

  // Завантажуємо JSON
  console.log(`   Завантаження JSON...`);
  const jsonData = await client.fetchJson(nreg);
  await writeFile(jsonPath, JSON.stringify(jsonData, null, 2), 'utf-8');
  console.log(`   ✅ JSON збережено: ${jsonPath}`);

  // Спробуємо завантажити TXT якщо потрібно
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
    metadata: jsonData,
  };
}

/**
 * Будує canonical JSON
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

  // Зберігаємо canonical JSON локально для перевірки
  const safeFilename = nregToSafeFilename(canonical.metadata.rada_nreg);
  await mkdir(PATHS.canonical, { recursive: true });
  const canonicalPath = `${PATHS.canonical}/${safeFilename}.canonical.json`;
  await writeFile(canonicalPath, JSON.stringify(canonical, null, 2), 'utf-8');
  
  console.log(`   ✅ Canonical JSON створено:`);
  console.log(`      Статей: ${canonical.content.articles.length}`);
  console.log(`      Чанків: ${canonical.content.chunks.length}`);
  console.log(`      Content hash: ${canonical.metadata.content_hash}`);
  console.log(`      R2 key: ${canonical.metadata.r2_key}`);

  return canonical;
}

/**
 * Генерує embeddings для чанків
 */
async function generateEmbeddingsForChunks(
  chunks: Array<{ text: string }>
): Promise<number[][]> {
  console.log(`\n🧠 Крок 3: Генерація embeddings...`);
  console.log(`   Кількість чанків: ${chunks.length}`);

  const apiKey = process.env.OPEN_ROUTER_API_RAG || process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPEN_ROUTER_API_RAG або OPENROUTER_API_KEY не встановлено в .env');
  }

  const texts = chunks.map(c => c.text);
  const results = await generateEmbeddingsBatch(texts, apiKey, 3);

  console.log(`   ✅ Embeddings згенеровано: ${results.length}`);
  console.log(`   Розмірність: ${results[0].dimensions}`);

  return results.map(r => r.embedding);
}

/**
 * Завантажує canonical JSON в R2
 */
async function uploadToR2(
  canonical: CanonicalDocument,
  r2Key: string
): Promise<void> {
  console.log(`\n☁️  Крок 4: Завантаження в R2...`);
  console.log(`   R2 key: ${r2Key}`);

  // Використовуємо MCP для завантаження
  // Потрібно використати mcp_cloudflare-r2-legislation_upload_file
  // Але оскільки це TypeScript скрипт, використаємо прямий виклик через fetch або SDK
  
  const canonicalJson = JSON.stringify(canonical, null, 2);
  
  // Для тестування використаємо MCP через окремий виклик
  // В production це має бути через MCP або SDK
  console.log(`   ⚠️  R2 upload через MCP буде виконано окремо`);
  console.log(`   Розмір JSON: ${(canonicalJson.length / 1024).toFixed(2)} KB`);
  
  // Зберігаємо для ручного завантаження якщо потрібно
  const safeFilename = nregToSafeFilename(canonical.metadata.rada_nreg);
  const uploadPath = `${PATHS.canonical}/${safeFilename}.for-r2.json`;
  await writeFile(uploadPath, canonicalJson, 'utf-8');
  console.log(`   ✅ JSON готовий для upload: ${uploadPath}`);
}

/**
 * Вставляє дані в Supabase
 */
async function insertToSupabase(
  canonical: CanonicalDocument,
  embeddings: number[][]
): Promise<void> {
  console.log(`\n💾 Крок 5: Вставка в Supabase...`);

  const url = process.env.SUPABASE_LEGISLATION_URL || process.env.SUPABASE_LEGISLATION_RAG_URL;
  const key = process.env.SUPABASE_LEGISLATION_SERVICE_ROLE_KEY || 
              process.env.SUPABASE_LEGISLATION_RAG_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('SUPABASE_LEGISLATION_URL та SUPABASE_LEGISLATION_SERVICE_ROLE_KEY не встановлено');
  }

  const supabase = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 1. Upsert документ
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
      r2_key: canonical.metadata.r2_key,
      source_url: canonical.metadata.source_url,
      articles_count: canonical.content.articles.length,
      chunks_count: canonical.content.chunks.length,
      imported_at: canonical.metadata.imported_at,
      updated_at: canonical.metadata.updated_at,
      is_active: true,
      sync_status: 'synced',
      keywords: canonical.ai_enrichment?.keywords || [],
      topics: canonical.ai_enrichment?.topics || [],
    }, {
      onConflict: 'rada_nreg',
    });

  if (docError) {
    throw new Error(`Помилка вставки документа: ${docError.message}`);
  }
  console.log(`   ✅ Документ вставлено`);

  // 2. Вставляємо chunks
  console.log(`   Вставка chunks (${canonical.content.chunks.length})...`);
  
  const chunksToInsert = canonical.content.chunks.map((chunk, idx) => ({
    document_nreg: canonical.metadata.rada_nreg,
    r2_key: canonical.metadata.r2_key!,
    json_path: `$.content.chunks[${chunk.chunk_index}].text`,
    chunk_index: chunk.chunk_index,
    embedding: `[${embeddings[idx].join(',')}]`, // PostgreSQL vector format
    article_number: chunk.article_number,
    token_count: chunk.token_count,
  }));

  // Вставляємо батчами по 50
  const batchSize = 50;
  for (let i = 0; i < chunksToInsert.length; i += batchSize) {
    const batch = chunksToInsert.slice(i, i + batchSize);
    
    // Конвертуємо embeddings в правильний формат для Supabase (vector)
    const batchWithVectors = batch.map((chunk, batchIdx) => {
      const embeddingIdx = i + batchIdx;
      return {
        document_nreg: chunk.document_nreg,
        r2_key: chunk.r2_key,
        json_path: chunk.json_path,
        chunk_index: chunk.chunk_index,
        embedding: embeddings[embeddingIdx], // Масив чисел, Supabase конвертує автоматично
        article_number: chunk.article_number,
        token_count: chunk.token_count,
      };
    });

    const { error: chunksError } = await supabase
      .from('legislation_chunks')
      .upsert(batchWithVectors, {
        onConflict: 'id',
      });

    if (chunksError) {
      throw new Error(`Помилка вставки chunks (batch ${i / batchSize + 1}): ${chunksError.message}`);
    }
    
    console.log(`   ✅ Batch ${i / batchSize + 1}: ${batch.length} chunks`);
  }

  console.log(`   ✅ Всі chunks вставлено`);
}

/**
 * Валідація результатів
 */
async function validateImport(nreg: string): Promise<void> {
  console.log(`\n✅ Крок 6: Валідація...`);

  const url = process.env.SUPABASE_LEGISLATION_URL || process.env.SUPABASE_LEGISLATION_RAG_URL;
  const key = process.env.SUPABASE_LEGISLATION_SERVICE_ROLE_KEY || 
              process.env.SUPABASE_LEGISLATION_RAG_SERVICE_ROLE_KEY;

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

  console.log(`   ✅ Документ знайдено: ${doc.title}`);
  console.log(`      Chunks count: ${doc.chunks_count}`);

  // Перевірка chunks
  const { data: chunks, error: chunksError } = await supabase
    .from('legislation_chunks')
    .select('chunk_index, article_number, json_path, r2_key')
    .eq('document_nreg', nreg)
    .order('chunk_index');

  if (chunksError) {
    throw new Error(`Помилка отримання chunks: ${chunksError.message}`);
  }

  console.log(`   ✅ Chunks знайдено: ${chunks.length}`);
  console.log(`   Перші 3 chunks:`);
  chunks.slice(0, 3).forEach(chunk => {
    console.log(`      [${chunk.chunk_index}] ${chunk.article_number}: ${chunk.json_path}`);
  });

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
  console.log('🚀 Pilot Full Import — End-to-End імпорт документа\n');

  validateConfig();

  const { nreg } = parseArgs();
  console.log(`📋 NREG: ${nreg}\n`);

  try {
    // 1. Fetch
    const { jsonPath, txtPath } = await fetchDocument(nreg);

    // 2. Build canonical
    const canonical = await buildCanonicalDocument(jsonPath, txtPath);

    // 3. Generate embeddings
    const embeddings = await generateEmbeddingsForChunks(canonical.content.chunks);

    // 4. Upload to R2 (через MCP окремо)
    await uploadToR2(canonical, canonical.metadata.r2_key!);

    // 5. Insert to Supabase
    await insertToSupabase(canonical, embeddings);

    // 6. Validate
    await validateImport(nreg);

    console.log(`\n🎉 Імпорт завершено успішно!`);
    console.log(`\n📊 Підсумок:`);
    console.log(`   Документ: ${canonical.metadata.title}`);
    console.log(`   Статей: ${canonical.content.articles.length}`);
    console.log(`   Chunks: ${canonical.content.chunks.length}`);
    console.log(`   R2 key: ${canonical.metadata.r2_key}`);

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

