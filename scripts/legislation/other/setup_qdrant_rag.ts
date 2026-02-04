#!/usr/bin/env node
/**
 * Qdrant RAG Setup — створення колекцій для Legislation RAG
 * 
 * Створює 2 колекції:
 * - lexery_legislation_chunks (1536 dims, cosine)
 * - lexery_legislation_acts (1536 dims, cosine)
 * 
 * Налаштовує payload indexes для швидкого фільтрування.
 * 
 * Використання:
 *   pnpm tsx scripts/legislation/setup_qdrant_rag.ts
 *   pnpm tsx scripts/legislation/setup_qdrant_rag.ts --smoke-test
 */

import dotenv from 'dotenv';
import { resolve } from 'path';
import { randomUUID } from 'crypto';
import { QdrantClient } from '@qdrant/js-client-rest';

dotenv.config({ path: resolve(process.cwd(), '.env') });

const COLLECTION_CHUNKS = 'lexery_legislation_chunks';
const COLLECTION_ACTS = 'lexery_legislation_acts';
const VECTOR_SIZE = 1536;
const DISTANCE = 'Cosine';

interface QdrantConfig {
  url: string;
  apiKey: string;
}

function getQdrantConfig(): QdrantConfig {
  const url = process.env.qdrant_clusterENDPOINT_LEXERY_LEGISLATION_DB;
  const apiKey = process.env.qdrant_clusterAPI_LEXERY_LEGISLATION_DB;

  if (!url) {
    throw new Error('qdrant_clusterENDPOINT_LEXERY_LEGISLATION_DB не встановлено в .env');
  }
  if (!apiKey) {
    throw new Error('qdrant_clusterAPI_LEXERY_LEGISLATION_DB не встановлено в .env');
  }

  return {
    url: url.replace(/\/+$/, ''),
    apiKey,
  };
}

function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return url.substring(0, 20) + '...';
  }
}

async function ensureCollection(
  client: QdrantClient,
  collectionName: string,
  description: string
): Promise<void> {
  console.log(`\n📦 Перевірка колекції: ${collectionName} (${description})`);

  try {
    const info = await client.getCollection(collectionName);
    const size = info.config?.params?.vectors?.size;
    const distance = info.config?.params?.vectors?.distance;

    if (typeof size === 'number' && size !== VECTOR_SIZE) {
      throw new Error(
        `Колекція "${collectionName}" існує, але розмірність не співпадає: очікується ${VECTOR_SIZE}, отримано ${size}`
      );
    }
    if (typeof distance === 'string' && distance !== DISTANCE) {
      throw new Error(
        `Колекція "${collectionName}" існує, але метрика не співпадає: очікується ${DISTANCE}, отримано ${distance}`
      );
    }

    console.log(`   ✅ Колекція вже існує (розмірність: ${size}, метрика: ${distance})`);
    return;
  } catch (e: any) {
    if (e.status === 404 || e?.message?.includes('Not Found')) {
      console.log(`   🔨 Створення колекції...`);
      await client.createCollection(collectionName, {
        vectors: {
          size: VECTOR_SIZE,
          distance: DISTANCE as any,
        },
        shard_number: 1,
        replication_factor: 1,
      });
      console.log(`   ✅ Колекція створена`);
      return;
    }
    throw e;
  }
}

async function ensurePayloadIndex(
  client: QdrantClient,
  collectionName: string,
  fieldName: string,
  fieldSchema: string
): Promise<void> {
  try {
    // Перевіряємо чи індекс вже існує
    const collectionInfo = await client.getCollection(collectionName);
    const existingIndexes = collectionInfo.payload_schema || {};
    
    if (existingIndexes[fieldName]) {
      console.log(`   ✅ Payload index "${fieldName}" вже існує`);
      return;
    }

    console.log(`   🔨 Створення payload index: ${fieldName} (${fieldSchema})`);
    await client.createPayloadIndex(collectionName, {
      field_name: fieldName,
      field_schema: fieldSchema as any,
    });
    console.log(`   ✅ Payload index "${fieldName}" створено`);
  } catch (e: any) {
    // Якщо індекс вже існує, це нормально
    if (e.status === 400 && e?.message?.includes('already exists')) {
      console.log(`   ✅ Payload index "${fieldName}" вже існує`);
      return;
    }
    throw e;
  }
}

