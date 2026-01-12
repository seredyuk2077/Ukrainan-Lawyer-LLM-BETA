#!/usr/bin/env node

/**
 * R2 Upload Canonical — CLI для завантаження canonical JSON в R2
 * 
 * Використання:
 *   pnpm tsx scripts/legislation/r2_upload_canonical.ts --nreg "254к/96-вр"
 *   pnpm tsx scripts/legislation/r2_upload_canonical.ts --file "tmp/canonical/254к-96-вр.canonical.json"
 */

import dotenv from 'dotenv';
import { resolve } from 'path';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { createR2Client, getLegislationBucket } from './lib/r2Client.js';
import { uploadFileToR2, uploadCanonicalJsonToR2 } from './lib/r2Upload.js';
import { generateR2Key } from './canonical/r2Path.js';
import { nregToSafeFilename } from './utils/nreg.js';
import { PATHS } from './config.js';

dotenv.config({ path: resolve(process.cwd(), '.env') });

/**
 * Парсить аргументи
 */
function parseArgs(): { nreg: string | null; file: string | null; force: boolean } {
  const args = process.argv.slice(2);
  let nreg: string | null = null;
  let file: string | null = null;
  let force = false;

  for (const arg of args) {
    if (arg.startsWith('--nreg=')) {
      nreg = arg.substring('--nreg='.length);
    } else if (arg.startsWith('--file=')) {
      file = arg.substring('--file='.length);
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Використання:
  pnpm tsx scripts/legislation/r2_upload_canonical.ts --nreg="<nreg>"
  pnpm tsx scripts/legislation/r2_upload_canonical.ts --file="<path>"
  pnpm tsx scripts/legislation/r2_upload_canonical.ts --nreg="<nreg>" --force

Параметри:
  --nreg    NREG документа (знайде файл в tmp/canonical/)
  --file    Прямий шлях до canonical JSON файлу
  --force   Примусово завантажити навіть якщо файл вже існує

Приклади:
  pnpm tsx scripts/legislation/r2_upload_canonical.ts --nreg="254к/96-вр"
  pnpm tsx scripts/legislation/r2_upload_canonical.ts --file="tmp/canonical/254к-96-вр.canonical.json"
      `);
      process.exit(0);
    }
  }

  return { nreg, file, force };
}

/**
 * Головна функція
 */
async function main() {
  console.log('☁️  R2 Upload Canonical — Завантаження canonical JSON в R2\n');

  const { nreg, file, force } = parseArgs();

  // Визначаємо шлях до файлу
  let filePath: string;
  let canonicalNreg: string;

  if (file) {
    filePath = resolve(process.cwd(), file);
    if (!existsSync(filePath)) {
      console.error(`❌ Файл не знайдено: ${filePath}`);
      process.exit(1);
    }
    // Читаємо nreg з файлу
    const content = await readFile(filePath, 'utf-8');
    const canonical = JSON.parse(content);
    canonicalNreg = canonical.metadata.rada_nreg;
  } else if (nreg) {
    const safeFilename = nregToSafeFilename(nreg);
    filePath = `${PATHS.canonical}/${safeFilename}.canonical.json`;
    canonicalNreg = nreg;
    
    if (!existsSync(filePath)) {
      console.error(`❌ Файл не знайдено: ${filePath}`);
      console.error(`   Переконайтеся що canonical JSON вже створено`);
      process.exit(1);
    }
  } else {
    console.error('❌ Помилка: не вказано --nreg або --file');
    console.error('   Використання: pnpm tsx scripts/legislation/r2_upload_canonical.ts --nreg="254к/96-вр"');
    process.exit(1);
  }

  // Читаємо canonical JSON
  console.log(`📥 Читання canonical JSON...`);
  const content = await readFile(filePath, 'utf-8');
  const canonical = JSON.parse(content);
  
  console.log(`   Файл: ${filePath}`);
  console.log(`   NREG: ${canonical.metadata.rada_nreg}`);
  console.log(`   Статей: ${canonical.content.articles.length}`);
  console.log(`   Chunks: ${canonical.content.chunks.length}`);

  // Генеруємо R2 key
  const r2Key = canonical.metadata.r2_key || generateR2Key(
    canonical.metadata.category,
    canonical.metadata.rada_nreg
  );

  console.log(`\n📤 Завантаження в R2...`);
  console.log(`   R2 Key: ${r2Key}`);

  // Створюємо R2 клієнт
  const client = createR2Client();
  const bucket = getLegislationBucket();

  console.log(`   Bucket: ${bucket}`);

  // Завантажуємо файл
  const result = await uploadFileToR2(
    client,
    bucket,
    r2Key,
    filePath,
    {
      contentType: 'application/json; charset=utf-8',
      skipIfExists: !force,
    }
  );

  console.log(`\n✅ Завантаження завершено!`);
  console.log(`   R2 Key: ${result.r2Key}`);
  console.log(`   ETag: ${result.etag}`);
  console.log(`   Розмір: ${(result.size / 1024).toFixed(2)} KB`);
  console.log(`   Статус: ${result.uploaded ? 'Завантажено' : 'Вже існував'}`);

  // Перевірка що r2_key в canonical співпадає
  if (canonical.metadata.r2_key !== r2Key) {
    console.log(`\n⚠️  Примітка: canonical.metadata.r2_key (${canonical.metadata.r2_key}) відрізняється від завантаженого ключа`);
    console.log(`   Оновіть canonical JSON або використайте правильний ключ`);
  }
}

main().catch(error => {
  console.error('\n❌ Помилка:', error instanceof Error ? error.message : String(error));
  if (error instanceof Error && error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
});

