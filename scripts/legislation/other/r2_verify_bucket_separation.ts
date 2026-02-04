#!/usr/bin/env node

/**
 * R2 Verify Bucket Separation — перевірка розділення bucket'ів
 */

import dotenv from 'dotenv';
import { resolve } from 'path';
import { S3Client, ListObjectsV2Command, HeadObjectCommand } from '@aws-sdk/client-s3';

dotenv.config({ path: resolve(process.cwd(), '.env') });

async function main() {
  const endpoint = 
    process.env.R2_ENDPOINT ||
    process.env.CLOUDFLARE_R2_ENDPOINT;
  const accessKeyId = 
    process.env.R2_ACCESS_KEY_ID ||
    process.env.R2_ACCESS_KEY ||
    process.env.CLOUDFLARE_R2_ACCESS_KEY;
  const secretAccessKey = 
    process.env.R2_SECRET_ACCESS_KEY ||
    process.env.R2_SECRET_KEY ||
    process.env.CLOUDFLARE_R2_SECRET_KEY;

  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error('R2 credentials не встановлено');
  }

  const client = new S3Client({
    endpoint,
    region: 'auto',
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });

  console.log('🔍 Перевірка розділення bucket\'ів\n');

  // Перевірка legal-court-decisions bucket
  console.log('📦 Bucket: legal-court-decisions');
  try {
    const cmd1 = new ListObjectsV2Command({
      Bucket: 'legal-court-decisions',
      Prefix: 'legislation/',
    });
    const result1 = await client.send(cmd1);
    const legislationFiles = result1.Contents?.filter(f => f.Key?.startsWith('legislation/')) || [];
    
    if (legislationFiles.length > 0) {
      console.error(`   ❌ Знайдено ${legislationFiles.length} помилкових файл(ів):`);
      legislationFiles.forEach(f => {
        console.error(`      - ${f.Key}`);
      });
      process.exit(1);
    } else {
      console.log('   ✅ Bucket чистий, немає файлів з префіксом "legislation/"');
    }
  } catch (error: any) {
    console.error(`   ❌ Помилка перевірки: ${error.message}`);
    process.exit(1);
  }

  // Перевірка legislation bucket
  console.log('\n📦 Bucket: legislation');
  try {
    const cmd2 = new HeadObjectCommand({
      Bucket: 'legislation',
      Key: 'legislation/constitutional/254%D0%BA%2F96-%D0%B2%D1%80.json',
    });
    const result2 = await client.send(cmd2);
    console.log(`   ✅ Файл знайдено в правильному bucket:`);
    console.log(`      Розмір: ${result2.ContentLength} bytes (${((result2.ContentLength || 0) / 1024).toFixed(2)} KB)`);
    console.log(`      ETag: ${result2.ETag}`);
    
    if ((result2.ContentLength || 0) < 100000) {
      console.warn(`      ⚠️  Файл занадто малий (можливо старий)`);
    }
  } catch (error: any) {
    if (error.name === 'NotFound') {
      console.error(`   ❌ Файл не знайдено в legislation bucket!`);
      process.exit(1);
    } else {
      console.error(`   ❌ Помилка перевірки: ${error.message}`);
      process.exit(1);
    }
  }

  console.log('\n✅ Перевірка завершена! Bucket\'и правильно розділені.');
}

main().catch(error => {
  console.error('\n❌ Помилка:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});

