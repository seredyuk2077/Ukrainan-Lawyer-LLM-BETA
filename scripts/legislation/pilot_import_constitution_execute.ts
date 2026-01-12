#!/usr/bin/env node

/**
 * Pilot Import Constitution — виконання повного імпорту Конституції
 * 
 * Виконує:
 * 1. Завантаження canonical JSON в R2
 * 2. Генерація embeddings
 * 3. Вставка в Supabase
 * 4. Валідація
 */

import dotenv from 'dotenv';
import { resolve } from 'path';
import { readFile } from 'fs/promises';
import { createClient } from '@supabase/supabase-js';
import { generateEmbeddingsBatch } from './canonical/embeddings.js';
import { buildCanonical, CanonicalDocument } from './canonical/buildCanonical.js';

dotenv.config({ path: resolve(process.cwd(), '.env') });

const NREG = '254к/96-вр';

async function main() {
  console.log('🚀 Pilot Import Constitution — Повний імпорт\n');

  // 1. Читаємо canonical JSON
  console.log('📥 Крок 1: Читання canonical JSON...');
  const canonicalPath = `tmp/canonical/254к-96-вр.canonical.json`;
  const canonicalContent = await readFile(canonicalPath, 'utf-8');
  const canonical: CanonicalDocument = JSON.parse(canonicalContent);
  console.log(`   ✅ Прочитано: ${canonical.content.chunks.length} chunks, ${canonical.content.articles.length} статей`);

  // 2. Завантажуємо в R2 через MCP (використовуємо окремий виклик)
  console.log(`\n☁️  Крок 2: Завантаження в R2...`);
  console.log(`   R2 Key: ${canonical.metadata.r2_key}`);
  console.log(`   Розмір: ${(canonicalContent.length / 1024).toFixed(2)} KB`);
  console.log(`   ⚠️  Завантаження через MCP виконайте окремо або через скрипт`);

  // 3. Генеруємо embeddings
  console.log(`\n🧠 Крок 3: Генерація embeddings...`);
  const apiKey = process.env.OPEN_ROUTER_API_RAG || process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPEN_ROUTER_API_RAG не встановлено');
  }

  const chunks = canonical.content.chunks;
  const texts = chunks.map(c => c.text);
  console.log(`   Генеруємо embeddings для ${texts.length} chunks...`);
  
  const embeddings = await generateEmbeddingsBatch(texts, apiKey, 3);
  console.log(`   ✅ Embeddings згенеровано: ${embeddings.length}`);
  console.log(`   Розмірність: ${embeddings[0].dimensions}`);

  // 4. Вставляємо в Supabase
  console.log(`\n💾 Крок 4: Вставка в Supabase...`);
  const url = process.env.SUPABASE_LEGISLATION_URL;
  const key = process.env.SUPABASE_LEGISLATION_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('Supabase credentials не встановлено');
  }

  const supabase = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Upsert документ
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

  // Вставляємо chunks
  console.log(`   Вставка chunks (${chunks.length})...`);
  const batchSize = 50;
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const batchEmbeddings = embeddings.slice(i, i + batchSize);
    
    const chunksToInsert = batch.map((chunk, idx) => ({
      document_nreg: canonical.metadata.rada_nreg,
      r2_key: canonical.metadata.r2_key!,
      json_path: `$.content.chunks[${chunk.chunk_index}].text`,
      chunk_index: chunk.chunk_index,
      embedding: batchEmbeddings[idx].embedding,
      article_number: chunk.article_number,
      token_count: chunk.token_count,
    }));

    const { error: chunksError } = await supabase
      .from('legislation_chunks')
      .upsert(chunksToInsert, {
        onConflict: 'id',
      });

    if (chunksError) {
      throw new Error(`Помилка вставки chunks (batch ${i / batchSize + 1}): ${chunksError.message}`);
    }
    
    console.log(`   ✅ Batch ${Math.floor(i / batchSize) + 1}: ${batch.length} chunks`);
  }

  // 5. Валідація
  console.log(`\n✅ Крок 5: Валідація...`);
  const { data: doc, error: docValError } = await supabase
    .from('legislation_documents')
    .select('*')
    .eq('rada_nreg', NREG)
    .single();

  if (docValError || !doc) {
    throw new Error(`Документ не знайдено: ${docValError?.message}`);
  }

  const { data: chunksData, error: chunksValError } = await supabase
    .from('legislation_chunks')
    .select('chunk_index, article_number, json_path')
    .eq('document_nreg', NREG)
    .order('chunk_index');

  if (chunksValError) {
    throw new Error(`Помилка отримання chunks: ${chunksValError.message}`);
  }

  console.log(`   ✅ Документ: ${doc.title}`);
  console.log(`   ✅ Chunks: ${chunksData.length}`);
  console.log(`   ✅ Перші 3 chunks:`);
  chunksData.slice(0, 3).forEach(chunk => {
    console.log(`      [${chunk.chunk_index}] ${chunk.article_number}: ${chunk.json_path}`);
  });

  console.log(`\n🎉 Імпорт завершено успішно!`);
  console.log(`\n📊 Підсумок:`);
  console.log(`   Документ: ${canonical.metadata.title}`);
  console.log(`   Статей: ${canonical.content.articles.length}`);
  console.log(`   Chunks: ${canonical.content.chunks.length}`);
  console.log(`   R2 key: ${canonical.metadata.r2_key}`);
  console.log(`   Content hash: ${canonical.metadata.content_hash}`);
}

main().catch(error => {
  console.error('\n❌ Помилка:', error instanceof Error ? error.message : String(error));
  if (error instanceof Error && error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
});