async function setupPayloadIndexes(client: QdrantClient, collectionName: string): Promise<void> {
  console.log(`\n📇 Налаштування payload indexes для ${collectionName}...`);

  // Загальні індекси для обох колекцій
  const commonIndexes = [
    { field: 'rada_nreg', schema: 'keyword' },
    { field: 'content_hash', schema: 'keyword' },
    { field: 'category', schema: 'keyword' },
    { field: 'document_type', schema: 'keyword' },
    { field: 'rada_datred', schema: 'datetime' },
  ];

  for (const idx of commonIndexes) {
    await ensurePayloadIndex(client, collectionName, idx.field, idx.schema);
  }

  // Специфічні індекси для chunks
  if (collectionName === COLLECTION_CHUNKS) {
    await ensurePayloadIndex(client, collectionName, 'article_number', 'keyword');
    await ensurePayloadIndex(client, collectionName, 'chunk_index', 'integer');
  }
}

async function smokeTest(client: QdrantClient): Promise<void> {
  console.log(`\n🧪 Smoke test: перевірка роботи колекцій...`);

  // Тестовий point для chunks (використовуємо UUID для ID)
  const testChunkId = randomUUID();
  const testChunkVector = new Array(VECTOR_SIZE).fill(0).map(() => Math.random());
  const testChunkPayload = {
    rada_nreg: 'test/123',
    content_hash: 'test_hash_1234567890123456789012345678901234567890123456789012345678901234',
    chunk_index: 0,
    article_number: '1',
    category: 'test',
    document_type: 'test',
    rada_datred: new Date().toISOString(),
  };

  console.log(`   📤 Upsert тестового point в ${COLLECTION_CHUNKS}...`);
  try {
    await client.upsert(COLLECTION_CHUNKS, {
      wait: true,
      points: [{
        id: testChunkId,
        vector: testChunkVector,
        payload: testChunkPayload,
      }],
    });
    console.log(`   ✅ Point додано`);
  } catch (error: any) {
    console.error(`   ❌ Помилка upsert: ${error.message}`);
    if (error.body) {
      console.error(`   Деталі: ${error.body}`);
    }
    throw error;
  }

  // Перевірка пошуку
  console.log(`   🔍 Тест пошуку...`);
  try {
    const searchResult = await client.search(COLLECTION_CHUNKS, {
      vector: testChunkVector,
      limit: 1,
      filter: {
        must: [{
          key: 'rada_nreg',
          match: { value: 'test/123' },
        }],
      },
    });
    console.log(`   ✅ Пошук працює (знайдено ${searchResult.length} результатів)`);
  } catch (error: any) {
    console.error(`   ❌ Помилка пошуку: ${error.message}`);
    throw error;
  }

  // Видалення тестового point
  console.log(`   🗑️  Видалення тестового point...`);
  try {
    await client.delete(COLLECTION_CHUNKS, {
      wait: true,
      points: [testChunkId],
    });
    console.log(`   ✅ Тестовий point видалено`);
  } catch (error: any) {
    console.error(`   ❌ Помилка видалення: ${error.message}`);
    throw error;
  }

  console.log(`\n✅ Smoke test пройдено успішно!`);
}

async function main() {
  const args = process.argv.slice(2);
  const smokeTestEnabled = args.includes('--smoke-test');

  console.log('🚀 Qdrant RAG Setup — Створення колекцій для Legislation RAG\n');

  const config = getQdrantConfig();
  console.log(`📍 Qdrant endpoint: ${redactUrl(config.url)}`);

  const client = new QdrantClient({
    url: config.url,
    apiKey: config.apiKey,
    checkCompatibility: false,
  });

  // Створюємо колекції
  await ensureCollection(client, COLLECTION_CHUNKS, 'chunks для точного пошуку норм');
  await ensureCollection(client, COLLECTION_ACTS, 'acts для абстрактного пошуку актів');

  // Налаштовуємо payload indexes
  await setupPayloadIndexes(client, COLLECTION_CHUNKS);
  await setupPayloadIndexes(client, COLLECTION_ACTS);

  // Smoke test (опційно)
  if (smokeTestEnabled) {
    await smokeTest(client);
  }

  console.log(`\n✅ Налаштування завершено!`);
  console.log(`\n📊 Створені колекції:`);
  console.log(`   - ${COLLECTION_CHUNKS} (${VECTOR_SIZE} dims, ${DISTANCE})`);
  console.log(`   - ${COLLECTION_ACTS} (${VECTOR_SIZE} dims, ${DISTANCE})`);
}

main().catch(error => {
  console.error('\n❌ Помилка:', error instanceof Error ? error.message : String(error));
  if (error instanceof Error && error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
});
