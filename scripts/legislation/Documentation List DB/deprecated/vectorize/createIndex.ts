#!/usr/bin/env node

/**
 * DEPRECATED (2026-01-21): Cloudflare Vectorize is no longer used in prod.
 *
 * Historical script: Create Vectorize Index — створення Cloudflare Vectorize індексу для каталогу документів.
 *
 * Original usage (kept for reference; file was moved):
 *   pnpm tsx "scripts/legislation/Documentation List DB/deprecated/vectorize/createIndex.ts"
 *
 * Required env vars (historical):
 *   - VECTOR_DB_API: Cloudflare API token з правами на Vectorize
 *   - CLOUDFLARE_ACCOUNT_ID: Account ID (опціонально, можна отримати з API)
 */

import dotenv from 'dotenv';
import { resolve } from 'path';

dotenv.config({ path: resolve(process.cwd(), '.env') });

const VECTOR_DB_API = process.env.VECTOR_DB_API;
const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;

const INDEX_NAME = 'legislation-catalog-index';
const DIMENSIONS = 768; // Для каталогу достатньо 768 (не 1536)
const METRIC = 'cosine';

interface VectorizeIndexConfig {
  name: string;
  dimensions: number;
  metric: 'cosine' | 'euclidean' | 'dot-product';
  description?: string;
}

interface MetadataIndexConfig {
  indexName: string;
  propertyName: string;
  type: 'string' | 'number' | 'boolean' | 'date';
}

/**
 * Отримує Account ID з Cloudflare API (якщо не вказано в env)
 */
