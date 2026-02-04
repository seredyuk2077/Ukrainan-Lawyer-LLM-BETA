#!/usr/bin/env node

/**
 * R2 Repair Document — ремонт документа: завантажує canonical JSON в R2 та оновлює DB
 * 
 * Використання:
 *   pnpm tsx scripts/legislation/r2_repair_document.ts --nreg "254к/96-вр"
 */

import dotenv from 'dotenv';
import { resolve } from 'path';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { createR2Client, getLegislationBucket } from './lib/r2Client.js';
import { uploadFileToR2 } from './lib/r2Upload.js';
import { nregToSafeFilename } from './utils/nreg.js';
import { PATHS } from './config.js';

dotenv.config({ path: resolve(process.cwd(), '.env') });

/**
 * Парсить аргументи
 */
function parseArgs(): { nreg: string } {
  const args = process.argv.slice(2);
  let nreg: string | null = null;

  for (const arg of args) {
    if (arg.startsWith('--nreg=')) {
      nreg = arg.substring('--nreg='.length);
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Використання:
  pnpm tsx scripts/legislation/r2_repair_document.ts --nreg="<nreg>"

Приклад:
  pnpm tsx scripts/legislation/r2_repair_document.ts --nreg="254к/96-вр"
      `);
      process.exit(0);
    }
  }

  if (!nreg) {
    console.error('❌ Помилка: не вказано --nreg');
    process.exit(1);
  }

  return { nreg };
}

/**
 * Головна функція
 */
async function main() {
  console.log('🔧 R2 Repair Document — Ремонт документа\n');

  const { nreg } = parseArgs();
  console.log(`📋 NREG: ${nreg}\n`);

  // 1. Перевіряємо чи документ існує в DB
  const url = process.env.SUPABASE_LEGISLATION_URL;
  const key = process.env.SUPABASE_LEGISLATION_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('Supabase credentials не встановлено');
  }

  const supabase = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log('📥 Перевірка документа в DB...');
  const { data: doc, error: docError } = await supabase
    .from('legislation_documents')
    .select('*')
    .eq('rada_nreg', nreg)
    .single();

  if (docError || !doc) {
    throw new Error(`Документ не знайдено в DB: ${docError?.message}`);
  }

  console.log(`   ✅ Документ знайдено: ${doc.title}`);
  console.log(`      Поточний R2 key: ${doc.r2_key || '(не встановлено)'}`);
  console.log(`      Sync status: ${doc.sync_status}`);

  // 2. Знаходимо canonical JSON файл
  const safeFilename = nregToSafeFilename(nreg);
  const canonicalPath = `${PATHS.canonical}/${safeFilename}.canonical.json`;

  if (!existsSync(canonicalPath)) {
    throw new Error(`Canonical JSON не знайдено: ${canonicalPath}`);
  }

  console.log(`\n📥 Читання canonical JSON...`);
  const content = await readFile(canonicalPath, 'utf-8');
  const canonical = JSON.parse(content);
  
  console.log(`   Файл: ${canonicalPath}`);
  console.log(`   Розмір: ${(content.length / 1024).toFixed(2)} KB`);
  console.log(`   Chunks: ${canonical.content.chunks.length}`);

  // 3. Визначаємо правильний R2 key
  const r2Key = canonical.metadata.r2_key || doc.r2_key;
  
  if (!r2Key) {
    throw new Error('R2 key не знайдено ні в canonical JSON, ні в DB');
  }

  console.log(`\n☁️  Завантаження в R2...`);
  console.log(`   R2 Key: ${r2Key}`);

  // 4. Завантажуємо в R2
  const client = createR2Client();
  const bucket = getLegislationBucket();

  const result = await uploadFileToR2(
    client,
    bucket,
    r2Key,
    canonicalPath,
    {
      contentType: 'application/json; charset=utf-8',
      skipIfExists: false, // Завжди перезавантажуємо для repair
    }
  );

  console.log(`   ✅ Завантажено:`);
  console.log(`      Розмір: ${(result.size / 1024).toFixed(2)} KB`);
  console.log(`      ETag: ${result.etag}`);

  // 5. Оновлюємо DB
  console.log(`\n💾 Оновлення DB...`);
  
  const { error: updateError } = await supabase
    .from('legislation_documents')
    .update({
      r2_key: r2Key,
      sync_status: 'synced',
      updated_at: new Date().toISOString(),
    })
    .eq('rada_nreg', nreg);

  if (updateError) {
    throw new Error(`Помилка оновлення DB: ${updateError.message}`);
  }

  // Оновлюємо r2_key в chunks якщо потрібно
  const { data: chunks } = await supabase
    .from('legislation_chunks')
    .select('id, r2_key')
    .eq('document_nreg', nreg)
    .limit(1);

  if (chunks && chunks.length > 0 && chunks[0].r2_key !== r2Key) {
    console.log(`   Оновлення r2_key в chunks...`);
    const { error: chunksUpdateError } = await supabase
      .from('legislation_chunks')
      .update({ r2_key: r2Key })
      .eq('document_nreg', nreg);

    if (chunksUpdateError) {
      console.warn(`   ⚠️  Помилка оновлення chunks: ${chunksUpdateError.message}`);
    } else {
      console.log(`   ✅ Chunks оновлено`);
    }
  }

  console.log(`   ✅ DB оновлено`);

  // 6. Фінальна перевірка
  console.log(`\n✅ Фінальна перевірка...`);
  const { data: finalDoc } = await supabase
    .from('legislation_documents')
    .select('r2_key, sync_status')
    .eq('rada_nreg', nreg)
    .single();

  console.log(`   R2 Key в DB: ${finalDoc?.r2_key}`);
  console.log(`   Sync Status: ${finalDoc?.sync_status}`);

  console.log(`\n🎉 Ремонт завершено успішно!`);
}

main().catch(error => {
  console.error('\n❌ Помилка:', error instanceof Error ? error.message : String(error));
  if (error instanceof Error && error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
});

