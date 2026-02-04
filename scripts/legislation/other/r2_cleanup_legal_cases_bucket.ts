#!/usr/bin/env node

/**
 * R2 Cleanup Legal Cases Bucket — видалення помилково завантажених файлів з legal-court-decisions bucket
 * 
 * Цей скрипт видаляє всі файли з префіксом "legislation/" з bucket "legal-court-decisions"
 * оскільки це окремі бакети і legislation має бути тільки в bucket "legislation"
 * 
 * Використання:
 *   pnpm tsx scripts/legislation/r2_cleanup_legal_cases_bucket.ts --confirm
 */

import dotenv from 'dotenv';
import { resolve } from 'path';
import { S3Client, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';

dotenv.config({ path: resolve(process.cwd(), '.env') });

/**
 * Отримує R2 credentials для legal-court-decisions bucket
 */
function getLegalCasesR2Config(): {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region: string;
} {
  const endpoint = process.env.R2_ENDPOINT || process.env.CLOUDFLARE_R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY || process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_KEY || process.env.R2_SECRET_ACCESS_KEY;
  const bucket = 'legal-court-decisions'; // Supreme Court bucket
  const region = process.env.R2_REGION || 'auto';

  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error('R2 credentials не встановлено');
  }

  return {
    endpoint,
    accessKeyId,
    secretAccessKey,
    bucket,
    region,
  };
}

/**
 * Створює S3 клієнт для legal-court-decisions bucket
 */
function createLegalCasesR2Client(): S3Client {
  const config = getLegalCasesR2Config();
  
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: true,
  });
}

/**
 * Знаходить всі файли з префіксом "legislation/" в legal-court-decisions bucket
 */
async function findLegislationFiles(client: S3Client, bucket: string): Promise<string[]> {
  const files: string[] = [];
  let continuationToken: string | undefined;

  do {
    const command = new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: 'legislation/',
      ContinuationToken: continuationToken,
    });

    const response = await client.send(command);
    
    if (response.Contents) {
      for (const obj of response.Contents) {
        if (obj.Key && obj.Key.startsWith('legislation/')) {
          files.push(obj.Key);
        }
      }
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return files;
}

/**
 * Видаляє файл з bucket
 */
async function deleteFile(client: S3Client, bucket: string, key: string): Promise<void> {
  await client.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
    })
  );
}

/**
 * Головна функція
 */
async function main() {
  console.log('🧹 R2 Cleanup Legal Cases Bucket — Видалення помилкових файлів\n');

  const args = process.argv.slice(2);
  const confirm = args.includes('--confirm');

  if (!confirm) {
    console.error('❌ Помилка: потрібно підтвердити видалення');
    console.error('   Використання: pnpm tsx scripts/legislation/r2_cleanup_legal_cases_bucket.ts --confirm');
    process.exit(1);
  }

  const client = createLegalCasesR2Client();
  const config = getLegalCasesR2Config();
  const bucket = config.bucket;

  console.log(`📋 Bucket: ${bucket}`);
  console.log(`🔍 Пошук файлів з префіксом "legislation/"...\n`);

  const files = await findLegislationFiles(client, bucket);

  if (files.length === 0) {
    console.log('✅ Файлів з префіксом "legislation/" не знайдено');
    console.log('   Bucket чистий!');
    return;
  }

  console.log(`⚠️  Знайдено ${files.length} файл(ів) для видалення:\n`);
  files.forEach((file, idx) => {
    console.log(`   ${idx + 1}. ${file}`);
  });

  console.log(`\n🗑️  Видалення файлів...\n`);

  for (const file of files) {
    try {
      await deleteFile(client, bucket, file);
      console.log(`   ✅ Видалено: ${file}`);
    } catch (error: any) {
      console.error(`   ❌ Помилка видалення ${file}: ${error.message}`);
    }
  }

  console.log(`\n✅ Очищення завершено!`);
  console.log(`   Видалено ${files.length} файл(ів)`);

  // Перевірка після видалення
  console.log(`\n🔍 Перевірка після видалення...`);
  const remainingFiles = await findLegislationFiles(client, bucket);
  
  if (remainingFiles.length === 0) {
    console.log('   ✅ Bucket чистий, всі файли видалено');
  } else {
    console.warn(`   ⚠️  Залишилося ${remainingFiles.length} файл(ів):`);
    remainingFiles.forEach(file => {
      console.warn(`      - ${file}`);
    });
  }
}

main().catch(error => {
  console.error('\n❌ Помилка:', error instanceof Error ? error.message : String(error));
  if (error instanceof Error && error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
});

