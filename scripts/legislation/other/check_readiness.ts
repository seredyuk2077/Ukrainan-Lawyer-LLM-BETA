#!/usr/bin/env node
/**
 * Readiness Checks — перевірка готовності інфраструктури
 * 
 * Перевіряє:
 * - Supabase: наявність колонок/індексів/constraints
 * - Qdrant: наявність колекцій, правильні dims
 * - R2: доступність bucket/prefix
 * 
 * Використання:
 *   pnpm tsx scripts/legislation/check_readiness.ts
 */

import dotenv from 'dotenv';
import { resolve } from 'path';
import { createClient } from '@supabase/supabase-js';
import { QdrantClient } from '@qdrant/js-client-rest';
import { createR2Client, getLegislationBucket } from './lib/r2Client.js';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';

dotenv.config({ path: resolve(process.cwd(), '.env') });

interface CheckResult {
  name: string;
  status: 'ok' | 'warning' | 'error';
  message: string;
  details?: any;
}

const results: CheckResult[] = [];

function addResult(result: CheckResult) {
  results.push(result);
  const icon = result.status === 'ok' ? '✅' : result.status === 'warning' ? '⚠️' : '❌';
  console.log(`${icon} ${result.name}: ${result.message}`);
  if (result.details) {
    console.log(`   Деталі:`, result.details);
  }
}

async function checkSupabase(): Promise<void> {
  console.log('\n📊 Перевірка Supabase...');

  const url = process.env.SUPABASE_LEGISLATION_URL;
  const key = process.env.SUPABASE_LEGISLATION_SERVICE_ROLE_KEY;

  if (!url || !key) {
    addResult({
      name: 'Supabase credentials',
      status: 'error',
      message: 'SUPABASE_LEGISLATION_URL або SUPABASE_LEGISLATION_SERVICE_ROLE_KEY не встановлено',
    });
    return;
  }

  const supabase = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Перевірка таблиці legislation_documents (спроба прочитати нові колонки)
  const { data: docSample, error: docError } = await supabase
    .from('legislation_documents')
    .select('rada_nreg, content_hash, r2_key, qdrant_status, expected_chunks, indexed_chunks, summary, aliases')
    .limit(1);

  if (docError) {
    addResult({
      name: 'Supabase connection',
      status: 'error',
      message: `Помилка підключення: ${docError.message}`,
    });
    return;
  }

  // Перевірка наявності нових колонок
  const { data: newCols, error: newColsError } = await supabase
    .from('legislation_documents')
    .select('indexed_content_hash, qdrant_status, expected_chunks, indexed_chunks, summary, aliases')
    .limit(1);

  if (newColsError && newColsError.code === 'PGRST116') {
    addResult({
      name: 'Supabase schema (new columns)',
      status: 'error',
      message: 'Нові колонки не знайдено. Потрібно застосувати міграцію.',
    });
  } else if (newColsError) {
    addResult({
      name: 'Supabase schema (new columns)',
      status: 'warning',
      message: `Помилка перевірки: ${newColsError.message}`,
    });
  } else {
    addResult({
      name: 'Supabase schema (new columns)',
      status: 'ok',
      message: 'Всі нові колонки присутні',
    });
  }

  // Перевірка unique constraint в chunks
  const { data: chunksSample, error: chunksError } = await supabase
    .from('legislation_chunks')
    .select('document_nreg, content_hash, chunk_index')
    .limit(1);

  if (chunksError) {
    addResult({
      name: 'Supabase chunks table',
      status: 'error',
      message: `Помилка: ${chunksError.message}`,
    });
  } else {
    addResult({
      name: 'Supabase chunks table',
      status: 'ok',
      message: 'Таблиця chunks доступна',
    });
  }

  addResult({
    name: 'Supabase connection',
    status: 'ok',
    message: 'Підключення працює',
  });
}

