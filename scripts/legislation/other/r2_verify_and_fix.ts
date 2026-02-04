#!/usr/bin/env node

/**
 * R2 Verify and Fix — повна перевірка та виправлення R2 завантаження
 * 
 * Перевіряє:
 * 1. Розмір файлу в R2 (через AWS SDK)
 * 2. Розмір локального canonical JSON
 * 3. Співпадіння content_hash
 * 4. Правильність r2_key в DB
 * 5. Правильність r2_key в chunks
 * 
 * Використання:
 *   pnpm tsx scripts/legislation/r2_verify_and_fix.ts --nreg "254к/96-вр" --fix
 */

import dotenv from 'dotenv';
import { resolve } from 'path';
import { readFile } from 'fs/promises';
import { existsSync, statSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { S3Client, HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { createR2Client, getLegislationBucket } from './lib/r2Client.js';
import { uploadFileToR2 } from './lib/r2Upload.js';
import { nregToSafeFilename } from './utils/nreg.js';
import { PATHS } from './config.js';
import { createHash } from 'crypto';

dotenv.config({ path: resolve(process.cwd(), '.env') });

/**
 * Парсить аргументи
 */
function parseArgs(): { nreg: string; fix: boolean } {
  const args = process.argv.slice(2);
  let nreg: string | null = null;
  let fix = false;

  for (const arg of args) {
    if (arg.startsWith('--nreg=')) {
      nreg = arg.substring('--nreg='.length);
    } else if (arg === '--fix') {
      fix = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Використання:
  pnpm tsx scripts/legislation/r2_verify_and_fix.ts --nreg="<nreg>" [--fix]

Параметри:
  --nreg   NREG документа (обов'язково)
  --fix    Автоматично виправити проблеми

Приклад:
  pnpm tsx scripts/legislation/r2_verify_and_fix.ts --nreg="254к/96-вр" --fix
      `);
      process.exit(0);
    }
  }

  if (!nreg) {
    console.error('❌ Помилка: не вказано --nreg');
    process.exit(1);
  }

  return { nreg, fix };
}

/**
 * Перевіряє розмір файлу в R2 через AWS SDK
 */
async function checkR2FileSize(
  client: S3Client,
  bucket: string,
  r2Key: string
): Promise<{ size: number; etag: string; exists: boolean } | null> {
  try {
    const result = await client.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: r2Key,
      })
    );

    return {
      size: result.ContentLength || 0,
      etag: result.ETag || '',
      exists: true,
    };
  } catch (error: any) {
    if (error.name === 'NotFound') {
      return null;
    }
    throw error;
  }
}

/**
 * Обчислює hash файлу
 */
async function computeFileHash(filePath: string): Promise<string> {
  const content = await readFile(filePath, 'utf-8');
  const hash = createHash('sha256');
  hash.update(content, 'utf-8');
  return hash.digest('hex');
}

/**
 * Порівнює canonical JSON з файлом в R2
 */
async function compareR2Content(
  client: S3Client,
  bucket: string,
  r2Key: string,
  localCanonical: any
): Promise<{ match: boolean; r2Size: number; localSize: number; r2Chunks?: number; localChunks?: number }> {
  try {
    const result = await client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: r2Key,
      })
    );

    const r2Content = await result.Body!.transformToString('utf-8');
    const r2Json = JSON.parse(r2Content);
    const r2Size = Buffer.byteLength(r2Content, 'utf-8');
    const localSize = Buffer.byteLength(JSON.stringify(localCanonical, null, 2), 'utf-8');

    return {
      match: r2Json.content?.chunks?.length === localCanonical.content?.chunks?.length,
      r2Size,
      localSize,
      r2Chunks: r2Json.content?.chunks?.length,
      localChunks: localCanonical.content?.chunks?.length,
    };
  } catch (error: any) {
    throw new Error(`Помилка завантаження з R2: ${error.message}`);
  }
}

/**
 * Головна функція
 */
async function main() {
  console.log('🔍 R2 Verify and Fix — Повна перевірка та виправлення\n');

  const { nreg, fix } = parseArgs();
  console.log(`📋 NREG: ${nreg}`);
  if (fix) {
    console.log(`   Режим: --fix (автоматичне виправлення)\n`);
  } else {
    console.log(`   Режим: перевірка (додайте --fix для виправлення)\n`);
  }

  // 1. Перевірка документа в DB
  const url = process.env.SUPABASE_LEGISLATION_URL;
  const key = process.env.SUPABASE_LEGISLATION_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('Supabase credentials не встановлено');
  }

  const supabase = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log('📥 Перевірка документа в Supabase...');
  const { data: doc, error: docError } = await supabase
    .from('legislation_documents')
    .select('*')
    .eq('rada_nreg', nreg)
    .single();

  if (docError || !doc) {
    throw new Error(`Документ не знайдено: ${docError?.message}`);
  }

  console.log(`   ✅ Документ: ${doc.title}`);
  console.log(`   R2 Key: ${doc.r2_key}`);
  console.log(`   Content Hash: ${doc.content_hash}`);
  console.log(`   Chunks Count: ${doc.chunks_count}`);
  console.log(`   Sync Status: ${doc.sync_status}`);

  // 2. Перевірка canonical JSON файлу
  const safeFilename = nregToSafeFilename(nreg);
  const canonicalPath = `${PATHS.canonical}/${safeFilename}.canonical.json`;

  if (!existsSync(canonicalPath)) {
    throw new Error(`Canonical JSON не знайдено: ${canonicalPath}`);
  }

  console.log(`\n📁 Перевірка локального canonical JSON...`);
  const canonicalContent = await readFile(canonicalPath, 'utf-8');
  const canonical = JSON.parse(canonicalContent);
  const localStats = statSync(canonicalPath);

  console.log(`   Файл: ${canonicalPath}`);
  console.log(`   Розмір: ${(localStats.size / 1024).toFixed(2)} KB (${localStats.size} bytes)`);
  console.log(`   Chunks: ${canonical.content.chunks.length}`);
  console.log(`   Articles: ${canonical.content.articles.length}`);
  console.log(`   Content Hash: ${canonical.metadata.content_hash}`);

  // Порівняння hash
  if (canonical.metadata.content_hash !== doc.content_hash) {
    console.warn(`   ⚠️  Content hash не співпадає з DB!`);
  } else {
    console.log(`   ✅ Content hash співпадає з DB`);
  }

  // 3. Перевірка R2 файлу через AWS SDK
  console.log(`\n☁️  Перевірка файлу в R2 (через AWS SDK)...`);
  
  const r2Client = createR2Client();
  const bucket = getLegislationBucket();
  const r2Key = doc.r2_key;

  if (!r2Key) {
    throw new Error('R2 key не встановлено в DB');
  }

  const r2FileInfo = await checkR2FileSize(r2Client, bucket, r2Key);

  if (!r2FileInfo) {
    console.error(`   ❌ Файл не знайдено в R2: ${r2Key}`);
    if (fix) {
      console.log(`   🔧 Виправлення: завантаження файлу...`);
      await uploadFileToR2(r2Client, bucket, r2Key, canonicalPath, {
        contentType: 'application/json; charset=utf-8',
        skipIfExists: false,
      });
      console.log(`   ✅ Файл завантажено`);
    } else {
      console.log(`   💡 Виконайте: pnpm tsx scripts/legislation/r2_verify_and_fix.ts --nreg="${nreg}" --fix`);
      process.exit(1);
    }
  } else {
    console.log(`   ✅ Файл знайдено в R2`);
    console.log(`   Розмір: ${(r2FileInfo.size / 1024).toFixed(2)} KB (${r2FileInfo.size} bytes)`);
    console.log(`   ETag: ${r2FileInfo.etag}`);

    // Порівняння розмірів
    if (r2FileInfo.size !== localStats.size) {
      console.warn(`   ⚠️  Розмір не співпадає!`);
      console.warn(`      Локальний: ${localStats.size} bytes`);
      console.warn(`      R2: ${r2FileInfo.size} bytes`);
      console.warn(`      Різниця: ${Math.abs(localStats.size - r2FileInfo.size)} bytes`);
      
      if (fix) {
        console.log(`   🔧 Виправлення: перезавантаження файлу...`);
        await uploadFileToR2(r2Client, bucket, r2Key, canonicalPath, {
          contentType: 'application/json; charset=utf-8',
          skipIfExists: false, // Примусове перезавантаження
        });
        console.log(`   ✅ Файл перезавантажено`);
      } else {
        console.log(`   💡 Виконайте: pnpm tsx scripts/legislation/r2_verify_and_fix.ts --nreg="${nreg}" --fix`);
      }
    } else {
      console.log(`   ✅ Розмір співпадає`);
    }

    // Порівняння контенту (chunks count)
    const contentCompare = await compareR2Content(r2Client, bucket, r2Key, canonical);
    if (!contentCompare.match) {
      console.warn(`   ⚠️  Контент не співпадає!`);
      console.warn(`      Локальний chunks: ${contentCompare.localChunks}`);
      console.warn(`      R2 chunks: ${contentCompare.r2Chunks}`);
      
      if (fix) {
        console.log(`   🔧 Виправлення: перезавантаження файлу...`);
        await uploadFileToR2(r2Client, bucket, r2Key, canonicalPath, {
          contentType: 'application/json; charset=utf-8',
          skipIfExists: false,
        });
        console.log(`   ✅ Файл перезавантажено`);
      } else {
        console.log(`   💡 Виконайте: pnpm tsx scripts/legislation/r2_verify_and_fix.ts --nreg="${nreg}" --fix`);
      }
    } else {
      console.log(`   ✅ Контент співпадає (chunks: ${contentCompare.localChunks})`);
    }
  }

  // 4. Перевірка chunks в DB
  console.log(`\n💾 Перевірка chunks в Supabase...`);
  
  const { data: chunks, error: chunksError } = await supabase
    .from('legislation_chunks')
    .select('id, chunk_index, r2_key, json_path, article_number')
    .eq('document_nreg', nreg)
    .order('chunk_index');

  if (chunksError) {
    throw new Error(`Помилка отримання chunks: ${chunksError.message}`);
  }

  console.log(`   Загальна кількість chunks: ${chunks.length}`);
  
  // Перевірка r2_key в chunks
  const wrongR2Key = chunks.filter(c => c.r2_key !== r2Key);
  if (wrongR2Key.length > 0) {
    console.warn(`   ⚠️  ${wrongR2Key.length} chunks мають неправильний r2_key`);
    if (fix) {
      console.log(`   🔧 Виправлення: оновлення r2_key в chunks...`);
      const { error: updateError } = await supabase
        .from('legislation_chunks')
        .update({ r2_key: r2Key })
        .eq('document_nreg', nreg);
      
      if (updateError) {
        console.error(`   ❌ Помилка оновлення: ${updateError.message}`);
      } else {
        console.log(`   ✅ Chunks оновлено`);
      }
    } else {
      console.log(`   💡 Виконайте: pnpm tsx scripts/legislation/r2_verify_and_fix.ts --nreg="${nreg}" --fix`);
    }
  } else {
    console.log(`   ✅ Всі chunks мають правильний r2_key`);
  }

  // Перевірка json_path
  const invalidPaths = chunks.filter(c => !c.json_path || !c.json_path.startsWith('$.content.chunks['));
  if (invalidPaths.length > 0) {
    console.warn(`   ⚠️  ${invalidPaths.length} chunks мають неправильний json_path`);
  } else {
    console.log(`   ✅ Всі chunks мають правильний json_path`);
  }

  // 5. Фінальна перевірка синхронізації
  console.log(`\n✅ Фінальна перевірка синхронізації...`);
  
  const finalR2Info = await checkR2FileSize(r2Client, bucket, r2Key);
  if (!finalR2Info || finalR2Info.size !== localStats.size) {
    console.error(`   ❌ Проблеми з синхронізацією!`);
    process.exit(1);
  }

  const finalChunks = await supabase
    .from('legislation_chunks')
    .select('r2_key')
    .eq('document_nreg', nreg)
    .limit(1)
    .single();

  if (finalChunks.data?.r2_key !== r2Key) {
    console.error(`   ❌ R2 key в chunks не співпадає!`);
    process.exit(1);
  }

  console.log(`   ✅ R2 файл: ${(finalR2Info.size / 1024).toFixed(2)} KB`);
  console.log(`   ✅ Локальний файл: ${(localStats.size / 1024).toFixed(2)} KB`);
  console.log(`   ✅ R2 key в DB: ${r2Key}`);
  console.log(`   ✅ R2 key в chunks: ${finalChunks.data?.r2_key}`);
  console.log(`   ✅ Chunks count: ${chunks.length}`);
  console.log(`   ✅ Sync status: ${doc.sync_status}`);

  console.log(`\n🎉 Перевірка завершена! Все синхронізовано правильно.`);
}

main().catch(error => {
  console.error('\n❌ Помилка:', error instanceof Error ? error.message : String(error));
  if (error instanceof Error && error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
});