async function getAccountId(): Promise<string> {
  if (CLOUDFLARE_ACCOUNT_ID) {
    return CLOUDFLARE_ACCOUNT_ID;
  }

  console.log('🔍 Отримую Account ID з Cloudflare API...');

  const response = await fetch('https://api.cloudflare.com/client/v4/accounts', {
    headers: {
      Authorization: `Bearer ${VECTOR_DB_API}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Не вдалося отримати Account ID: ${response.status} ${error}`);
  }

  const data = (await response.json()) as { result?: Array<{ id: string }> };
  if (!data.result || data.result.length === 0) {
    throw new Error('Account ID не знайдено. Вкажіть CLOUDFLARE_ACCOUNT_ID в .env');
  }

  const accountId = data.result[0].id;
  console.log(`✅ Account ID: ${accountId}`);
  return accountId;
}

/**
 * Перевіряє чи існує індекс
 */
async function indexExists(accountId: string, indexName: string): Promise<boolean> {
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/vectorize/indexes/${indexName}`, {
      headers: {
        Authorization: `Bearer ${VECTOR_DB_API}`,
        'Content-Type': 'application/json',
      },
    });

    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Створює Vectorize індекс
 */
async function createIndex(accountId: string, config: VectorizeIndexConfig): Promise<void> {
  console.log(`\n📦 Створюю індекс: ${config.name}`);
  console.log(`   Dimensions: ${config.dimensions}`);
  console.log(`   Metric: ${config.metric}`);

  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/vectorize/indexes`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${VECTOR_DB_API}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: config.name,
      config: {
        dimensions: config.dimensions,
        metric: config.metric,
      },
      description: config.description || `Catalog index for legislation documents (${config.name})`,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Не вдалося створити індекс: ${response.status} ${error}`);
  }

  const data = (await response.json()) as { result?: { id?: string } };
  console.log('✅ Індекс створено успішно!');
  console.log(`   ID: ${data.result?.id || 'N/A'}`);
}

/**
 * Створює metadata index
 *
 * Примітка: Metadata indexes можуть створюватися через wrangler CLI або автоматично при першому upsert.
 * Якщо API endpoint недоступний, metadata indexes можна створити пізніше через wrangler.
 */
async function createMetadataIndex(accountId: string, indexName: string, config: MetadataIndexConfig): Promise<void> {
  console.log(`\n📊 Створюю metadata index: ${config.propertyName} (${config.type})`);

  // Спробуємо різні варіанти endpoint
  const endpoints = [
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/vectorize/indexes/${indexName}/metadata-indexes`,
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/vectorize/v2/indexes/${indexName}/metadata-indexes`,
  ];

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${VECTOR_DB_API}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          propertyName: config.propertyName,
          type: config.type,
        }),
      });

      if (response.ok) {
        console.log('   ✅ Metadata index створено');
        return;
      }

      if (response.status === 409) {
        console.log('   ⚠️  Metadata index вже існує, пропускаю');
        return;
      }
    } catch {
      // keep trying endpoints
    }
  }

  // Якщо всі спроби не вдалися, виводимо попередження, але не падаємо
  console.log('   ⚠️  Не вдалося створити metadata index через API');
  console.log('   💡 Створіть metadata indexes вручну через wrangler CLI:');
  console.log(
    `      npx wrangler vectorize create-metadata-index ${indexName} --property-name=${config.propertyName} --type=${config.type}`
  );
  console.log('   💡 Або metadata indexes можуть створюватися автоматично при першому upsert з metadata');
}

/**
 * Отримує інформацію про індекс
 */
async function getIndexInfo(
  accountId: string,
  indexName: string
): Promise<{
  result: { created_on?: string; modified_on?: string; name: string; description?: string; config: { dimensions: number; metric: string } };
}> {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/vectorize/indexes/${indexName}`, {
    headers: {
      Authorization: `Bearer ${VECTOR_DB_API}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Не вдалося отримати інформацію про індекс: ${response.status} ${error}`);
  }

  return (await response.json()) as {
    result: { created_on?: string; modified_on?: string; name: string; description?: string; config: { dimensions: number; metric: string } };
  };
}

/**
 * Головна функція
 */
async function main() {
  console.log('🚀 (DEPRECATED) Створення Cloudflare Vectorize індексу для каталогу документів\n');

  // Перевірка env
  if (!VECTOR_DB_API) {
    throw new Error('VECTOR_DB_API не встановлено в .env');
  }

  try {
    // Отримуємо Account ID
    const accountId = await getAccountId();

    // Перевіряємо чи існує індекс
    const exists = await indexExists(accountId, INDEX_NAME);
    if (exists) {
      console.log(`\n⚠️  Індекс "${INDEX_NAME}" вже існує`);
      console.log('   Отримую інформацію про індекс...\n');

      const info = await getIndexInfo(accountId, INDEX_NAME);
      console.log('📋 Інформація про індекс:');
      console.log(JSON.stringify(info.result, null, 2));

      console.log('\n✅ Індекс вже створений, пропускаю створення');
      return;
    }

    // Створюємо індекс
    await createIndex(accountId, {
      name: INDEX_NAME,
      dimensions: DIMENSIONS,
      metric: METRIC,
      description:
        'Catalog index for legislation documents from Rada Open Data Portal. Used for semantic search to discover documents for on-demand import.',
    });

    // Створюємо metadata indexes
    const metadataIndexes: MetadataIndexConfig[] = [
      { indexName: INDEX_NAME, propertyName: 'type', type: 'string' },
      { indexName: INDEX_NAME, propertyName: 'organ', type: 'string' },
      { indexName: INDEX_NAME, propertyName: 'status', type: 'string' },
      { indexName: INDEX_NAME, propertyName: 'year', type: 'number' },
    ];

    for (const metaIndex of metadataIndexes) {
      await createMetadataIndex(accountId, metaIndex.indexName, metaIndex);
    }

    // Отримуємо фінальну інформацію про індекс
    console.log('\n📋 Фінальна інформація про індекс:');
    const info = await getIndexInfo(accountId, INDEX_NAME);
    console.log(JSON.stringify(info.result, null, 2));

    console.log('\n🎉 Індекс успішно створено та налаштовано!');
  } catch (error) {
    console.error('\n❌ Помилка:', error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('❌ Критична помилка:', error);
  process.exit(1);
});