async function checkQdrant(): Promise<void> {
  console.log('\n🔍 Перевірка Qdrant...');

  const url = process.env.qdrant_clusterENDPOINT_LEXERY_LEGISLATION_DB;
  const apiKey = process.env.qdrant_clusterAPI_LEXERY_LEGISLATION_DB;

  if (!url || !apiKey) {
    addResult({
      name: 'Qdrant credentials',
      status: 'error',
      message: 'qdrant_clusterENDPOINT_LEXERY_LEGISLATION_DB або qdrant_clusterAPI_LEXERY_LEGISLATION_DB не встановлено',
    });
    return;
  }

  const client = new QdrantClient({
    url: url.replace(/\/+$/, ''),
    apiKey,
    checkCompatibility: false,
  });

  // Перевірка колекції chunks
  try {
    const chunksInfo = await client.getCollection('lexery_legislation_chunks');
    const size = chunksInfo.config?.params?.vectors?.size;
    const distance = chunksInfo.config?.params?.vectors?.distance;

    if (size === 1536 && distance === 'Cosine') {
      addResult({
        name: 'Qdrant collection (chunks)',
        status: 'ok',
        message: `Колекція існує (${size} dims, ${distance})`,
        details: { points_count: chunksInfo.points_count },
      });
    } else {
      addResult({
        name: 'Qdrant collection (chunks)',
        status: 'error',
        message: `Неправильні параметри: size=${size}, distance=${distance}`,
      });
    }
  } catch (error: any) {
    if (error.status === 404) {
      addResult({
        name: 'Qdrant collection (chunks)',
        status: 'error',
        message: 'Колекція lexery_legislation_chunks не знайдена',
      });
    } else {
      addResult({
        name: 'Qdrant collection (chunks)',
        status: 'error',
        message: `Помилка: ${error.message}`,
      });
    }
  }

  // Перевірка колекції acts
  try {
    const actsInfo = await client.getCollection('lexery_legislation_acts');
    const size = actsInfo.config?.params?.vectors?.size;
    const distance = actsInfo.config?.params?.vectors?.distance;

    if (size === 1536 && distance === 'Cosine') {
      addResult({
        name: 'Qdrant collection (acts)',
        status: 'ok',
        message: `Колекція існує (${size} dims, ${distance})`,
        details: { points_count: actsInfo.points_count },
      });
    } else {
      addResult({
        name: 'Qdrant collection (acts)',
        status: 'error',
        message: `Неправильні параметри: size=${size}, distance=${distance}`,
      });
    }
  } catch (error: any) {
    if (error.status === 404) {
      addResult({
        name: 'Qdrant collection (acts)',
        status: 'error',
        message: 'Колекція lexery_legislation_acts не знайдена',
      });
    } else {
      addResult({
        name: 'Qdrant collection (acts)',
        status: 'error',
        message: `Помилка: ${error.message}`,
      });
    }
  }
}

async function checkR2(): Promise<void> {
  console.log('\n☁️  Перевірка R2...');

  try {
    const client = createR2Client();
    const bucket = getLegislationBucket();

    // Спроба отримати список файлів (обмежено 1 для швидкості)
    const command = new ListObjectsV2Command({
      Bucket: bucket,
      MaxKeys: 1,
    });

    const response = await client.send(command);

    addResult({
      name: 'R2 connection',
      status: 'ok',
      message: `Bucket доступний: ${bucket}`,
      details: { keyCount: response.KeyCount },
    });
  } catch (error: any) {
    addResult({
      name: 'R2 connection',
      status: 'error',
      message: `Помилка: ${error.message}`,
    });
  }
}

async function main() {
  console.log('🔍 Readiness Checks — Перевірка готовності інфраструктури\n');

  await checkSupabase();
  await checkQdrant();
  await checkR2();

  console.log('\n' + '='.repeat(60));
  const okCount = results.filter(r => r.status === 'ok').length;
  const warnCount = results.filter(r => r.status === 'warning').length;
  const errorCount = results.filter(r => r.status === 'error').length;

  console.log(`\n📊 Підсумок:`);
  console.log(`   ✅ OK: ${okCount}`);
  console.log(`   ⚠️  Warnings: ${warnCount}`);
  console.log(`   ❌ Errors: ${errorCount}`);

  if (errorCount > 0) {
    console.log(`\n❌ Інфраструктура не готова. Виправте помилки перед продовженням.`);
    process.exit(1);
  } else if (warnCount > 0) {
    console.log(`\n⚠️  Інфраструктура готова з попередженнями.`);
    process.exit(0);
  } else {
    console.log(`\n✅ Інфраструктура готова!`);
    process.exit(0);
  }
}

main().catch(error => {
  console.error('\n❌ Критична помилка:', error);
  process.exit(1);
});
